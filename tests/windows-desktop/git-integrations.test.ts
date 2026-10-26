import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { IntegrationView, MaterialIntegrationRequest, MaterialMetadata, ProjectState } from '../../packages/contracts/src/index.ts'
import type { TaskView } from '../../packages/studio-plugin/src/shared/studio.ts'
import { CollaborationError, type CollaborationClient } from '../../packages/studio-plugin/src/host/adapters/collaboration/client.ts'
import { digest, saveMaterial } from '../../packages/studio-plugin/src/host/adapters/assets/materials.ts'
import { BackgroundLane } from '../../packages/studio-plugin/src/host/application/background-lane.ts'
import { GitIntegrations } from '../../packages/studio-plugin/src/host/application/git-integrations.ts'
import type { HostPorts } from '../../packages/studio-plugin/src/host/application/ports.ts'
import { StudioStore, type PendingOperation } from '../../packages/studio-plugin/src/host/application/state.ts'

const head = 'a'.repeat(40), candidate = 'b'.repeat(40)
type Step = 'lookup' | 'push' | 'prepare' | 'get' | 'project' | 'head' | 'update' | 'complete' | 'delivery'

async function fixture(t: test.TestContext, stage: MaterialIntegrationRequest['stage'] = 'material') {
  const root = await mkdtemp(path.join(tmpdir(), 'eadp-git-integrations-')), stateRoot = path.join(root, 'state'), worktree = path.join(root, 'task')
  await mkdir(worktree)
  const store = new StudioStore(stateRoot); store.useUser(1)
  const local = await store.read()
  local.projects.push({ id: 'project', name: '项目', directory: root, repositoryUrl: 'https://git.test/project.git' })
  const task: TaskView = { projectId: 'project', entityId: 'requirement', worktree, purpose: stage === 'prototype' ? 'prototype' : 'material', sessionId: 'original-session', inputHash: 'input' }
  local.tasks.push({ ...task, worktree: path.join(root, 'different-task'), sessionId: 'earlier-session', purpose: 'review' }, task)
  await store.save()
  const metadata: MaterialMetadata = { entityId: task.entityId, kind: 'requirement', title: '审批需求', templateId: 'template', templateRef: { commitSha: head, path: '.template/requirement.md', sha256: digest('template') }, scenarioIds: ['scene'], sources: [{ projectId: 'project', entityId: 'scene', version: 1 }], prerequisites: [], businessEvidence: [], openQuestions: [], coreRulesPresent: true, acceptanceCriteriaPresent: true, referencedAssets: [] }
  const draft = await saveMaterial(worktree, metadata, '确认的业务正文')
  const token = { occupationId: 'occupation', generation: 1, taskId: 'task', clientId: local.clientId, expectedRevision: 1 }
  const prepare: MaterialIntegrationRequest = { idempotencyKey: 'operation', entityId: task.entityId, stage, token, sourceSha: candidate, candidateSha: candidate, expectedHead: head, allowedPaths: [draft.path], checks: { candidateSha: candidate, passed: true, checks: [{ name: 'materials', passed: true, evidenceHash: digest('checked') }] },
    confirmations: [{ entityId: task.entityId, expectedRevision: 1, fixed: { commitSha: stage === 'prototype' ? head : candidate, path: draft.path, sha256: draft.sha256 }, readHash: draft.sha256, authorConfirmed: true, confirmationMethod: 'direct' }] }
  const calls: Step[] = [], delivered: Array<{ operation: string; integration: string; task: TaskView }> = [], hooks = new Map<Step, () => Promise<void>>()
  const failures = { prepareReply: false, completeReply: false, completePending: false, delivery: false }
  let accountId = 1, remoteHead = head, integration: IntegrationView | undefined, completeEffects = 0
  const step = async (name: Step) => { calls.push(name); const hook = hooks.get(name); hooks.delete(name); await hook?.() }
  const api = { async request(method: string, route: string, input?: MaterialIntegrationRequest) {
    if (method === 'GET' && route.includes('/operations/')) {
      // The first remote action must observe a fully persisted pending record.
      const persisted = JSON.parse(await readFile(path.join(stateRoot, 'users', '1', 'studio-state.json'), 'utf8')) as { operations: PendingOperation[] }
      assert.equal(persisted.operations[0]?.id, prepare.idempotencyKey)
      await step('lookup')
      if (!integration) throw new CollaborationError('OPERATION_NOT_FOUND', 'missing', 404)
      return { action: 'integration.prepare', result: structuredClone(integration) }
    }
    if (method === 'POST' && route.endsWith('/integrations')) {
      assert.ok(input); assert.deepEqual(input, prepare)
      integration = { id: 'integration', entityId: task.entityId, ownerId: 1, status: 'prepared', sourceSha: input.sourceSha, expectedHead: input.expectedHead, candidateSha: input.candidateSha, stage: input.stage, createdAt: '' }
      await step('prepare')
      if (failures.prepareReply) { failures.prepareReply = false; throw new Error('prepare response lost') }
      return structuredClone(integration)
    }
    if (method === 'GET' && route.includes('/integrations/')) { await step('get'); return structuredClone(integration) }
    if (method === 'GET' && route === '/v1/projects/project') {
      await step('project')
      return { project: { id: 'project', initializationStatus: 'ready', stableBranch: 'main' } } as ProjectState
    }
    if (method === 'POST' && route.endsWith('/complete')) {
      assert.ok(integration); assert.equal(integration.status, 'prepared')
      assert.deepEqual(input, { idempotencyKey: 'operation-complete', token })
      if (!failures.completePending) { completeEffects++; integration.status = 'accepted'; integration.confirmationIds = ['confirmation'] }
      await step('complete')
      if (failures.completeReply) { failures.completeReply = false; throw new Error('complete response lost') }
      return structuredClone(integration)
    }
    throw new Error(`unexpected ${method} ${route}`)
  } } as unknown as CollaborationClient
  const ports = { account: async () => ({ id: accountId }), git: {
    async push(directory: string, sha: string, branch: string) { assert.equal(directory, worktree); assert.equal(sha, candidate); assert.equal(branch, 'studio-fixed/operation'); await step('push') },
    async remoteHead(directory: string, branch: string) { assert.equal(directory, root); assert.equal(branch, 'main'); await step('head'); return remoteHead },
    async conditionalUpdate(directory: string, branch: string, expected: string, next: string) { assert.equal(directory, worktree); assert.equal(branch, 'main'); assert.equal(expected, remoteHead); remoteHead = next; await step('update') },
  } } as unknown as HostPorts
  const lanes: BackgroundLane[] = []
  const create = (nextStore = store, now: () => number = Date.now) => {
    const lane = new BackgroundLane(); lanes.push(lane)
    const runner = new GitIntegrations(nextStore, api, ports, lane, { async accepted(operation, accepted, originalTask) {
      assert.equal(operation.phase, 'accepted')
      const saved = JSON.parse(await readFile(path.join(stateRoot, 'users', '1', 'studio-state.json'), 'utf8')) as { operations: PendingOperation[] }
      assert.equal(saved.operations[0]?.accepted?.id, accepted.id)
      await step('delivery')
      if (failures.delivery) throw new Error('delivery not recorded')
      delivered.push({ operation: operation.id, integration: accepted.id, task: structuredClone(originalTask) })
    } }, now)
    return { runner, lane }
  }
  t.after(async () => { for (const lane of lanes) await lane.settle(); await rm(root, { recursive: true, force: true }) })
  return { root, stateRoot, store, api, ports, local, task, draft, prepare, calls, delivered, failures, create, ...create(),
    during(name: Step, hook: () => Promise<void>) { hooks.set(name, hook) },
    remote(value: string) { remoteHead = value },
    account(value: number) { accountId = value },
    get completeEffects() { return completeEffects },
    get integration() { return integration },
  }
}

