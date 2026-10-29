import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { canonical, PROTOTYPE_MERGE_POLICY } from '../../packages/asset-domain/src/index.ts'
import type { PrototypeTaskView } from '../../packages/contracts/src/index.ts'
import type { PrototypeCollaborationCommand } from '../../packages/studio-plugin/src/shared/prototype.ts'
import type { TaskView } from '../../packages/studio-plugin/src/shared/studio.ts'
import { CollaborationError, type CollaborationClient } from '../../packages/studio-plugin/src/host/adapters/collaboration/client.ts'
import { digest } from '../../packages/studio-plugin/src/host/adapters/assets/materials.ts'
import { PrototypeCollaboration } from '../../packages/studio-plugin/src/host/application/prototype-collaboration.ts'
import type { HostPorts } from '../../packages/studio-plugin/src/host/application/ports.ts'
import { StudioStore } from '../../packages/studio-plugin/src/host/application/state.ts'
import { readTemplateManifest } from '../../packages/studio-plugin/src/host/prototype/template.ts'

type Claim = PrototypeTaskView['developmentClaims'][number]
type Start = Extract<PrototypeCollaborationCommand, { action: 'startPrototypeCollaboration' }>
type Phase = 'sent' | 'unknown' | 'commit-known' | 'pushing' | 'synchronizing'

