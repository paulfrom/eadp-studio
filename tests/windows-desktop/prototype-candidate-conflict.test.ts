import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { PrototypeSourceBaseResult, PrototypeTaskView } from '../../packages/contracts/src/index.ts'
import { CollaborationError, type CollaborationClient } from '../../packages/studio-plugin/src/host/adapters/collaboration/client.ts'
import type { PrototypeConflictWriteback } from '../../packages/studio-plugin/src/host/adapters/workspace/git.ts'
import type { HostPorts } from '../../packages/studio-plugin/src/host/application/ports.ts'
import { PrototypeCandidates } from '../../packages/studio-plugin/src/host/application/prototype-candidates.ts'
import type { PrototypeCollaboration } from '../../packages/studio-plugin/src/host/application/prototype-collaboration.ts'
import type { PrototypeIntegrations } from '../../packages/studio-plugin/src/host/application/prototype-integrations.ts'
import { StudioStore } from '../../packages/studio-plugin/src/host/application/state.ts'
import type { TaskView } from '../../packages/studio-plugin/src/shared/studio.ts'

const oldBase = 'a'.repeat(40), expectedHead = 'b'.repeat(40), mergeBase = 'c'.repeat(40)
const oldSource = 'd'.repeat(40), newSource = 'e'.repeat(40)

