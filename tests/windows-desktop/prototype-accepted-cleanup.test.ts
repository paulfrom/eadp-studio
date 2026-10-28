import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { PrototypeIntegrationRequest, PrototypeTaskView } from '../../packages/contracts/src/index.ts'
import type { CollaborationClient } from '../../packages/studio-plugin/src/host/adapters/collaboration/client.ts'
import type { HostPorts } from '../../packages/studio-plugin/src/host/application/ports.ts'
import { AtomicState } from '../../packages/studio-plugin/src/host/adapters/local-state/atomic-state.ts'
import { PrototypeCandidates } from '../../packages/studio-plugin/src/host/application/prototype-candidates.ts'
import type { PrototypeCollaboration } from '../../packages/studio-plugin/src/host/application/prototype-collaboration.ts'
import { PrototypeIntegrations, type PrototypeIntegrationOperation } from '../../packages/studio-plugin/src/host/application/prototype-integrations.ts'
import { StudioStore } from '../../packages/studio-plugin/src/host/application/state.ts'
import type { TaskView } from '../../packages/studio-plugin/src/shared/studio.ts'

const sourceSha = 'a'.repeat(40), candidateSha = sourceSha, expectedHead = sourceSha
const steps = ['projection', 'adoptions', 'preview', 'release', 'main', 'cleanup'] as const
type Step = typeof steps[number]

function task(root: string): TaskView {
  return { projectId: 'project', entityId: 'task', purpose: 'prototype', sessionId: 'session', inputHash: 'input', worktree: path.join(root, 'worktree'), baseHead: sourceSha, writePaths: ['src/'] }
}

function request(): PrototypeIntegrationRequest {
  return {
    idempotencyKey: 'operation', stage: 'prototype', prototypeId: 'prototype',
    token: { prototypeTaskId: 'task', generation: 1, clientId: 'client', expectedRevision: 1 },
    sourceSha, sourceBaseHead: expectedHead, expectedHead, candidateSha,
    sourceRef: 'refs/heads/studio-private/task/operation/source', candidateRef: 'refs/heads/studio-private/task/operation/candidate',
    allowedPaths: ['原型代码/src/app.ts'], developmentRequirementIds: ['requirement'],
    developmentClaims: [{ requirementId: 'requirement', claimId: 'claim', generation: 1 }], claimsDigest: 'b'.repeat(64),
    evidence: { candidateSha, sourceTreeHash: 'c'.repeat(64), rulesHash: 'd'.repeat(64), buildArtifactSha256: 'e'.repeat(64), checks: ['engineering', 'mock', 'browser'].map(name => ({ name: name as 'engineering' | 'mock' | 'browser', passed: true as const, evidenceHash: 'f'.repeat(64) })) },
    derivation: { kind: 'author-confirmed' },
    authorConfirmation: { confirmationId: 'confirmation', sourceSha, authorConfirmed: true, claimsDigest: 'b'.repeat(64), mergePolicy: 'clean-merge-and-recheck' },
  }
}

function acceptedOperation(root: string): PrototypeIntegrationOperation {
  return {
    id: 'operation', accountId: 1, projectId: 'project', taskId: 'task', worktree: path.join(root, 'worktree'), sessionId: 'session',
    request: request(), phase: 'accepted', integrationId: 'integration',
    accepted: { id: 'integration', prototypeTaskId: 'task', status: 'accepted', sourceSha, expectedHead, candidateSha, acceptanceId: 'acceptance', baselineId: 'baseline' },
  }
}

