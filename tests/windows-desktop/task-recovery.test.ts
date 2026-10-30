import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { studioToolGuard } from '../../packages/studio-plugin/src/host/adapters/platform/execution-guard.ts'
import { registerHooks } from 'node:module'
import { StudioApplication } from '../../packages/studio-plugin/src/host/application/studio.ts'
import { StudioStore } from '../../packages/studio-plugin/src/host/application/state.ts'
import type { PendingOperation } from '../../packages/studio-plugin/src/host/application/state.ts'
import { initialMetadata, type HostPorts } from '../../packages/studio-plugin/src/host/application/ports.ts'
import { materialText, readMaterial, saveMaterial } from '../../packages/studio-plugin/src/host/adapters/assets/materials.ts'
import type { CollaborationClient } from '../../packages/studio-plugin/src/host/adapters/collaboration/client.ts'
import { isMaterialIntegrationRequest, type EntityView, type IntegrationView, type MaterialIntegrationRequest, type ProjectState } from '../../packages/contracts/src/index.ts'

// Recovery tests isolate DSH message factories and installer registration.
// task-presets-runtime verifies the actual scoped assembly/request middleware.
const llmFactory = 'data:text/javascript,' + encodeURIComponent('export const createUserMessage = value => value; export const ReasoningEffortId = value => value')
const agentFactory = 'data:text/javascript,' + encodeURIComponent('export const installModelSelection = () => () => {}')
const toolsFactory = 'data:text/javascript,' + encodeURIComponent('export const defineTool = value => value')
const hooks = registerHooks({ resolve(specifier, context, nextResolve) { const url = specifier === '@deepseek-ai/dsh-llm' ? llmFactory : specifier === '@deepseek-ai/dsh-agent' ? agentFactory : specifier === '@deepseek-ai/dsh-tools' ? toolsFactory : undefined; return url ? { url, shortCircuit: true } : nextResolve(specifier, context) } })
const { DshTaskSessions } = await import('../../packages/studio-plugin/src/host/adapters/dsh/sessions.ts')
hooks.deregister()