for (const stage of ['material', 'prototype'] as const) test(`${stage} persists before remote work and accepts its fixed original task`, async t => {
  const f = await fixture(t, stage), operation = await f.runner.submit(f.task, f.draft, f.prepare)
  await f.lane.settle()
  assert.equal(operation.phase, 'accepted')
  assert.equal(operation.accepted?.id, 'integration')
  assert.deepEqual(f.calls, ['lookup', 'push', 'prepare', 'get', 'project', 'head', 'update', 'complete', 'delivery'])
  assert.equal(f.delivered[0]?.task.sessionId, f.task.sessionId)
  assert.equal(f.delivered[0]?.task.worktree, f.task.worktree)
  assert.equal(f.completeEffects, 1)
  const requests = f.calls.filter(value => value !== 'delivery').length
  await f.runner.resume(operation)
  assert.equal(f.calls.filter(value => value !== 'delivery').length, requests, 'accepted recovery never repeats Git or backend acceptance')
})

test('a lost prepare response recovers the original receipt after restart without another push or prepare', async t => {
  const f = await fixture(t); f.failures.prepareReply = true
  const operation = await f.runner.submit(f.task, f.draft, f.prepare)
  await f.lane.settle()
  assert.equal(operation.phase, 'unknown')
  assert.equal(operation.integrationId, undefined)
  const rebooted = new StudioStore(f.stateRoot); rebooted.useUser(1)
  const saved = (await rebooted.read()).operations[0]!, restarted = f.create(rebooted)
  await restarted.runner.resume(saved)
  assert.equal(saved.phase, 'accepted')
  assert.equal(f.calls.filter(value => value === 'push').length, 1)
  assert.equal(f.calls.filter(value => value === 'prepare').length, 1)
  assert.equal(f.completeEffects, 1)
})

