import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { studioToolGuard } from '../../packages/studio-plugin/src/host/adapters/platform/execution-guard.ts'
import { registerHooks } from 'node:module'
import { StudioApplication } from '../../packages/studio-plugin/src/host/application/studio.ts'
import { StudioStore } from '../../packages/studio-plugin/src/host/application/state.ts'
import type { PendingOperation } from '../../packages/studio-plugin/src/host/application/state.ts'
import type { HostPorts } from '../../packages/studio-plugin/src/host/application/ports.ts'
import type { CollaborationClient } from '../../packages/studio-plugin/src/host/adapters/collaboration/client.ts'
import type { EntityView, IntegrationView, ProjectState } from '@eadp/contracts'

// Isolate the unrelated DSH message factory; session inspect/resume and application code are real.
const llmFactory = 'data:text/javascript,' + encodeURIComponent('export const createUserMessage = value => value')
const hooks = registerHooks({ resolve(specifier, context, nextResolve) { return specifier === '@deepseek-ai/dsh-llm' ? { url: llmFactory, shortCircuit: true } : nextResolve(specifier, context) } })
const { DshTaskSessions } = await import('../../packages/studio-plugin/src/host/adapters/dsh/sessions.ts')
hooks.deregister()

const material = (version: number) => `# 固定场景 ${version}\n`
const hash = (version: number) => createHash('sha256').update(material(version)).digest('hex')
const output = (title: string) => '```eadp-candidates\n' + JSON.stringify([{ title, summary: '需求摘要' }]) + '\n```'
async function fixture(failure?: 'session' | 'prompt') {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-split-recovery-'))
  const storeRoot = path.join(root, 'state')
  const store = new StudioStore(storeRoot); store.useUser(1)
  const local = await store.read()
  const scenario = (version: number): EntityView => ({ id: 'scenario', kind: 'scenario', title: '采购', categoryId: 'cat', revision: version, generation: 1, materialVersion: version, confirmationStatus: 'confirmed', taskStatus: 'idle', scenarioIds: [], prerequisites: [], authorId: 1, frozenBy: [], associationRevision: 0,
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
  return { root, ports, api, store, storeRoot, remote, local, calls, first, addOperation, createApp, corruptInput: (value: boolean) => { corrupted = value }, nextVersion: (version: number) => { remote.entities = [scenario(version)] }, dispose: () => rm(root, { recursive: true, force: true }) }
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
    await app.acceptSessionOutput(task.sessionId, { kind: 'assistant', content: output('候选一') })
    assert.equal((await rebooted.read()).candidates.length, 1)
    await app.command({ action: 'retryOperation', operationId: f.first.id })
    await app.acceptSessionOutput(task.sessionId, { kind: 'assistant', content: output('重放不能覆盖') })
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
    await app.acceptSessionOutput(oldTask.sessionId, { kind: 'assistant', content: output('旧候选') })
    f.local.candidates[0]!.selectedEntityId = 'adopted-requirement'; await f.store.save()
    f.nextVersion(2); const next = f.addOperation(2); await f.store.save()
    await app.command({ action: 'retryOperation', operationId: next.id })
    const newTask = f.local.tasks.filter(task => task.purpose === 'split').at(-1)!
    assert.notEqual(newTask.sessionId, oldTask.sessionId)
    await app.acceptSessionOutput(newTask.sessionId, { kind: 'assistant', content: output('新候选') })
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
    await app.acceptSessionOutput(oldTask.sessionId, { kind: 'assistant', content: output('迟到旧候选') })
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
    await app.acceptSessionOutput(task.sessionId, { kind: 'assistant', content: output('失效候选') }); const id = f.local.candidates[0]!.id
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
    await assert.rejects(app.acceptSessionOutput(task.sessionId, { kind: 'assistant', content: output('').replace('需求摘要', 'x') }), /格式无效/)
    await app.acceptSessionOutput(task.sessionId, { kind: 'assistant', content: '```eadp-candidates\n[]\n```' })
    await app.acceptSessionOutput(task.sessionId, { kind: 'assistant', content: output('完成后重放') })
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
    await app.acceptSessionOutput(task.sessionId, { kind: 'assistant', content: output('相同哈希的旧确认') })
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


function dshFixture(events: Map<string, unknown[]>) {
  let listener: (session: { id: string }, event: unknown) => void = () => {}
  const counts = { creates: 0, resumes: 0, followups: 0 }
  const context = {
    on: (_event: string, callback: typeof listener) => { listener = callback }, effect: () => {},
    sessionController: { inspect: async (id: string) => { if (!events.has(id)) throw new Error('not persisted'); return { events: events.get(id) } } },
    agents: {
      create: async ({ sessionId }: { sessionId: string }) => { counts.creates++; events.set(sessionId, []); return handle(sessionId) },
      resume: async ({ resumeSessionId }: { resumeSessionId: string }) => { assert.ok(events.has(resumeSessionId)); counts.resumes++; return handle(resumeSessionId) },
    },
  }
  const handle = (sessionId: string) => ({ agent: { followup: (message: unknown) => { counts.followups++; events.get(sessionId)!.push({ type: 'user/message', data: message }) } }, dispose: async () => {} })
  return { context, counts, emit: (id: string, content: string) => listener({ id }, assistant(content)), emitEvent: (id: string, event: unknown) => listener({ id }, event) }
}
const assistant = (text: string, interrupted = false) => ({ type: 'assistant/message', data: { interrupted, message: { content: [{ type: 'text', text }] } } })

test('sent split resumes its original DSH handle after Host restart without another prompt or session', async () => {
  const f = await fixture()
  try {
    const events = new Map<string, unknown[]>(), firstDsh = dshFixture(events)
    let app = f.createApp()
    let sessions = new DshTaskSessions(firstDsh.context as never, '', (id, text) => app.acceptSessionOutput(id, text))
    f.ports.session = (task, rules) => sessions.open(task, rules, undefined); f.ports.prompt = (id, text) => sessions.prompt(id, text)
    assert.equal((await app.command({ action: 'retryOperation', operationId: f.first.id })).ok, true)
    const task = f.local.tasks.find(task => task.purpose === 'split')!
    assert.equal(firstDsh.counts.followups, 1); await sessions.dispose()
    const store = new StudioStore(f.storeRoot); store.useUser(1)
    const resumed = dshFixture(events); app = f.createApp(store)
    sessions = new DshTaskSessions(resumed.context as never, '', (id, text) => app.acceptSessionOutput(id, text))
    assert.equal((await app.command({ action: 'retryOperation', operationId: f.first.id })).ok, true)
    assert.deepEqual(resumed.counts, { creates: 0, resumes: 1, followups: 0 })
    resumed.emit(task.sessionId, output('恢复后的候选')); await app.acceptSessionOutput(task.sessionId, { kind: 'assistant', content: '' })
    assert.equal((await store.read()).candidates[0]!.title, '恢复后的候选')
    assert.equal((await store.read()).tasks.filter(task => task.purpose === 'split').length, 1)
    await sessions.dispose()
  } finally { await f.dispose() }
})

test('persisted assistant output is replayed after restart without queue deadlock or duplicate candidates', { timeout: 3000 }, async () => {
  const f = await fixture()
  try {
    let app = f.createApp(); await app.command({ action: 'retryOperation', operationId: f.first.id })
    const task = f.local.tasks.find(task => task.purpose === 'split')!
    const events = new Map([[task.sessionId, [assistant(output('被中断输出'), true), assistant(output('持久候选'))]]])
    const store = new StudioStore(f.storeRoot); store.useUser(1); app = f.createApp(store)
    const dsh = dshFixture(events), sessions = new DshTaskSessions(dsh.context as never, '', (id, text) => app.acceptSessionOutput(id, text))
    f.ports.session = (next, rules) => sessions.open(next, rules, undefined); f.ports.prompt = (id, text) => sessions.prompt(id, text)
    assert.equal((await app.command({ action: 'retryOperation', operationId: f.first.id })).ok, true)
    await app.acceptSessionOutput(task.sessionId, { kind: 'assistant', content: '' })
    assert.equal((await store.read()).candidates[0]!.title, '持久候选')
    await app.command({ action: 'retryOperation', operationId: f.first.id }); await app.acceptSessionOutput(task.sessionId, { kind: 'assistant', content: '' })
    assert.equal((await store.read()).candidates.length, 1); assert.equal(dsh.counts.followups, 0); assert.equal(dsh.counts.creates, 0)
    await sessions.dispose()
  } finally { await f.dispose() }
})

test('persisted output from a superseded confirmation is not replayed into current candidates', async () => {
  const f = await fixture()
  try {
    let app = f.createApp(); await app.command({ action: 'retryOperation', operationId: f.first.id })
    const task = f.local.tasks.find(task => task.purpose === 'split')!
    f.nextVersion(2)
    const store = new StudioStore(f.storeRoot); store.useUser(1); app = f.createApp(store)
    const dsh = dshFixture(new Map([[task.sessionId, [assistant(output('过期持久输出'))]]]))
    let deliveries = 0
    const sessions = new DshTaskSessions(dsh.context as never, '', (id, text) => { deliveries++; return app.acceptSessionOutput(id, text) })
    await sessions.open(task, '', undefined); await app.acceptSessionOutput(task.sessionId, { kind: 'assistant', content: '' })
    assert.equal(deliveries, 1); assert.equal((await store.read()).candidates.length, 0); assert.equal(dsh.counts.followups, 0)
    await sessions.dispose()
  } finally { await f.dispose() }
})


for (const action of ['checkPrototype', 'startPreview'] as const) test('failed ' + action + ' clears an earlier successful preview projection', async () => {
  const f = await fixture()
  try {
    const entity = f.remote.entities[0]!
    entity.kind = 'requirement'
    entity.occupation = { occupationId: 'occupation', expectedRevision: 1, entityId: entity.id, ownerId: 1, clientId: f.local.clientId, taskId: 'prototype-task', generation: 1, purpose: 'prototype', inputVersion: 1, prerequisiteBindings: [], createdAt: '' }
    f.local.tasks.push({ projectId: 'project', entityId: entity.id, sessionId: 'prototype-session', purpose: 'prototype', inputHash: entity.current!.fixed.sha256, worktree: path.join(f.root, 'prototype-task') })
    await f.store.save()
    f.ports.git.state = async () => ({ root: f.root, head: 'a'.repeat(40), branch: 'main', dirty: false, repositoryUrl: '' })
    f.ports.preview = async () => ({ url: 'http://127.0.0.1:4173' })
    const app = f.createApp()
    assert.equal((await app.command({ action: 'startPreview', entityId: entity.id })).ok, true)
    assert.equal((await app.state()).preview?.url, 'http://127.0.0.1:4173')
    if (action === 'checkPrototype') f.ports.checks = async () => { throw new Error('injected check failure') }
    else f.ports.preview = async () => { throw new Error('injected preview failure') }
    assert.equal((await app.command({ action, entityId: entity.id })).ok, false)
    assert.equal((await app.state()).preview, undefined)
  } finally { await f.dispose() }
})


test('sent recovery with unreadable history fails closed without creating or prompting a replacement', async () => {
  const f = await fixture()
  try {
    let app = f.createApp(); await app.command({ action: 'retryOperation', operationId: f.first.id })
    const store = new StudioStore(f.storeRoot); store.useUser(1); app = f.createApp(store)
    const dsh = dshFixture(new Map()), sessions = new DshTaskSessions(dsh.context as never, '', (id, text) => app.acceptSessionOutput(id, text))
    f.ports.session = (task, rules) => sessions.open(task, rules, undefined); f.ports.prompt = (id, text) => sessions.prompt(id, text)
    const result = await app.command({ action: 'retryOperation', operationId: f.first.id })
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.message, /已发送的拆分会话无法读取/)
    assert.deepEqual(dsh.counts, { creates: 0, resumes: 0, followups: 0 })
    assert.equal((await store.read()).tasks.find(task => task.purpose === 'split')!.split!.status, 'sent')
    await sessions.dispose()
  } finally { await f.dispose() }
})

test('a failed replay is retried from persisted events even when the DSH handle is already open', async () => {
  const f = await fixture()
  try {
    let app = f.createApp(); await app.command({ action: 'retryOperation', operationId: f.first.id })
    const task = f.local.tasks.find(task => task.purpose === 'split')!
    const store = new StudioStore(f.storeRoot); store.useUser(1); app = f.createApp(store)
    const dsh = dshFixture(new Map([[task.sessionId, [assistant(output('可重放候选'))]]]))
    let attempts = 0
    const sessions = new DshTaskSessions(dsh.context as never, '', (id, text) => { attempts++; return attempts === 1 ? Promise.reject(new Error('injected delivery failure')) : app.acceptSessionOutput(id, text) })
    f.ports.session = (next, rules) => sessions.open(next, rules, undefined)
    await app.command({ action: 'retryOperation', operationId: f.first.id }); await app.acceptSessionOutput(task.sessionId, { kind: 'assistant', content: '' })
    assert.equal((await store.read()).candidates.length, 0)
    await app.command({ action: 'retryOperation', operationId: f.first.id }); await app.acceptSessionOutput(task.sessionId, { kind: 'assistant', content: '' })
    assert.equal((await store.read()).candidates[0]!.title, '可重放候选'); assert.equal(attempts, 2)
    assert.deepEqual(dsh.counts, { creates: 0, resumes: 1, followups: 0 })
    await sessions.dispose()
  } finally { await f.dispose() }
})


for (const status of ['pending', 'failed'] as const) test('durable request and result recover from a stale ' + status + ' record without a duplicate prompt', { timeout: 3000 }, async () => {
  const f = await fixture()
  try {
    const events = new Map<string, unknown[]>(), firstDsh = dshFixture(events)
    let app = f.createApp(), sessions = new DshTaskSessions(firstDsh.context as never, '', (id, text) => app.acceptSessionOutput(id, text))
    f.ports.session = (task, rules) => sessions.open(task, rules, undefined); f.ports.prompt = (id, text) => sessions.prompt(id, text)
    await app.command({ action: 'retryOperation', operationId: f.first.id })
    const task = f.local.tasks.find(task => task.purpose === 'split')!
    assert.equal(firstDsh.counts.followups, 1)
    // The official user/message is durable; the Host crashes before its sent status/candidates save.
    task.split!.status = status; await f.store.save(); await sessions.dispose()
    events.get(task.sessionId)!.push(assistant(output('投递崩溃窗口候选')))
    const store = new StudioStore(f.storeRoot); store.useUser(1); app = f.createApp(store)
    const dsh = dshFixture(events); sessions = new DshTaskSessions(dsh.context as never, '', (id, text) => app.acceptSessionOutput(id, text))
    assert.equal((await app.command({ action: 'retryOperation', operationId: f.first.id })).ok, true)
    await app.acceptSessionOutput(task.sessionId, { kind: 'assistant', content: '' })
    assert.deepEqual(dsh.counts, { creates: 0, resumes: 1, followups: 0 })
    assert.equal((await store.read()).tasks.filter(task => task.purpose === 'split').length, 1)
    assert.equal((await store.read()).candidates[0]!.title, '投递崩溃窗口候选')
    assert.equal((await store.read()).tasks.find(task => task.purpose === 'split')!.split!.status, 'completed')
    await sessions.dispose()
  } finally { await f.dispose() }
})

test('only an exact studio-task request suppresses split delivery', async () => {
  const f = await fixture()
  try {
    const app = f.createApp(); await app.command({ action: 'retryOperation', operationId: f.first.id })
    const task = f.local.tasks.find(task => task.purpose === 'split')!
    const events = new Map([[task.sessionId, [
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'fixed prompt' }] } },
      { type: 'user/message', data: { source: { kind: 'studio-task' }, content: [{ type: 'text', text: 'different prompt' }] } },
    ]]])
    const dsh = dshFixture(events), sessions = new DshTaskSessions(dsh.context as never, '', async () => {})
    await sessions.open(task, '', undefined)
    await sessions.prompt(task.sessionId, 'fixed prompt')
    assert.equal(dsh.counts.followups, 1)
    await sessions.prompt(task.sessionId, 'fixed prompt')
    assert.equal(dsh.counts.followups, 1)
    await sessions.dispose()
  } finally { await f.dispose() }
})