const template = '## 场景范围\n'
const templateHash = createHash('sha256').update(template).digest('hex')
const requirementTemplate = '# 需求目标\n\n## 业务规则\n'
const requirementTemplateHash = createHash('sha256').update(requirementTemplate).digest('hex')
// Confirmed flow-only scenes need no uploaded evidence and remain valid split inputs.
const scenarioMetadata = () => ({ ...initialMetadata({ id: 'scenario', kind: 'scenario', title: '采购', templateId: 'default', templateRef: { commitSha: 'b'.repeat(40), path: '.template/default.md', sha256: templateHash } }), flowComplete: true })
const material = (version: number) => materialText(scenarioMetadata(), `# 固定场景 ${version}\n\n采购业务规则。\n`)
const hash = (version: number) => createHash('sha256').update(material(version)).digest('hex')
const output = (title: string, sourceId = 'scenario') => '```eadp-candidates\n' + JSON.stringify([{ title, summary: '需求摘要', goal: '采购可追溯', scope: '已提交采购申请', rules: ['申请完成后保留流水'], acceptanceCriteria: ['用户可核对申请结果'], openQuestions: [], sources: [{ entityId: sourceId, excerpts: [{ startLine: 3, endLine: 3, text: '采购业务规则。' }] }], body: `# ${title}\n\n采购可追溯\n\n已提交采购申请\n\n申请完成后保留流水\n\n用户可核对申请结果` }]) + '\n```'
async function fixture(failure?: 'session' | 'prompt') {
  const workspace = await mkdtemp(path.join(tmpdir(), 'studio-split-recovery-')), root = path.join(workspace, 'repo'); await mkdir(root, { recursive: true })
  const storeRoot = path.join(root, 'state')
  const store = new StudioStore(storeRoot); store.useUser(1)
  const local = await store.read()
  const scenario = (version: number): EntityView => {
    const entity: EntityView = { id: 'scenario', kind: 'scenario', title: '采购', templateId: 'default', templateRef: { commitSha: 'b'.repeat(40), path: '.template/default.md', sha256: templateHash }, revision: version, generation: 1, materialVersion: version, confirmationStatus: 'confirmed', taskStatus: 'idle', scenarioIds: [], prerequisites: [], authorId: 1 }
    entity.current = { version, confirmationId: `confirmation-${version}`, fixed: { commitSha: String(version).repeat(40), path: '场景/scenario.md', sha256: hash(version) }, metadata: scenarioMetadata(), confirmedBy: 1, confirmedAt: '', reuse: { enabled: true, reason: '' } }
    return entity
  }

  const remote: ProjectState = { project: { id: 'project', name: '测试项目', gitlabProjectId: 1, repositoryUrl: 'https://example.test/project.git', stableBranch: 'main', namespaceId: 1, namespacePath: 'test', initializationStatus: 'ready', recognizedHead: 'a'.repeat(40), revision: 1 }, entities: [scenario(1)], baselines: [], integrations: [] }
  const materialTask = { projectId: 'project', entityId: 'scenario', sessionId: 'material-session', purpose: 'material' as const, inputHash: '', worktree: path.join(root, 'worktree') }
  local.tasks.push(materialTask)
  const integrations = new Map<string, IntegrationView>()
  const addOperation = (version: number): PendingOperation => {
    const fixed = scenario(version).current!.fixed, id = `operation-${version}`
    const token = { occupationId: `occupation-${version}`, generation: version, taskId: path.basename(materialTask.worktree), clientId: local.clientId, expectedRevision: version }
    const prepare: MaterialIntegrationRequest = { idempotencyKey: id, entityId: 'scenario', token, sourceSha: fixed.commitSha, expectedHead: remote.project.recognizedHead!, candidateSha: fixed.commitSha,
      stage: 'material', allowedPaths: [fixed.path], checks: { candidateSha: fixed.commitSha, passed: true, checks: [{ name: 'materials', passed: true, evidenceHash: fixed.sha256 }] },
      confirmations: [{ entityId: 'scenario', expectedRevision: version, fixed, readHash: fixed.sha256, authorConfirmed: true, confirmationMethod: 'direct' }] }
    assert.ok(isMaterialIntegrationRequest(prepare))
    const integration: IntegrationView = { id: `integration-${version}`, entityId: 'scenario', ownerId: 1, status: 'accepted', sourceSha: prepare.sourceSha, expectedHead: prepare.expectedHead, candidateSha: prepare.candidateSha, stage: prepare.stage, confirmationIds: [`confirmation-${version}`], createdAt: '' }
    integrations.set(integration.id, integration); remote.integrations.push(integration)
    const operation: PendingOperation = { id, accountId: 1, projectId: 'project', entityId: 'scenario', task: { ...materialTask }, phase: 'accepted', candidateSha: prepare.candidateSha, expectedHead: prepare.expectedHead,
      fixedPath: fixed.path, sha256: fixed.sha256, integrationId: integration.id, prepare, token, accepted: structuredClone(integration) }
    local.operations.push(operation); return operation
  }
  const first = addOperation(1)
  local.selectedProjectId = 'project'; local.projects.push({ id: 'project', name: '测试项目', directory: root, workspaceDirectory: path.dirname(root), repositoryUrl: remote.project.repositoryUrl })
  await store.save()
  const calls = { sessions: [] as string[], prompts: [] as string[], promptTexts: [] as string[], creates: 0 }; const reservations = new Map<string, EntityView>(); let failed = false, corrupted = false
  const api = { request: async (method: string, route: string, body?: Record<string, unknown>) => {
    if (method === 'POST' && route.endsWith('/entities')) {
      const previous = reservations.get(String(body!.idempotencyKey)); if (previous) return previous
      calls.creates++
      const entity: EntityView = { id: `requirement-${calls.creates}`, kind: 'requirement', title: String(body!.title), templateId: String(body!.templateId), templateRef: body!.templateRef as EntityView['templateRef'], scenarioIds: (body!.sources as Array<{ entityId: string }>).map(source => source.entityId), scenarioSources: body!.sources as NonNullable<EntityView['scenarioSources']>, prerequisites: [], revision: 0, generation: 1, materialVersion: 0, confirmationStatus: 'draft', taskStatus: 'idle', authorId: 1 }
      reservations.set(String(body!.idempotencyKey), entity); remote.entities.push(entity); return entity
    }
    if (method === 'POST' && route.endsWith('/claim')) {
      const entity = remote.entities.find(value => value.id === route.split('/').at(-2))! as EntityView
      entity.occupation = { occupationId: `occupation-${entity.id}`, expectedRevision: entity.revision, entityId: entity.id, ownerId: 1, clientId: local.clientId, taskId: String(body!.taskId), generation: 1, purpose: 'design', inputVersion: entity.materialVersion, prerequisiteBindings: [], createdAt: '' }; return entity
    }
    if (method === 'POST') throw new Error('unexpected write')
    if (route === '/v1/projects') return [remote.project]
    if (route === '/v1/namespaces') return []
    if (route === '/v1/projects/project/templates') { const catalog = { defaultTemplateId: 'default', templates: [{ id: 'default', name: '默认', fixed: { commitSha: 'b'.repeat(40), path: '.template/default.md', sha256: templateHash } }] }; return { acceptedHead: remote.project.recognizedHead, scenarios: catalog, requirements: { defaultTemplateId: 'requirement-default', templates: [{ id: 'requirement-default', name: '默认需求', fixed: { commitSha: 'b'.repeat(40), path: '.template/requirement-default.md', sha256: requirementTemplateHash } }] } } }
    if (route.includes('/operations/')) { const operation = local.operations.find(value => value.id === route.split('/').at(-1)); return { action: 'integration.prepare', result: operation?.accepted } }
    if (route.includes('/integrations/')) return integrations.get(route.split('/').at(-1)!)
    return remote
  } } as unknown as CollaborationClient
  const ports = { git: { state: async () => ({ root, head: 'a'.repeat(40), branch: 'main', dirty: false, repositoryUrl: remote.project.repositoryUrl }), createWorktree: async (_source: string, target: string) => mkdir(target, { recursive: true }), hasCommit: async () => true, fetchCommit: async () => {}, readBlob: async (_directory: string, sha: string, file: string) => Buffer.from(file === '.template/default.md' ? template : file === '.template/requirement-default.md' ? requirementTemplate : corrupted ? 'modified input' : material(Number(sha[0]))) }, account: async () => ({ id: 1 }), stopPreview: async () => {}, session: async (task: { sessionId: string }) => { calls.sessions.push(task.sessionId); if (failure === 'session' && !failed) { failed = true; throw new Error('injected session failure') }; return task.sessionId }, prompt: async (sessionId: string, text: string) => { calls.prompts.push(sessionId); calls.promptTexts.push(text); if (failure === 'prompt' && !failed) { failed = true; throw new Error('injected prompt failure') } } } as unknown as HostPorts
  const apps: StudioApplication[] = []
  const createApp = (nextStore = store) => { const app = new StudioApplication(nextStore, api, ports); apps.push(app); return app }
  return { root, ports, api, store, storeRoot, remote, local, calls, first, addOperation, createApp, corruptInput: (value: boolean) => { corrupted = value }, nextVersion: (version: number) => { remote.entities = [scenario(version)] }, dispose: async () => { for (const app of apps) await app.dispose(); await rm(workspace, { recursive: true, force: true }) } }
}

