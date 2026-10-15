import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { StudioApplication } from '../../packages/studio-plugin/src/host/application/studio.ts'
import { StudioStore } from '../../packages/studio-plugin/src/host/application/state.ts'
import type { PendingOperation } from '../../packages/studio-plugin/src/host/application/state.ts'
import type { HostPorts } from '../../packages/studio-plugin/src/host/application/ports.ts'
import type { CollaborationClient } from '../../packages/studio-plugin/src/host/adapters/collaboration/client.ts'
import type { EntityView, IntegrationView, ProjectState } from '@eadp/contracts'

const material = (version: number) => `# 固定场景 ${version}\n`
const hash = (version: number) => createHash('sha256').update(material(version)).digest('hex')
const output = (title: string) => '```eadp-candidates\n' + JSON.stringify([{ title, summary: '需求摘要' }]) + '\n```'
async function fixture(failure?: 'session' | 'prompt') {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-split-recovery-'))
  const storeRoot = path.join(root, 'state')
  const store = new StudioStore(storeRoot); store.useUser(1)
  const local = await store.read()
  const scenario = (version: number): EntityView => ({ id: 'scenario', kind: 'scenario', title: '采购', categoryId: 'cat', revision: version, generation: 1, materialVersion: version, confirmationStatus: 'confirmed', taskStatus: 'idle', scenarioIds: [], prerequisites: [], frozenBy: [], associationRevision: 0,
    current: { version, confirmationId: `confirmation-${version}`, fixed: { commitSha: String(version).repeat(40), path: '场景/scenario.md', sha256: hash(version) }, metadata: {} as never, confirmedBy: 1, confirmedAt: '', reuse: { enabled: true, reason: '' } } })
  const remote: ProjectState = { project: { id: 'project', name: '测试项目', gitlabProjectId: 1, repositoryUrl: 'https://example.test/project.git', stableBranch: 'main', namespaceId: 1, namespacePath: 'test', initializationStatus: 'ready', recognizedHead: 'a'.repeat(40), revision: 1, categories: [] }, entities: [scenario(1)], baselines: [], integrations: [] }
  const integrations = new Map<string, IntegrationView>()
  const addOperation = (version: number): PendingOperation => {
    const integration: IntegrationView = { id: `integration-${version}`, entityId: 'scenario', ownerId: 1, status: 'accepted', sourceSha: 'a'.repeat(40), expectedHead: 'a'.repeat(40), candidateSha: 'a'.repeat(40), stage: 'material', confirmationIds: [`confirmation-${version}`], createdAt: '' }
    integrations.set(integration.id, integration)
    const operation: PendingOperation = { id: `operation-${version}`, projectId: 'project', entityId: 'scenario', phase: 'accepted', candidateSha: 'a'.repeat(40), expectedHead: 'a'.repeat(40), fixedPath: '场景/scenario.md', sha256: hash(version), integrationId: integration.id, prepare: { confirmations: [{ fixed: scenario(version).current!.fixed }] }, token: {} }
    local.operations.push(operation); return operation
  }
  const first = addOperation(1)
  local.selectedProjectId = 'project'; local.projects.push({ id: 'project', name: '测试项目', directory: root, repositoryUrl: remote.project.repositoryUrl })
  local.tasks.push({ projectId: 'project', entityId: 'scenario', sessionId: 'material-session', purpose: 'material', inputHash: '', worktree: path.join(root, 'worktree') })
  await store.save()
  const calls = { sessions: [] as string[], prompts: [] as string[], promptTexts: [] as string[], creates: 0 }; let failed = false, corrupted = false
  const api = { request: async (method: string, route: string) => {
    if (method === 'POST') { calls.creates++; throw new Error('unexpected write') }
    if (route === '/v1/projects') return [remote.project]
    if (route === '/v1/namespaces') return []
    if (route.includes('/integrations/')) return integrations.get(route.split('/').at(-1)!)
    return remote
  } } as unknown as CollaborationClient
  const ports = { git: { fetchCommit: async () => {}, readBlob: async (_directory: string, sha: string) => Buffer.from(corrupted ? 'modified input' : material(Number(sha[0]))) }, account: async () => ({ id: 1 }), stopPreview: async () => {}, session: async (task: { sessionId: string }) => { calls.sessions.push(task.sessionId); if (failure === 'session' && !failed) { failed = true; throw new Error('injected session failure') }; return task.sessionId }, prompt: async (sessionId: string, text: string) => { calls.prompts.push(sessionId); calls.promptTexts.push(text); if (failure === 'prompt' && !failed) { failed = true; throw new Error('injected prompt failure') } } } as unknown as HostPorts
  const createApp = (nextStore = store) => new StudioApplication(nextStore, api, ports)
  return { root, store, storeRoot, remote, local, calls, first, addOperation, createApp, corruptInput: (value: boolean) => { corrupted = value }, nextVersion: (version: number) => { remote.entities = [scenario(version)] }, dispose: () => rm(root, { recursive: true, force: true }) }
}