async function integrationFixture(t: test.TestContext, options: { release?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'prototype-accepted-delivery-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new StudioStore(path.join(root, 'state')); store.useUser(1)
  await mkdir(store.directory, { recursive: true })
  const original = acceptedOperation(root)
  await writeFile(path.join(store.directory, 'prototype-integrations.json'), JSON.stringify({ operations: [original], taskEnds: [] }))
  let accountId = 1, failure: Step | undefined
  const calls: Step[] = [], hooks = new Map<Step, () => Promise<void>>(), effects: Partial<Record<Step, string>> = {}
  const api = { request: async () => { throw new Error('accepted cleanup must not prepare, push, or complete again') } } as unknown as CollaborationClient
  const ports = { account: async () => ({ id: accountId }) } as unknown as HostPorts
  const act = async (step: Step, effect: string) => {
    const persisted = JSON.parse(await readFile(path.join(store.directory, 'prototype-integrations.json'), 'utf8')) as { operations: PrototypeIntegrationOperation[] }
    assert.equal(persisted.operations[0]?.delivery?.step, step, `${step} must be persisted before its side effect`)
    calls.push(step)
    const hook = hooks.get(step); hooks.delete(step); await hook?.()
    if (failure === step) { failure = undefined; throw new Error(`${step} failed`) }
    effects[step] = effect
  }
  const release = async (worktree: string) => { assert.equal(worktree, original.worktree); await act('release', worktree) }
  const deps = {
    task: async () => { throw new Error('accepted cleanup must not reauthorize publication') },
    accepted: async (taskId: string, baselineId: string) => { assert.equal(taskId, 'task'); assert.equal(baselineId, 'baseline'); await act('projection', `${taskId}:${baselineId}`) },
    completeAdoptions: async (taskId: string, baselineId: string) => { assert.equal(taskId, 'task'); assert.equal(baselineId, 'baseline'); await act('adoptions', `${taskId}:${baselineId}`) },
    stopPreview: async (sessionId: string) => { assert.equal(sessionId, 'session'); await act('preview', sessionId) },
    releaseTask: options.release === false ? undefined : release,
    syncMain: async (projectId: string, commit: string, expectedAccountId: number) => { assert.equal(projectId, 'project'); assert.equal(commit, candidateSha); assert.equal(expectedAccountId, 1); await act('main', `${projectId}:${commit}:${expectedAccountId}`) },
    cleanup: async (operationId: string) => { assert.equal(operationId, 'operation'); await act('cleanup', operationId) },
  }
  const create = (nextStore = store) => new PrototypeIntegrations(nextStore, api, ports, deps)
  return {
    root, store, original, calls, effects, create, runner: create(), deps,
    fail(step: Step) { failure = step },
    during(step: Step, hook: () => Promise<void>) { hooks.set(step, hook) },
    account(value: number) { accountId = value; store.useUser(value) },
    enableRelease() { deps.releaseTask = release },
    async saved() { return (JSON.parse(await readFile(path.join(root, 'state', 'users', '1', 'prototype-integrations.json'), 'utf8')) as { operations: PrototypeIntegrationOperation[] }).operations[0]! },
  }
}

for (const failed of steps) test(`accepted cleanup resumes after ${failed} without repeating completed steps`, async t => {
  const f = await integrationFixture(t); f.fail(failed)
  await assert.rejects(f.runner.resume('operation'), new RegExp(`${failed} failed`))
  const failedIndex = steps.indexOf(failed)
  assert.deepEqual(f.calls, steps.slice(0, failedIndex + 1))
  assert.match((await f.saved()).deliveryMessage!, new RegExp(`${failed} failed`))
  assert.deepEqual((await f.saved()).delivery?.completed, steps.slice(0, failedIndex))
  assert.equal(f.effects[failed], undefined, 'an ordinary action failure happens before its side effect')
  const operation = await f.runner.resume('operation')
  assert.deepEqual(f.calls, [...steps.slice(0, failedIndex + 1), ...steps.slice(failedIndex)])
  assert.deepEqual(operation.delivery?.completed, steps)
  assert.equal(operation.deliveryMessage, undefined)
  assert.equal(operation.phase, 'accepted')
  assert.equal(operation.accepted?.baselineId, 'baseline')
})

for (const repeated of steps) test(`${repeated} is idempotently retried after its completion marker write fails`, async t => {
  const index = steps.indexOf(repeated), f = await integrationFixture(t)
  const originalWrite = AtomicState.prototype.write
  let failCompletion = true
  AtomicState.prototype.write = async function <T>(this: AtomicState<T>, value: T): Promise<void> {
    const current = (value as { operations?: PrototypeIntegrationOperation[] }).operations?.[0]
    if (failCompletion && current?.delivery?.step === repeated && current.delivery.completed.includes(repeated)) {
      failCompletion = false
      throw new Error('completion marker save failed')
    }
    await originalWrite.call(this, value)
  }
  t.after(() => { AtomicState.prototype.write = originalWrite })
  await assert.rejects(f.runner.resume('operation'), /completion marker save failed/)
  assert.ok(f.effects[repeated], 'the external side effect completed before the storage failure')
  assert.match((await f.saved()).deliveryMessage!, /completion marker save failed/)
  assert.deepEqual((await f.saved()).delivery?.completed, steps.slice(0, index))
  assert.equal((await f.saved()).delivery?.step, repeated)
  const restartedStore = new StudioStore(path.join(f.root, 'state')); restartedStore.useUser(1)
  const restarted = f.create(restartedStore), operation = await restarted.resume('operation')
  for (const step of steps) assert.equal(f.calls.filter(value => value === step).length, step === repeated ? 2 : 1)
  assert.deepEqual(f.calls, [...steps.slice(0, index + 1), ...steps.slice(index)])
  assert.deepEqual(f.effects, { projection: 'task:baseline', adoptions: 'task:baseline', preview: 'session', release: f.original.worktree, main: `project:${candidateSha}:1`, cleanup: 'operation' })
  assert.deepEqual(operation.delivery?.completed, steps)
  const calls = [...f.calls]
  await restarted.resume('operation')
  assert.deepEqual(f.calls, calls, 'fully delivered accepted work has no further side effects')
})

test('switching accounts during a local step cannot deliver the original operation into another account', async t => {
  const f = await integrationFixture(t)
  f.during('release', async () => { f.account(2) })
  await assert.rejects(f.runner.resume('operation'), /协同账号已变化/)
  assert.deepEqual(f.calls, ['projection', 'adoptions', 'preview', 'release'])
  assert.deepEqual((await f.saved()).delivery?.completed, ['projection', 'adoptions', 'preview'])
  assert.equal((await f.saved()).delivery?.step, 'release')
  f.account(1)
  const operation = await f.runner.resume('operation')
  assert.deepEqual(f.calls, ['projection', 'adoptions', 'preview', 'release', 'release', 'main', 'cleanup'])
  assert.equal(operation.deliveryMessage, undefined)
})

test('missing native release capability remains an explicit retryable delivery failure', async t => {
  const f = await integrationFixture(t, { release: false })
  await assert.rejects(f.runner.resume('operation'), /原生事项资源释放能力/)
  assert.deepEqual(f.calls, ['projection', 'adoptions', 'preview'])
  assert.match((await f.saved()).deliveryMessage!, /原生事项资源释放能力/)
  f.enableRelease()
  const operation = await f.runner.resume('operation')
  assert.equal(operation.deliveryMessage, undefined)
  assert.deepEqual(operation.delivery?.completed, steps)
})

const exists = (target: string) => stat(target).then(() => true, error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return false })

