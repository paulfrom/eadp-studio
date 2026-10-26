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
const task: TaskView = { projectId: 'p', entityId: 'e', sessionId: 's1', purpose: 'material', inputHash: '', worktree: '/w' }
const operation = { id: 'op1', accountId: 1, projectId: 'p', entityId: 'e', phase: 'unknown',
  task: { projectId: 'p', entityId: 'e', worktree: '/w', purpose: 'material', sessionId: 's1', inputHash: '' },
  candidateSha: candidate, expectedHead: expected, fixedPath: '场景/e.md', sha256: sha('c'), prepare: {}, token: {} } as PendingOperation
const request = { idempotencyKey: 'op1', sourceSha: candidate, candidateSha: candidate, expectedHead: expected,
  allowedPaths: ['场景/e.md'], checks: { candidateSha: candidate, passed: true, checks: [] }, entityId: 'e',
  token: {}, stage: 'material',
  confirmations: [{ entityId: 'e', fixed: { commitSha: candidate, path: '场景/e.md', sha256: sha('c') }, readHash: sha('c'), authorConfirmed: true }] } as unknown as MaterialIntegrationRequest
const draft = { path: '场景/e.md', sha256: sha('d'), body: 'merged', entityId: 'e', metadata: { entityId: 'e', sources: [] } } as unknown as MaterialDraft

async function fixture(t: { after(fn: () => unknown): void }, conflict: boolean, outOfScope = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'merges-')); t.after(() => rm(root, { recursive: true, force: true }))
  const store = new StudioStore(root); store.useUser(1)
  const local = await store.read(); local.tasks.push(structuredClone(task)); await store.save()
  const calls: string[] = []
  let currentHead = candidate
  const ports = {
    session: async (_task: TaskView) => 'studio-merge-op1-333333333333',
    prompt: async () => { calls.push('prompt') },
    git: {
      state: async () => ({ root: '/w', head: currentHead, branch: 'main', dirty: false, repositoryUrl: 'https://gitlab.test/p.git' }),
      fetch: async () => { calls.push('fetch') },
      changedFiles: async (_root: string, from: string, to: string) => from === expected && to === remote ? ['场景/remote.md'] : outOfScope ? ['其他/x.md'] : ['场景/e.md'],
      merge: async () => { currentHead = merged; return conflict ? { status: 'conflicted', files: ['场景/e.md'] } : { status: 'merged', commit: merged } },
      completeMerge: async (_root: string, files: string[]) => { calls.push(`complete:${files.join(',')}`); currentHead = merged; return merged },
    },
  } as unknown as HostPorts
  const merges = new CandidateMerges(store, ports, {
    entity: async () => ({ entity: { id: 'e', kind: 'scenario' } as EntityView }),
    identity: async () => ({ name: '作者', email: 'a@b.test' }),
    checks: (candidateSha: string) => ({ candidateSha, passed: true, checks: [] }) as CheckEvidence,
    readDraft: async () => structuredClone(draft),
  })
  return { merges, calls }
}

test('a clean merge rebuilds the candidate on the new remote head and keeps the original read hash', async t => {
  const { merges } = await fixture(t, false)
  const result = await merges.merge(operation, request, remote, 'main')
  assert.ok(result)
  assert.equal(result.prepare.idempotencyKey, `m-${merged}`)
  assert.equal(result.prepare.expectedHead, remote)
  assert.equal(result.prepare.candidateSha, merged)
  assert.equal(result.prepare.sourceSha, merged)
  assert.equal(result.prepare.confirmations[0]!.fixed.commitSha, merged)
  assert.equal(result.prepare.confirmations[0]!.fixed.sha256, sha('d'))
  assert.equal(result.prepare.confirmations[0]!.readHash, sha('c'), '用户阅读版本不随合并改变')
  assert.deepEqual(result.note, { remoteFiles: ['场景/remote.md'], aiFiles: [] })
})

test('a conflicted merge waits for the agent turn and completes the merge commit', async t => {
  const { merges, calls } = await fixture(t, true)
  const promise = merges.merge(operation, request, remote, 'main')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, ['fetch', 'prompt'])
  assert.equal(await merges.accept('studio-merge-op1-333333333333', { kind: 'turn-ended', reason: 'stop' }), true)
  const result = await promise
  assert.ok(result)
  assert.deepEqual(result.note.aiFiles, ['场景/e.md'])
  assert.ok(calls.includes('complete:场景/e.md'))
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