async function fixture(t: test.TestContext, options: { phase?: Phase; second?: boolean; delivery?: 'unknown' | 'delivered' } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'prototype-requirement-development-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const stateRoot = path.join(root, 'state'), store = new StudioStore(stateRoot); store.useUser(1)
  const clientId = (await store.read()).clientId, worktree = path.join(root, 'worktree'); await mkdir(worktree)
  const base = 'a'.repeat(40), firstCommit = digest('first-commit').slice(0, 40), branch = 'studio/prototype/initial'
  const claim: Claim = { requirementId: 'requirement-1', claimId: 'claim-1', generation: 1 }
  const manifest = await readTemplateManifest(path.resolve('packages/studio-plugin/assets/prototype-template.manifest.json'))
  const policyHash = digest(canonical({ protectedPaths: manifest.contract.protectedPaths, writablePrefixes: manifest.contract.writablePrefixes, mergePolicy: PROTOTYPE_MERGE_POLICY }))
  const task: PrototypeTaskView = { id: 'task-1', prototypeId: 'prototype', ownerId: 1, clientId, generation: 1, revision: 0, status: 'active', title: '需求一', branch, startHead: base, sourceBaseHead: base, developmentRequirementIds: ['requirement-1'], referenceRequirementIds: [], developmentClaims: [claim], claimsDigest: 'b'.repeat(64), writeScope: ['src/pages/'], policyHash }
  const request: Start = { action: 'startPrototypeCollaboration', projectId: 'project', operationId: 'run-1', title: task.title, instruction: '实现需求一', developmentRequirementIds: ['requirement-1'], referenceRequirementIds: [], writeScope: task.writeScope }
  const phase = options.phase ?? 'sent', operation: Record<string, unknown> = { id: 'run-1', taskId: task.id, request, phase, turnStartHead: base, turnStartFingerprint: 'clean' }
  const development: Record<string, unknown> = { requirementId: claim.requirementId, runId: operation.id, stage: phase === 'unknown' ? 'sending' : phase === 'sent' ? 'developing' : phase, reviewStatus: 'pending', startCommitId: base, remoteRef: `refs/heads/${branch}`, claim, claimReleased: false }
  let head = phase === 'sent' || phase === 'unknown' ? base : firstCommit, dirty = false, remote: string | undefined
  if (phase !== 'sent' && phase !== 'unknown') {
    operation.commitId = firstCommit; operation.checksPassed = true; development.commitId = firstCommit
  }
  const synchronizeRequest = { key: digest('run-1:sync'), token: { prototypeTaskId: task.id, generation: 1, clientId, expectedRevision: 0 }, claim, commitId: firstCommit, remoteRef: `refs/heads/${branch}`, release: true }
  if (phase === 'synchronizing') operation.synchronizeRequest = synchronizeRequest
  const tasks: unknown[] = [{ projectId: 'project', task, sessionId: 'session-1', worktree, sessionOpened: true, state: phase === 'sent' || phase === 'unknown' || phase === 'commit-known' || phase === 'pushing' || phase === 'synchronizing' ? 'running' : 'queued', development }]
  const operations: unknown[] = [operation]
  const claims = new Map<string, Claim>([[claim.requirementId, claim]])
  if (options.second) {
    const secondClaim: Claim = { requirementId: 'requirement-2', claimId: 'claim-2', generation: 1 }, secondBranch = 'studio/prototype/second'
    const secondTask: PrototypeTaskView = { ...task, id: 'task-2', title: '需求二', branch: secondBranch, developmentRequirementIds: [secondClaim.requirementId], developmentClaims: [secondClaim] }
    const secondWorktree = path.join(root, 'worktree-2'); await mkdir(secondWorktree)
    const secondRequest: Start = { ...request, operationId: 'run-2', title: secondTask.title, instruction: '实现需求二', developmentRequirementIds: [secondClaim.requirementId] }
    tasks.push({ projectId: 'project', task: secondTask, sessionId: 'session-2', worktree: secondWorktree, state: 'queued', development: { requirementId: secondClaim.requirementId, runId: 'run-2', stage: 'queued', reviewStatus: 'pending', startCommitId: base, remoteRef: `refs/heads/${secondBranch}`, claim: secondClaim, claimReleased: false } })
    operations.push({ id: 'run-2', taskId: secondTask.id, request: secondRequest, phase: 'workspace' })
    claims.set(secondClaim.requirementId, secondClaim)
  }
  await store.save()
  const queuePath = path.join(store.directory, 'prototype-queue.json')
  const receipts = new Map<string, unknown>()
  if (phase === 'synchronizing') receipts.set(synchronizeRequest.key, null)
  const initialRecord = { revision: 1, selectedTaskId: task.id, tasks, operations }
  const { writeFile } = await import('node:fs/promises'); await writeFile(queuePath, JSON.stringify(initialRecord))
  const calls = { commits: 0, pushes: 0, checks: 0, prompts: 0, sessions: 0, inspections: 0, syncPosts: 0, claimPosts: 0, routes: [] as string[], releases: [] as boolean[] }
  let delivery = options.delivery ?? 'delivered', claimConflict = false, loseSync = false, commitSequence = 0
  const remoteTask = (id: string) => tasks.map(value => (value as { task: PrototypeTaskView }).task).find(value => value.id === id)!
  const api = { async request(method: string, route: string, input?: Record<string, unknown>) {
    calls.routes.push(`${method} ${route}`)
    const taskMatch = /^\/v1\/projects\/project\/prototype\/tasks\/([^/]+)$/.exec(route)
    if (method === 'GET' && taskMatch) return structuredClone(remoteTask(taskMatch[1]!))
    const claimMatch = /^\/v1\/projects\/project\/prototype\/requirements\/([^/]+)\/development-claim$/.exec(route)
    if (method === 'GET' && claimMatch) {
      const current = claims.get(claimMatch[1]!)
      return current ? { ...current, taskId: 'task-1', active: true, commitId: head, remoteRef: 'refs/heads/studio/prototype/initial' } : null
    }
    const operationMatch = /^\/v1\/projects\/project\/operations\/([^/]+)$/.exec(route)
    if (method === 'GET' && operationMatch) {
      if (!receipts.has(operationMatch[1]!)) throw new CollaborationError('OPERATION_NOT_FOUND', 'missing', 404)
      return { result: structuredClone(receipts.get(operationMatch[1]!)) }
    }
    if (method === 'POST' && /\/development-claims$/.test(route)) {
      calls.claimPosts++
      if (claimConflict) throw new CollaborationError('REQUIREMENT_ALREADY_CLAIMED', '需求正在开发中', 409)
      const requirementId = String(input!.requirementId), prior = claims.get(requirementId)
      if (prior) throw new CollaborationError('REQUIREMENT_ALREADY_CLAIMED', '需求正在开发中', 409)
      const next = { requirementId, claimId: `claim-${requirementId}-${calls.claimPosts + 1}`, generation: 2 }
      claims.set(requirementId, next); receipts.set(String(input!.key), next); return next
    }
    if (method === 'POST' && /\/synchronize$/.test(route)) {
      calls.syncPosts++
      assert.equal(remote, input!.commitId)
      assert.deepEqual(input!.claim, claims.get(String(input!.claim && (input!.claim as Claim).requirementId)))
      calls.releases.push(Boolean(input!.release)); receipts.set(String(input!.key), null)
      if (input!.release) claims.delete(String((input!.claim as Claim).requirementId))
      if (loseSync) { loseSync = false; throw new Error('同步答复丢失') }
      return null
    }
    throw new Error(`unexpected ${method} ${route}`)
  } } as unknown as CollaborationClient
  const ports = {
    prototypeManifestPath: path.resolve('packages/studio-plugin/assets/prototype-template.manifest.json'),
    account: async () => ({ id: 1, name: '作者', gitlabUsername: 'author', gitlabEmail: 'author@example.test' }),
    git: {
      state: async () => ({ root: worktree, head, branch, dirty, repositoryUrl: 'https://git.test/project.git' }),
      workingFingerprint: async () => dirty ? 'dirty' : 'clean',
      identity: async () => ({ name: '作者', email: 'author@example.test' }),
      commitAll: async () => { if (dirty) { calls.commits++; head = digest(`commit-${++commitSequence}`).slice(0, 40); dirty = false } return head },
      optionalRemoteHead: async () => remote,
      isAncestor: async () => true,
      conditionalUpdate: async (_root: string, _branch: string, expected: string | undefined, commit: string) => { assert.equal(remote, expected); calls.pushes++; remote = commit },
    },
    candidateChecks: async () => { calls.checks++; return {} },
    session: async () => { calls.sessions++; return 'session-1' },
    prompt: async () => { calls.prompts++; dirty = true },
    inspectPrompt: async () => { calls.inspections++; return delivery },
    settlePrototypeSession: async () => true,
  } as unknown as HostPorts
  const collaboration = new PrototypeCollaboration(store, api, ports)
  return {
    collaboration, store, stateRoot, api, ports, calls, task, claim, worktree, queuePath, firstCommit,
    get head() { return head }, get remote() { return remote }, get dirty() { return dirty },
    setDirty(value: boolean) { dirty = value },
    setDelivery(value: 'unknown' | 'delivered') { delivery = value },
    setClaimConflict(value: boolean) { claimConflict = value },
    loseNextSync() { loseSync = true },
    setClaim(value: Claim | null) { if (value) claims.set(value.requirementId, value); else claims.delete(claim.requirementId) },
    async restart() { const restarted = new StudioStore(stateRoot); restarted.useUser(1); return new PrototypeCollaboration(restarted, api, ports) },
    async record() { return JSON.parse(await readFile(queuePath, 'utf8')) as { tasks: Array<{ development: Record<string, unknown> }>; operations: Array<Record<string, unknown>> } },
  }
}