async function candidateFixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'prototype-accepted-cleanup-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new StudioStore(path.join(root, 'state')); store.useUser(1)
  await mkdir(store.directory, { recursive: true })
  const localTask = task(root)
  const authorization: PrototypeTaskView = {
    id: 'task', prototypeId: 'prototype', ownerId: 1, clientId: 'client', generation: 1, revision: 1, status: 'accepted', title: 'Prototype', branch: 'studio/task', startHead: sourceSha, sourceBaseHead: sourceSha,
    developmentRequirementIds: ['requirement'], referenceRequirementIds: [], developmentClaims: request().developmentClaims, claimsDigest: request().claimsDigest, writeScope: ['src/'], policyHash: '0'.repeat(64),
  }
  const mergeRoot = path.join(store.directory, 'prototype-merges'), checkRoot = path.join(store.directory, 'prototype-candidate-checks')
  const mergedDirectory = path.join(mergeRoot, 'prototype-merge-accepted'), conflictDirectory = path.join(mergeRoot, 'prototype-merge-conflict'), otherDirectory = path.join(mergeRoot, 'prototype-merge-other'), checkDirectory = path.join(checkRoot, 'candidate-accepted')
  for (const directory of [mergedDirectory, conflictDirectory, otherDirectory, checkDirectory, localTask.worktree]) { await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, 'keep-or-remove.txt'), directory) }
  const record = {
    id: 'operation', accountId: 1, task: localTask, authorization, status: 'confirmed', mergeCheckDirectories: [checkDirectory],
    mergeScenes: [
      { expectedHead, mergeBaseSha: sourceSha, directory: mergedDirectory, status: 'merged' },
      { expectedHead, mergeBaseSha: sourceSha, directory: conflictDirectory, status: 'conflicted' },
    ],
    merged: { expectedHead, candidateSha, mergeBaseSha: sourceSha },
  }
  const write = async () => writeFile(path.join(store.directory, 'prototype-candidates.json'), JSON.stringify({ operations: [record] }))
  await write()
  const integrations = { operation: async () => acceptedOperation(root) } as unknown as PrototypeIntegrations
  const candidates = new PrototypeCandidates(store, {} as CollaborationClient, { account: async () => ({ id: 1 }) } as HostPorts, {} as PrototypeCollaboration, integrations)
  return { root, store, candidates, record, write, mergedDirectory, conflictDirectory, otherDirectory, checkDirectory, worktree: localTask.worktree, mergeRoot, checkRoot }
}