test('accepted confirmation recovery offers splitting and waits for an explicit split command', async () => {
  const f = await fixture()
  try {
    const app = f.createApp()
    const recovered = await app.command({ action: 'retryOperation', operationId: f.first.id })
    assert.equal(recovered.ok, true, JSON.stringify(recovered))
    // Recovery continues on the background lane; the recorded operation and the
    // offered split are visible once that work settles.
    await app.settle()
    assert.equal(f.local.tasks.filter(task => task.purpose === 'split').length, 0)
    assert.equal(f.calls.sessions.length, 0); assert.equal(f.calls.prompts.length, 0)
    assert.equal(f.local.scenarios.find(record => record.entityId === 'scenario')!.splitOffered, true)
    const split = await app.command({ action: 'splitScenario', entityId: 'scenario' })
    assert.equal(split.ok, true, JSON.stringify(split))
    assert.equal(f.local.tasks.filter(task => task.purpose === 'split').length, 1)
    assert.equal(f.calls.prompts.length, 1)
  } finally { await f.dispose() }
})

for (const failure of ['session', 'prompt'] as const) test(`failed ${failure} restores the same immutable task, while explicit split starts a new round`, async () => {
  const f = await fixture(failure)
  try {
    let app = f.createApp()
    assert.equal((await app.command({ action: 'splitScenario', entityId: 'scenario' })).ok, false)
    assert.equal(f.first.phase, 'accepted')
    const task = (await f.store.read()).tasks.find(task => task.purpose === 'split')!
    assert.ok(task)
    const rebooted = new StudioStore(f.storeRoot); rebooted.useUser(1); app = f.createApp(rebooted)
    assert.equal((await app.command({ action: 'restoreSession', sessionId: task.sessionId })).ok, true)
    assert.equal((await rebooted.read()).tasks.filter(task => task.purpose === 'split').length, 1)
    assert.equal(f.calls.prompts.at(-1), task.sessionId)
    await app.acceptSessionOutput(task.sessionId, { kind: 'assistant', content: output('候选一') })
    await app.command({ action: 'splitScenario', entityId: 'scenario' })
    await app.acceptSessionOutput(task.sessionId, { kind: 'assistant', content: output('重放不能覆盖') })
    assert.equal((await rebooted.read()).tasks.filter(task => task.purpose === 'split').length, 2)
    assert.equal((await rebooted.read()).candidates[0]!.title, '候选一')
  } finally { await f.dispose() }
})

test('new confirmed versions have independent candidates and preserve adopted source provenance', async () => {
  const f = await fixture()
  try {
    const app = f.createApp()
    await app.command({ action: 'splitScenario', entityId: 'scenario' })
    const oldTask = f.local.tasks.find(task => task.purpose === 'split')!
    await app.acceptSessionOutput(oldTask.sessionId, { kind: 'assistant', content: output('旧候选') })
    f.local.candidates[0]!.selectedEntityId = 'adopted-requirement'; await f.store.save()
    f.nextVersion(2); f.addOperation(2); await f.store.save()
    await app.command({ action: 'splitScenario', entityId: 'scenario' })
    const newTask = f.local.tasks.filter(task => task.purpose === 'split').at(-1)!
    assert.notEqual(newTask.sessionId, oldTask.sessionId)
    await app.acceptSessionOutput(newTask.sessionId, { kind: 'assistant', content: output('新候选') })
    assert.equal(f.local.candidates.length, 2)
    assert.equal(f.local.candidates[0]!.selectedEntityId, 'adopted-requirement')
    const current = f.local.candidates[1]! as unknown as Record<string, unknown>
    assert.equal(current.projectId, 'project'); assert.equal(current.sessionId, newTask.sessionId)
    assert.deepEqual(f.local.candidates[1]!.sources.map(source => [source.confirmationId, source.version, source.fixed.sha256]), [['confirmation-2', 2, hash(2)]])
  } finally { await f.dispose() }
})

