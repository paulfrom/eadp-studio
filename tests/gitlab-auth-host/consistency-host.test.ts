import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { isMaterialIntegrationRequest, type ConsistencyComparisonView, type ConsistencyContextView, type IntegrationView, type MaterialIntegrationRequest, type MaterialMetadata, type ProjectState, type SubmitConsistencyComparisonRequest } from '../../packages/contracts/src/index.ts'
import type { StudioReply, StudioState, TaskView } from '../../packages/studio-plugin/src/shared/studio.ts'
import type { ConsistencyModelInput } from '../../packages/studio-plugin/src/shared/consistency.ts'
import type { HostPorts } from '../../packages/studio-plugin/src/host/application/ports.ts'
import { StudioApplication } from '../../packages/studio-plugin/src/host/application/studio.ts'
import { StudioStore, type PendingOperation } from '../../packages/studio-plugin/src/host/application/state.ts'
import { saveMaterial } from '../../packages/studio-plugin/src/host/adapters/assets/materials.ts'
import { CollaborationError, type CollaborationClient } from '../../packages/studio-plugin/src/host/adapters/collaboration/client.ts'

const noConflicts = JSON.stringify({ summary: '本次范围未发现冲突', conflicts: [] })
const metadata: MaterialMetadata = { entityId: 'scene', kind: 'scenario', title: '审批', templateId: 'default', templateRef: { commitSha: 'a'.repeat(40), path: '.template/default.md', sha256: 'b'.repeat(64) }, scenarioIds: [], sources: [], prerequisites: [], referencedAssets: [], businessEvidence: [], openQuestions: [], coreRulesPresent: false, acceptanceCriteriaPresent: false }
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('异步流程未在独立调度边界内完成')), 2000) })]) }
  finally { if (timer) clearTimeout(timer) }
}
function successful(reply: StudioReply): StudioState { assert.equal(reply.ok, true, JSON.stringify(reply)); if (!reply.ok) throw new Error(reply.message); return reply.state }