test('accepted cleanup removes only registered merged and check directories and preserves all author and conflict state', async t => {
  const f = await candidateFixture(t)
  await f.candidates.cleanupAccepted('operation')
  assert.equal(await exists(f.mergedDirectory), false)
  assert.equal(await exists(f.checkDirectory), false)
  for (const retained of [f.conflictDirectory, f.otherDirectory, f.worktree]) assert.equal(await readFile(path.join(retained, 'keep-or-remove.txt'), 'utf8'), retained)
  await f.candidates.cleanupAccepted('operation')
})

test('accepted cleanup refuses a registered path outside the account managed root', async t => {
  const f = await candidateFixture(t), outside = path.join(f.root, 'outside')
  await mkdir(outside); await writeFile(path.join(outside, 'author.txt'), 'keep')
  f.record.mergeScenes[0]!.directory = outside; await f.write()
  await assert.rejects(f.candidates.cleanupAccepted('operation'), /受管根目录|越界/)
  assert.equal(await readFile(path.join(outside, 'author.txt'), 'utf8'), 'keep')
  assert.equal(await exists(f.checkDirectory), true, 'a failed cleanup leaves later registered directories available for retry')
})

test('accepted cleanup refuses symbolic links without deleting their targets', async t => {
  const f = await candidateFixture(t), outside = path.join(f.root, 'outside'), link = path.join(f.checkRoot, 'candidate-link')
  await mkdir(outside); await writeFile(path.join(outside, 'author.txt'), 'keep')
  await rm(f.checkDirectory, { recursive: true, force: true }); await symlink(outside, link)
  f.record.mergeCheckDirectories = [link]; await f.write()
  await assert.rejects(f.candidates.cleanupAccepted('operation'), /符号链接/)
  assert.equal(await readFile(path.join(outside, 'author.txt'), 'utf8'), 'keep')
})