for (const scenario of ['put', 'receipt', 'writeback'] as const) {
  test(`conflict recovery (${scenario}) preserves the original request and creates independent confirmation and evidence`, async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'prototype-candidate-conflict-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const store = new StudioStore(path.join(root, 'state')); store.useUser(1)
    const task: TaskView = { projectId: 'project', entityId: 'task', purpose: 'prototype', sessionId: 'session', inputHash: '', worktree: path.join(root, 'worktree'), baseHead: oldBase, writePaths: ['src/'] }
    const authorization: PrototypeTaskView = {
      id: task.entityId, prototypeId: 'prototype', ownerId: 1, clientId: 'client', generation: 1, revision: 1, status: 'active', title: 'Prototype task', branch: 'studio/task', startHead: oldBase, sourceBaseHead: oldBase,
      developmentRequirementIds: ['requirement'], referenceRequirementIds: [], developmentClaims: [{ requirementId: 'requirement', claimId: 'claim', generation: 1 }], claimsDigest: 'f'.repeat(64), writeScope: ['src/'], policyHash: 'a'.repeat(64),
    }
    const updated = { ...authorization, sourceBaseHead: expectedHead, revision: 2 }
    const request = {
      idempotencyKey: 'stable-source-base-key', token: { prototypeTaskId: task.entityId, generation: 1, clientId: 'client', expectedRevision: 1 },
      sourceOperationId: 'old-operation', sourceRef: 'refs/heads/studio-private/task/old-operation/source', sourceSha: oldSource, newBaseHead: expectedHead,
      developmentClaims: authorization.developmentClaims, claimsDigest: authorization.claimsDigest,
    }
    const result: PrototypeSourceBaseResult = { task: updated, source: { operationId: 'old-operation', ref: request.sourceRef, sha: oldSource, previousBaseHead: oldBase, newBaseHead: expectedHead } }
    const plan: PrototypeConflictWriteback = { files: [{ path: 'src/app.txt', before: { kind: 'file', sha256: '0'.repeat(64), mode: '100644' }, temporary: '.eadp-conflict-old-operation-deadbeef.tmp', status: 'pending' }] }
    const original = {
      id: 'old-operation', accountId: 1, task: scenario === 'writeback' ? { ...task, baseHead: expectedHead } : task, authorization: scenario === 'writeback' ? updated : authorization,
      status: 'conflict', sourceUpload: { ref: request.sourceRef, sha: oldSource, status: 'uploaded' },
      summary: {
        operationId: 'old-operation', projectId: task.projectId, prototypeTaskId: task.entityId, title: authorization.title, sourceBaseHead: oldBase, sourceSha: oldSource,
        claimsDigest: authorization.claimsDigest, developmentRequirementIds: authorization.developmentRequirementIds, summaryHash: 'old-summary', changes: [{ path: '原型代码/src/app.txt', status: 'modified' }], status: 'conflict', conflict: { expectedHead, files: ['原型代码/src/app.txt'] },
      },
      recovery: {
        request, directory: path.join(root, 'conflict-scene'), mergeBaseSha: mergeBase, conflictFiles: ['src/app.txt'], phase: scenario === 'writeback' ? 'writeback' : 'source-base',
        ...(scenario === 'writeback' ? { result, writeback: plan } : {}),
      },
    }
    await mkdir(store.directory, { recursive: true })
    await writeFile(path.join(store.directory, 'prototype-candidates.json'), JSON.stringify({ operations: [original] }))
    const requests: Array<{ method: string; route: string; body?: object }> = []
    const api = { request: async (method: string, route: string, body?: object) => {
      assert.notEqual(scenario, 'writeback', 'a persisted source-base result must not be requested again')
      requests.push({ method, route, ...(body ? { body } : {}) })
      if (method === 'GET') {
        if (scenario === 'put') throw new CollaborationError('OPERATION_NOT_FOUND', 'not found', 404)
        assert.equal(route, '/v1/projects/project/operations/stable-source-base-key')
        return { action: 'prototype.task.source-base:task', result }
      }
      assert.equal(scenario, 'put'); return result
    } } as unknown as CollaborationClient
    const collaboration = { confirmationTask: async () => ({ task: { ...task, baseHead: expectedHead }, authorization: updated }) } as unknown as PrototypeCollaboration
    const integrations = { unresolved: async () => undefined, operation: async () => undefined } as unknown as PrototypeIntegrations
    const restorations: Array<{ hadPlan: boolean; sourceSha: string; expectedHead: string }> = []
    const snapshot = [{ path: 'src/app.txt', bytes: Buffer.from('resolved\n'), mode: '100644' as const }]
    const sourceTreeHash = createHash('sha256').update(snapshot[0]!.path).update('\0').update(snapshot[0]!.bytes).update('\0').digest('hex')
    const ports = {
      account: async () => ({ id: 1 }),
      git: {
        prototypeRestoreConflict: async (_root: string, input: { writeback?: PrototypeConflictWriteback; sourceSha: string; expectedHead: string; onPlan(plan: PrototypeConflictWriteback): Promise<void>; onPathRestored(path: string): Promise<void> }) => {
          restorations.push({ hadPlan: !!input.writeback, sourceSha: input.sourceSha, expectedHead: input.expectedHead })
          const writeback = structuredClone(input.writeback ?? plan)
          if (!input.writeback) await input.onPlan(writeback)
          for (const entry of writeback.files) if (entry.status !== 'written') { entry.status = 'written'; await input.onPathRestored(entry.path) }
          return { conflictFiles: ['src/app.txt'], writeback }
        },
        prototypeSource: async (_root: string, base: string, operationId: string) => { assert.equal(base, expectedHead); assert.equal(operationId, 'new-operation'); return { sha: newSource, changedPaths: ['原型代码/src/app.txt'] } },
        prototypeSnapshot: async () => snapshot,
        changedPathStatuses: async () => [{ path: '原型代码/src/app.txt', status: 'M' }], identity: async () => ({ name: 'Author', email: 'author@example.test' }),
      },
      candidateChecks: async (_task: TaskView, candidateSha: string, operationId: string) => {
        assert.equal(candidateSha, newSource); assert.equal(operationId, 'new-check')
        return { candidateSha, sourceTreeHash, rulesHash: '1'.repeat(64), buildArtifactSha256: '2'.repeat(64), checks: ['engineering', 'mock', 'browser'].map(name => ({ name, passed: true as const, evidenceHash: createHash('sha256').update(`${name}:${candidateSha}`).digest('hex') })) }
      },
    } as unknown as HostPorts
    const candidates = new PrototypeCandidates(store, api, ports, collaboration, integrations)

    const before = await candidates.latest([task.entityId])
    assert.equal(before[0]?.operationId, 'old-operation'); assert.equal(before[0]?.status, 'conflict'); assert.deepEqual(before[0]?.conflict?.files, ['原型代码/src/app.txt'])
    const summary = await candidates.prepare(task.entityId, 'new-operation')
    assert.equal(summary.operationId, 'new-operation'); assert.equal(summary.sourceBaseHead, expectedHead); assert.equal(summary.sourceSha, newSource); assert.equal(summary.status, 'ready')
    assert.deepEqual(restorations, [{ hadPlan: scenario === 'writeback', sourceSha: oldSource, expectedHead }])
    assert.equal(requests.filter(value => value.method === 'PUT').length, scenario === 'put' ? 1 : 0)
    assert.equal(requests.length, scenario === 'writeback' ? 0 : scenario === 'put' ? 2 : 1)
    const put = requests.find(value => value.method === 'PUT')
    if (put) assert.deepEqual(put.body, request)
    await candidates.check('new-operation', 'new-check')
    const confirmed = await candidates.confirm('new-operation', summary.summaryHash)
    assert.equal(confirmed.status, 'confirmed'); assert.equal(confirmed.checks, 'passed')
    const persisted = JSON.parse(await readFile(path.join(store.directory, 'prototype-candidates.json'), 'utf8'))
    assert.equal(persisted.operations[0].recovery.phase, 'restored'); assert.equal(persisted.operations[0].authorization.sourceBaseHead, expectedHead); assert.equal(persisted.operations[0].task.baseHead, expectedHead)
    assert.ok(persisted.operations[0].recovery.writeback.files.every((value: { status: string }) => value.status === 'written'))
    assert.equal(persisted.operations[0].summary.status, 'conflict'); assert.equal(persisted.operations[1].id, 'new-operation')
    assert.match(persisted.operations[1].confirmationId, /^[a-f0-9-]{36}$/); assert.equal(persisted.operations[1].evidence.candidateSha, newSource); assert.equal(persisted.operations[1].checkOperationId, 'new-check')
    assert.equal((await candidates.latest([task.entityId]))[0]?.operationId, 'new-operation')
    await assert.rejects(candidates.confirm('old-operation', 'old-summary'), /冲突修复/)
    await assert.rejects(candidates.submit('old-operation', 'old-check'), /请先确认/)
  })
}