async function fixture(t: { after(fn: () => Promise<unknown>): unknown }, automatic = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'eadp-consistency-command-')), directory = path.join(root, 'main'), worktree = path.join(root, 'task')
  await mkdir(directory); await mkdir(worktree)
  await mkdir(path.join(directory, '需求')); await mkdir(path.join(worktree, '需求'))
  const oldDraft = await saveMaterial(directory, metadata, 'MAIN-OLD-CONTENT：旧规则。')
  const draft = await saveMaterial(worktree, metadata, 'TASK-ACCEPTED-CONTENT：本次确认的新规则。')
  const store = new StudioStore(path.join(root, 'state')); store.useUser(1)
  const local = await store.read(); local.selectedProjectId = 'project'
  local.projects.push({ id: 'project', name: '项目', directory, repositoryUrl: 'https://example.test/project.git' })
  const task: TaskView = { projectId: 'project', entityId: 'scene', sessionId: 'material-session', purpose: 'material', inputHash: draft.sha256, worktree }
  local.tasks.push(task)
  const candidateSha = 'c'.repeat(40)
  const remote = { project: { id: 'project', name: '项目', gitlabProjectId: 1, repositoryUrl: 'https://example.test/project.git', stableBranch: 'main', recognizedHead: candidateSha, revision: 2, initializationStatus: 'ready' }, entities: [{ id: 'scene', kind: 'scenario', title: '审批', generation: 1, materialVersion: 1, revision: 2, current: { confirmationId: 'accepted-confirmation', version: 1, fixed: { commitSha: candidateSha, path: draft.path, sha256: draft.sha256 }, metadata, confirmedBy: 1, confirmedAt: '' } }], integrations: [], baselines: [] } as unknown as ProjectState
  const token = { occupationId: 'design-occupation', generation: 1, taskId: path.basename(task.worktree), clientId: local.clientId, expectedRevision: 1 }
  const prepare: MaterialIntegrationRequest = { idempotencyKey: 'confirmation-operation', entityId: task.entityId, token, sourceSha: candidateSha, expectedHead: 'a'.repeat(40), candidateSha,
    stage: 'material', allowedPaths: [draft.path], checks: { candidateSha, passed: true, checks: [{ name: 'materials', passed: true, evidenceHash: draft.sha256 }] },
    confirmations: [{ entityId: task.entityId, expectedRevision: token.expectedRevision, fixed: { commitSha: candidateSha, path: draft.path, sha256: draft.sha256 }, readHash: draft.sha256, authorConfirmed: true, confirmationMethod: 'direct' }] }
  assert.ok(isMaterialIntegrationRequest(prepare))
  const integration: IntegrationView = { id: 'integration', entityId: 'scene', ownerId: 1, status: 'accepted', stage: prepare.stage, confirmationIds: ['accepted-confirmation'], candidateSha, sourceSha: prepare.sourceSha, expectedHead: prepare.expectedHead, createdAt: '' }
  const operation: PendingOperation = { id: prepare.idempotencyKey, accountId: 1, projectId: 'project', entityId: 'scene', task: { ...task }, phase: 'prepared', candidateSha, expectedHead: prepare.expectedHead,
    fixedPath: draft.path, sha256: draft.sha256, integrationId: integration.id, prepare, token }
  if (automatic) local.operations.push(operation)
  const context: ConsistencyContextView = { entity: { id: 'scene', kind: 'scenario', title: '审批', revision: 2, materialVersion: 1, confirmationStatus: 'confirmed', occupied: false }, sources: [], requirements: [], prerequisites: [] }
  const apiCalls: Array<{ method: string; route: string; body?: SubmitConsistencyComparisonRequest }> = [], inputs: ConsistencyModelInput[] = [], capabilities: string[] = []
  const accepted = new Map<string, ConsistencyComparisonView>(), maintained = deferred<void>()
  let readContext: () => Promise<ConsistencyContextView> = async () => context, model: () => Promise<string> = async () => noConflicts, loseReply = false, mainHead = 'a'.repeat(40)
  const api = { async request(method: string, route: string, body?: SubmitConsistencyComparisonRequest) {
    apiCalls.push({ method, route, ...(body ? { body: structuredClone(body) } : {}) })
    if (route === '/v1/projects/project/entities/scene/consistency-context' && method === 'GET') return readContext()
    if (route.startsWith('/v1/projects/project/consistency-comparisons?') && method === 'GET') {
      const entityId = new URLSearchParams(route.split('?')[1]).get('entityId')
      return [...accepted.values()].filter(value => !entityId || value.entityId === entityId)
    }
    if (route.startsWith('/v1/projects/project/consistency-comparisons/') && method === 'GET') {
      const result = accepted.get(route.split('/').at(-1)!)
      if (!result) throw new CollaborationError('COMPARISON_NOT_FOUND', 'not found', 404)
      return result
    }
    if (route === '/v1/projects/project/consistency-comparisons' && method === 'POST' && body) {
      const { idempotencyKey: _key, ...fields } = body
      const result = { ...fields, conflictCount: body.conflicts.length, creator: { id: 1, name: '作者' }, createdAt: '' } as ConsistencyComparisonView
      accepted.set(body.id, result)
      if (loseReply) { loseReply = false; throw new Error('提交响应未知') }
      return result
    }
    if (automatic && route === '/v1/projects/project/integrations/integration' && method === 'GET') return integration
    if (automatic && route === '/v1/projects/project' && method === 'GET') return remote
    throw new Error(`comparison crossed the API boundary: ${method} ${route}`)
  } } as unknown as CollaborationClient
  const forbid = (name: string) => { capabilities.push(name); throw new Error(`comparison crossed the capability boundary: ${name}`) }
  const maintenanceGit = {
    async state(current: string) { capabilities.push(`maintenance:state:${current === directory ? 'main' : 'task'}`); return { root: current, head: current === directory ? mainHead : candidateSha, branch: current === directory ? 'main' : 'studio/scene/task', dirty: false, repositoryUrl: remote.project.repositoryUrl } },
    async hasCommit() { capabilities.push('maintenance:hasCommit'); return true },
    async fastForward() { capabilities.push('maintenance:fastForward'); mainHead = candidateSha },
    async removeWorktree(_root: string, target: string) { capabilities.push('maintenance:removeWorktree'); await rm(target, { recursive: true }); maintained.resolve() },
    async keepRef() { capabilities.push('maintenance:keepRef') }, async deleteBranch() { capabilities.push('maintenance:deleteBranch') },
  }
  const git = new Proxy(automatic ? maintenanceGit : {}, { get(target, key: string) { return key in target ? target[key as keyof typeof target] : () => forbid(`git.${key}`) } })
  const ports = { workspaceRoot: root, git, async account() { return { id: 1 } }, async compareConsistency(input: ConsistencyModelInput) { inputs.push(structuredClone(input)); return model() },
    async gitLocal() { if (!automatic) return forbid('gitLocal'); capabilities.push('maintenance:gitLocal'); return '' },
    async releaseTask() { if (!automatic) return forbid('releaseTask'); capabilities.push('maintenance:releaseTask') },
    async session() { return forbid('session') }, async prompt() { return forbid('prompt') }, async checks() { return forbid('checks') }, async installTemplate() { return forbid('installTemplate') }, async stopPreview() {},
  } as unknown as HostPorts
  const app = new StudioApplication(store, api, ports)
  let genericStateReads = 0
  app.state = async () => {
    genericStateReads++
    if (!automatic) throw new Error('comparison must not call the full app.state projection')
    return { connected: true, account: { id: 1 }, projects: local.projects, selectedProjectId: 'project', collaboration: remote, availableProjects: [], namespaces: [], projectInitializations: [], drafts: [], tasks: local.tasks, candidates: [], reviews: [], pending: local.operations.map(value => ({ id: value.id, entityId: value.entityId, phase: value.phase })) } as StudioState
  }
  t.after(async () => { await app.dispose(); await rm(root, { recursive: true, force: true }) })
  return { app, store, local, task, operation, context, apiCalls, inputs, capabilities, maintained, root, directory, worktree, oldDraft, draft,
    stateReads: () => genericStateReads, loseSubmissionReply() { loseReply = true }, contextReader(value: typeof readContext) { readContext = value }, model(value: typeof model) { model = value } }
}

