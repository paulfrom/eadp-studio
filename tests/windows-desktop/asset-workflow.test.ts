import assert from 'node:assert/strict'
import { cp, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'
import { OccupationTokenSchema } from '../../packages/contracts/src/index.ts'
import type { EntityView, FixedVersion, MaterialMetadata, PrepareIntegrationRequest, ProjectState } from '@eadp/contracts'
import { StudioApplication } from '../../packages/studio-plugin/src/host/application/studio.ts'
import { StudioStore } from '../../packages/studio-plugin/src/host/application/state.ts'
import { initialMetadata, type HostPorts } from '../../packages/studio-plugin/src/host/application/ports.ts'
import { CollaborationError, CollaborationClient } from '../../packages/studio-plugin/src/host/adapters/collaboration/client.ts'
import { registerRoutes } from '../../apps/collaboration-api/src/routes.ts'
import { loadConfig } from '../../apps/collaboration-api/src/config.ts'
import { digest, readMaterial, saveMaterial } from '../../packages/studio-plugin/src/host/adapters/assets/materials.ts'
import { archiveSelectedEvidence } from '../../packages/studio-plugin/src/host/application/scenario-evidence.ts'
import { validateIntegration } from '../../apps/collaboration-api/src/modules/integration.ts'

const head = 'a'.repeat(40), candidate = 'b'.repeat(40)
const { Value } = createRequire(new URL('../../packages/contracts/package.json', import.meta.url))('@sinclair/typebox/value')
/** A handled exception keeps the confirmation intent and offers recovery instead of reporting acceptance. */
function assertConfirmationRecovery(reply: Awaited<ReturnType<StudioApplication['command']>>): void {
  assert.equal(reply.ok, true, JSON.stringify(reply))
  if (reply.ok) assert.ok(reply.state.pending.some(value => value.phase === 'confirmation-recovery'), JSON.stringify(reply.state.pending))
}
const body = '# 材料\n\n## 核心业务规则\n\n用户按固定业务范围检查记录且保留审计依据。\n\n## 验收条件\n\n符合业务规则的记录可以保存，不符合的显示明确错误。\n'
const templateBody = '## 目标与范围\n\n## 业务规则\n\n## 验收条件\n'
const templateRef = { commitSha: head, path: '.template/default.md', sha256: digest(templateBody) }
const evidencePath = '.eadp/evidence/fixture/approved.txt'
const evidenceBody = '合成业务访谈：用户按固定业务范围检查记录并保留审计依据。\n'
const evidence = { label: '合成测试业务依据', reference: 'synthetic:fixture', files: [{ path: evidencePath, sha256: digest(evidenceBody) }], ranges: [{ path: evidencePath, startLine: 1, endLine: 1 }] }
const entity = (id: string, kind: EntityView['kind'] = 'requirement'): EntityView => ({ id, kind, title: id,
  ...(kind === 'handoff' ? {} : { templateId: 'default', templateRef }),
  revision: 1, generation: 1, materialVersion: 0, confirmationStatus: 'draft', taskStatus: 'active',
  scenarioIds: kind === 'requirement' ? ['origin'] : [],
  ...(kind === 'requirement' ? { scenarioSources: [{ projectId: 'project', entityId: 'origin', version: 1 }] } : {}),
  prerequisites: [], authorId: 1 })
const metadata = (value: EntityView): MaterialMetadata => ({ ...initialMetadata(value, value.scenarioIds,
  value.scenarioIds.map(entityId => ({ projectId: 'project', entityId, version: 1 }))),
  businessEvidence: [evidence], coreRulesPresent: true, acceptanceCriteriaPresent: true })
async function fixedFiles(directory: string): Promise<void> {
  await mkdir(path.dirname(path.join(directory, evidencePath)), { recursive: true })
  await writeFile(path.join(directory, evidencePath), evidenceBody)
  await mkdir(path.join(directory, '.template'), { recursive: true })
  await writeFile(path.join(directory, templateRef.path), templateBody)
}
async function fixture(t: test.TestContext, kind: EntityView['kind'] = 'requirement') {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-asset-workflow-')), apps: StudioApplication[] = []
  // Confirmations finish on the background lane; teardown waits for it so no
  // local state write races removal of the temporary directory.
  t.after(async () => { for (const created of apps) await created.dispose(); await rm(root, { recursive: true, force: true }) })
  const store = new StudioStore(path.join(root, 'state')); store.useUser(1)
  const local = await store.read(), value = entity('target', kind), worktree = path.join(root, 'task')
  await mkdir(worktree)
  await fixedFiles(worktree)
  value.occupation = { occupationId: 'occupation', generation: 1, taskId: 'task', clientId: local.clientId, expectedRevision: 1, entityId: value.id, ownerId: 1, purpose: 'design', inputVersion: 0, prerequisiteBindings: [], createdAt: '' }
  const project = { id: 'project', name: '测试项目', gitlabProjectId: 1, repositoryUrl: 'https://example.test/project.git', stableBranch: 'main', namespaceId: 1, namespacePath: 'test', initializationStatus: 'ready' as const, recognizedHead: head, revision: 1 }
  const origin = entity('origin', 'scenario'); origin.materialVersion = 1; origin.confirmationStatus = 'confirmed'; origin.taskStatus = 'idle'
  const originDraft = await saveMaterial(worktree, metadata(origin), body)
  origin.current = { version: 1, fixed: { commitSha: head, path: originDraft.path, sha256: originDraft.sha256 }, metadata: originDraft.metadata, confirmationId: 'origin-confirmation', confirmedBy: 1, confirmedAt: '', reuse: { enabled: true, reason: '' } }
  const remote: ProjectState = { project, entities: [value, origin], integrations: [], baselines: [] }
  local.projects.push({ id: project.id, name: project.name, directory: root, repositoryUrl: project.repositoryUrl }); local.selectedProjectId = project.id
  local.tasks.push({ projectId: project.id, entityId: value.id, worktree, purpose: kind === 'handoff' ? 'handoff' : 'material', inputHash: '', sessionId: 'material-session' })
  await saveMaterial(worktree, metadata(value), body)
  await store.save()
  const sourceEntity = entity('source'), sourceMetadata = { ...metadata(sourceEntity), sources: [{ projectId: 'source-project', entityId: 'origin', version: 1 }] }
  const sourceDirectory = path.join(root, 'source'); await mkdir(sourceDirectory); await fixedFiles(sourceDirectory)
  const sourceDraft = await saveMaterial(sourceDirectory, sourceMetadata, body)
  local.projects.push({ id: 'source-project', name: '来源项目', directory: sourceDirectory, repositoryUrl: project.repositoryUrl }); await store.save()
  const source: FixedVersion = { version: 2, fixed: { commitSha: head, path: sourceDraft.path, sha256: sourceDraft.sha256 }, metadata: sourceMetadata, confirmationId: 'source-confirmation', confirmedBy: 1, confirmedAt: '', reuse: { enabled: true, reason: '' } }
  const records = new Map<string, unknown>(), calls = { prompts: [] as string[], sessions: [] as string[], adoptions: 0, successEffects: 0, successRequests: [] as object[], commits: [] as Array<readonly string[]>, prepared: [] as PrepareIntegrationRequest[], pushes: [] as string[], conditionalUpdates: 0 }
  const gitState = { head, remote: head, dirtyFiles: [(await readMaterial(worktree, kind, value.id)).path], changedFiles: [] as string[] }
  const reviewTrees = new Map<string, string>()
  const failures = { adoptionResponse: false, successResponse: false, prompt: false, session: false, push: false, integrationResponse: false, pendingIntegration: false }
  const api = { request: async (method: string, route: string, input?: Record<string, unknown>) => {
    if (input && 'token' in input) assert.equal(Value.Check(OccupationTokenSchema, input.token), true, 'Host writes must send the exact occupation token contract')
    if (method === 'GET' && route === '/v1/projects') return [project]
    if (method === 'GET' && route.endsWith('/templates')) return { acceptedHead: project.recognizedHead, scenarios: { defaultTemplateId: 'default', templates: [{ id: 'default', name: '默认场景模板', fixed: templateRef }] }, requirements: { defaultTemplateId: 'default', templates: [{ id: 'default', name: '默认需求模板', fixed: templateRef }] } }
    if (method === 'GET' && route.endsWith('/versions')) return [source]
    if (method === 'GET' && route.includes('/operations/')) { const result = records.get(route.split('/').at(-1)!); if (!result) throw new CollaborationError('OPERATION_NOT_FOUND', 'missing', 404); return { action: 'integration.prepare', result } }
    if (method === 'GET' && route.includes('/integrations/')) return remote.integrations.find(integration => integration.id === route.split('/').at(-1))
    if (method === 'GET' && route === '/v1/projects/source-project') return { ...remote, project: { ...project, id: 'source-project' } }
    if (method === 'GET' && route === '/v1/projects/project') return remote
    if (method === 'POST' && route.endsWith('/adoptions')) {
      const operationKey = String(input!.idempotencyKey)
      let result = records.get(operationKey)
      if (!result) { calls.adoptions++; result = { id: 'adoption', ...input, status: 'accepted' }; records.set(operationKey, result) }
      if (failures.adoptionResponse) { failures.adoptionResponse = false; throw new Error('adoption response lost') }
      return result
    }
    if (method === 'POST' && route.endsWith('/adoptions/adoption/success')) {
      calls.successRequests.push(input!)
      const operationKey = String(input!.idempotencyKey)
      let result = records.get(operationKey)
      if (!result) { calls.successEffects++; result = { id: 'adoption', status: 'succeeded', targetConfirmationId: input!.targetConfirmationId }; records.set(operationKey, result) }
      if (failures.successResponse) { failures.successResponse = false; throw new Error('success response lost') }
      return result
    }
    if (method === 'POST' && route.endsWith('/integrations')) {
      const prepared = input as unknown as PrepareIntegrationRequest; calls.prepared.push(prepared)
      assert.notEqual(prepared.stage, 'template', 'material workflow must not publish project configuration')
      if (prepared.stage === 'template') throw new Error('Unexpected template integration')
      const materials = new Map<string, MaterialMetadata>()
      for (const confirmation of prepared.confirmations) {
        const target = remote.entities.find(entity => entity.id === confirmation.entityId) as EntityView
        const fixedDraft = await readMaterial(worktree, target.kind, target.id)
        assert.equal(fixedDraft.sha256, confirmation.fixed.sha256, 'backend verification reads the exact fixed material bytes')
        assert.equal('metadata' in confirmation, false, 'confirmation controls cannot carry business content')
        materials.set(confirmation.entityId, fixedDraft.metadata)
      }
      validateIntegration(project, remote.entities as EntityView[], { id: 1 } as never, prepared, materials)
      const saved = { id: `integration-${prepared.idempotencyKey}`, entityId: value.id, ownerId: 1, status: failures.pendingIntegration ? 'prepared' as const : 'accepted' as const, sourceSha: prepared.sourceSha, expectedHead: prepared.expectedHead, candidateSha: prepared.candidateSha, stage: prepared.stage, confirmationIds: prepared.confirmations.map(item => 'confirmed-' + item.entityId), createdAt: '' }
      remote.integrations.push(saved); records.set(prepared.idempotencyKey, saved)
      if (saved.status === 'accepted' && prepared.stage !== 'prototype') for (const item of prepared.confirmations) {
        const changed = remote.entities.find(e => e.id === item.entityId) as EntityView
        changed.current = { version: changed.materialVersion + 1, fixed: item.fixed, metadata: materials.get(item.entityId)!, confirmationId: 'confirmed-' + item.entityId, confirmedBy: 1, confirmedAt: '', reuse: { enabled: true, reason: '' } }; changed.materialVersion++; delete changed.occupation
      }
      if (failures.integrationResponse) { failures.integrationResponse = false; throw new Error('integration response lost') }
      return saved
    }
    throw new Error('Unexpected request: ' + method + ' ' + route)
  } } as unknown as CollaborationClient
  const ports = { account: async () => ({ id: 1, name: '作者', gitlabUsername: 'author', gitlabEmail: 'author@example.invalid' }), stopPreview: async () => {},
    session: async (task: { sessionId: string }) => { calls.sessions.push(task.sessionId); if (failures.session) { failures.session = false; throw new Error('session failed') }; return task.sessionId },
    prompt: async (session: string, text: string) => { calls.prompts.push(session + ':' + text); if (failures.prompt) { failures.prompt = false; throw new Error('prompt failed') } },
    checks: async (_task: unknown, sha: string) => ({ candidateSha: sha, passed: true, checks: [{ name: 'engineering', passed: true, evidenceHash: digest('checked') }] }),
    gitLocal: async () => gitState.dirtyFiles.map(file => ' M ' + file + '\0').join(''),
    git: { hasCommit: async () => true, commitFiles: async (_directory: string, files: readonly string[]) => { calls.commits.push(files); gitState.head = candidate; gitState.changedFiles = [...new Set([...gitState.changedFiles, ...files])]; gitState.dirtyFiles = []; return candidate }, verifyFile: async () => {}, push: async (_root: string, commit: string, branch: string) => { calls.pushes.push(commit + ':' + branch); if (failures.push) { failures.push = false; throw new Error('push response lost') } }, remoteHead: async () => gitState.remote, conditionalUpdate: async () => { calls.conditionalUpdates++ }, fetch: async () => {}, merge: async () => { gitState.head = 'd'.repeat(40); project.recognizedHead = gitState.remote; failures.pendingIntegration = false; return { status: 'merged' as const, commit: gitState.head } }, fetchCommit: async () => {}, readBlob: async (_directory: string, _sha: string, file: string) => { const { readFile } = await import('node:fs/promises'); return readFile(path.join(_directory === sourceDirectory ? sourceDirectory : worktree, file)) }, changedFiles: async () => gitState.changedFiles, state: async (directory: string) => { if (directory === worktree) return { head: gitState.head, dirty: gitState.dirtyFiles.length > 0 }; await stat(directory); return { head: reviewTrees.get(directory), dirty: false } }, createWorktree: async (_root: string, directory: string, _branch: string, sha: string) => { if (!directory.includes(path.sep + 'reviews' + path.sep)) throw new Error('prototype intentionally not started'); await cp(worktree, directory, { recursive: true }); reviewTrees.set(directory, sha) } },
  } as unknown as HostPorts
  const app = (nextStore = store) => { const created = new StudioApplication(nextStore, api, ports); apps.push(created); return created }
  const settle = async () => { for (const created of apps) await created.settle() }
  const adopt = { action: 'adopt' as const, sourceProjectId: 'source-project', sourceEntityId: 'source', version: 2, targetEntityId: value.id, reason: '依据目标业务调整验收条件' }
  return { root, store, local, value, worktree, remote, source, sourceDirectory, calls, failures, gitState, app, settle, adopt, api, ports }
}

test('author handoff acknowledgement uses the actual API receipt route and current confirmation', async t => {
  const f = await fixture(t, 'handoff'), app = f.app()
  const Fastify = createRequire(new URL('../../apps/collaboration-api/package.json', import.meta.url))('fastify')
  const server = Fastify({ ajv: { customOptions: { removeAdditional: false } } })
  t.after(() => server.close())
  const receipts: Array<{ projectId: string; entityId: string; input: unknown }> = []
  registerRoutes(server, { auth: { authenticate: async () => ({ id: 1 }) }, receipt: async (_actor: unknown, projectId: string, entityId: string, input: unknown) => { receipts.push({ projectId, entityId, input }); return { id: 'receipt' } } } as never,
    loadConfig({ DATABASE_URL: 'postgresql://synthetic', PG_SSL: 'disable', GITLAB_URL: 'http://gitlab.test', GITLAB_ALLOW_HTTP: 'true', SEI_GITLAB_TOKEN: 'synthetic' }))
  const routed = new CollaborationClient('http://route.test', async () => 'synthetic', undefined, async (url, options) => {
    const response = await server.inject({ method: options!.method, url: new URL(String(url)).pathname, headers: options!.headers, payload: options!.body })
    return new Response(response.payload, { status: response.statusCode, headers: { 'content-type': 'application/json' } })
  })
  const original = f.api.request.bind(f.api)
  f.api.request = (method, route, input) => method === 'POST' ? routed.request(method, route, input) : original(method, route, input)
  assert.equal((await app.command({ action: 'acknowledgeHandoff', entityId: f.value.id, note: '已核对固定资料' })).ok, false)
  f.value.current = { ...f.source, confirmationId: 'confirmed-handoff' }
  const reply = await app.command({ action: 'acknowledgeHandoff', entityId: f.value.id, note: '已核对固定资料' })
  assert.equal(reply.ok, true, JSON.stringify(reply))
  assert.equal(receipts.length, 1); assert.equal(receipts[0]!.entityId, f.value.id)
  assert.equal((receipts[0]!.input as { confirmationId: string }).confirmationId, 'confirmed-handoff')
})

test('adoption success binds the accepted target confirmation and survives a lost response without duplicate acceptance', async t => {
  const f = await fixture(t)
  f.failures.adoptionResponse = true
  assert.equal((await f.app().command(f.adopt)).ok, false)
  const rebooted = new StudioStore(path.join(f.root, 'state')); rebooted.useUser(1)
  const app = f.app(rebooted)
  assert.equal((await app.command(f.adopt)).ok, true)
  assert.equal(f.calls.adoptions, 1, 'restart must resolve the original adoption instead of accepting a new record')
  const draft = await readMaterial(f.worktree, 'requirement', f.value.id)
  const checked = await saveMaterial(f.worktree, { ...draft.metadata, coreRulesPresent: true, acceptanceCriteriaPresent: true }, draft.body)
  f.failures.successResponse = true
  const confirmed = await app.command({ action: 'confirmMaterial', entityId: f.value.id, expectedHash: checked.sha256, method: 'direct' })
  assert.equal(confirmed.ok, true, JSON.stringify(confirmed))
  assert.equal((await rebooted.read()).scenarios.find(record => record.entityId === f.value.id)?.requirementConfirmation?.message, undefined)
  // The confirmation is recorded before its Git publication finishes; the lost
  // acknowledgement surfaces on the operation the surfaces render.
  await app.settle()
  const pending = (await rebooted.read()).operations[0]!
  assert.equal(pending.phase, 'accepted', 'the target confirmation remains accepted if success acknowledgement is lost')
  const second = new StudioStore(path.join(f.root, 'state')); second.useUser(1)
  const retry = f.app(second)
  assert.equal((await retry.command({ action: 'retryOperation', operationId: pending.id })).ok, true)
  await retry.settle()
  assert.equal(f.calls.successEffects, 1)
  assert.equal(f.calls.successRequests.length, 2)
  assert.deepEqual(f.calls.successRequests[0], f.calls.successRequests[1], 'retries retain the exact confirmation and idempotency key')
})

test('a lost push acknowledgement is repeated by the persisted operation retry', async t => {
  const f = await fixture(t), app = f.app()
  f.failures.push = true
  const draft = await readMaterial(f.worktree, 'requirement', f.value.id)
  assert.equal((await app.command({ action: 'confirmMaterial', entityId: f.value.id, expectedHash: draft.sha256, method: 'direct' })).ok, true)
  await app.settle()
  const operation = (await f.store.read()).operations[0]!
  assert.equal(operation.phase, 'unknown')
  assert.equal(f.calls.prepared.length, 0)
  assert.equal((await app.command({ action: 'retryOperation', operationId: operation.id })).ok, true)
  await app.settle()
  assert.equal(f.calls.pushes.length, 2, 'recovery repeats the idempotent candidate push before preparing')
  assert.equal(f.calls.prepared.length, 1)
  assert.equal((await f.store.read()).operations[0]!.phase, 'accepted')
})

test('a lost integration response resolves the original operation on retry without a second prepare', async t => {
  const f = await fixture(t), app = f.app()
  f.failures.integrationResponse = true
  const draft = await readMaterial(f.worktree, 'requirement', f.value.id)
  assert.equal((await app.command({ action: 'confirmMaterial', entityId: f.value.id, expectedHash: draft.sha256, method: 'direct' })).ok, true)
  await app.settle()
  const operation = (await f.store.read()).operations[0]!
  assert.equal(operation.phase, 'unknown')
  assert.equal(f.calls.prepared.length, 1)
  assert.equal((await app.command({ action: 'retryOperation', operationId: operation.id })).ok, true)
  await app.settle()
  assert.equal(f.calls.prepared.length, 1, 'retry queries the original operation instead of preparing again')
  assert.equal((await f.store.read()).operations[0]!.phase, 'accepted')
})

/** External adapters that let an accepted requirement open its fixed prototype task. */
function enablePrototypeStartup(f: Awaited<ReturnType<typeof fixture>>): void {
  const request = f.api.request.bind(f.api)
  f.api.request = async (method, route, input?: Record<string, unknown>) => {
    if (method === 'POST' && route.endsWith('/claim')) {
      f.value.revision++; f.value.generation++
      f.value.occupation = { occupationId: 'prototype-occupation', generation: f.value.generation, taskId: String(input!.taskId), clientId: String(input!.clientId), expectedRevision: f.value.revision,
        entityId: f.value.id, ownerId: 1, purpose: 'prototype', inputVersion: f.value.materialVersion, prerequisiteBindings: [], createdAt: '' }
      return structuredClone(f.value)
    }
    return request(method, route, input)
  }
  f.ports.git.createWorktree = async (_root, directory) => { await cp(f.worktree, directory, { recursive: true }) }
}

test('an unknown prototype send keeps material acceptance and is not resent by confirmation recovery or restart', async t => {
  const f = await fixture(t)
  enablePrototypeStartup(f)
  f.failures.prompt = true
  const app = f.app(), draft = await readMaterial(f.worktree, 'requirement', f.value.id)
  assert.equal((await app.command({ action: 'confirmMaterial', entityId: f.value.id, expectedHash: draft.sha256, method: 'direct' })).ok, true)
  await app.settle()
  const operation = f.local.operations[0]!, startup = f.local.tasks.find(task => task.purpose === 'material')!.prototypeStart!
  assert.equal(operation.phase, 'accepted'); assert.equal(operation.accepted!.status, 'accepted')
  assert.equal(operation.message, undefined); assert.equal(operation.deliveryMessage, undefined)
  assert.equal(startup.status, 'unknown'); assert.ok(startup.task)
  assert.equal(f.calls.prompts.length, 1)
  await app.command({ action: 'retryOperation', operationId: operation.id }); await app.settle()
  const store = new StudioStore(path.join(f.root, 'state')); store.useUser(1)
  const restarted = f.app(store)
  await restarted.command({ action: 'retryOperation', operationId: operation.id }); await restarted.settle()
  assert.equal(f.calls.prepared.length, 1, 'follow-up recovery never prepares another confirmation')
  assert.equal(f.calls.prompts.length, 1, 'a missing send acknowledgement is not permission to send again')
  const pending = await restarted.command({ action: 'state' })
  assert.ok(pending.ok && pending.state.pending.some(value => value.id === startup.id && value.phase === 'prototype-startup'))
})

test('a failed final startup receipt never makes an already sent prototype prompt retryable', async t => {
  const f = await fixture(t)
  enablePrototypeStartup(f)
  const save = f.store.save.bind(f.store)
  let lostReceipt = false
  f.store.save = async () => {
    if (!lostReceipt && f.local.tasks.some(task => task.prototypeStart?.status === 'sent')) { lostReceipt = true; throw new Error('startup receipt write failed') }
    await save()
  }
  const app = f.app(), draft = await readMaterial(f.worktree, 'requirement', f.value.id)
  await app.command({ action: 'confirmMaterial', entityId: f.value.id, expectedHash: draft.sha256, method: 'direct' }); await app.settle()
  const operation = f.local.operations[0]!, startup = f.local.tasks.find(task => task.purpose === 'material')!.prototypeStart!
  assert.equal(lostReceipt, true); assert.equal(startup.status, 'unknown'); assert.equal(operation.phase, 'accepted')
  assert.equal(f.calls.prompts.length, 1)
  await app.command({ action: 'retryOperation', operationId: operation.id }); await app.settle()
  const rebooted = new StudioStore(path.join(f.root, 'state')); rebooted.useUser(1)
  const restarted = f.app(rebooted)
  await restarted.command({ action: 'retryOperation', operationId: operation.id }); await restarted.settle()
  assert.equal(f.calls.prompts.length, 1)
  assert.equal(f.calls.prepared.length, 1)
})

test('an old automatic prototype startup cannot cancel a later explicit design occupation', async t => {
  const f = await fixture(t), app = f.app(), draft = await readMaterial(f.worktree, 'requirement', f.value.id)
  await app.command({ action: 'confirmMaterial', entityId: f.value.id, expectedHash: draft.sha256, method: 'direct' }); await app.settle()
  const operation = f.local.operations[0]!, original = f.local.tasks.find(task => task.purpose === 'material')!, startup = original.prototypeStart!
  assert.equal(operation.phase, 'accepted'); assert.equal(startup.status, 'blocked')
  const worktree = path.join(f.root, 'new-revision'); await cp(f.worktree, worktree, { recursive: true })
  const next = { ...original, worktree, sessionId: 'new-revision-session' }; delete next.cleanup; delete next.prototypeStart
  f.local.tasks.push(next)
  f.value.revision++; f.value.generation++
  f.value.occupation = { occupationId: 'new-design', generation: f.value.generation, taskId: 'new-revision', clientId: f.local.clientId, expectedRevision: f.value.revision,
    entityId: f.value.id, ownerId: 1, purpose: 'design', inputVersion: f.value.materialVersion, prerequisiteBindings: [], createdAt: '' }
  const expected = structuredClone(f.value.occupation), request = f.api.request.bind(f.api)
  const controls: string[] = []
  f.api.request = async (method, route, input) => {
    if (method === 'POST' && /\/(cancel|claim)$/.test(route)) controls.push(route)
    return request(method, route, input)
  }
  await f.store.save()
  await app.command({ action: 'retryOperation', operationId: startup.id }); await app.settle()
  assert.deepEqual(controls, []); assert.deepEqual(f.value.occupation, expected)
  assert.equal(next.cleanup, undefined); assert.equal(startup.status, 'blocked'); assert.match(startup.message!, /设计占用/)
  assert.equal(operation.phase, 'accepted'); assert.equal(f.calls.prepared.length, 1)
})

test('switching accounts during prototype preparation never creates or saves a task in the new account', { timeout: 5000 }, async t => {
  const f = await fixture(t)
  enablePrototypeStartup(f)
  let accountId = 1, reached!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { reached = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  f.ports.account = async () => ({ id: accountId, name: '作者', gitlabUsername: 'author', gitlabEmail: 'author@example.invalid' }) as Awaited<ReturnType<HostPorts['account']>>
  const hasCommit = f.ports.git.hasCommit.bind(f.ports.git), createWorktree = f.ports.git.createWorktree.bind(f.ports.git)
  const created: string[] = []
  f.ports.git.hasCommit = async (directory, sha) => {
    if (directory === f.root && f.value.occupation?.purpose === 'prototype') { reached(); await gate }
    return hasCommit(directory, sha)
  }
  f.ports.git.createWorktree = async (directory, worktree, branch, sha) => { created.push(worktree); await createWorktree(directory, worktree, branch, sha) }
  const app = f.app(), draft = await readMaterial(f.worktree, 'requirement', f.value.id)
  const reply = await app.command({ action: 'confirmMaterial', entityId: f.value.id, expectedHash: draft.sha256, method: 'direct' })
  assert.equal(reply.ok, true)
  await entered
  accountId = 2; f.store.useUser(2)
  const other = await f.store.read()
  release(); await app.settle()
  assert.deepEqual(created, []); assert.deepEqual(other.tasks, []); assert.deepEqual(other.projects, [])
  assert.equal(f.local.tasks.filter(task => task.purpose === 'prototype').length, 0)
  assert.equal(f.calls.sessions.length, 0); assert.equal(f.calls.prompts.length, 0)
  assert.equal(f.local.operations[0]!.phase, 'accepted')
})

test('same-named accepted operations in two projects start their own prototypes exactly once', async t => {
  const f = await fixture(t)
  enablePrototypeStartup(f)
  const app = f.app(), draft = await readMaterial(f.worktree, 'requirement', f.value.id)
  await app.command({ action: 'confirmMaterial', entityId: f.value.id, expectedHash: draft.sha256, method: 'direct' }); await app.settle()
  const original = f.local.tasks.find(task => task.purpose === 'material')!, first = f.local.operations[0]!
  assert.equal(original.prototypeStart!.status, 'sent'); assert.equal(f.calls.prompts.length, 1)
  const directory = path.join(f.root, 'second-project'), worktree = path.join(directory, 'task')
  await cp(f.worktree, worktree, { recursive: true })
  const task = { ...structuredClone(original), projectId: 'second-project', worktree, sessionId: 'second-material-session' }
  delete task.prototypeStart; delete task.cleanup; delete task.error
  const entity = structuredClone(f.value); delete entity.occupation
  entity.current!.confirmationId = 'second-confirmation'
  const project = { ...f.remote.project, id: 'second-project', name: '第二项目', recognizedHead: candidate }
  const operation = { ...structuredClone(first), projectId: project.id, task: { projectId: project.id, entityId: task.entityId, worktree, sessionId: task.sessionId, purpose: task.purpose, inputHash: task.inputHash } }
  operation.integrationId = 'second-integration'; operation.accepted!.id = operation.integrationId; operation.accepted!.confirmationIds = ['second-confirmation']
  const remote: ProjectState = { project, entities: [entity], integrations: [operation.accepted!], baselines: [] }
  f.local.projects.push({ id: project.id, name: project.name, directory, repositoryUrl: project.repositoryUrl })
  f.local.tasks.push(task); f.local.operations.push(operation)
  const request = f.api.request.bind(f.api)
  f.api.request = async (method, route, input?: Record<string, unknown>) => {
    if (method === 'GET' && route === '/v1/projects') return [f.remote.project, project]
    if (method === 'GET' && route === '/v1/projects/second-project') return remote
    if (method === 'POST' && route === '/v1/projects/second-project/entities/target/claim') {
      entity.revision++; entity.generation++
      entity.occupation = { occupationId: 'second-prototype', generation: entity.generation, taskId: String(input!.taskId), clientId: f.local.clientId, expectedRevision: entity.revision,
        entityId: entity.id, ownerId: 1, purpose: 'prototype', inputVersion: entity.materialVersion, prerequisiteBindings: [], createdAt: '' }
      return structuredClone(entity)
    }
    return request(method, route, input)
  }
  await f.store.save(); await app.command({ action: 'state' }); await app.settle()
  assert.equal(task.prototypeStart!.status, 'sent')
  assert.notEqual(task.prototypeStart!.id, original.prototypeStart!.id)
  assert.equal(f.calls.sessions.length, 2); assert.equal(f.calls.prompts.length, 2)
  await app.command({ action: 'retryOperation', operationId: task.prototypeStart!.id }); await app.settle()
  assert.equal(f.calls.prepared.length, 1); assert.equal(f.calls.prompts.length, 2)
})

test('a moved remote head rebuilds and accepts a merged candidate without rewriting the diverged branch', async t => {
  const f = await fixture(t), app = f.app()
  f.failures.pendingIntegration = true
  f.gitState.remote = 'c'.repeat(40)
  const draft = await readMaterial(f.worktree, 'requirement', f.value.id)
  assert.equal((await app.command({ action: 'confirmMaterial', entityId: f.value.id, expectedHash: draft.sha256, method: 'direct' })).ok, true)
  await app.settle()
  const operations = (await f.store.read()).operations
  assert.equal(operations.length, 2)
  assert.equal(operations[0]!.phase, 'superseded')
  assert.equal(operations[1]!.phase, 'accepted', operations[1]!.message)
  assert.equal(operations[1]!.id, `m-${'d'.repeat(40)}`)
  assert.equal(f.calls.prepared[1]!.confirmations[0]!.readHash, draft.sha256)
  assert.equal(f.calls.conditionalUpdates, 0, 'a moved remote head is never force-updated')
  assert.equal(f.calls.prepared.length, 2)
})

test('accepted handoff generation is durable per fixed baseline and never overwrites author edits on retry', async t => {
  const f = await fixture(t, 'handoff')
  f.value.title = '交接 requirement v2'
  const requirement = entity('requirement'); requirement.materialVersion = 2
  f.remote.entities.push(requirement)
  f.remote.baselines.push({ id: 'baseline', entityId: requirement.id, version: 2, commitSha: candidate, confirmationId: 'completed', createdAt: '' })
  assert.equal((await f.app().command({ action: 'generateHandoff', baselineId: 'baseline' })).ok, true)
  const generated = await readMaterial(f.worktree, 'handoff', f.value.id)
  await saveMaterial(f.worktree, generated.metadata, '作者修改必须保留\n' + body)
  const rebooted = new StudioStore(path.join(f.root, 'state')); rebooted.useUser(1)
  assert.equal((await f.app(rebooted).command({ action: 'generateHandoff', baselineId: 'baseline' })).ok, true)
  assert.match((await readMaterial(f.worktree, 'handoff', f.value.id)).body, /作者修改必须保留/)
  assert.equal(f.calls.prompts.length, 1)
})

test('scenario confirmation fixes only the scenario material and leaves related requirements untouched', async t => {
  const f = await fixture(t, 'scenario')
  f.value.materialVersion = 1; f.value.occupation!.inputVersion = 1
  const unstarted = entity('unstarted'), completed = entity('completed'), unrelated = entity('unrelated')
  for (const requirement of [unstarted, completed, unrelated]) requirement.scenarioIds = [f.value.id]
  completed.materialVersion = 2; completed.completedVersion = 2
  f.remote.entities.push(unstarted, completed, unrelated)
  const draft = await readMaterial(f.worktree, 'scenario', f.value.id)
  const reply = await f.app().command({ action: 'confirmMaterial', entityId: f.value.id, expectedHash: draft.sha256, method: 'direct' })
  assert.equal(reply.ok, true, JSON.stringify(reply))
  const request = f.calls.prepared[0]!
  assert.equal(request.stage, 'material')
  assert.deepEqual(request.confirmations.map(item => item.entityId), ['target'])
  assert.deepEqual([...f.calls.commits[0]!].sort(), [evidencePath, '场景/target.md'].sort())
  assert.ok(request.confirmations.every(item => item.fixed.commitSha === candidate))
})

test('a blocked scenario confirmation retains its original saved input after an external correction', async t => {
  const f = await fixture(t, 'scenario'), app = f.app()
  const draft = await readMaterial(f.worktree, 'scenario', f.value.id)
  const blocked = await saveMaterial(f.worktree, { ...draft.metadata, coreRulesPresent: false }, '作者原始正文\n' + body)
  assert.equal((await app.command({ action: 'confirmMaterial', entityId: f.value.id, expectedHash: blocked.sha256, method: 'direct' })).ok, false)
  const original = f.local.scenarios.find(record => record.entityId === f.value.id)!.materialConfirmations![0]!
  assert.equal(original.phase, 'recovery'); assert.equal(original.request.body, blocked.body)
  await saveMaterial(f.worktree, { ...blocked.metadata, coreRulesPresent: true }, '外部修正正文\n' + body)
  await app.command({ action: 'retryOperation', operationId: original.operationId }); await app.settle()
  assert.equal(original.request.body, blocked.body); assert.equal(original.request.metadata!.coreRulesPresent, false)
  assert.equal(original.request.expectedHash, blocked.sha256); assert.equal(original.phase, 'recovery')
  assert.equal(f.calls.prepared.length, 0, 'an old confirmation cannot silently adopt the externally corrected bytes')
})


test('a requirement material session receives the shared read-only design context', async t => {
  const f = await fixture(t), app = f.app()
  const context = await app.scenarioSessionContext(f.local.tasks[0]!)
  assert.match(context.text, /当前需求 target/)
  assert.match(context.text, /回答规则：先用可读中文归纳本轮明确结论/)
  assert.match(context.text, /核心业务规则/)
  assert.deepEqual(context.readPaths, [], 'requirement context never grants paths outside its worktree')
})

test('an adoption acknowledgement cannot overwrite a target edited while its response was lost', async t => {
  const f = await fixture(t)
  f.failures.adoptionResponse = true
  assert.equal((await f.app().command(f.adopt)).ok, false)
  const original = await readMaterial(f.worktree, 'requirement', f.value.id)
  await saveMaterial(f.worktree, original.metadata, '作者保留的新内容\n' + body)
  const rebooted = new StudioStore(path.join(f.root, 'state')); rebooted.useUser(1)
  assert.equal((await f.app(rebooted).command(f.adopt)).ok, false)
  assert.equal(f.calls.adoptions, 1)
  assert.match((await readMaterial(f.worktree, 'requirement', f.value.id)).body, /作者保留的新内容/)
  assert.equal(f.calls.successEffects, 0)
})

test('a confirmed target without the exact adopted source cannot report reuse success', async t => {
  const f = await fixture(t)
  assert.equal((await f.app().command(f.adopt)).ok, true)
  const draft = await readMaterial(f.worktree, 'requirement', f.value.id)
  const checked = await saveMaterial(f.worktree, { ...draft.metadata, sources: draft.metadata.sources.filter(source => source.projectId === 'project' && draft.metadata.scenarioIds.includes(source.entityId)), coreRulesPresent: true, acceptanceCriteriaPresent: true }, draft.body)
  assert.equal((await f.app().command({ action: 'confirmMaterial', entityId: f.value.id, expectedHash: checked.sha256, method: 'direct' })).ok, true)
  assert.equal(f.calls.successEffects, 0)
})

for (const failure of ['session', 'prompt'] as const) test('failed handoff ' + failure + ' retries its fixed task without replacing author content', async t => {
  const f = await fixture(t, 'handoff')
  f.value.title = '交接 requirement v2'
  const requirement = entity('requirement'); requirement.materialVersion = 2
  f.remote.entities.push(requirement)
  f.remote.baselines.push({ id: 'baseline', entityId: requirement.id, version: 2, commitSha: candidate, confirmationId: 'completed', createdAt: '' })
  f.failures[failure] = true
  assert.equal((await f.app().command({ action: 'generateHandoff', baselineId: 'baseline' })).ok, false)
  const draft = await readMaterial(f.worktree, 'handoff', f.value.id)
  await saveMaterial(f.worktree, draft.metadata, '失败后作者补充\n' + body)
  const rebooted = new StudioStore(path.join(f.root, 'state')); rebooted.useUser(1)
  assert.equal((await f.app(rebooted).command({ action: 'generateHandoff', baselineId: 'baseline' })).ok, true)
  assert.match((await readMaterial(f.worktree, 'handoff', f.value.id)).body, /失败后作者补充/)
  assert.ok(f.calls.sessions.every(id => id === 'material-session'))
})

test('a related requirement without local material does not block scenario confirmation', async t => {
  const f = await fixture(t, 'scenario')
  f.value.materialVersion = 1; f.value.occupation!.inputVersion = 1
  const missing = entity('missing'); missing.scenarioIds = [f.value.id]
  f.remote.entities.push(missing)
  const draft = await readMaterial(f.worktree, 'scenario', f.value.id)
  assert.equal((await f.app().command({ action: 'confirmMaterial', entityId: f.value.id, expectedHash: draft.sha256, method: 'direct' })).ok, true)
  assert.deepEqual(f.calls.prepared[0]!.confirmations.map(item => item.entityId), ['target'])
})

test("a requirement under another owner's design occupation is read-only and refuses edits", async t => {
  const f = await fixture(t, 'scenario')
  const related = entity('related'); related.scenarioIds = [f.value.id]
  related.occupation = { occupationId: 'foreign', generation: 1, taskId: 'foreign-task', clientId: f.local.clientId, expectedRevision: 1, entityId: related.id, ownerId: 2, purpose: 'design', inputVersion: 0, prerequisiteBindings: [], createdAt: '' }
  f.remote.entities.push(related)
  const app = f.app()
  const state = await app.state()
  assert.equal(state.materialSources!.find(value => value.entityId === related.id)!.readOnly, true)
  const draft = await readMaterial(f.worktree, 'scenario', f.value.id)
  assert.equal((await app.command({ action: 'saveMaterial', entityId: related.id, metadata: { ...metadata(related), entityId: related.id }, body })).ok, false)
  assert.equal(related.occupation!.ownerId, 2)
  assert.equal((await readMaterial(f.worktree, 'scenario', f.value.id)).sha256, draft.sha256)
})


const reviewReport = (summary = '固定候选符合业务依据，作者仍需检查并确认。') => String.fromCharCode(96).repeat(3) + 'eadp-review\n' + JSON.stringify({ summary, findings: [{ severity: 'warning', message: '请作者核对异常分支的使用限制。' }] }) + '\n' + String.fromCharCode(96).repeat(3)

test('an author-requested material review binds the local snapshot without committing and only explicit author confirmation submits its hashes', async t => {
  const f = await fixture(t), app = f.app()
  const requested = await app.command({ action: 'requestReview', entityId: f.value.id, purpose: 'material' })
  assert.equal(requested.ok, true, JSON.stringify(requested))
  const review = (await f.store.read()).reviews[0]!
  assert.notEqual(review.task.worktree, f.worktree)
  assert.equal(review.task.purpose, 'review')
  assert.equal(review.head, head, 'the review binds the local HEAD')
  assert.equal(f.gitState.head, head, 'requesting a review leaves Git history unchanged')
  assert.equal(f.calls.commits.length, 0, 'requesting a review creates no candidate commit')
  await app.acceptSessionOutput(review.task.sessionId, { kind: 'assistant', content: reviewReport() })
  await app.acceptSessionOutput(review.task.sessionId, { kind: 'turn-ended', reason: 'completed' })
  assert.equal(f.calls.prepared.length, 0, 'AI output cannot author-confirm or integrate')
  const draft = await readMaterial(f.worktree, 'requirement', f.value.id)
  const reply = await app.command({ action: 'confirmMaterial', entityId: f.value.id, expectedHash: draft.sha256, method: 'ai-assisted', reviewId: review.id, authorDisposition: '已核对异常分支并在交付限制中保留说明。' })
  assert.equal(reply.ok, true, JSON.stringify(reply))
  assert.equal((await f.store.read()).scenarios.find(record => record.entityId === f.value.id)?.materialConfirmations?.at(-1)?.message, undefined)
  const confirmation = f.calls.prepared[0]!.confirmations[0]!
  assert.equal(confirmation.confirmationMethod, 'ai-assisted')
  if (confirmation.confirmationMethod === 'ai-assisted') {
    assert.deepEqual(confirmation.reviewEvidence, { candidateSha: candidate, inputHash: review.inputHash, reportHash: digest(reviewReport()), dispositionHash: digest('已核对异常分支并在交付限制中保留说明。') })
  }
  assert.equal(JSON.stringify(f.calls.prepared).includes('请作者核对异常分支'), false)
  assert.equal(f.calls.commits.length, 1, 'confirmation creates the reviewed candidate once')
})

test('a review report is rejected when the fixed snapshot bytes change', async t => {
  const f = await fixture(t), app = f.app()
  assert.equal((await app.command({ action: 'requestReview', entityId: f.value.id, purpose: 'material' })).ok, true)
  const review = (await f.store.read()).reviews[0]!
  const draft = await readMaterial(review.task.worktree, 'requirement', f.value.id)
  await writeFile(path.join(review.task.worktree, draft.path), '被改动的评审快照\n')
  await assert.rejects(app.acceptSessionOutput(review.task.sessionId, { kind: 'assistant', content: reviewReport() }), /快照已变化/)
  assert.equal((await f.store.read()).reviews[0]!.status, 'failed')
  assert.equal(f.calls.prepared.length, 0)
})

test('direct confirmation remains available after a pending review freezes a clean candidate', async t => {
  const f = await fixture(t), app = f.app()
  assert.equal((await app.command({ action: 'requestReview', entityId: f.value.id, purpose: 'material' })).ok, true)
  const draft = await readMaterial(f.worktree, 'requirement', f.value.id)
  assert.equal((await app.command({ action: 'confirmMaterial', entityId: f.value.id, expectedHash: draft.sha256, method: 'direct' })).ok, true)
  assert.equal(f.calls.prepared[0]!.confirmations[0]!.confirmationMethod, 'direct')
  assert.equal(f.calls.commits.length, 1)
})

test('AI-assisted confirmation rejects pending output and blank author disposition without integration', async t => {
  const f = await fixture(t), app = f.app()
  await app.command({ action: 'requestReview', entityId: f.value.id, purpose: 'material' })
  const review = (await f.store.read()).reviews[0]!, draft = await readMaterial(f.worktree, 'requirement', f.value.id)
  assertConfirmationRecovery(await app.command({ action: 'confirmMaterial', entityId: f.value.id, expectedHash: draft.sha256, method: 'ai-assisted', reviewId: review.id, authorDisposition: '已自行检查' }))
  await app.acceptSessionOutput(review.task.sessionId, { kind: 'assistant', content: reviewReport() })
  await app.acceptSessionOutput(review.task.sessionId, { kind: 'turn-ended', reason: 'completed' })
  assertConfirmationRecovery(await app.command({ action: 'confirmMaterial', entityId: f.value.id, expectedHash: draft.sha256, method: 'ai-assisted', reviewId: review.id, authorDisposition: '   ' }))
  assert.equal(f.calls.prepared.length, 0)
})

test('changing author material after review invalidates the original report and preserves the fixed review snapshot', async t => {
  const f = await fixture(t), app = f.app()
  await app.command({ action: 'requestReview', entityId: f.value.id, purpose: 'material' })
  const review = (await f.store.read()).reviews[0]!
  await app.acceptSessionOutput(review.task.sessionId, { kind: 'assistant', content: reviewReport() })
  await app.acceptSessionOutput(review.task.sessionId, { kind: 'turn-ended', reason: 'completed' })
  const original = await readMaterial(f.worktree, 'requirement', f.value.id)
  const changed = await saveMaterial(f.worktree, original.metadata, original.body + '\n作者新增业务规则。')
  f.gitState.dirtyFiles = [changed.path]
  assertConfirmationRecovery(await app.command({ action: 'confirmMaterial', entityId: f.value.id, expectedHash: changed.sha256, method: 'ai-assisted', reviewId: review.id, authorDisposition: '确认旧评审' }))
  assert.equal((await readMaterial(review.task.worktree, 'requirement', f.value.id)).sha256, original.sha256)
  assert.equal(f.calls.prepared.length, 0)
})

test('duplicate review requests recover the same local report across Host restart and reject AI self-confirm fields', async t => {
  const f = await fixture(t), app = f.app()
  await app.command({ action: 'requestReview', entityId: f.value.id, purpose: 'material' })
  const review = (await f.store.read()).reviews[0]!
  const rebooted = new StudioStore(path.join(f.root, 'state')); rebooted.useUser(1)
  const next = f.app(rebooted)
  assert.equal((await next.command({ action: 'requestReview', entityId: f.value.id, purpose: 'material' })).ok, true)
  assert.equal(f.calls.prompts.length, 1)
  assert.equal((await rebooted.read()).reviews.length, 1)
  await assert.rejects(next.acceptSessionOutput(review.task.sessionId, { kind: 'assistant', content: String.fromCharCode(96).repeat(3) + 'eadp-review\n' + JSON.stringify({ summary: 'AI self approval', findings: [], authorConfirmed: true }) + '\n' + String.fromCharCode(96).repeat(3) }), /格式无效/)
  assert.equal((await rebooted.read()).reviews[0]!.status, 'failed')
  assert.equal(f.calls.prepared.length, 0)
})

async function prototypeFixture(t: test.TestContext) {
  const f = await fixture(t)
  const draft = await readMaterial(f.worktree, 'requirement', f.value.id)
  f.value.materialVersion = 1; f.value.confirmationStatus = 'confirmed'; f.value.current = { version: 1, fixed: { commitSha: head, path: draft.path, sha256: draft.sha256 }, metadata: draft.metadata, confirmationId: 'requirement-confirmation', confirmedBy: 1, confirmedAt: '', reuse: { enabled: true, reason: '' } }
  f.value.occupation!.purpose = 'prototype'; f.value.occupation!.inputVersion = 1
  f.local.tasks[0]!.purpose = 'prototype'; f.local.tasks[0]!.inputHash = draft.sha256
  await mkdir(path.join(f.worktree, '原型代码/src'), { recursive: true }); await writeFile(path.join(f.worktree, '原型代码/src/page.tsx'), 'export default () => null')
  f.gitState.dirtyFiles = ['原型代码/src/page.tsx']; await f.store.save()
  return f
}

test('prototype AI review binds the confirmed input and uses the same completion pipeline as direct author confirmation', async t => {
  const f = await prototypeFixture(t), app = f.app()
  assert.equal((await app.command({ action: 'requestReview', entityId: f.value.id, purpose: 'prototype' })).ok, true)
  const review = (await f.store.read()).reviews[0]!
  await app.acceptSessionOutput(review.task.sessionId, { kind: 'assistant', content: reviewReport('原型固定候选已检查。') })
  await app.acceptSessionOutput(review.task.sessionId, { kind: 'turn-ended', reason: 'completed' })
  const reply = await app.command({ action: 'confirmPrototype', entityId: f.value.id, method: 'ai-assisted', reviewId: review.id, authorDisposition: '已核对并确认本次固定原型。' })
  assert.equal(reply.ok, true, JSON.stringify(reply))
  assert.equal(f.calls.prepared[0]!.stage, 'prototype')
  assert.deepEqual(f.calls.prepared[0]!.confirmations[0]!.fixed, f.value.current!.fixed)
  assert.equal(f.calls.prepared[0]!.confirmations[0]!.confirmationMethod, 'ai-assisted')
})

test('candidate commits outside the task whitelist are rejected even when the current worktree is clean', async t => {
  const f = await prototypeFixture(t)
  f.gitState.dirtyFiles = []; f.gitState.head = candidate; f.gitState.changedFiles = ['原型代码/src/page.tsx', '场景/unrelated.md']
  assert.equal((await f.app().command({ action: 'confirmPrototype', entityId: f.value.id, method: 'direct' })).ok, false)
  assert.equal(f.calls.prepared.length, 0)
})


test('adoption recovery recognizes already-applied exact provenance without replacing later author edits', async t => {
  const f = await fixture(t), app = f.app()
  await app.command(f.adopt)
  const draft = await readMaterial(f.worktree, 'requirement', f.value.id)
  await saveMaterial(f.worktree, draft.metadata, draft.body + '\n采用后作者调整。')
  const adoption = (await f.store.read()).adoptions[0]!; delete adoption.applied; await f.store.save()
  const rebooted = new StudioStore(path.join(f.root, 'state')); rebooted.useUser(1)
  assert.equal((await f.app(rebooted).command(f.adopt)).ok, true)
  assert.match((await readMaterial(f.worktree, 'requirement', f.value.id)).body, /采用后作者调整/)
  assert.equal(f.calls.adoptions, 1)
})


for (const reason of ['error', 'aborted', 'completed']) test('review terminal ' + reason + ' without a valid report leaves pending and permits an explicit new-session retry', async t => {
  const f = await fixture(t), app = f.app()
  assert.equal((await app.command({ action: 'requestReview', entityId: f.value.id, purpose: 'material' })).ok, true)
  const review = (await f.store.read()).reviews[0]!
  await app.acceptSessionOutput(review.task.sessionId, { kind: 'assistant', content: '正在核对固定业务依据，尚未生成报告。' })
  assert.equal(review.status, 'pending', 'intermediate assistant text must not fail a running review')
  await app.acceptSessionOutput(review.task.sessionId, { kind: 'turn-ended', reason })
  assert.equal(review.status, 'failed')
  assert.ok(review.error)
  assert.equal((await app.command({ action: 'requestReview', entityId: f.value.id, purpose: 'material' })).ok, true)
  const next = (await f.store.read()).reviews.at(-1)!
  assert.notEqual(next.id, review.id); assert.notEqual(next.task.sessionId, review.task.sessionId)
  assert.equal(next.status, 'pending'); assert.equal(f.calls.prompts.length, 2)
})


for (const reason of ['error', 'aborted']) test('a valid-looking report followed by ' + reason + ' cannot become author-confirmable or be revived by late text', async t => {
  const f = await fixture(t), app = f.app()
  await app.command({ action: 'requestReview', entityId: f.value.id, purpose: 'material' })
  const review = (await f.store.read()).reviews[0]!
  await app.acceptSessionOutput(review.task.sessionId, { kind: 'assistant', content: reviewReport() })
  assert.equal(review.status, 'pending', 'a report is incomplete until the actual turn succeeds')
  const draft = await readMaterial(f.worktree, 'requirement', f.value.id)
  assertConfirmationRecovery(await app.command({ action: 'confirmMaterial', entityId: f.value.id, expectedHash: draft.sha256, method: 'ai-assisted', reviewId: review.id, authorDisposition: '尝试提前确认' }))
  await app.acceptSessionOutput(review.task.sessionId, { kind: 'turn-ended', reason })
  assert.equal(review.status, 'failed')
  await app.acceptSessionOutput(review.task.sessionId, { kind: 'assistant', content: reviewReport() })
  assert.equal(review.status, 'failed')
  assert.equal(f.calls.prepared.length, 0)
})

test('explicit scenario revision claims a design occupation and leaves requirement materials untouched', async t => {
  const f = await fixture(t, 'scenario'), app = f.app()
  const current = await readMaterial(f.worktree, 'scenario', f.value.id)
  f.value.materialVersion = 1; f.value.confirmationStatus = 'confirmed'; f.value.taskStatus = 'idle'
  f.value.current = { version: 1, fixed: { commitSha: head, path: current.path, sha256: current.sha256 }, metadata: current.metadata, confirmationId: 'scene-confirmation', confirmedBy: 1, confirmedAt: '', reuse: { enabled: true, reason: '' } }
  delete f.value.occupation
  const related = entity('unfinished'), completed = entity('already-completed')
  for (const requirement of [related, completed]) {
    requirement.scenarioIds = [f.value.id, 'origin']
    requirement.scenarioSources = [{ projectId: 'project', entityId: f.value.id, version: 1 }, { projectId: 'project', entityId: 'origin', version: 1 }]
  }
  const previous = await saveMaterial(f.worktree, metadata(related), body + '\n作者保留的业务细节。')
  const finished = await saveMaterial(f.worktree, metadata(completed), body + '\n已完成需求保持固定。')
  completed.materialVersion = 2; completed.completedVersion = 2; completed.confirmationStatus = 'confirmed'
  completed.current = { version: 2, fixed: { commitSha: head, path: finished.path, sha256: finished.sha256 }, metadata: finished.metadata, confirmationId: 'completed-confirmation', confirmedBy: 1, confirmedAt: '', reuse: { enabled: true, reason: '' } }
  f.remote.entities.push(related, completed)
  const original = f.api.request.bind(f.api), claims: Array<Record<string, unknown>> = []
  f.api.request = async (method, route, input) => {
    if (method === 'GET' && route.endsWith('/revision-impact')) return { requirements: [related, completed] }
    if (method === 'POST' && route.endsWith(`/entities/${f.value.id}/claim`)) {
      claims.push(input!)
      assert.equal(input!.purpose, 'design')
      assert.equal(input!.expectedRevision, f.value.revision)
      f.value.revision++; f.value.generation++
      f.value.occupation = { occupationId: 'revision-occupation', generation: f.value.generation, taskId: String(input!.taskId), clientId: String(input!.clientId), expectedRevision: f.value.revision, entityId: f.value.id, ownerId: 1, purpose: 'design', inputVersion: 1, prerequisiteBindings: [], createdAt: '' }
      return f.value
    }
    return original(method, route, input)
  }
  const state = f.ports.git.state.bind(f.ports.git)
  f.ports.git.createWorktree = async (_root, directory) => { await cp(f.worktree, directory, { recursive: true }) }
  f.ports.git.state = async directory => directory.includes(`${path.sep}worktrees${path.sep}`) ? { head, dirty: true, branch: 'studio/revision' } : state(directory)
  const impact = await app.command({ action: 'scenarioRevisionImpact', entityId: f.value.id })
  assert.equal(impact.ok, true, JSON.stringify(impact))
  assert.equal(claims.length, 0, 'viewing the impact cannot claim anything')
  assert.equal(f.value.occupation, undefined)
  const reply = await app.command({ action: 'startScenarioRevision', entityId: f.value.id, expectedRevision: f.value.revision })
  assert.equal(reply.ok, true, JSON.stringify(reply))
  assert.equal(claims.length, 1)
  const task = (await f.store.read()).tasks.findLast(task => task.entityId === f.value.id && task.purpose === 'material')!
  assert.notEqual(task.worktree, f.worktree)
  assert.equal((await readMaterial(task.worktree, 'scenario', f.value.id)).sha256, current.sha256)
  assert.equal((await readMaterial(task.worktree, 'requirement', related.id)).sha256, previous.sha256, 'requirement materials are not rebound by a scenario revision')
  assert.equal(f.value.current!.fixed.sha256, current.sha256, 'the accepted scene stays fixed while its revision is edited')
})


test('requirement attachments share source extraction, retry, context, formal archives and pruning', async t => {
  const f = await fixture(t), app = f.app()
  let reads = 0
  f.ports.readScenarioSource = async () => ++reads === 1
    ? { status: 'failed', text: '', ranges: [], error: '转换服务暂不可用' }
    : { status: 'partial', text: '实际读取的需求规则', ranges: ['page:1'], error: '第 2 页未读取' }
  const imported = await app.command({ action: 'importScenarioSource', entityId: f.value.id, operationId: 'requirement-source', name: '规则.pdf', base64: Buffer.from('原始资料').toString('base64') })
  assert.equal(imported.ok, true, JSON.stringify(imported)); await app.settle()
  const record = f.local.scenarios.find(value => value.entityId === f.value.id)!, source = record.sources[0]!
  assert.equal(source.status, 'failed'); assert.match(source.error!, /转换服务/)
  assert.ok(record.sourcePaths[source.id]!.includes(`${path.sep}scenario-sources${path.sep}project${path.sep}target${path.sep}`))
  let reply = await app.command({ action: 'selectScenarioSource', entityId: f.value.id, sourceId: source.id, selected: true, formal: true })
  assert.equal(reply.ok, false, 'unread requirement sources cannot become formal evidence')
  reply = await app.command({ action: 'retryScenarioSource', entityId: f.value.id, sourceId: source.id })
  assert.equal(reply.ok, true, JSON.stringify(reply)); await app.settle()
  assert.equal(source.status, 'partial'); assert.deepEqual(source.ranges, ['page:1'])
  const projection = await app.state(), projected = projection.materialSources!.find(value => value.entityId === f.value.id)!
  assert.equal(projected.readOnly, false); assert.equal(projected.sources[0]!.text, '')
  const context = await app.scenarioSessionContext(f.local.tasks[0]!)
  assert.deepEqual(context.readPaths, [record.sourcePaths[source.id]])
  assert.match(context.text, /实际读取的需求规则/); assert.match(context.text, /page:1/)
  assert.match(context.text, /eadp-write-proposal/)
  const original = await readMaterial(f.worktree, 'requirement', f.value.id)
  reply = await app.command({ action: 'selectScenarioSource', entityId: f.value.id, sourceId: source.id, selected: true, formal: true })
  assert.equal(reply.ok, true, JSON.stringify(reply))
  const archived = await readMaterial(f.worktree, 'requirement', f.value.id), evidence = archived.metadata.businessEvidence[0]!
  assert.equal(archived.body, original.body); assert.notEqual(archived.sha256, original.sha256)
  assert.equal(evidence.label, '规则.pdf'); assert.equal(evidence.files.length, 3)
  assert.equal(await readFile(path.join(f.worktree, evidence.files.find(file => file.path.includes('extracted-'))!.path), 'utf8'), source.text)
  reply = await app.command({ action: 'selectScenarioSource', entityId: f.value.id, sourceId: source.id, selected: false, formal: false })
  assert.equal(reply.ok, true, JSON.stringify(reply))
  assert.deepEqual((await readMaterial(f.worktree, 'requirement', f.value.id)).metadata.businessEvidence, [])
  for (const file of evidence.files) await assert.rejects(readFile(path.join(f.worktree, file.path)), { code: 'ENOENT' })
  assert.deepEqual((await app.scenarioSessionContext(f.local.tasks[0]!)).readPaths, [])
  assert.doesNotMatch((await app.scenarioSessionContext(f.local.tasks[0]!)).text, /实际读取的需求规则/)
  assert.equal(await readFile(record.sourcePaths[source.id]!, 'utf8'), '原始资料')
})

test('native image reads for requirement attachments require the current design owner and original source hash', async t => {
  const f = await fixture(t), app = f.app()
  f.ports.readScenarioSource = async () => ({ status: 'failed', text: '', ranges: [], error: '请使用 read_image' })
  assert.equal((await app.command({ action: 'importScenarioSource', entityId: f.value.id, operationId: 'image-source', name: '流程.png', base64: Buffer.from('image-bytes').toString('base64') })).ok, true)
  await app.settle()
  const record = f.local.scenarios.find(value => value.entityId === f.value.id)!, source = record.sources[0]!, filename = record.sourcePaths[source.id]!
  const output = { kind: 'source-read' as const, path: filename, attachmentId: 'native-image', ranges: ['image:1 (20×10)'] }
  await writeFile(filename, 'changed-bytes')
  await app.acceptSessionOutput('material-session', output)
  assert.equal(source.status, 'failed', 'changed original bytes cannot become actual-read evidence')
  await writeFile(filename, 'image-bytes')
  const ownerId = f.value.occupation!.ownerId; f.value.occupation!.ownerId = 2
  await app.acceptSessionOutput('material-session', output)
  assert.equal(source.status, 'failed', 'a former session cannot mark evidence after ownership changes')
  f.value.occupation!.ownerId = ownerId
  await app.acceptSessionOutput('material-session', { ...output, path: path.join(f.root, 'outside.png') })
  assert.equal(source.status, 'failed')
  await app.acceptSessionOutput('material-session', output)
  assert.equal(source.status, 'read'); assert.match(source.text, /attachmentId=native-image/)
  assert.deepEqual(source.ranges, output.ranges)
  assert.match((await app.scenarioSessionContext(f.local.tasks[0]!)).text, /attachmentId=native-image/)
})

test('confirmed requirement attachment projections use fixed evidence and reject mutation or prototype ownership', async t => {
  const f = await fixture(t), app = f.app(), draft = await readMaterial(f.worktree, 'requirement', f.value.id)
  const archived = await archiveSelectedEvidence(f.worktree, [{ source: { id: 'fixed-pdf', name: '已确认部分读取.pdf', format: 'pdf', sha256: digest('原始PDF'), status: 'partial', ranges: ['page:1'], text: '仅读取第一页', error: '第 2 页提取失败', selected: true, formal: true }, original: Buffer.from('原始PDF') }], ['fixed-pdf'])
  f.value.current = { version: 1, fixed: { commitSha: head, path: draft.path, sha256: draft.sha256 }, metadata: { ...draft.metadata, businessEvidence: archived }, confirmationId: 'accepted', confirmedBy: 1, confirmedAt: '', reuse: { enabled: true, reason: '' } }
  const record = { projectId: 'project', entityId: f.value.id, sources: [{ id: 'local', name: '未确认本地资料', format: 'txt', sha256: digest('local'), status: 'read' as const, ranges: ['line:1'], text: '本地未确认文本', selected: true, formal: false }], sourcePaths: {} }
  f.local.scenarios.push(record); await f.store.save()
  delete f.value.occupation
  let projection = (await app.state()).materialSources!.find(value => value.entityId === f.value.id)!
  assert.equal(projection.readOnly, true); assert.equal(projection.sources[0]!.name, '已确认部分读取.pdf')
  assert.equal(projection.sources[0]!.formal, true); assert.equal(projection.sources[0]!.text, '')
  assert.equal(projection.sources[0]!.status, 'partial'); assert.equal(projection.sources[0]!.format, 'pdf')
  assert.deepEqual(projection.sources[0]!.ranges, ['page:1']); assert.match(projection.sources[0]!.error!, /第 2 页提取失败/)
  const command = { action: 'importScenarioSource' as const, entityId: f.value.id, operationId: 'blocked-source', name: '禁止.txt', base64: Buffer.from('blocked').toString('base64') }
  assert.equal((await app.command(command)).ok, false)
  f.value.occupation = { occupationId: 'prototype', generation: 1, taskId: 'task', clientId: f.local.clientId, expectedRevision: 1, entityId: f.value.id, ownerId: 1, purpose: 'prototype', inputVersion: 1, prerequisiteBindings: [], createdAt: '' }
  projection = (await app.state()).materialSources!.find(value => value.entityId === f.value.id)!
  assert.equal(projection.readOnly, true); assert.equal((await app.command(command)).ok, false)
  assert.equal(record.sources.length, 1)
  f.value.current!.metadata.businessEvidence = [evidence]
  projection = (await app.state()).materialSources!.find(value => value.entityId === f.value.id)!
  assert.equal(projection.sources[0]!.status, 'failed'); assert.match(projection.sources[0]!.error!, /读取记录/)
  f.value.current!.metadata.businessEvidence = archived
  const manifest = archived[0]!.files.find(file => file.path.endsWith('.json'))!
  await writeFile(path.join(f.worktree, manifest.path), '{}')
  projection = (await f.app().state()).materialSources!.find(value => value.entityId === f.value.id)!
  assert.equal(projection.sources[0]!.status, 'failed'); assert.match(projection.sources[0]!.error!, /hash|哈希/)
})