for (const failure of ['session', 'prompt'] as const) test(`failed ${failure} resumes the same fixed-event task and session after restart`, async () => {
  const f = await fixture(failure)
  try {
    let app = f.createApp()
    assert.equal((await app.command({ action: 'retryOperation', operationId: f.first.id })).ok, false)
    assert.equal(f.first.phase, 'accepted', 'confirmed integration remains accepted when local split delivery fails')
    const task = (await f.store.read()).tasks.find(task => task.purpose === 'split')
    assert.ok(task, 'task identity must be durable before session or prompt can fail')
    const rebooted = new StudioStore(f.storeRoot); rebooted.useUser(1); app = f.createApp(rebooted)
    assert.equal((await app.command({ action: 'retryOperation', operationId: f.first.id })).ok, true)
    const splits = (await rebooted.read()).tasks.filter(task => task.purpose === 'split')
    assert.equal(splits.length, 1); assert.equal(splits[0]!.sessionId, task.sessionId)
    assert.equal(f.calls.prompts.at(-1), task.sessionId)
    assert.equal(f.calls.prompts.length, failure === 'prompt' ? 2 : 1)
    await app.acceptCandidates(task.sessionId, output('候选一'))
    assert.equal((await rebooted.read()).candidates.length, 1)
    await app.command({ action: 'retryOperation', operationId: f.first.id })
    await app.acceptCandidates(task.sessionId, output('重放不能覆盖'))
    assert.equal(f.calls.prompts.length, failure === 'prompt' ? 2 : 1)
    assert.equal((await rebooted.read()).candidates[0]!.title, '候选一')
  } finally { await f.dispose() }
})

test('new confirmed versions have independent candidates and preserve adopted source provenance', async () => {
  const f = await fixture()
  try {
    const app = f.createApp()
    await app.command({ action: 'retryOperation', operationId: f.first.id })
    const oldTask = f.local.tasks.find(task => task.purpose === 'split')!
    await app.acceptCandidates(oldTask.sessionId, output('旧候选'))
    f.local.candidates[0]!.selectedEntityId = 'adopted-requirement'; await f.store.save()
    f.nextVersion(2); const next = f.addOperation(2); await f.store.save()
    await app.command({ action: 'retryOperation', operationId: next.id })
    const newTask = f.local.tasks.filter(task => task.purpose === 'split').at(-1)!
    assert.notEqual(newTask.sessionId, oldTask.sessionId)
    await app.acceptCandidates(newTask.sessionId, output('新候选'))
    assert.equal(f.local.candidates.length, 2)
    assert.equal(f.local.candidates[0]!.selectedEntityId, 'adopted-requirement')
    const current = f.local.candidates[1]! as unknown as Record<string, unknown>
    assert.deepEqual([current.projectId, current.sessionId, current.integrationId, current.confirmationId, current.version, current.inputHash], ['project', newTask.sessionId, 'integration-2', 'confirmation-2', 2, hash(2)])
  } finally { await f.dispose() }
})

