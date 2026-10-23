import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import type { CheckEvidence, EntityView, ProjectState, StudioIdentity, StudioUser } from '../../packages/contracts/src/index.ts'
import { createApp } from '../../apps/collaboration-api/src/app.ts'
import { loadConfig } from '../../apps/collaboration-api/src/config.ts'
import { createDatabase } from '../../apps/collaboration-api/src/persistence/database.ts'
import { CollaborationClient } from '../../packages/studio-plugin/src/host/adapters/collaboration/client.ts'
import { PlatformRuntime } from '../../packages/studio-plugin/src/host/adapters/platform/runtime.ts'
import { WorkspaceGit } from '../../packages/studio-plugin/src/host/adapters/workspace/git.ts'
import { StudioApplication } from '../../packages/studio-plugin/src/host/application/studio.ts'
import { StudioStore } from '../../packages/studio-plugin/src/host/application/state.ts'
import type { HostPorts } from '../../packages/studio-plugin/src/host/application/ports.ts'
import { copyTemplate } from '../../packages/studio-plugin/src/host/prototype/template.ts'
import type { StudioCommand, StudioReply } from '../../packages/studio-plugin/src/shared/studio.ts'
import { gitHttpFixture, gitHttpToken } from './git-http-fixture.ts'

const runtimeRoot = process.env.EADP_TEST_RUNTIME_ROOT
const databaseUrl = process.env.STUDIO_TEST_DATABASE_URL
const serverGitExecutable = process.env.EADP_TEST_SERVER_GIT
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const json = async (response: Response) => { const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value }
async function fixture() {
  assert.ok(runtimeRoot && serverGitExecutable, 'EADP_TEST_RUNTIME_ROOT and EADP_TEST_SERVER_GIT must explicitly select the pinned client bundle and full CGI server Git')
  const manifest = JSON.parse(await readFile(path.join(runtimeRoot, 'runtime-manifest.json'), 'utf8'))
  const gitlab = await gitHttpFixture(path.resolve(runtimeRoot, manifest.tools.git.path), serverGitExecutable)
  const runtime = await PlatformRuntime.load(path.join(runtimeRoot, 'runtime-manifest.json'), runtimeRoot, gitlab.subprocess)
  const git = new WorkspaceGit(runtime, async () => gitlab.origin)
  return { gitlab, runtime, git, close: async () => { await runtime.dispose(); await gitlab.close() } }
}