test('late old-session output retains its accepted historical confirmation and retries do not replace it', async () => {
  const f = await fixture()
  try {
    const app = f.createApp(); await app.command({ action: 'splitScenario', entityId: 'scenario' })
    const oldTask = f.local.tasks.find(task => task.purpose === 'split')!
    f.nextVersion(2)
    await app.acceptSessionOutput(oldTask.sessionId, { kind: 'assistant', content: output('迟到旧候选') })
    assert.equal(f.local.candidates.length, 1)
    assert.equal(f.local.candidates[0]!.sources[0]!.confirmationId, 'confirmation-1')
    const prompts = f.calls.prompts.length
    await app.command({ action: 'retryOperation', operationId: f.first.id })
    assert.equal(f.calls.prompts.length, prompts)
    assert.equal(f.local.tasks.filter(task => task.purpose === 'split').length, 1)
  } finally { await f.dispose() }
})

test('historical candidates remain visible and adoption writes their complete content with the original source', async () => {
  const f = await fixture()
  try {
    const app = f.createApp(); await app.command({ action: 'splitScenario', entityId: 'scenario' })
    const task = f.local.tasks.find(task => task.purpose === 'split')!
    await app.acceptSessionOutput(task.sessionId, { kind: 'assistant', content: output('历史候选') })
    const candidate = f.local.candidates[0]!
    f.nextVersion(2)
    assert.equal((await app.state()).candidates.length, 1)
    assert.equal((await app.command({ action: 'selectCandidate', candidateId: candidate.id, expectedInputHash: 'stale' })).ok, false)
    assert.equal(f.calls.creates, 0)
    const reply = await app.command({ action: 'selectCandidate', candidateId: candidate.id, expectedInputHash: candidate.inputHash })
    assert.equal(reply.ok, true, JSON.stringify(reply))
    assert.equal(f.calls.creates, 1)
    const requirement = f.remote.entities.find(value => value.kind === 'requirement')! as EntityView
    assert.equal(requirement.scenarioSources![0]!.version, 1)
    assert.equal(requirement.templateId, 'requirement-default')
    const materialTask = f.local.tasks.find(value => value.entityId === requirement.id && value.purpose === 'material')!
    const draft = await readMaterial(materialTask.worktree, 'requirement', requirement.id)
    assert.equal(draft.body, candidate.body)
    assert.match(draft.body, /申请完成后保留流水/)
    assert.match(draft.body, /confirmation-1/)
    const evidence = draft.metadata.businessEvidence[0]!
    assert.equal(evidence.files[0]!.sha256, hash(1))
    const archived = await readFile(path.join(materialTask.worktree, evidence.files[0]!.path), 'utf8')
    assert.equal(archived, material(1))
    const range = evidence.ranges[0]!
    assert.equal(archived.split('\n').slice(range.startLine - 1, range.endLine).join('\n'), '采购业务规则。')
    assert.equal((await app.command({ action: 'selectCandidate', candidateId: candidate.id, expectedInputHash: candidate.inputHash })).ok, true)
    assert.equal(f.calls.creates, 1)
  } finally { await f.dispose() }
})

test('empty completed output is durable and malformed output can be corrected', async () => {
  const f = await fixture()
  try {
    const app = f.createApp(); await app.command({ action: 'splitScenario', entityId: 'scenario' })
    const task = f.local.tasks.find(task => task.purpose === 'split')!
    await assert.rejects(app.acceptSessionOutput(task.sessionId, { kind: 'assistant', content: output('').replace('需求摘要', 'x') }), /无效/)
    await app.acceptSessionOutput(task.sessionId, { kind: 'assistant', content: '```eadp-candidates\n[]\n```' })
    await app.acceptSessionOutput(task.sessionId, { kind: 'assistant', content: output('完成后重放') })
    await app.command({ action: 'splitScenario', entityId: 'scenario' })
    assert.equal(f.local.candidates.length, 0); assert.equal(f.calls.prompts.length, 2)
  } finally { await f.dispose() }
})


test('explicit supplemental splits keep independent sessions and only verified fixed business input', async () => {
  const f = await fixture()
  try {
    const app = f.createApp()
    await app.command({ action: 'splitScenario', entityId: 'scenario' })
    await app.command({ action: 'splitScenario', entityId: 'scenario' })
    assert.equal(f.calls.prompts.length, 2)
    assert.notEqual(f.calls.prompts[0], f.calls.prompts[1])
    assert.match(f.calls.promptTexts[0]!, /3: 采购业务规则。/)
    assert.ok(f.calls.promptTexts[0]!.includes(hash(1)))
    assert.equal(f.local.tasks.find(task => task.purpose === 'split')!.split!.status, 'sent')
  } finally { await f.dispose() }
})

