import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type { CheckEvidence, EntityView, StudioIdentity, StudioUser } from '../../packages/contracts/src/index.ts'
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

test('actual Host, API, PostgreSQL and smart HTTP Git execute requirement collaboration with recovery', { skip: !runtimeRoot || !databaseUrl, timeout: 300_000 }, async t => {
  assert.match(new URL(databaseUrl!).pathname, /^\/eadp_auth_check_[a-z0-9]+$/, 'Only a fresh, disposable suite-owned PostgreSQL database is allowed')
  const f = await fixture(); t.after(() => f.close())
  const config = loadConfig({ DATABASE_URL: databaseUrl, PG_SSL: 'disable', GITLAB_URL: f.gitlab.origin, GITLAB_ALLOW_HTTP: 'true', SEI_GITLAB_TOKEN: gitHttpToken })
  const database = createDatabase(config)
  assert.equal((await database.query("SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema='public'")).rows[0].count, 0)
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
  const comparisons: Array<{ targetId: string; paths: string[] }> = []
  const ports: HostPorts = {
    workspaceRoot: path.join(f.gitlab.root, 'workspace'), git: f.git, gitLocal: (args, cwd) => f.git.local(cwd, args),
    login: async (username, password) => { const session = await api.request<StudioIdentity & { token: string }>('POST', '/v1/auth/login', { username, password }); token = session.token; account = session.user; return session },
    logout: async () => { await api.request('POST', '/v1/auth/logout'); token = ''; account = undefined }, account: async () => account,
    installTemplate: async destinationRoot => { await copyTemplate({ templateRoot: fileURLToPath(new URL('../../packages/studio-plugin/assets/prototype-template', import.meta.url)), manifestPath: fileURLToPath(new URL('../../packages/studio-plugin/assets/prototype-template.manifest.json', import.meta.url)), destinationRoot }) },
    session: async task => task.sessionId, prompt: async (sessionId, text) => { prompts.push({ sessionId, text }) },
    readScenarioSource: async source => ({ status: 'read', ranges: ['line:1-2'], text: await readFile(source.path, 'utf8') }),
    compareConsistency: async input => {
      for (const material of input.materials) assert.equal(digest(material.text), material.sha256, 'Model input and recorded hash come from identical bytes')
      comparisons.push({ targetId: input.targetId, paths: input.materials.map(value => value.path) })
      return JSON.stringify({ summary: '本次实际读取范围未发现冲突', conflicts: [] })
    },
    checks: async (_task, candidateSha): Promise<CheckEvidence> => ({ candidateSha, passed: true, checks: ['engineering', 'mock', 'browser', 'relations'].map(name => ({ name, passed: true, evidenceHash: digest(`deterministic-test-check:${name}:${candidateSha}`) })) }),
    preview: async () => { throw new Error('This suite does not claim native preview verification') }, stopPreview: async () => {}, publication: async () => { throw new Error('Publication is outside requirement collaboration') },
  }
  const app = new StudioApplication(store, api, ports); t.after(() => app.dispose())
  const command = async (input: StudioCommand) => { const reply = await app.command(input); assert.equal(reply.ok, true, JSON.stringify(reply)); if (!reply.ok) throw new Error('unreachable'); console.info('workflow command completed:', input.action); return reply.state }
  const rejected = async (input: StudioCommand, message: RegExp) => { const reply: StudioReply = await app.command(input); assert.equal(reply.ok, false); if (reply.ok) throw new Error('Expected rejection'); assert.match(reply.message, message) }
  const waitUntil = async (ready: () => Promise<boolean>) => {
    const deadline = Date.now() + 30_000
    while (!await ready()) { assert.ok(Date.now() < deadline, 'The local asynchronous operation did not finish'); await new Promise(resolve => setTimeout(resolve, 20)) }
  }
  await command({ action: 'login', username: 'studioAdmin', password: 'admin@123' })
  let state = await command({ action: 'createProject', name: 'Requirement collaboration', namespaceId: 42, path: 'requirement-collaboration' })
  await waitUntil(async () => {
    const initializations = (await store.read()).projectInitializations
    const failed = initializations.find(value => value.phase === 'unknown')
    assert.equal(failed?.message, undefined, 'Project initialization failed: ' + failed?.message)
    return initializations.some(value => value.phase === 'ready')
  })
  state = await command({ action: 'state' })
  assert.equal(state.project?.initializationStatus, 'ready'); assert.match(state.project.recognizedHead!, /^[a-f0-9]{40}$/)
  const projectId = state.project.id, rootSha = state.project.recognizedHead
  const general = state.collaboration!.entities.find(value => value.builtinKey === 'general')!
  assert.equal(general.materialVersion, 1); assert.equal(general.code, 'SC-0001')
  const createOperation = randomUUID()
  state = await command({ action: 'createMaterial', operationId: createOperation, kind: 'requirement', title: 'Manual requirement', scenarioIds: [general.id] })
  const manual = state.drafts.find(value => value.metadata.kind === 'requirement')!
  assert.equal(manual.body, ''); assert.deepEqual(manual.metadata.sources, [{ projectId, entityId: general.id, version: 1 }])
  state = await command({ action: 'createMaterial', operationId: createOperation, kind: 'requirement', title: 'Manual requirement', scenarioIds: [general.id] })
  assert.equal(state.collaboration!.entities.filter(value => value.kind === 'requirement').length, 1)
  await rejected({ action: 'confirmMaterial', entityId: manual.entityId, expectedHash: manual.sha256, method: 'direct' }, /核心|验收|明确|缺失|依据/)
  await rejected({ action: 'splitRequirements', scenarioIds: [general.id] }, /普通场景|通用/)

  state = await command({ action: 'createMaterial', operationId: randomUUID(), kind: 'scenario', title: 'Purchase scenario' })
  const scenario = state.scenario!.draft
  const evidenceId = randomUUID()
  await command({ action: 'importScenarioSource', entityId: scenario.entityId, name: 'business-interview.txt', base64: Buffer.from('采购数量必须大于零。\n提交采购申请后进入审核。\n').toString('base64'), operationId: evidenceId })
  await waitUntil(async () => (await store.read()).scenarios.find(value => value.entityId === scenario.entityId)?.sources.some(value => value.id === evidenceId && value.status === 'read') === true)
  state = await command({ action: 'selectScenarioSource', entityId: scenario.entityId, sourceId: evidenceId, selected: true, formal: true })
  const scenarioBody = '# Purchase scenario\n\n## 业务规则\n\n1. 采购数量必须大于零。\n2. 提交采购申请后进入审核。\n\n## 验收条件\n\n数量为零时拒绝提交，数量为一时进入审核。\n'
  let draft = state.scenario!.draft
  state = await command({ action: 'saveScenario', entityId: draft.entityId, expectedHash: draft.sha256, operationId: randomUUID(), metadata: { ...draft.metadata, coreRulesPresent: true, acceptanceCriteriaPresent: true }, body: scenarioBody })
  await rejected({ action: 'confirmMaterial', entityId: scenario.entityId, expectedHash: scenario.sha256, method: 'direct' }, /变化|新版本|版本/)
  loseCompletion = true
  const lost = await app.command({ action: 'confirmMaterial', entityId: scenario.entityId, expectedHash: state.scenario!.draft.sha256, method: 'direct' })
  assert.equal(lost.ok, true, 'The command records its pending operation before publication finishes')
  const operation = (await store.read()).operations.find(value => value.entityId === scenario.entityId)!
  await waitUntil(async () => operation.phase === 'unknown')
  assert.equal(completionResponseLost, true, JSON.stringify({ operation, requests }))
  state = await command({ action: 'retryOperation', operationId: operation.id })
  await waitUntil(async () => operation.phase === 'accepted')
  state = await command({ action: 'state' })
  assert.equal((await store.read()).tasks.filter(value => value.purpose === 'split').length, 0, 'Confirmation offers splitting without creating a split or requirement')
  assert.equal(state.collaboration!.entities.filter(value => value.kind === 'requirement').length, 1)
  state = await command({ action: 'splitRequirements', scenarioIds: [scenario.entityId] })
  const split = (await store.read()).tasks.find(value => value.purpose === 'split')!
  const goal = '允许采购员提交采购申请', scope = '采购提交与审核入口', rule = '采购数量必须大于零。', acceptance = '数量为零时拒绝提交，数量为一时进入审核。'
  const candidateBody = `# Purchase requirement\n\n## 目标\n\n${goal}\n\n## 范围\n\n${scope}\n\n## 业务规则\n\n1. ${rule}\n\n## 验收条件\n\n${acceptance}\n`
  const lines = scenarioBody.split('\n'), line = lines.findIndex(value => value.includes(rule)) + 1
  await app.acceptSessionOutput(split.sessionId, { kind: 'assistant', content: '```eadp-candidates\n' + JSON.stringify([{ title: 'Purchase requirement', summary: 'Deterministic capability candidate', goal, scope, rules: [rule], acceptanceCriteria: [acceptance], openQuestions: [], body: candidateBody, sources: [{ entityId: scenario.entityId, excerpts: [{ startLine: line, endLine: line, text: lines[line - 1] }] }] }]) + '\n```' })
  state = await command({ action: 'state' }); assert.equal(state.candidates.length, 1)
  const selected = state.candidates[0]!
  state = await command({ action: 'selectCandidate', candidateId: selected.id, expectedInputHash: selected.inputHash })
  const requirement = state.collaboration!.entities.find((value): value is EntityView => value.kind === 'requirement' && value.id !== manual.entityId)!
  draft = state.drafts.find(value => value.entityId === requirement.id)!
  assert.ok(draft.body.includes(candidateBody.trimEnd())); assert.ok(draft.metadata.businessEvidence.length > 0)
  assert.deepEqual(draft.metadata.sources, [{ projectId, entityId: scenario.entityId, version: 1 }])
  assert.equal(requirement.code, 'REQ-0002')
  state = await command({ action: 'selectCandidate', candidateId: selected.id, expectedInputHash: selected.inputHash })
  assert.equal(state.collaboration!.entities.filter(value => value.kind === 'requirement').length, 2)
  state = await command({ action: 'confirmMaterial', entityId: requirement.id, expectedHash: draft.sha256, method: 'direct' })
  const requirementOperation = (await store.read()).operations.find(value => value.entityId === requirement.id)!
  await waitUntil(async () => {
    assert.notEqual(requirementOperation.phase, 'unknown', requirementOperation.message)
    return requirementOperation.phase === 'accepted'
  })
  state = await command({ action: 'state' })
  const confirmed = state.collaboration!.entities.find(value => value.id === requirement.id) as EntityView
  assert.equal(confirmed.confirmationStatus, 'confirmed'); assert.equal(confirmed.materialVersion, 1)
  const source = await app.command({ action: 'readRequirementSource', entityId: requirement.id, sourceEntityId: scenario.entityId, expectedVersion: 1 })
  assert.ok(source.ok && source.requirementSource, JSON.stringify(source)); assert.equal(source.requirementSource.version, 1); assert.equal(source.requirementSource.body, scenarioBody)
  await waitUntil(async () => (await store.read()).consistencyComparisons.filter(value => value.trigger === 'confirmation').length === 2 && (await store.read()).consistencyComparisons.filter(value => value.trigger === 'confirmation').every(value => value.phase === 'shared'))
  const automatic = (await store.read()).consistencyComparisons.filter(value => value.trigger === 'confirmation')
  assert.equal(new Set(automatic.map(value => value.confirmationId)).size, 2)
  const beforeGit = f.gitlab.gitRequests(), beforeReads = f.gitlab.objects.length
  const history = await app.command({ action: 'listConsistencyComparisons', entityId: requirement.id, limit: 20, offset: 0 })
  assert.ok(history.ok && history.comparisons?.length === 1)
  assert.equal(history.comparisons[0]!.result, 'completed')
  assert.equal(f.gitlab.gitRequests(), beforeGit); assert.equal(f.gitlab.objects.length, beforeReads, 'Comparison history does not load Git material content')
  assert.equal((await database.query('SELECT id FROM studio_confirmations WHERE project_id=$1 AND entity_id=$2', [projectId, scenario.entityId])).rowCount, 1)
  assert.equal((await database.query('SELECT id FROM studio_confirmations WHERE project_id=$1 AND entity_id=$2', [projectId, requirement.id])).rowCount, 1)
  assert.equal(state.collaboration!.entities.find(value => value.id === general.id)!.materialVersion, 1)
  assert.deepEqual(f.gitlab.failures, [])
  const evidence = { status: 'passed', scope: 'actual-Host-API-PostgreSQL-and-Git-objects-with-loopback-GitLab-and-deterministic-model-ports', actualEnterpriseGitLabVerified: false, liveModelVerified: false, nativeGuiVerified: false, platform: process.platform, tools: { clientGit: { version: f.runtime.manifest.tools.git.version, sha256: f.runtime.manifest.tools.git.sha256 }, serverGit: f.gitlab.serverGit }, pgVersion: (await database.query('SHOW server_version')).rows[0].server_version, projectId, rootSha, requirementId: requirement.id, completionResponseLost, comparisons, gitRequests: f.gitlab.gitRequests(), objectReads: f.gitlab.objects, requests }
  const evidencePath = process.env.STUDIO_WORKFLOW_EVIDENCE ?? path.resolve('.local/acceptance/requirements-workflow/result.json'); await mkdir(path.dirname(evidencePath), { recursive: true }); await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n')
})
