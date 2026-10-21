/**
 * The projection lane separates the state the surfaces render from the local
 * writer queue: a stalled write must not hold the workbench or the settings
 * sections at their last projection, and the two surfaces must not issue two
 * Host reads for one state.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { StudioApplication } from '../../packages/studio-plugin/src/host/application/studio.ts'
import { StudioStore } from '../../packages/studio-plugin/src/host/application/state.ts'
import { CollaborationError } from '../../packages/studio-plugin/src/host/adapters/collaboration/client.ts'
import type { CollaborationClient } from '../../packages/studio-plugin/src/host/adapters/collaboration/client.ts'
import type { HostPorts } from '../../packages/studio-plugin/src/host/application/ports.ts'

const user = { id: 7, username: 'tester', name: '测试用户', email: 'tester@example.test', admin: false, gitlabUserId: 1, gitlabUsername: 'liu' }

/** A workbench with one signed-in account and no local project. */
async function harness(t: test.TestContext, request: (method: string, route: string) => Promise<unknown>) {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-projection-lane-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new StudioStore(path.join(root, 'state'))
  const api = { request: (method: string, route: string) => request(method, route) } as unknown as CollaborationClient
  const ports = {
    account: async () => user,
    stopPreview: async () => {},
  } as unknown as HostPorts
  return new StudioApplication(store, api, ports)
}

test('a stalled local write does not hold the projection the surfaces render', async t => {
  const stalled = new Promise<never>(() => {})
  const app = await harness(t, async (_method, route) => {
    if (route === '/v1/namespaces') return stalled
    if (route === '/v1/projects') return []
    throw new Error(`unexpected ${route}`)
  })
  const write = app.command({ action: 'namespaces' })
  const reply = await app.command({ action: 'state' })
  assert.equal(reply.ok, true, JSON.stringify(reply))
  if (reply.ok) assert.equal(reply.state.connected, true)
  // The write is still outstanding; only its queue waits for it.
  assert.equal(await Promise.race([write.then(() => 'settled'), Promise.resolve('pending')]), 'pending')
})

test('concurrent projection reads share one Host read', async t => {
  let projectReads = 0
  const app = await harness(t, async (_method, route) => {
    if (route === '/v1/projects') { projectReads += 1; return [] }
    throw new Error(`unexpected ${route}`)
  })
  const [first, second] = await Promise.all([app.command({ action: 'state' }), app.command({ action: 'state' })])
  assert.equal(first.ok && second.ok, true)
  assert.equal(projectReads, 1, 'two surfaces asking for the state must not issue two reads')
})

test('a projection failure answers with its code instead of rejecting the command', async t => {
  const app = await harness(t, async () => { throw new CollaborationError('UNAVAILABLE', '协同服务暂不可用', 503) })
  const reply = await app.command({ action: 'state' })
  assert.equal(reply.ok, false)
  if (!reply.ok) assert.equal(reply.code, 'UNAVAILABLE')
})

test('a projection read that settles starts the next one', async t => {
  let projectReads = 0
  const app = await harness(t, async (_method, route) => {
    if (route === '/v1/projects') { projectReads += 1; return [] }
    throw new Error(`unexpected ${route}`)
  })
  await app.command({ action: 'state' })
  await app.command({ action: 'state' })
  assert.equal(projectReads, 2, 'a later refresh must observe the Host again')
})