test('the joint split command gives each candidate only its actual selected source subset', async () => {
  const f = await fixture()
  try {
    const metadata = { ...scenarioMetadata(), entityId: 'scenario-second', title: '预算' }
    const bytes = materialText(metadata, '# 预算控制\n\n采购业务规则。\n')
    const original = f.remote.entities[0]! as EntityView
    const second: EntityView = { ...original, id: metadata.entityId, title: metadata.title, current: { ...original.current!, metadata, confirmationId: 'confirmation-second', fixed: { commitSha: 'c'.repeat(40), path: '场景/预算.md', sha256: createHash('sha256').update(bytes).digest('hex') } } }
    f.remote.entities.push(second)
    const readBlob = f.ports.git.readBlob
    f.ports.git.readBlob = async (directory, sha, file) => file === second.current!.fixed.path ? Buffer.from(bytes) : readBlob(directory, sha, file)
    const app = f.createApp()
    const reply = await app.command({ action: 'splitRequirements', scenarioIds: ['scenario', second.id] })
    assert.equal(reply.ok, true, JSON.stringify(reply))
    const task = f.local.tasks.find(task => task.purpose === 'split')!
    assert.deepEqual(task.split!.sources.map(source => source.entityId), ['scenario', second.id])
    await app.acceptSessionOutput(task.sessionId, { kind: 'assistant', content: output('联合能力', second.id) })
    assert.deepEqual(f.local.candidates[0]!.sources.map(source => source.entityId), [second.id])
    second.builtinKey = 'general'
    const refused = await app.command({ action: 'splitRequirements', scenarioIds: [second.id] })
    assert.equal(refused.ok, false)
    if (!refused.ok) assert.match(refused.message, /普通场景/)
    assert.equal(f.calls.prompts.length, 1)
  } finally { await f.dispose() }
})

test('a newer confirmation does not replace the old split fixed reference', async () => {
  const f = await fixture()
  try {
    const app = f.createApp(); await app.command({ action: 'splitScenario', entityId: 'scenario' })
    const task = f.local.tasks.find(task => task.purpose === 'split')!
    f.remote.entities[0]!.current!.confirmationId = 'different-confirmation'
    await app.acceptSessionOutput(task.sessionId, { kind: 'assistant', content: output('相同哈希的旧确认') })
    assert.equal(f.local.candidates.length, 1)
    assert.equal(f.local.candidates[0]!.sources[0]!.confirmationId, 'confirmation-1')
  } finally { await f.dispose() }
})


test('fixed input integrity failure sends no model request and a new request succeeds after repair', async () => {
  const f = await fixture()
  try {
    const app = f.createApp(); f.corruptInput(true)
    const result = await app.command({ action: 'splitScenario', entityId: 'scenario' })
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.message, /哈希/)
    assert.equal(f.calls.prompts.length, 0); assert.equal(f.calls.sessions.length, 0)
    f.corruptInput(false)
    assert.equal((await app.command({ action: 'splitScenario', entityId: 'scenario' })).ok, true)
    assert.equal(f.local.tasks.filter(task => task.purpose === 'split').length, 1)
  } finally { await f.dispose() }
})

function dshFixture(events: Map<string, unknown[]>) {
  let listener: (session: { id: string }, event: unknown) => void = () => {}
  const counts = { creates: 0, resumes: 0, followups: 0 }
  const context = {
    attachments: { admitPromptContent: async (content: unknown) => content },
    sessions: { flush: async () => true },
    agentDefaultModel: { currentSelection: () => ({ provider: 'default-provider', model: 'default-model' }) },
    agentPresets: { resolve: async () => ({ id: 'standard' }), mount: async () => {} },
    sessionProjections: { restore: () => ({ snapshot: { values: { agentPreset: null } } }) },
    on: (event: string, callback: typeof listener) => { if (event === 'session/event') listener = callback; return () => {} }, effect: () => {},
    sessionController: { inspect: async (id: string) => { if (!events.has(id)) throw new Error('not persisted'); return { events: events.get(id) } } },
    agents: {
      get: () => undefined,
      create: async ({ sessionId }: { sessionId: string }) => { counts.creates++; events.set(sessionId, []); return handle(sessionId) },
      resume: async ({ resumeSessionId }: { resumeSessionId: string }) => { assert.ok(events.has(resumeSessionId)); counts.resumes++; return handle(resumeSessionId) },
    },
  }
  const handle = (sessionId: string) => ({ agent: { session: { id: sessionId }, followup: (message: unknown) => { counts.followups++; events.get(sessionId)!.push({ type: 'user/message', data: message }) } }, dispose: async () => {} })
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
    assert.equal((await app.command({ action: 'splitScenario', entityId: 'scenario' })).ok, true)
    const task = f.local.tasks.find(task => task.purpose === 'split')!
    assert.equal(firstDsh.counts.followups, 1); await sessions.dispose()
    const store = new StudioStore(f.storeRoot); store.useUser(1)
    const resumed = dshFixture(events); app = f.createApp(store)
    sessions = new DshTaskSessions(resumed.context as never, '', (id, text) => app.acceptSessionOutput(id, text))
    assert.equal((await app.command({ action: 'restoreSession', sessionId: task.sessionId })).ok, true)
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
    let app = f.createApp(); await app.command({ action: 'splitScenario', entityId: 'scenario' })
    const task = f.local.tasks.find(task => task.purpose === 'split')!
    const events = new Map([[task.sessionId, [assistant(output('被中断输出'), true), assistant(output('持久候选'))]]])
    const store = new StudioStore(f.storeRoot); store.useUser(1); app = f.createApp(store)
    const dsh = dshFixture(events), sessions = new DshTaskSessions(dsh.context as never, '', (id, text) => app.acceptSessionOutput(id, text))
    f.ports.session = (next, rules) => sessions.open(next, rules, undefined); f.ports.prompt = (id, text) => sessions.prompt(id, text)
    assert.equal((await app.command({ action: 'restoreSession', sessionId: task.sessionId })).ok, true)
    await app.acceptSessionOutput(task.sessionId, { kind: 'assistant', content: '' })
    assert.equal((await store.read()).candidates[0]!.title, '持久候选')
    await app.command({ action: 'restoreSession', sessionId: task.sessionId }); await app.acceptSessionOutput(task.sessionId, { kind: 'assistant', content: '' })
    assert.equal((await store.read()).candidates.length, 1); assert.equal(dsh.counts.followups, 0); assert.equal(dsh.counts.creates, 0)
    await sessions.dispose()
  } finally { await f.dispose() }
})