const completed = { kind: 'turn-ended', reason: 'completed', seq: 10 } as const

test('first completed turn commits, pushes, releases and automatically starts the next requirement idempotently', async t => {
  const f = await fixture(t, { second: true })
  f.setDirty(true)
  assert.equal(await f.collaboration.accept('session-1', completed), true)
  const view = await f.collaboration.view()
  assert.equal(view.items[0]!.developmentStage, 'awaiting-review')
  assert.equal(view.items[0]!.reviewStatus, 'awaiting-review')
  assert.equal(view.items[0]!.commitId, f.head)
  assert.equal(view.items[1]!.localDispatchState, 'running')
  assert.equal(f.calls.commits, 1); assert.equal(f.calls.pushes, 1); assert.equal(f.calls.syncPosts, 1); assert.equal(f.calls.prompts, 1)
  assert.deepEqual(f.calls.releases, [true]); assert.equal(f.remote, f.head)
  await f.collaboration.accept('session-1', completed)
  await f.collaboration.accept('session-1', { ...completed, seq: 9 })
  assert.equal(f.calls.commits, 1); assert.equal(f.calls.pushes, 1); assert.equal(f.calls.syncPosts, 1); assert.equal(f.calls.prompts, 1)
  assert.ok(f.calls.routes.every(route => !route.includes('/integrations') && !route.includes('/baselines')))
})

test('a crash after observing but before consuming the completion event still finishes the original run', async t => {
  const f = await fixture(t)
  const record = JSON.parse(await readFile(f.queuePath, 'utf8')) as { tasks: Array<{ development: { lastTurnSeq?: number } }>; operations: Array<{ turnSeq?: number }> }
  record.tasks[0]!.development.lastTurnSeq = 10; record.operations[0]!.turnSeq = 10
  const { writeFile } = await import('node:fs/promises'); await writeFile(f.queuePath, JSON.stringify(record))
  const restarted = await f.restart(); f.setDirty(true)
  await restarted.accept('session-1', completed)
  assert.equal((await restarted.view()).items[0]!.developmentStage, 'awaiting-review')
  assert.equal(f.calls.commits, 1); assert.equal(f.calls.pushes, 1); assert.equal(f.calls.syncPosts, 1)
})