test('unknown operations recover automatically at most once per retry interval', async t => {
  const f = await fixture(t)
  let now = 1_000_000
  const { runner, lane } = f.create(f.store, () => now)
  f.failures.prepareReply = true
  const operation = await runner.submit(f.task, f.draft, f.prepare)
  await lane.settle()
  assert.equal(operation.phase, 'unknown')
  const callsAfterFailure = f.calls.length
  runner.recover(operation)
  await lane.settle()
  assert.equal(f.calls.length, callsAfterFailure)
  now += 61_000
  runner.recover(operation)
  await lane.settle()
  assert.equal(operation.phase, 'accepted')
})

test('a lost complete response queries the accepted integration without completing it twice', async t => {
  const f = await fixture(t); f.failures.completeReply = true
  const operation = await f.runner.submit(f.task, f.draft, f.prepare)
  await f.lane.settle()
  assert.equal(operation.phase, 'unknown')
  assert.equal(f.integration?.status, 'accepted')
  await f.runner.resume(operation)
  assert.equal(operation.phase, 'accepted')
  assert.equal(f.calls.filter(value => value === 'complete').length, 1)
  assert.equal(f.calls.filter(value => value === 'prepare').length, 1)
  assert.equal(f.completeEffects, 1)
})

test('a nonaccepted complete reply remains recoverable and cannot produce accepted delivery', async t => {
  const f = await fixture(t); f.failures.completePending = true
  const operation = await f.runner.submit(f.task, f.draft, f.prepare)
  await f.lane.settle()
  assert.equal(operation.phase, 'unknown')
  assert.match(operation.message!, /尚未被后台接受/)
  assert.equal(operation.accepted, undefined)
  assert.equal(f.delivered.length, 0)
  f.failures.completePending = false
  await f.runner.resume(operation)
  assert.equal(operation.phase, 'accepted')
  assert.equal(f.calls.filter(value => value === 'update').length, 1, 'the original branch update is not repeated')
  assert.equal(f.completeEffects, 1)
})

test('a moved remote head preserves the fixed candidate without advancing or accepting another head', async t => {
  const f = await fixture(t); f.remote('d'.repeat(40))
  const operation = await f.runner.submit(f.task, f.draft, f.prepare)
  await f.lane.settle()
  assert.equal(operation.phase, 'unknown')
  assert.match(operation.message!, /集成头已变化/)
  assert.equal(operation.candidateSha, candidate)
  assert.equal(f.calls.includes('update'), false)
  assert.equal(f.calls.includes('complete'), false)
})

test('one operation rejects different fixed inputs and a missing original task is not replaced by an entity sibling', async t => {
  const f = await fixture(t), operation = await f.runner.submit(f.task, f.draft, f.prepare)
  await f.lane.settle()
  await assert.rejects(f.runner.submit(f.task, f.draft, { ...f.prepare, sourceSha: 'c'.repeat(40) }), /不同的固定候选/)
  f.local.tasks.splice(f.local.tasks.indexOf(f.task), 1)
  await f.store.save()
  const count = f.delivered.length
  await assert.rejects(f.runner.resume(operation), /原集成任务现场缺失/)
  assert.equal(operation.phase, 'accepted')
  assert.equal(f.delivered.length, count)
})