test('late old-session output and old-operation retry cannot acquire the new confirmation identity', async () => {
  const f = await fixture()
  try {
    const app = f.createApp(); await app.command({ action: 'retryOperation', operationId: f.first.id })
    const oldTask = f.local.tasks.find(task => task.purpose === 'split')!
    f.nextVersion(2)
    await app.acceptCandidates(oldTask.sessionId, output('迟到旧候选'))
    assert.equal(f.local.candidates.length, 0)
    const prompts = f.calls.prompts.length
    await app.command({ action: 'retryOperation', operationId: f.first.id })
    assert.equal(f.calls.prompts.length, prompts)
    assert.equal(f.local.tasks.filter(task => task.purpose === 'split').length, 1)
  } finally { await f.dispose() }
})

test('unadopted old candidates are hidden and rejected before any requirement creation', async () => {
  const f = await fixture()
  try {
    const app = f.createApp(); await app.command({ action: 'retryOperation', operationId: f.first.id })
    const task = f.local.tasks.find(task => task.purpose === 'split')!
    await app.acceptCandidates(task.sessionId, output('失效候选')); const id = f.local.candidates[0]!.id
    f.nextVersion(2)
    assert.equal((await app.state()).candidates.length, 0)
    assert.equal((await app.command({ action: 'selectCandidate', candidateId: id, categoryId: 'cat' })).ok, false)
    assert.equal(f.calls.creates, 0)
  } finally { await f.dispose() }
})

test('empty completed output is durable and malformed output can be corrected', async () => {
  const f = await fixture()
  try {
    const app = f.createApp(); await app.command({ action: 'retryOperation', operationId: f.first.id })
    const task = f.local.tasks.find(task => task.purpose === 'split')!
    await assert.rejects(app.acceptCandidates(task.sessionId, output('').replace('需求摘要', 'x')), /格式无效/)
    await app.acceptCandidates(task.sessionId, '```eadp-candidates\n[]\n```')
    await app.acceptCandidates(task.sessionId, output('完成后重放'))
    await app.command({ action: 'retryOperation', operationId: f.first.id })
    assert.equal(f.local.candidates.length, 0); assert.equal(f.calls.prompts.length, 1)
  } finally { await f.dispose() }
})


test('pending model output does not resend and the prompt contains only verified fixed Git input', async () => {
  const f = await fixture()
  try {
    const app = f.createApp()
    await app.command({ action: 'retryOperation', operationId: f.first.id })
    await app.command({ action: 'retryOperation', operationId: f.first.id })
    assert.equal(f.calls.prompts.length, 1)
    assert.ok(f.calls.promptTexts[0]!.endsWith(material(1)))
    assert.ok(f.calls.promptTexts[0]!.includes(hash(1)))
    assert.equal(f.local.tasks.find(task => task.purpose === 'split')!.split!.status, 'sent')
  } finally { await f.dispose() }
})

test('identical bytes with a different confirmation still invalidate old-session output', async () => {
  const f = await fixture()
  try {
    const app = f.createApp(); await app.command({ action: 'retryOperation', operationId: f.first.id })
    const task = f.local.tasks.find(task => task.purpose === 'split')!
    f.remote.entities[0]!.current!.confirmationId = 'different-confirmation'
    await app.acceptCandidates(task.sessionId, output('相同哈希的旧确认'))
    assert.equal(f.local.candidates.length, 0)
  } finally { await f.dispose() }
})


test('fixed input integrity failure sends no model request and retries the same task after repair', async () => {
  const f = await fixture()
  try {
    const app = f.createApp(); f.corruptInput(true)
    const result = await app.command({ action: 'retryOperation', operationId: f.first.id })
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.message, /哈希校验失败/)
    const task = f.local.tasks.find(task => task.purpose === 'split')!
    assert.equal(task.split!.status, 'failed'); assert.equal(f.calls.prompts.length, 0); assert.equal(f.calls.sessions.length, 0)
    f.corruptInput(false)
    assert.equal((await app.command({ action: 'retryOperation', operationId: f.first.id })).ok, true)
    assert.equal(f.local.tasks.filter(task => task.purpose === 'split').length, 1)
    assert.equal(f.calls.prompts[0], task.sessionId)
  } finally { await f.dispose() }
})