test('review setup is read-only before the official Agent handle is published and cannot receive prototype capabilities', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-review-guard-'))
  const disposers: Array<() => void> = []
  try {
    await writeFile(path.join(root, 'reviewed.md'), 'fixed candidate')
    let creates = 0
    const context = {
      on: () => {}, effect: () => {},
      sessionController: { inspect: async () => { throw new Error('new session') } },
      agents: { create: async ({ setup }: { setup: (scope: unknown) => Promise<void> }) => {
        creates++
        await setup({ systemPrompt: { section: () => {} }, effect: (register: () => () => void) => { disposers.push(register()) } })
        const attempt = (name: string, file = 'reviewed.md') => studioToolGuard({ name, arguments: { file_path: file }, agent: { session: { header: { cwd: root } } } })
        assert.equal(attempt('read'), undefined)
        assert.ok(attempt('write')); assert.ok(attempt('edit')); assert.ok(attempt('bash')); assert.ok(attempt('read', '../outside'))
        return { agent: { followup: () => {} }, dispose: async () => {} }
      } },
    }
    const sessions = new DshTaskSessions(context as never, '', async () => {})
    const task = { projectId: 'project', entityId: 'requirement', sessionId: 'review-session', worktree: root, purpose: 'review' as const, reviewId: 'review', inputHash: 'fixed' }
    await assert.rejects(sessions.open(task, 'readonly', {} as never), /不能取得原型写入权限/)
    assert.equal(creates, 0)
    await sessions.open(task, 'readonly', undefined)
    assert.equal(creates, 1)
    await assert.rejects(sessions.open(task, 'readonly', {} as never), /不能取得原型写入权限/)
    await sessions.dispose()
  } finally { for (const dispose of disposers.reverse()) dispose(); await rm(root, { recursive: true, force: true }) }
})


for (const reason of [{ kind: 'completed' }, { kind: 'error', error: { code: 'UNKNOWN', message: 'provider body must stay private' } }, { kind: 'aborted', reason: { kind: 'user' } }]) test('DSH forwards terminal ' + reason.kind + ' using the actual alpha4 turn/end event', async () => {
  const f = await fixture()
  try {
    const received: unknown[] = [], dsh = dshFixture(new Map())
    const sessions = new DshTaskSessions(dsh.context as never, '', async (_id, output) => { received.push(output) })
    const task = { projectId: 'project', entityId: 'requirement', sessionId: 'terminal-review', worktree: f.root, purpose: 'review' as const, reviewId: 'review', inputHash: 'fixed' }
    await sessions.open(task, 'readonly', undefined)
    dsh.emitEvent(task.sessionId, { type: 'turn/end', data: { turn: 1, reason } })
    assert.deepEqual(received, [{ kind: 'turn-ended', reason: reason.kind }])
    assert.equal(JSON.stringify(received).includes('provider body'), false)
    await sessions.dispose()
  } finally { await f.dispose() }
})
