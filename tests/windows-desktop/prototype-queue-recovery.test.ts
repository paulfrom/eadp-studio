import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { StudioStore } from '../../packages/studio-plugin/src/host/application/state.ts'
import { PrototypeCollaboration } from '../../packages/studio-plugin/src/host/application/prototype-collaboration.ts'
import type { HostPorts } from '../../packages/studio-plugin/src/host/application/ports.ts'
import type { CollaborationClient } from '../../packages/studio-plugin/src/host/adapters/collaboration/client.ts'

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'prototype-queue-recovery-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new StudioStore(path.join(root, 'state')); store.useUser(1)
  const local = await store.read(), worktree = path.join(root, 'worktree')
  await mkdir(worktree)
  const task = { id: 'task', status: 'active', ownerId: 1, clientId: local.clientId, generation: 1, title: '项目事项', branch: 'studio/task', sourceBaseHead: 'a'.repeat(40), writeScope: ['src/pages/'], developmentClaims: [{ requirementId: 'requirement' }], developmentRequirementIds: ['requirement'] }
  const operation = { id: 'original-message', taskId: 'task', phase: 'sending', request: { action: 'startPrototypeCollaboration', instruction: '原指令' } }
  await writeFile(path.join(store.directory, 'prototype-queue.json'), JSON.stringify({ revision: 1, selectedTaskId: 'task', tasks: [{ projectId: 'project', task, sessionId: 'session', worktree, state: 'running' }], operations: [operation] }))
  const calls = { prompts: 0, restores: 0, inspected: [] as string[] }
  let delivery = 'unknown'
  const ports = { prototypeManifestPath: path.resolve('packages/studio-plugin/assets/prototype-template.manifest.json'),
    git: { state: async () => ({ branch: task.branch }) },
    session: async (_task: unknown, _rules: string, existing: boolean) => { assert.equal(existing, true); calls.restores++; return 'session' },
    prompt: async () => { calls.prompts++ },
    inspectPrompt: async (session: string, operationId: string) => { assert.equal(session, 'session'); calls.inspected.push(operationId); return delivery },
    settlePrototypeSession: async () => true,
  } as unknown as HostPorts
  const api = { request: async (method: string, route: string) => { assert.equal(method, 'GET'); assert.equal(route, '/v1/projects/project/prototype/tasks/task'); return task } } as unknown as CollaborationClient
  return { collaboration: new PrototypeCollaboration(store, api, ports), calls, task, delivery: (value: string) => { delivery = value } }
}

test('project task restores its existing session after restart without sending another instruction', async t => {
  const f = await fixture(t)
  assert.equal((await f.collaboration.view()).items[0]!.localDispatchState, 'recovery-required')
  assert.equal(await f.collaboration.restoreSession('session'), 'session')
  assert.equal(f.calls.restores, 1)
  assert.equal(f.calls.prompts, 0)
  f.task.ownerId = 2
  await assert.rejects(f.collaboration.restoreSession('session'), /开发占用已变化/)
  assert.equal(f.calls.restores, 1)
})

test('unknown delivery queries the original operation and never resends, including after recovery', async t => {
  const f = await fixture(t)
  await f.collaboration.queryMessage('task')
  assert.equal((await f.collaboration.view()).items[0]!.localDispatchState, 'recovery-required')
  assert.equal(f.calls.prompts, 0)
  f.delivery('delivered')
  await f.collaboration.queryMessage('task')
  assert.deepEqual(f.calls.inspected, ['original-message', 'original-message'])
  assert.equal((await f.collaboration.view()).items[0]!.localDispatchState, 'awaiting-user')
  assert.equal(f.calls.prompts, 0)
})

test('a clean task cannot restore a write scope outside the protected template policy', async t => {
  const f = await fixture(t)
  f.task.writeScope = ['../outside']
  await assert.rejects(f.collaboration.restoreSession('session'), /写入范围超出原型模板可写区域/)
  assert.equal(f.calls.restores, 0)
  assert.equal(f.calls.prompts, 0)
})