test('correction keeps its new claim until final confirmation, which reuses a clean commit and releases', async t => {
  const f = await fixture(t)
  f.setDirty(true)
  await f.collaboration.accept('session-1', completed)
  await f.collaboration.correct({ action: 'correctPrototypeRequirement', prototypeTaskId: f.task.id, operationId: 'correction-1', instruction: '调整交互' })
  const beforeStale = f.calls.commits
  await f.collaboration.accept('session-1', completed)
  assert.equal(f.calls.commits, beforeStale, 'a late prior-turn event cannot complete the correction')
  await f.collaboration.accept('session-1', { ...completed, seq: 11 })
  let view = await f.collaboration.view()
  assert.equal(view.items[0]!.developmentStage, 'awaiting-review', JSON.stringify(view.items[0]))
  assert.deepEqual(f.calls.releases, [true, false]); assert.equal(f.calls.claimPosts, 1)
  const commits = f.calls.commits, pushes = f.calls.pushes
  await f.collaboration.confirm({ action: 'confirmPrototypeRequirement', prototypeTaskId: f.task.id, operationId: 'final-1' })
  view = await f.collaboration.view()
  assert.equal(view.items[0]!.developmentStage, 'reviewed'); assert.equal(view.items[0]!.reviewStatus, 'reviewed')
  assert.equal(f.calls.commits, commits); assert.equal(f.calls.pushes, pushes); assert.equal(f.calls.claimPosts, 1)
  assert.deepEqual(f.calls.releases, [true, false, true])
})

test('a question-only completed turn and unsuccessful native reasons never commit or release', async t => {
  const question = await fixture(t)
  await question.collaboration.accept('session-1', completed)
  assert.equal((await question.collaboration.view()).items[0]!.developmentStage, 'developing')
  assert.equal(question.calls.commits, 0); assert.equal(question.calls.syncPosts, 0)
  for (const reason of ['aborted', 'error', 'interrupted', 'blocked', 'max-tokens']) {
    const f = await fixture(t)
    await f.collaboration.accept('session-1', { kind: 'turn-ended', reason, seq: 10 })
    assert.equal((await f.collaboration.view()).items[0]!.localDispatchState, 'recovery-required')
    assert.equal(f.calls.commits, 0); assert.equal(f.calls.pushes, 0); assert.equal(f.calls.syncPosts, 0)
  }
})

test('a claim conflict preserves the exact correction input and does not dispatch it', async t => {
  const f = await fixture(t)
  f.setDirty(true)
  await f.collaboration.accept('session-1', completed)
  f.setClaimConflict(true)
  await assert.rejects(f.collaboration.correct({ action: 'correctPrototypeRequirement', prototypeTaskId: f.task.id, operationId: 'correction-conflict', instruction: '保留这条纠偏输入' }), /正在开发中/)
  assert.equal((await f.collaboration.view()).items[0]!.developmentStage, 'blocked')
  assert.equal(f.calls.prompts, 0)
  const record = await f.record()
  assert.equal((record.operations.find(value => value.id === 'correction-conflict')!.request as { instruction: string }).instruction, '保留这条纠偏输入')
  assert.equal(record.tasks[0]!.development.correction, '保留这条纠偏输入')
})

test('restart resumes commit-known, push verification and backend synchronization without repeating completed steps', async t => {
  for (const phase of ['commit-known', 'pushing', 'synchronizing'] as const) {
    await t.test(phase, async t => {
      const f = await fixture(t, { phase })
      if (phase === 'synchronizing') f.setClaim(f.claim)
      const restarted = await f.restart()
      await restarted.recover()
      assert.equal((await restarted.view()).items[0]!.developmentStage, 'awaiting-review')
      assert.equal(f.calls.commits, 0)
      assert.equal(f.calls.pushes, phase === 'synchronizing' ? 0 : 1)
      assert.equal(f.calls.syncPosts, phase === 'synchronizing' ? 0 : 1)
    })
  }
})

test('a lost synchronization reply recovers from the original operation and remote ref', async t => {
  const f = await fixture(t)
  f.setDirty(true)
  f.loseNextSync()
  await f.collaboration.accept('session-1', completed)
  assert.equal((await f.collaboration.view()).items[0]!.developmentStage, 'synchronizing')
  assert.equal(f.calls.syncPosts, 1)
  const restarted = await f.restart(); await restarted.recover()
  assert.equal((await restarted.view()).items[0]!.developmentStage, 'awaiting-review')
  assert.equal(f.calls.commits, 1); assert.equal(f.calls.pushes, 1); assert.equal(f.calls.syncPosts, 1)
})