test('merge check registration survives a later conflict reset and accepted cleanup still preserves the conflict scene', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'prototype-check-conflict-history-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new StudioStore(path.join(root, 'state')); store.useUser(1)
  await mkdir(store.directory, { recursive: true })
  const localTask = task(root), firstHead = '1'.repeat(40), secondHead = '2'.repeat(40), mergedCandidate = '3'.repeat(40), mergeBase = '4'.repeat(40)
  const authorization: PrototypeTaskView = {
    id: 'task', prototypeId: 'prototype', ownerId: 1, clientId: 'client', generation: 1, revision: 1, status: 'active', title: 'Prototype', branch: 'studio/task', startHead: sourceSha, sourceBaseHead: sourceSha,
    developmentRequirementIds: ['requirement'], referenceRequirementIds: [], developmentClaims: request().developmentClaims, claimsDigest: request().claimsDigest, writeScope: ['src/'], policyHash: '0'.repeat(64),
  }
  const snapshot = [{ path: 'src/app.ts', bytes: Buffer.from('export {}\n'), mode: '100644' as const }]
  const sourceTreeHash = createHash('sha256').update(snapshot[0]!.path).update('\0').update(snapshot[0]!.bytes).update('\0').digest('hex')
  const evidence = (sha: string) => ({ candidateSha: sha, sourceTreeHash, rulesHash: 'd'.repeat(64), buildArtifactSha256: 'e'.repeat(64), checks: request().evidence.checks })
  const record = {
    id: 'operation', accountId: 1, task: localTask, authorization, status: 'confirmed', confirmationId: 'confirmation', checkOperationId: 'check', evidence: evidence(sourceSha),
    sourceUpload: { ref: request().sourceRef, sha: sourceSha, status: 'uploaded' },
    summary: { operationId: 'operation', projectId: 'project', prototypeTaskId: 'task', title: 'Prototype', sourceBaseHead: sourceSha, sourceSha, claimsDigest: request().claimsDigest, developmentRequirementIds: ['requirement'], summaryHash: 'summary', changes: [{ path: '原型代码/src/app.ts', status: 'modified' }], status: 'confirmed', checks: 'passed' },
  }
  await writeFile(path.join(store.directory, 'prototype-candidates.json'), JSON.stringify({ operations: [record] }))
  const mergeRoot = path.join(store.directory, 'prototype-merges'), mergedDirectory = path.join(mergeRoot, 'prototype-merge-first'), conflictDirectory = path.join(mergeRoot, 'prototype-merge-conflict')
  for (const directory of [mergedDirectory, conflictDirectory, localTask.worktree]) { await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, 'scene.txt'), directory) }
  let current = { task: localTask, authorization }, expected = firstHead, projectReads = 0, merges = 0, accepted = false, checkDirectory = ''
  const collaboration = { confirmationTask: async () => structuredClone(current) } as unknown as PrototypeCollaboration
  const integrations = {
    operation: async () => accepted ? acceptedOperation(root) : undefined,
    submitConfirmed: async () => { throw new Error('retry after merged check') },
  } as unknown as PrototypeIntegrations
  const api = { request: async (method: string, route: string) => {
    if (method === 'GET' && route === '/v1/projects/project') {
      expected = projectReads++ === 0 ? firstHead : secondHead
      return { project: { id: 'project', recognizedHead: expected, stableBranch: 'main' } }
    }
    if (method === 'GET' && route.includes('/operations/')) {
      const updated = { ...authorization, sourceBaseHead: secondHead, revision: 2 }
      current = { task: { ...localTask, baseHead: secondHead }, authorization: updated }
      return { action: 'prototype.task.source-base:task', result: { task: updated, source: { operationId: 'operation', ref: request().sourceRef, sha: sourceSha, previousBaseHead: sourceSha, newBaseHead: secondHead, mergeBaseSha: mergeBase } } }
    }
    throw new Error(`unexpected ${method} ${route}`)
  } } as unknown as CollaborationClient
  const ports = {
    account: async () => ({ id: 1 }),
    git: {
      identity: async () => ({ name: 'Author', email: 'author@example.test' }),
      prototypeSource: async () => ({ sha: sourceSha, changedPaths: ['原型代码/src/app.ts'] }),
      prototypeSnapshot: async () => snapshot,
      optionalRemoteHead: async () => sourceSha,
      fetch: async () => {}, remoteHead: async () => expected,
      prototypeCleanMerge: async () => ++merges === 1
        ? { status: 'merged', candidateSha: mergedCandidate, mergeBaseSha: mergeBase, changedPaths: ['原型代码/src/app.ts'], retainedDirectory: mergedDirectory }
        : { status: 'conflicted', mergeBaseSha: mergeBase, conflictFiles: ['src/app.ts'], directory: conflictDirectory },
      prototypeRestoreConflict: async (_worktree: string, input: { onPlan(plan: { files: unknown[] }): Promise<void> }) => { const writeback = { files: [] }; await input.onPlan(writeback); return { conflictFiles: ['src/app.ts'], writeback } },
    },
    candidateChecks: async (checkedTask: TaskView, sha: string) => { checkDirectory = checkedTask.worktree; return evidence(sha) },
  } as unknown as HostPorts
  const candidates = new PrototypeCandidates(store, api, ports, collaboration, integrations)
  await assert.rejects(candidates.submit('operation', 'check'), /retry after merged check/)
  const persisted = async () => (JSON.parse(await readFile(path.join(store.directory, 'prototype-candidates.json'), 'utf8')) as { operations: Array<{ merged?: unknown; mergeCheckDirectories?: string[] }> }).operations[0]!
  assert.ok(checkDirectory)
  assert.deepEqual((await persisted()).mergeCheckDirectories, [checkDirectory])
  await assert.rejects(candidates.submit('operation', 'check'), /发生冲突/)
  assert.equal((await persisted()).merged, undefined)
  assert.deepEqual((await persisted()).mergeCheckDirectories, [checkDirectory])
  accepted = true
  await candidates.cleanupAccepted('operation')
  assert.equal(await exists(mergedDirectory), false)
  assert.equal(await exists(checkDirectory), false)
  assert.equal(await readFile(path.join(conflictDirectory, 'scene.txt'), 'utf8'), conflictDirectory)
  assert.equal(await readFile(path.join(localTask.worktree, 'scene.txt'), 'utf8'), localTask.worktree)
})