test('comparison commands use only dedicated APIs and local projections, with no full state, Git, sessions or material writes', async t => {
  const f = await fixture(t)
  const original = await readFile(path.join(f.worktree, f.draft.path))
  successful(await f.app.command({ action: 'compareConsistency', entityId: 'scene' }))
  await f.app.settle()
  const record = f.local.consistencyComparisons[0]!
  const fresh = successful(await f.app.command({ action: 'checkConsistencyFreshness', comparisonId: record.id }))
  assert.equal(fresh.consistencyTasks![0]!.freshness, 'current')
  const history = await f.app.command({ action: 'listConsistencyComparisons', entityId: 'scene', limit: 10, offset: 0 })
  assert.deepEqual(successful(history).consistencyLatest, [])
  assert.ok(history.ok)
  assert.deepEqual(history.comparisons!.map(value => value.id), [record.id])
  f.loseSubmissionReply()
  successful(await f.app.command({ action: 'compareConsistency', entityId: 'scene' })); await f.app.settle()
  const pending = f.local.consistencyComparisons.at(-1)!
  assert.equal(pending.phase, 'pending-sync')
  const count = f.apiCalls.length, modelCount = f.inputs.length
  const retried = successful(await f.app.command({ action: 'retryConsistencySubmission', comparisonId: pending.id }))
  assert.equal(retried.consistencyTasks!.at(-1)!.phase, 'shared')
  assert.equal(f.apiCalls[count]!.method, 'GET')
  assert.match(f.apiCalls[count]!.route, new RegExp(`/consistency-comparisons/${pending.id}$`))
  assert.equal(f.inputs.length, modelCount)
  assert.equal(f.stateReads(), 0)
  assert.deepEqual(f.capabilities, [])
  assert.equal(f.apiCalls.every(call => /\/consistency-context$|\/consistency-comparisons(?:[/?]|$)/.test(call.route)), true)
  assert.deepEqual(await readFile(path.join(f.worktree, f.draft.path)), original)
})