test('persisted output retains the historical fixed confirmation after a newer version', async () => {
  const f = await fixture()
  try {
    let app = f.createApp(); await app.command({ action: 'splitScenario', entityId: 'scenario' })
    const task = f.local.tasks.find(task => task.purpose === 'split')!
    f.nextVersion(2)
    const store = new StudioStore(f.storeRoot); store.useUser(1); app = f.createApp(store)
    const dsh = dshFixture(new Map([[task.sessionId, [assistant(output('过期持久输出'))]]]))
    let deliveries = 0
    const sessions = new DshTaskSessions(dsh.context as never, '', (id, text) => { deliveries++; return app.acceptSessionOutput(id, text) })
    await sessions.open(task, '', undefined); await app.acceptSessionOutput(task.sessionId, { kind: 'assistant', content: '' })
    assert.equal(deliveries, 1); assert.equal((await store.read()).candidates.length, 1); assert.equal(dsh.counts.followups, 0)
    await sessions.dispose()
  } finally { await f.dispose() }
})


test('sent recovery with unreadable history fails closed without creating or prompting a replacement', async () => {
  const f = await fixture()
  try {
    let app = f.createApp(); await app.command({ action: 'splitScenario', entityId: 'scenario' })
    const task = f.local.tasks.find(task => task.purpose === 'split')!
    const store = new StudioStore(f.storeRoot); store.useUser(1); app = f.createApp(store)
    const dsh = dshFixture(new Map()), sessions = new DshTaskSessions(dsh.context as never, '', (id, text) => app.acceptSessionOutput(id, text))
    f.ports.session = (task, rules) => sessions.open(task, rules, undefined); f.ports.prompt = (id, text) => sessions.prompt(id, text)
    const result = await app.command({ action: 'restoreSession', sessionId: task.sessionId })
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
    let app = f.createApp(); await app.command({ action: 'splitScenario', entityId: 'scenario' })
    const task = f.local.tasks.find(task => task.purpose === 'split')!
    const store = new StudioStore(f.storeRoot); store.useUser(1); app = f.createApp(store)
    const dsh = dshFixture(new Map([[task.sessionId, [assistant(output('可重放候选'))]]]))
    let attempts = 0
    const sessions = new DshTaskSessions(dsh.context as never, '', (id, text) => { attempts++; return attempts === 1 ? Promise.reject(new Error('injected delivery failure')) : app.acceptSessionOutput(id, text) })
    f.ports.session = (next, rules) => sessions.open(next, rules, undefined)
    await app.command({ action: 'restoreSession', sessionId: task.sessionId }); await app.acceptSessionOutput(task.sessionId, { kind: 'assistant', content: '' })
    assert.equal((await store.read()).candidates.length, 0)
    await app.command({ action: 'restoreSession', sessionId: task.sessionId }); await app.acceptSessionOutput(task.sessionId, { kind: 'assistant', content: '' })
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
    await app.command({ action: 'splitScenario', entityId: 'scenario' })
    const task = f.local.tasks.find(task => task.purpose === 'split')!
    assert.equal(firstDsh.counts.followups, 1)
    // The official user/message is durable; the Host crashes before its sent status/candidates save.
    task.split!.status = status; await f.store.save(); await sessions.dispose()
    events.get(task.sessionId)!.push(assistant(output('投递崩溃窗口候选')))
    const store = new StudioStore(f.storeRoot); store.useUser(1); app = f.createApp(store)
    const dsh = dshFixture(events); sessions = new DshTaskSessions(dsh.context as never, '', (id, text) => app.acceptSessionOutput(id, text))
    const restored = await app.command({ action: 'restoreSession', sessionId: task.sessionId })
    assert.equal(restored.ok, true, JSON.stringify(restored))
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
    const app = f.createApp(); await app.command({ action: 'splitScenario', entityId: 'scenario' })
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
  const workspace = await mkdtemp(path.join(tmpdir(), 'studio-review-guard-')), root = path.join(workspace, 'repo'); await mkdir(root, { recursive: true })
  const disposers: Array<() => void> = []
  try {
    await writeFile(path.join(root, 'reviewed.md'), 'fixed candidate')
    let creates = 0
    const context = {
      agentDefaultModel: { currentSelection: () => ({ provider: 'default-provider', model: 'default-model' }) },
    agentPresets: { resolve: async () => ({ id: 'standard' }), mount: async () => {} },
      sessionProjections: { restore: () => ({ snapshot: { values: { agentPreset: null } } }) },
      on: () => () => {}, effect: () => {},
      sessionController: { inspect: async () => { throw new Error('new session') } },
      agents: { get: () => undefined, create: async ({ setup }: { setup: (scope: unknown, agent: unknown) => Promise<void> }) => {
        creates++
        const agent = { session: { header: { cwd: root } }, followup: () => {} }
        await setup({ systemPrompt: { section: () => {} }, effect: (register: () => () => void) => { disposers.push(register()) } }, agent)
        const attempt = (name: string, file = 'reviewed.md') => studioToolGuard({ name, arguments: { file_path: file }, agent })
        assert.equal(attempt('read'), undefined)
        assert.ok(attempt('write')); assert.ok(attempt('edit')); assert.ok(attempt('bash')); assert.ok(attempt('read', '../outside'))
        return { agent, dispose: async () => {} }
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
  } finally { for (const dispose of disposers.reverse()) dispose(); await rm(workspace, { recursive: true, force: true }) }
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


for (const restore of [false, true]) test('task sessions mount the resolved official preset before publishing ' + (restore ? 'resumed' : 'new') + ' Agents', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'studio-preset-')), root = path.join(workspace, 'repo'); await mkdir(root, { recursive: true })
  const disposers: Array<() => void> = [], mounted: string[] = [], resolved: Array<string | undefined> = [], sections: string[] = [], variables: string[] = []
  let published = 0
  const setupAgent = async (options: any) => {
    assert.deepEqual(options.agentOptions, restore ? { provider: 'deepseek-account', model: 'deepseek-flash' } : { provider: 'default-provider', model: 'default-model' }, 'real request routing belongs to AgentOptions')
    if (!restore) assert.equal(options.meta.agentPreset, 'standard')
    const agent = { session: { header: { cwd: root } }, followup: () => {} }
    await options.setup({
      systemPrompt: { section: ({ name }: { name: string }) => { sections.push(name) }, variable: (name: string) => { variables.push(name); return () => {} } },
      effect: (register: () => () => void) => { disposers.push(register()) },
    }, agent)
    assert.deepEqual(mounted, [restore ? 'selected' : 'standard'])
    assert.ok(sections.includes('eadp-task'))
    published++
    return { agent, dispose: async () => {} }
  }
  const context = {
    on: () => () => {}, effect: () => {},
    sessionProjections: { restore: (_checkpoint: unknown, events: any[], _base: number, meta: any) => { assert.equal(meta.agentPreset, 'original'); assert.equal(events[0].data.agentPreset, 'selected'); return { checkpoint: { modelSelection: { val: { pending: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' }, lastUsed: null } } }, snapshot: { values: { agentPreset: 'selected', ...(restore ? { modelSelection: { next: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' } } } : {}) } } } } },
    agentDefaultModel: { currentSelection: () => ({ provider: 'default-provider', model: 'default-model' }) },
    agentPresets: { resolve: async (id?: string) => { resolved.push(id); return { id: id ?? 'standard' } }, mount: async (_scope: unknown, id: string) => { mounted.push(id) } },
    sessionController: { inspect: async () => { if (!restore) throw new Error('new session'); return { meta: { agentPreset: 'original' }, inheritedEventCount: 0, events: [{ type: 'agent-preset/selected', data: { agentPreset: 'selected' } }] } } },
    agents: { get: () => undefined, create: setupAgent, resume: setupAgent },
  }
  const sessions = new DshTaskSessions(context as never, '', async () => {})
  try {
    const task = { projectId: 'project', entityId: 'requirement', sessionId: 'session', worktree: root, purpose: 'material' as const, inputHash: '' }
    await sessions.open(task, 'fixed rules', undefined)
    await sessions.open(task, 'fixed rules', undefined)
    assert.equal(published, 1, 'opening an existing handle does not remount its preset')
    assert.deepEqual(resolved, [restore ? 'selected' : undefined])
    assert.deepEqual(variables, [], 'official loop owns provider/model prompt variables')
  } finally { await sessions.dispose(); for (const dispose of disposers.reverse()) dispose(); await rm(workspace, { recursive: true, force: true }) }
})


