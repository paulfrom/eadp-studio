import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CandidateMerges } from '../../packages/studio-plugin/src/host/application/candidate-merges.ts'
import { StudioStore, type PendingOperation } from '../../packages/studio-plugin/src/host/application/state.ts'
import type { MaterialIntegrationRequest, CheckEvidence, EntityView } from '@eadp/contracts'
import type { MaterialDraft, TaskView } from '../../packages/studio-plugin/src/shared/studio.ts'
import type { HostPorts } from '../../packages/studio-plugin/src/host/application/ports.ts'

const sha = (letter: string) => letter.repeat(40)
const candidate = sha('1'), expected = sha('2'), remote = sha('3'), merged = sha('4')
const mergeSession = 'studio-merge-op1-333333333333'
const task: TaskView = { projectId: 'p', entityId: 'e', sessionId: 's1', purpose: 'material', inputHash: '', worktree: '/w' }
const operation = { id: 'op1', accountId: 1, projectId: 'p', entityId: 'e', phase: 'unknown',
  task: { projectId: 'p', entityId: 'e', worktree: '/w', purpose: 'material', sessionId: 's1', inputHash: '' },
  candidateSha: candidate, expectedHead: expected, fixedPath: '场景/e.md', sha256: sha('c'), prepare: {}, token: {} } as PendingOperation
const request = { idempotencyKey: 'op1', sourceSha: candidate, candidateSha: candidate, expectedHead: expected,
  allowedPaths: ['场景/e.md'], checks: { candidateSha: candidate, passed: true, checks: [] }, entityId: 'e',
  token: {}, stage: 'material',
  confirmations: [{ entityId: 'e', fixed: { commitSha: candidate, path: '场景/e.md', sha256: sha('c') }, readHash: sha('c'), authorConfirmed: true }] } as unknown as MaterialIntegrationRequest
const draft = { path: '场景/e.md', sha256: sha('d'), body: 'merged', entityId: 'e', metadata: { entityId: 'e', sources: [] } } as unknown as MaterialDraft

async function fixture(t: { after(fn: () => unknown): void }, conflict: boolean, outOfScope = false, wrongParent = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'merges-')); t.after(() => rm(root, { recursive: true, force: true }))
  const store = new StudioStore(root); store.useUser(1)
  const local = await store.read(); local.tasks.push(structuredClone(task)); await store.save()
  const calls: string[] = [], mergeCommits: string[] = [], cancelled: string[] = [], sessionTasks: TaskView[] = []
  const checkouts: Array<{ branch: string; baseSha: string }> = [], switches: Array<{ branch: string; commit: string }> = [], deletions: Array<{ branch: string; commit: string }> = []
  let currentHead = candidate, currentBranch = 'studio/e/original', notifyPrompt!: () => void
  const prompted = new Promise<void>(resolve => { notifyPrompt = resolve })
  const ports = {
    session: async (sessionTask: TaskView) => { sessionTasks.push(structuredClone(sessionTask)); return mergeSession },
    prompt: async () => { calls.push('prompt'); notifyPrompt() },
    cancelSession: async (sessionId: string) => { cancelled.push(sessionId) },
    gitLocal: async (args: readonly string[]) => {
      assert.deepEqual(args, ['rev-list', '--parents', '-n', '1', merged])
      return wrongParent ? `${merged} ${candidate} ${remote}` : `${merged} ${remote} ${candidate}`
    },
    git: {
      state: async () => ({ root: '/w', head: currentHead, branch: currentBranch, dirty: false, repositoryUrl: 'https://gitlab.test/p.git' }),
      fetch: async () => { calls.push('fetch') },
      checkoutBranch: async (_root: string, branch: string, baseSha: string) => { checkouts.push({ branch, baseSha }); currentHead = baseSha; currentBranch = branch },
      switchBranch: async (_root: string, branch: string, commit: string) => { switches.push({ branch, commit }); currentHead = commit; currentBranch = branch },
      deleteBranch: async (_root: string, branch: string, commit: string) => { deletions.push({ branch, commit }) },
      changedFiles: async (_root: string, from: string, to: string) => from === expected && to === remote ? ['场景/remote.md'] : outOfScope ? ['其他/x.md'] : ['场景/e.md'],
      merge: async (_root: string, commit: string) => { mergeCommits.push(commit); if (!conflict) currentHead = merged; return conflict ? { status: 'conflicted', files: ['场景/e.md', '.eadp/evidence/interview.md'] } : { status: 'merged', commit: merged } },
      completeMerge: async (_root: string, files: string[]) => { calls.push(`complete:${files.join(',')}`); currentHead = merged; return merged },
    },
  } as unknown as HostPorts
  const merges = new CandidateMerges(store, ports, {
    entity: async () => ({ entity: { id: 'e', kind: 'scenario' } as EntityView }),
    identity: async () => ({ name: '作者', email: 'a@b.test' }),
    checks: (candidateSha: string) => ({ candidateSha, passed: true, checks: [] }) as CheckEvidence,
    readDraft: async () => structuredClone(draft),
  })
  return { merges, calls, prompted, mergeCommits, checkouts, switches, deletions, sessionTasks, cancelled, head: () => currentHead }
}