test('unknown native delivery is inspected and restored without resending the original instruction', async t => {
  const f = await fixture(t, { phase: 'unknown', delivery: 'unknown' })
  await f.collaboration.recover()
  assert.equal(f.calls.prompts, 0); assert.equal(f.calls.sessions, 0)
  f.setDelivery('delivered'); await f.collaboration.recover()
  assert.equal(f.calls.prompts, 0); assert.equal(f.calls.sessions, 1); assert.equal(f.calls.commits, 0)
})

test('read-only final confirmation after first release checks the original receipt without a new claim or release', async t => {
  const f = await fixture(t)
  f.setDirty(true)
  await f.collaboration.accept('session-1', completed)
  const syncPosts = f.calls.syncPosts
  await f.collaboration.confirm({ action: 'confirmPrototypeRequirement', prototypeTaskId: f.task.id, operationId: 'read-only-final' })
  assert.equal((await f.collaboration.view()).items[0]!.developmentStage, 'reviewed')
  assert.equal(f.calls.claimPosts, 0); assert.equal(f.calls.syncPosts, syncPosts)
  assert.deepEqual(f.calls.releases, [true])
})

test('released sessions remain readable but old and new writes require a current claim', async t => {
  const f = await fixture(t)
  const localTask: TaskView = { projectId: 'project', entityId: f.task.id, purpose: 'prototype', sessionId: 'session-1', inputHash: '', worktree: f.worktree, writePaths: f.task.writeScope }
  const authorize = await f.collaboration.writeAuthorization(localTask)
  f.setDirty(true)
  await f.collaboration.accept('session-1', completed)
  await assert.rejects(authorize(), /代次|占用/)
  assert.equal(await f.collaboration.restoreSession('session-1'), 'session-1')
  assert.deepEqual((await f.collaboration.fileWorkspace(f.task.id)).writablePaths, [])
})

test('an administratively released claim stops the completion hook before Git writes', async t => {
  const f = await fixture(t)
  f.setClaim(null)
  f.setDirty(true)
  await f.collaboration.accept('session-1', completed)
  assert.equal((await f.collaboration.view()).items[0]!.localDispatchState, 'recovery-required')
  assert.equal(f.calls.commits, 0); assert.equal(f.calls.pushes, 0); assert.equal(f.calls.syncPosts, 0)
})

test('task creation persists the atomic claim and managed ref before any native instruction', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'prototype-development-create-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new StudioStore(path.join(root, 'state')); store.useUser(1)
  const local = await store.read(), base = 'a'.repeat(40), branch = 'studio/prototype/create-run'
  local.projects.push({ id: 'project', name: '项目', directory: root, repositoryUrl: 'https://git.test/project.git' }); await store.save()
  const claim: Claim = { requirementId: 'requirement-1', claimId: 'claim-new', generation: 1 }
  let task: PrototypeTaskView | undefined, prompts = 0
  const api = { async request(method: string, route: string, input?: Record<string, unknown>) {
    if (method === 'GET' && route === '/v1/projects/project') return { project: { id: 'project', recognizedHead: base }, entities: [{ id: claim.requirementId, kind: 'requirement', generation: 1, title: '需求一' }] }
    if (method === 'POST' && route === '/v1/projects/project/prototype/tasks') {
      assert.equal(input!.commitId, base); assert.equal(input!.remoteRef, `refs/heads/${branch}`)
      task = { id: 'task-new', prototypeId: 'prototype', ownerId: 1, clientId: local.clientId, generation: 1, revision: 0, status: 'active', title: '需求一', branch, startHead: base, sourceBaseHead: base, developmentRequirementIds: [claim.requirementId], referenceRequirementIds: [], developmentClaims: [claim], claimsDigest: 'b'.repeat(64), writeScope: input!.writeScope as string[], policyHash: String(input!.policyHash) }
      return task
    }
    if (method === 'GET' && route === '/v1/projects/project/prototype/tasks/task-new') return task
    if (method === 'GET' && route === '/v1/projects/project/prototype/requirements/requirement-1/development-claim') return claim
    throw new Error(`unexpected ${method} ${route}`)
  } } as unknown as CollaborationClient
  const ports = {
    prototypeManifestPath: path.resolve('packages/studio-plugin/assets/prototype-template.manifest.json'),
    account: async () => ({ id: 1 }),
    identifyPrototypeRequirements: async () => JSON.stringify({ targets: [], ambiguous: false }),
    git: {
      hasCommit: async () => true,
      createWorktree: async (_root: string, destination: string) => { await mkdir(destination, { recursive: true }) },
      state: async () => ({ root, head: base, branch, dirty: false, repositoryUrl: 'https://git.test/project.git' }),
      workingFingerprint: async () => 'clean',
    },
    session: async () => 'session-new',
    prompt: async () => {
      prompts++
      const record = JSON.parse(await readFile(path.join(store.directory, 'prototype-queue.json'), 'utf8')) as { tasks: Array<{ development: { claim: Claim; stage: string } }> }
      assert.deepEqual(record.tasks[0]!.development.claim, claim)
      assert.equal(record.tasks[0]!.development.stage, 'sending')
    },
  } as unknown as HostPorts
  const collaboration = new PrototypeCollaboration(store, api, ports)
  await collaboration.start({ action: 'startPrototypeCollaboration', projectId: 'project', operationId: 'create-run', title: '需求一', instruction: '实现需求一', developmentRequirementIds: [claim.requirementId], referenceRequirementIds: [], writeScope: ['src/pages/'] })
  assert.equal(prompts, 1)
  assert.equal((await collaboration.view()).items[0]!.developmentStage, 'developing')
})