test('a broken official preset prevents publication and cannot fall through to a tool-less Agent', async () => {
  let creates = 0
  const sessions = new DshTaskSessions({ on: () => () => {}, effect: () => {},
    sessionController: { inspect: async () => { throw new Error('new session') } },
    agentPresets: { resolve: async () => { throw new Error('preset unavailable') } },
    agents: { create: async () => { creates++; throw new Error('must not create') } },
  } as never, '', async () => {})
  try {
    await assert.rejects(sessions.open({ projectId: 'project', entityId: 'requirement', sessionId: 'session', worktree: 'unused', purpose: 'material', inputHash: '' }, '', undefined), /preset unavailable/)
    assert.equal(creates, 0)
  } finally { await sessions.dispose() }
})

test('an already live conversation Agent is reused and receives the Studio task scope', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'studio-live-reuse-')), root = path.join(workspace, 'repo'); await mkdir(root, { recursive: true })
  const material = await saveMaterial(root, initialMetadata({ id: 'entity', kind: 'requirement', title: '合成需求', templateId: 'default', templateRef: { commitSha: 'b'.repeat(40), path: '.template/default.md', sha256: templateHash } }), '# entity\n')
  const live = {
    session: { header: { id: 'live-session', cwd: root }, requestHeader: () => undefined },
    ctx: { systemPrompt: { section: () => {} }, effect: (register: () => () => void) => { register() } },
    followup: () => {},
  }
  const context = {
    on: () => () => {}, effect: () => {},
    sessionProjections: { restore: () => ({ snapshot: { values: {} } }) },
    agentDefaultModel: { currentSelection: () => ({ provider: 'default-provider', model: 'default-model' }) },
    agentPresets: { resolve: async () => ({ id: 'standard' }), mount: async () => {} },
    sessionController: { inspect: async () => { throw new Error('new session') } },
    agents: {
      get: (id: string) => id === 'live-session' ? live : undefined,
      create: async () => { throw new Error('must reuse the live Agent') },
      resume: async () => { throw new Error('must not open a second write handle') },
    },
  }
  const sessions = new DshTaskSessions(context as never, '', async () => {})
  try {
    await sessions.open({ projectId: 'project', entityId: 'entity', sessionId: 'live-session', worktree: root, purpose: 'material', inputHash: '' }, 'fixed rules', undefined)
    assert.equal(studioToolGuard({ name: 'read', arguments: { file_path: material.path }, agent: live }), undefined)
    assert.ok(studioToolGuard({ name: 'write', arguments: { file_path: material.path }, agent: live }))
    assert.ok(studioToolGuard({ name: 'write', arguments: { file_path: '需求/other.md' }, agent: live }))
  } finally { await sessions.dispose(); await rm(workspace, { recursive: true, force: true }) }
})