test('a clean merge rebuilds the candidate on the new remote head and keeps the original read hash', async t => {
  const { merges, checkouts, switches, deletions, mergeCommits } = await fixture(t, false)
  const result = await merges.merge(operation, request, remote, 'main')
  assert.ok(result)
  const mergeBranch = `studio-merge/${candidate.slice(0, 12)}-${remote.slice(0, 12)}`
  assert.deepEqual(checkouts, [{ branch: mergeBranch, baseSha: remote }])
  assert.deepEqual(switches, [{ branch: 'studio/e/original', commit: merged }])
  assert.deepEqual(deletions, [{ branch: mergeBranch, commit: merged }])
  assert.deepEqual(mergeCommits, [candidate])
  assert.equal(result.prepare.idempotencyKey, `m-${merged}`)
  assert.equal(result.prepare.expectedHead, remote)
  assert.equal(result.prepare.candidateSha, merged)
  assert.equal(result.prepare.sourceSha, merged)
  assert.equal(result.prepare.confirmations[0]!.fixed.commitSha, merged)
  assert.equal(result.prepare.confirmations[0]!.fixed.sha256, sha('d'))
  assert.equal(result.prepare.confirmations[0]!.readHash, sha('c'), '用户阅读版本不随合并改变')
  assert.deepEqual(result.note, { remoteFiles: ['场景/remote.md'], aiFiles: [] })
})

test('an existing merge commit is resumed without repeating checkout, merge or AI', async t => {
  const { merges, calls, prompted, checkouts, mergeCommits, sessionTasks } = await fixture(t, true)
  const first = merges.merge(operation, request, remote, 'main')
  await prompted
  await merges.accept(mergeSession, { kind: 'turn-ended', reason: 'stop' })
  assert.ok(await first)
  const resumed = await merges.merge(operation, request, remote, 'main')
  assert.ok(resumed)
  assert.equal(resumed.prepare.candidateSha, merged)
  assert.deepEqual(resumed.note, { remoteFiles: ['场景/remote.md'], aiFiles: [] })
  assert.equal(checkouts.length, 1)
  assert.deepEqual(mergeCommits, [candidate])
  assert.equal(sessionTasks.length, 1)
})

test('a conflicted merge waits for the agent turn and completes the merge commit', async t => {
  const { merges, calls, prompted, sessionTasks } = await fixture(t, true)
  const promise = merges.merge(operation, request, remote, 'main')
  await prompted
  assert.deepEqual(calls, ['fetch', 'prompt'])
  assert.deepEqual(sessionTasks[0]!.writePaths, ['场景/e.md', '.eadp/evidence/interview.md'])
  assert.equal(await merges.accept(mergeSession, { kind: 'turn-ended', reason: 'stop' }), true)
  const result = await promise
  assert.ok(result)
  assert.deepEqual(result.note.aiFiles, ['场景/e.md', '.eadp/evidence/interview.md'])
  assert.ok(calls.includes('complete:场景/e.md,.eadp/evidence/interview.md'))
})

for (const reason of ['error', 'aborted', 'completed']) test(`a conflicted merge rejects a ${reason} agent turn without completing it`, async t => {
  const { merges, calls, prompted, head } = await fixture(t, true)
  const promise = merges.merge(operation, request, remote, 'main')
  await prompted
  assert.equal(await merges.accept(mergeSession, { kind: 'turn-ended', reason }), true)
  await assert.rejects(promise, /AI 合并未正常完成，现场已保留/)
  assert.equal(calls.some(call => call.startsWith('complete:')), false)
  assert.equal(head(), remote)
  assert.equal(await merges.accept(mergeSession, { kind: 'turn-ended', reason: 'stop' }), false)
})

test('a timed out merge cancels the session and ignores late output without completing it', async t => {
  const { merges, calls, prompted, cancelled, head } = await fixture(t, true)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const promise = merges.merge(operation, request, remote, 'main')
  await prompted
  const rejection = assert.rejects(promise, /AI 合并超时，现场已保留/)
  t.mock.timers.tick(600_000)
  await prompted
  await rejection
  assert.deepEqual(cancelled, [mergeSession])
  assert.equal(calls.some(call => call.startsWith('complete:')), false)
  assert.equal(head(), remote)
  assert.equal(await merges.accept(mergeSession, { kind: 'turn-ended', reason: 'stop' }), false)
})

test('a merge whose first parent is not the new remote head is rejected', async t => {
  const { merges } = await fixture(t, false, false, true)
  await assert.rejects(merges.merge(operation, request, remote, 'main'), /合并父顺序不符合远端头优先/)
})

test('a merged result outside the material scope is rejected and nothing is produced', async t => {
  const { merges } = await fixture(t, false, true)
  await assert.rejects(merges.merge(operation, request, remote, 'main'), /超出本材料允许范围/)
})

test('a missing original task returns undefined for the manual recovery path', async t => {
  const { merges } = await fixture(t, false)
  const missing = { ...operation, task: { ...operation.task, worktree: '/gone' } }
  assert.equal(await merges.merge(missing, request, remote, 'main'), undefined)
})