test('the loopback GitLab fixture pushes real objects through standard Git smart HTTP and reads their exact API bytes', { skip: !runtimeRoot, timeout: 300_000 }, async t => {
  const f = await fixture(); t.after(() => f.close())
  const project = await json(await fetch(`${f.gitlab.origin}/api/v4/projects`, { method: 'POST', headers: { 'PRIVATE-TOKEN': gitHttpToken, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Smart HTTP check', path: 'smart-http-check', namespace_id: 42, visibility: 'private', initialize_with_readme: false, description: 'test-owned' }) }))
  const directory = path.join(f.gitlab.root, 'author'); await f.git.init(directory, project.http_url_to_repo)
  await mkdir(path.join(directory, '需求')); await writeFile(path.join(directory, '需求', '真实材料.md'), '# 实际 Git 对象\n')
  const first = await f.git.commitFiles(directory, ['需求/真实材料.md'], 'Create actual bytes', { name: 'Synthetic author', email: 'author@example.test' })
  await f.git.push(directory, first, 'main')
  const clone = path.join(f.gitlab.root, 'reader'); await f.git.clone(project.http_url_to_repo, clone)
  assert.equal(await f.git.head(clone), first)
  const headers = { 'PRIVATE-TOKEN': gitHttpToken }
  const body = await fetch(`${f.gitlab.origin}/api/v4/projects/${project.id}/repository/files/${encodeURIComponent('需求/真实材料.md')}/raw?ref=${first}`, { headers })
  assert.equal(await body.text(), '# 实际 Git 对象\n')
  await writeFile(path.join(directory, '需求', '真实材料.md'), '# 实际 Git 对象第二版\n')
  const second = await f.git.commitFiles(directory, ['需求/真实材料.md'], 'Change actual bytes', { name: 'Synthetic author', email: 'author@example.test' })
  await f.git.push(directory, second, 'candidate'); await f.git.conditionalUpdate(directory, 'main', first, second)
  const commit = await json(await fetch(`${f.gitlab.origin}/api/v4/projects/${project.id}/repository/commits/${second}`, { headers }))
  assert.deepEqual(commit.parent_ids, [first])
  const compare = await json(await fetch(`${f.gitlab.origin}/api/v4/projects/${project.id}/repository/compare?from=${first}&to=${second}&straight=true`, { headers }))
  assert.equal(compare.diffs.length, 1); assert.equal(compare.diffs[0].new_path, '需求/真实材料.md'); assert.match(compare.diffs[0].diff, /第二版/)
  assert.ok(f.gitlab.gitRequests() >= 6, 'Git pushes and clones must actually reach the CGI')
  assert.deepEqual(f.gitlab.failures, [])
})

test('actual Host, API, PostgreSQL and smart HTTP Git complete stages, baseline, handoff and adoption with recovery', { skip: !runtimeRoot || !databaseUrl, timeout: 3_600_000 }, async t => {
  assert.match(new URL(databaseUrl!).pathname, /^\/eadp_auth_check_[a-z0-9]+$/, 'Only a fresh, disposable suite-owned PostgreSQL database is allowed')
  const f = await fixture(); t.after(() => f.close())
  const config = loadConfig({ DATABASE_URL: databaseUrl, PG_SSL: 'disable', GITLAB_URL: f.gitlab.origin, GITLAB_ALLOW_HTTP: 'true', SEI_GITLAB_TOKEN: gitHttpToken })
  const database = createDatabase(config)
  const tables = await database.query("SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema='public'")
  assert.equal(tables.rows[0].count, 0, 'The suite must never initialize or reuse a shared database')
  await database.query(await readFile(new URL('../../apps/collaboration-api/db/schema.sql', import.meta.url), 'utf8'))
  const server = createApp(config, database); t.after(() => server.close()); await server.listen({ port: 0, host: '127.0.0.1' })
  const address = server.server.address(); assert.ok(address && typeof address !== 'string'); const origin = `http://127.0.0.1:${address.port}`
  let token = '', account: StudioUser | undefined, loseCompletion = false, completionResponseLost = false
  const requests: Array<{ method: string; route: string; status: number }> = []
  const requestHttp: typeof fetch = async (url, options) => {
    const route = new URL(String(url)).pathname, response = await fetch(url, options)
    requests.push({ method: String(options?.method ?? 'GET'), route, status: response.status })
    if (loseCompletion && route.endsWith('/complete') && response.ok) { loseCompletion = false; completionResponseLost = true; await response.body?.cancel(); throw new Error('Synthetic loss after actual server completion') }
    return response
  }
  const api = new CollaborationClient(origin, async () => token, undefined, requestHttp)
  const store = new StudioStore(path.join(f.gitlab.root, 'local-state'))
  const prompts: Array<{ sessionId: string; text: string }> = []
  const ports: HostPorts = {
    workspaceRoot: path.join(f.gitlab.root, 'workspace'), git: f.git, gitLocal: (args, cwd) => f.git.local(cwd, args),
    login: async (username, password) => { const session = await api.request<StudioIdentity & { token: string }>('POST', '/v1/auth/login', { username, password }); token = session.token; account = session.user; return session },
    logout: async () => { await api.request('POST', '/v1/auth/logout'); token = ''; account = undefined }, account: async () => account,
    installTemplate: async destinationRoot => { await copyTemplate({ templateRoot: path.resolve('packages/studio-plugin/assets/prototype-template'), manifestPath: path.resolve('packages/studio-plugin/assets/prototype-template.manifest.json'), destinationRoot }) },
    session: async task => task.sessionId, prompt: async (sessionId, text) => { prompts.push({ sessionId, text }) },
    checks: async (_task, candidateSha): Promise<CheckEvidence> => ({ candidateSha, passed: true, checks: ['engineering', 'mock', 'browser', 'relations'].map(name => ({ name, passed: true, evidenceHash: digest(`deterministic-test-check:${name}:${candidateSha}`) })) }),
    preview: async () => { throw new Error('This suite does not claim native preview verification') }, stopPreview: async () => {}, publication: async () => { throw new Error('Publication is outside G0 local workflow') },
  }
  const app = new StudioApplication(store, api, ports); t.after(() => app.dispose())
  const command = async (input: StudioCommand) => { const reply = await app.command(input); assert.equal(reply.ok, true, JSON.stringify(reply)); if (!reply.ok) throw new Error('unreachable'); console.info('workflow command completed:', input.action); return reply.state }
  const rejected = async (input: StudioCommand, message: RegExp) => { const reply: StudioReply = await app.command(input); assert.equal(reply.ok, false); if (reply.ok) throw new Error('Expected rejection'); assert.match(reply.message, message) }
  await command({ action: 'login', username: 'studioAdmin', password: 'admin@123' })
  let state = await command({ action: 'createProject', name: 'Workflow integration', namespaceId: 42, path: 'workflow-integration' })
  assert.equal(state.project?.initializationStatus, 'ready'); assert.match(state.project.recognizedHead!, /^[a-f0-9]{40}$/)
  const projectId = state.project.id, rootSha = state.project.recognizedHead
  state = await command({ action: 'createMaterial', operationId: randomUUID(), kind: 'scenario', title: 'Purchase scenario' })
  const scenario = state.drafts.find(draft => draft.metadata.kind === 'scenario')!
  await rejected({ action: 'confirmMaterial', entityId: scenario.entityId, expectedHash: scenario.sha256, method: 'direct' }, /核心|验收|明确|缺失/)
  const body = (title: string) => `# ${title}\n\n## 核心业务规则\n\n数量必须大于零，提交保留固定来源。\n\n## 验收条件\n\n输入合法时显示成功，非法时显示校验错误。\n`
  const saveReady = async (entityId: string, title: string) => {
    const current = (await app.state()).drafts.find(draft => draft.entityId === entityId)!
    return command({ action: 'saveMaterial', entityId, metadata: { ...current.metadata, businessEvidence: [...current.metadata.businessEvidence, { label: 'Explicit synthetic author input', reference: 'test:studio-workflow-fixture' }], coreRulesPresent: true, acceptanceCriteriaPresent: true }, body: body(title) })
  }
  state = await saveReady(scenario.entityId, 'Purchase scenario')
  await rejected({ action: 'confirmMaterial', entityId: scenario.entityId, expectedHash: scenario.sha256, method: 'direct' }, /变化|新版本/)
  loseCompletion = true
  const lost = await app.command({ action: 'confirmMaterial', entityId: scenario.entityId, expectedHash: state.drafts.find(draft => draft.entityId === scenario.entityId)!.sha256, method: 'direct' })
  assert.equal(lost.ok, false); assert.equal(completionResponseLost, true, JSON.stringify({ reply: lost, requests }))
  const operation = (await store.read()).operations[0]!
  state = await command({ action: 'retryOperation', operationId: operation.id })
  const split = (await store.read()).tasks.find(task => task.purpose === 'split')!
  await app.acceptSessionOutput(split.sessionId, { kind: 'assistant', content: '```eadp-candidates\n' + JSON.stringify([{ title: 'Purchase requirement', summary: 'Deterministic model fixture output' }]) + '\n```' })
  state = await command({ action: 'state' }); assert.equal(state.candidates.length, 1)
  state = await command({ action: 'selectCandidate', candidateId: state.candidates[0]!.id })
  const requirement = state.collaboration!.entities.find((entity): entity is EntityView => 'title' in entity && entity.kind === 'requirement')!
  state = await saveReady(requirement.id, 'Purchase requirement')
  state = await command({ action: 'confirmMaterial', entityId: requirement.id, expectedHash: state.drafts.find(draft => draft.entityId === requirement.id)!.sha256, method: 'direct' })
  const prototype = (await store.read()).tasks.find(task => task.entityId === requirement.id && task.purpose === 'prototype')!
  assert.ok(prototype)
  const codePath = path.join(prototype.worktree, '原型代码', 'src', 'pages', 'workflow', 'index.tsx'); await mkdir(path.dirname(codePath), { recursive: true }); await writeFile(codePath, 'export default function Workflow() { return <div>合成工作流演示</div> }\n')
  await command({ action: 'checkPrototype', entityId: requirement.id })
  state = await command({ action: 'confirmPrototype', entityId: requirement.id, method: 'direct' })
  const baseline = state.collaboration!.baselines[0]!; assert.ok(baseline); assert.equal(baseline.entityId, requirement.id)
  const handoff = state.collaboration!.entities.find((entity): entity is EntityView => 'title' in entity && entity.kind === 'handoff')!
  assert.ok(handoff)
  state = await saveReady(handoff.id, 'Author-edited handoff')
  const handoffHash = state.drafts.find(draft => draft.entityId === handoff.id)!.sha256, promptCount = prompts.length
  state = await command({ action: 'generateHandoff', baselineId: baseline.id })
  assert.equal(state.drafts.find(draft => draft.entityId === handoff.id)!.sha256, handoffHash); assert.equal(prompts.length, promptCount, 'retry must not overwrite or resend an already delivered handoff')
  state = await command({ action: 'confirmMaterial', entityId: handoff.id, expectedHash: handoffHash, method: 'direct' })
  await command({ action: 'acknowledgeHandoff', entityId: handoff.id, note: 'Synthetic receiver located fixed acceptance material' })
  state = await command({ action: 'createMaterial', operationId: randomUUID(), kind: 'requirement', title: 'Adopted target', scenarioIds: [scenario.entityId] })
  const target = state.collaboration!.entities.find((entity): entity is EntityView => 'title' in entity && entity.title === 'Adopted target')!
  const source = state.collaboration!.entities.find((entity): entity is EntityView => 'title' in entity && entity.id === requirement.id)!
  await command({ action: 'setEligibility', entityId: source.id, version: source.materialVersion, enabled: false, reason: 'Synthetic stop-new-adoption check' })
  await rejected({ action: 'adopt', sourceProjectId: projectId, sourceEntityId: source.id, version: source.materialVersion, targetEntityId: target.id, reason: 'Adapt to target' }, /不能采用|停用|eligible/)
  await command({ action: 'setEligibility', entityId: source.id, version: source.materialVersion, enabled: true, reason: 'Synthetic restore' })
  state = await command({ action: 'adopt', sourceProjectId: projectId, sourceEntityId: source.id, version: source.materialVersion, targetEntityId: target.id, reason: 'Adapt to target' })
  const accepted = await api.request<Array<{ id: string; status: string }>>('GET', `/v1/projects/${projectId}/adoptions`); assert.equal(accepted.length, 1); assert.equal(accepted[0]!.status, 'accepted')
  state = await saveReady(target.id, 'Adjusted target requirement')
  state = await command({ action: 'confirmMaterial', entityId: target.id, expectedHash: state.drafts.find(draft => draft.entityId === target.id)!.sha256, method: 'direct' })
  const adopted = await api.request<Array<{ id: string; status: string; targetConfirmationId?: string; targetVersion?: number; source: unknown }>>('GET', `/v1/projects/${projectId}/adoptions`)
  assert.equal(adopted[0]!.status, 'succeeded'); assert.ok(adopted[0]!.targetConfirmationId); assert.equal(adopted[0]!.targetVersion, 1)
  const pgVersion = (await database.query('SHOW server_version')).rows[0].server_version
  assert.deepEqual(f.gitlab.failures, [])
  const evidence = { status: 'passed', scope: 'actual-Host-API-PostgreSQL-and-Git-objects-with-loopback-test-GitLab-and-deterministic-model-check-ports', actualEnterpriseGitLabVerified: false, liveModelVerified: false, nativeGuiVerified: false, tools: { clientGit: { version: f.runtime.manifest.tools.git.version, sha256: f.runtime.manifest.tools.git.sha256 }, serverGit: f.gitlab.serverGit }, pgVersion, projectId, rootSha, baseline, adoption: adopted[0], completionResponseLost, gitRequests: f.gitlab.gitRequests(), objectReads: f.gitlab.objects, requests }
  const evidencePath = process.env.STUDIO_WORKFLOW_EVIDENCE ?? path.resolve('.local/acceptance/g0-workflow-e2e/result.json'); await mkdir(path.dirname(evidencePath), { recursive: true }); await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n')
})