test('prototype resumes and replays persisted terminal events on an existing handle without sending another prompt', async () => {
  const task = { projectId: 'p', entityId: 't', purpose: 'prototype' as const, sessionId: 'prototype-replay', worktree: '.', inputHash: '' }
  const event = { seq: 17, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }
  const dsh = dshFixture(new Map([[task.sessionId, [event]]]))
  const outputs: unknown[] = []
  const sessions = new DshTaskSessions(dsh.context as never, '', async (_id, output) => { outputs.push(output) })
  try {
    await sessions.open(task, '', undefined, true)
    await sessions.open(task, '', undefined, true)
    assert.deepEqual(outputs, [
      { kind: 'turn-ended', reason: 'completed', seq: 17 },
      { kind: 'turn-ended', reason: 'completed', seq: 17 },
    ])
    assert.deepEqual(dsh.counts, { creates: 0, resumes: 1, followups: 0 })
  } finally { await sessions.dispose() }
})


test('prototype input authority allows downstream runtime context but rejects external claimed messages', async () => {
  const dsh = dshFixture(new Map())
  let preStep: any
  const scope = { systemPrompt: { section() {} }, on(name: string, callback: unknown) { if (name === 'agent/pre-step') preStep = callback } }
  dsh.context.agents.create = (async ({ setup }: any) => {
    await setup(scope, {})
    throw new Error('setup must stop at authorization fixture')
  }) as never
  const manifest = path.resolve('packages/studio-plugin/assets/prototype-template.manifest.json')
  const task = { projectId: 'p', entityId: 't', purpose: 'prototype' as const, sessionId: 'authority', worktree: '.', inputHash: '' }
  const sessions = new DshTaskSessions(dsh.context as never, manifest, async () => {}, undefined, undefined, async () => { throw new Error('authorization fixture') })
  await assert.rejects(sessions.open(task, '', { prototypeRoot: '.', manifestPath: manifest, projectId: 'p', prototypeTaskId: 't', sessionId: task.sessionId, sourceSha: 'a'.repeat(40) }), /authorization fixture/)
  const authorized = { source: { kind: 'studio-task' } }
  const runtimeContext = { source: { kind: 'runtime-context' } }
  const decision = { kind: 'enter', messages: [authorized, runtimeContext] }
  let calls = 0
  const next = async () => { calls++; return decision }
  assert.equal(await preStep({ messages: [authorized] }, next), decision)
  assert.deepEqual(await preStep({ messages: [{ source: { kind: 'user' } }] }, next), { kind: 'reject' })
  assert.equal(calls, 1)
  await sessions.dispose()
})


test('prototype terminal watermark reads the latest persisted end without dispatch or replay', async () => {
  const events = new Map<string, unknown[]>([['persisted', [
    { seq: 3, type: 'turn/end', data: { reason: { kind: 'completed' } } },
    { seq: 7, type: 'turn/end', data: { reason: { kind: 'blocked' } } },
    { seq: 8, type: 'turn/start', data: { turn: 3 } },
  ]], ['empty', []]])
  const dsh = dshFixture(events)
  let deliveries = 0
  const sessions = new DshTaskSessions(dsh.context as never, '', async () => { deliveries++ })
  assert.deepEqual(await sessions.lastPrototypeTurn('persisted'), { kind: 'turn-ended', reason: 'blocked', seq: 7 })
  assert.equal(await sessions.lastPrototypeTurn('empty'), undefined)
  assert.equal(deliveries, 0)
  assert.deepEqual(dsh.counts, { creates: 0, resumes: 0, followups: 0 })
  await sessions.dispose()
})