test('a pending requirement is persisted locally without claiming while another run is active', async t => {
  const f = await fixture(t)
  const command: Start = { action: 'startPrototypeCollaboration', projectId: 'project', operationId: 'pending-run', title: '需求二', instruction: '实现需求二', developmentRequirementIds: ['requirement-2'], referenceRequirementIds: [], writeScope: [] }
  await f.collaboration.start(command)
  assert.equal(f.calls.claimPosts, 0)
  assert.ok(!f.calls.routes.some(route => route.includes('/prototype/tasks')))
  const pending = (await f.collaboration.view()).items.find(item => item.pendingCreation)
  assert.equal(pending?.requirementId, 'requirement-2')
  const queued = await f.collaboration.view()
  await f.collaboration.reorder({ action: 'reorderPrototypeQueue', operationId: 'reorder-pending', expectedRevision: queued.revision, prototypeTaskIds: [pending!.prototypeTaskId, f.task.id] })
  const restarted = await f.restart()
  assert.equal((await restarted.view()).items[0]?.title, '需求二')
})

test('question-only correction keeps the claim without synchronizing or completing', async t => {
  const f = await fixture(t)
  f.setDirty(true); await f.collaboration.accept('session-1', completed)
  await f.collaboration.correct({ action: 'correctPrototypeRequirement', prototypeTaskId: f.task.id, operationId: 'question-correction', instruction: '解释当前行为' })
  f.setDirty(false)
  const syncs = f.calls.syncPosts, commits = f.calls.commits
  await f.collaboration.accept('session-1', { ...completed, seq: 11 })
  assert.equal(f.calls.syncPosts, syncs); assert.equal(f.calls.commits, commits)
  assert.equal((await f.collaboration.view()).items[0]!.developmentStage, 'awaiting-review')
  await f.collaboration.correct({ action: 'correctPrototypeRequirement', prototypeTaskId: f.task.id, operationId: 'followup-correction', instruction: '调整行为' })
  assert.equal(f.calls.claimPosts, 1)
})

test('changed released result requires correction before final confirmation', async t => {
  const f = await fixture(t)
  f.setDirty(true); await f.collaboration.accept('session-1', completed)
  f.setDirty(true)
  await assert.rejects(f.collaboration.confirm({ action: 'confirmPrototypeRequirement', prototypeTaskId: f.task.id, operationId: 'changed-final' }), /先发起纠偏/)
  assert.equal(f.calls.claimPosts, 0); assert.equal(f.calls.syncPosts, 1)
  assert.equal((await f.collaboration.view()).items[0]!.developmentStage, 'awaiting-review')
})


test('a question-only correction leaves an already dirty worktree untouched', async t => {
  const f = await fixture(t)
  f.setDirty(true); await f.collaboration.accept('session-1', completed)
  f.setDirty(true)
  await f.collaboration.correct({ action: 'correctPrototypeRequirement', prototypeTaskId: f.task.id, operationId: 'dirty-question', instruction: '解释未提交的草稿' })
  const syncs = f.calls.syncPosts, commits = f.calls.commits
  await f.collaboration.accept('session-1', { ...completed, seq: 11 })
  assert.equal(f.calls.syncPosts, syncs); assert.equal(f.calls.commits, commits)
  assert.equal(f.dirty, true)
})