test('delivery failure retains accepted facts and an independent accepted key can recover it', async t => {
  const f = await fixture(t); f.failures.delivery = true
  const operation = await f.runner.submit(f.task, f.draft, f.prepare)
  await f.lane.settle()
  assert.equal(operation.phase, 'accepted')
  assert.equal(operation.accepted?.status, 'accepted')
  assert.equal(operation.message, undefined)
  assert.match(operation.deliveryMessage!, /delivery/)
  const count = f.calls.filter(value => value !== 'delivery').length
  f.failures.delivery = false
  f.runner.schedule(operation)
  await f.lane.settle()
  assert.equal(operation.deliveryMessage, undefined)
  assert.equal(f.delivered.length, 1)
  assert.equal(f.calls.filter(value => value !== 'delivery').length, count)
})

test('a remembered publication key does not suppress a later accepted-delivery retry', async t => {
  const f = await fixture(t), operation = await f.runner.submit(f.task, f.draft, f.prepare)
  await f.lane.settle()
  assert.equal(f.delivered.length, 1)
  f.runner.schedule(operation)
  await f.lane.settle()
  assert.equal(f.delivered.length, 2)
  assert.equal(f.calls.filter(value => value === 'prepare').length, 1)
  assert.equal(f.completeEffects, 1)
})

for (const wait of ['push', 'complete', 'delivery'] as const) test(`switching accounts during ${wait} never saves old work into the new scope`, async t => {
  const f = await fixture(t)
  f.during(wait, async () => { f.account(2); f.store.useUser(2); await f.store.read() })
  await f.runner.submit(f.task, f.draft, f.prepare)
  await f.lane.settle()
  assert.equal(f.store.accountId, 2)
  assert.deepEqual((await f.store.read()).operations, [])
  const next = JSON.parse(await readFile(path.join(f.stateRoot, 'users', '2', 'studio-state.json'), 'utf8')) as { operations: unknown[] }
  assert.deepEqual(next.operations, [])
  const previous = new StudioStore(f.stateRoot); previous.useUser(1)
  const original = (await previous.read()).operations[0]!
  assert.equal(original.phase, wait === 'push' ? 'fixed' : wait === 'complete' ? 'pushed' : 'accepted')
  assert.equal(original.message, undefined)
  assert.equal(original.deliveryMessage, undefined)
  f.account(1)
  await f.create(previous).runner.resume(original)
  assert.equal(original.phase, 'accepted')
  assert.equal(f.completeEffects, 1)
})

test('a diverged remote head is handed to the merge dependency instead of failing', async t => {
  const f = await fixture(t)
  f.remote('f'.repeat(40))
  const seen: string[] = []
  const runner = new GitIntegrations(f.store, f.api, f.ports, f.lane, {
    accepted: async () => undefined,
    merge: async (_operation, _request, head) => { seen.push(head); return true },
  })
  await runner.submit(f.task, f.draft, f.prepare)
  await f.lane.settle()
  assert.deepEqual(seen, ['f'.repeat(40)])
})

test('a terminal merge failure keeps its original message and is not retried by recover', async t => {
  const f = await fixture(t)
  f.remote('f'.repeat(40))
  let now = 1_000_000, merges = 0
  const runner = new GitIntegrations(f.store, f.api, f.ports, f.lane, {
    accepted: async () => undefined,
    merge: async () => { merges++; throw new Error('AI 合并超时，现场已保留') },
  }, () => now)
  const operation = await runner.submit(f.task, f.draft, f.prepare)
  await f.lane.settle()
  assert.equal(operation.phase, 'unknown')
  assert.equal(operation.mergeFailed, true)
  assert.equal(operation.message, 'AI 合并超时，现场已保留')
  const originalMessage = operation.message
  now += 61_000
  runner.recover(operation)
  await f.lane.settle()
  assert.equal(merges, 1)
  assert.equal(operation.message, originalMessage)
})

test('a diverged remote head remains unknown when the merge dependency declines it', async t => {
  const f = await fixture(t)
  f.remote('f'.repeat(40))
  const runner = new GitIntegrations(f.store, f.api, f.ports, f.lane, {
    accepted: async () => undefined,
    merge: async () => false,
  })
  const operation = await runner.submit(f.task, f.draft, f.prepare)
  await f.lane.settle()
  assert.equal(operation.phase, 'unknown')
  assert.equal(operation.message, 'Git 集成头已变化，需核对原候选并重新集成')
})