test('history query results preserve their scope without replacing the project-level state', async t => {
  const f = await fixture(t)
  successful(await f.app.command({ action: 'compareConsistency', entityId: 'scene' }))
  await f.app.settle()
  const record = f.local.consistencyComparisons[0]!
  successful(await f.app.command({ action: 'listConsistencySummaries' }))
  const projectHistory = await f.app.command({ action: 'listConsistencyComparisons', limit: 10, offset: 0 })
  assert.deepEqual(successful(projectHistory).consistencyLatest!.map(value => value.id), [record.id])
  assert.ok(projectHistory.ok)
  assert.deepEqual(projectHistory.comparisons!.map(value => value.id), [record.id])
  const entityHistory = await f.app.command({ action: 'listConsistencyComparisons', entityId: 'scene', limit: 10, offset: 0 })
  assert.deepEqual(successful(entityHistory).consistencyLatest!.map(value => value.id), [record.id])
  assert.ok(entityHistory.ok)
  assert.deepEqual(entityHistory.comparisons!.map(value => value.id), [record.id])
  const empty = await f.app.command({ action: 'listConsistencyComparisons', entityId: 'requirement', limit: 10, offset: 0 })
  assert.deepEqual(successful(empty).consistencyLatest!.map(value => value.id), [record.id])
  assert.ok(empty.ok)
  assert.deepEqual(empty.comparisons, [])
  const other = successful(await f.app.command({ action: 'checkConsistencyFreshness', comparisonId: record.id }))
  assert.deepEqual(other.consistencyLatest!.map(value => value.id), [record.id], '非查询命令的回复保持项目级历史')
  assert.equal(f.stateReads(), 0)
})

test('accepted integrations compare the task bytes and clean up after input reads while the model remains pending', async t => {
  const f = await fixture(t, true)
  const contextEntered = deferred<void>(), releaseContext = deferred<ConsistencyContextView>(), modelEntered = deferred<void>(), releaseModel = deferred<string>()
  f.contextReader(async () => { contextEntered.resolve(); return releaseContext.promise })
  f.model(async () => { modelEntered.resolve(); return releaseModel.promise })
  try {
    successful(await f.app.command({ action: 'retryOperation', operationId: f.operation.id }))
    await bounded(contextEntered.promise)
    assert.equal(f.operation.phase, 'accepted')
    const accepted = successful(await f.app.command({ action: 'state' }))
    assert.equal(accepted.pending[0]!.phase, 'accepted')
    assert.equal(f.capabilities.some(value => value === 'maintenance:removeWorktree'), false)
    assert.equal((await stat(f.worktree)).isDirectory(), true)
    assert.equal(f.inputs.length, 0)
    releaseContext.resolve(f.context)
    await bounded(modelEntered.promise)
    assert.match(f.inputs[0]!.materials[0]!.text, /TASK-ACCEPTED-CONTENT/)
    assert.doesNotMatch(f.inputs[0]!.materials[0]!.text, /MAIN-OLD-CONTENT/)
    assert.equal(f.inputs[0]!.materials[0]!.sha256, f.draft.sha256)
    await bounded(f.maintained.promise)
    assert.equal(f.local.consistencyComparisons[0]!.phase, 'running')
    assert.equal(f.operation.phase, 'accepted')
    assert.ok(f.capabilities.includes('maintenance:releaseTask'))
    const probe = successful(await f.app.command({ action: 'checkConsistencyFreshness', comparisonId: f.local.consistencyComparisons[0]!.id }))
    assert.equal(probe.consistencyTasks![0]!.phase, 'running')
    successful(await f.app.command({ action: 'retryOperation', operationId: f.operation.id }))
    assert.equal(f.inputs.length, 1)
  } finally { releaseContext.resolve(f.context); releaseModel.resolve(noConflicts); await f.app.settle() }
  assert.equal(f.local.consistencyComparisons.length, 1)
  assert.equal(f.local.consistencyComparisons[0]!.phase, 'shared')
  assert.equal(f.task.cleanup!.status, 'done')
  assert.equal(f.capabilities.some(value => /session|prompt|checks|installTemplate/.test(value)), false)
  const phases = f.apiCalls.filter(call => !/consistency/.test(call.route))
  assert.equal(phases.every(call => call.method === 'GET' && ['/v1/projects/project/integrations/integration', '/v1/projects/project'].includes(call.route)), true)
})
