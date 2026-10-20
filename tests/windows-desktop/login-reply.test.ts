import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { StudioApplication } from '../../packages/studio-plugin/src/host/application/studio.ts'
import { StudioStore } from '../../packages/studio-plugin/src/host/application/state.ts'
import type { HostPorts } from '../../packages/studio-plugin/src/host/application/ports.ts'
import type { CollaborationClient } from '../../packages/studio-plugin/src/host/adapters/collaboration/client.ts'
import type { StudioCommand } from '../../packages/studio-plugin/src/shared/studio.ts'

const profile = { user: { id: 7, username: 'tester', name: '测试用户', email: 'tester@example.test', admin: false, gitlabUserId: 1, gitlabUsername: 'liu' }, gitlabOrigin: 'https://gitlab.example.test' }

test('a successful login reply carries the account even when the state projection fails', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-login-reply-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new StudioStore(path.join(root, 'state'))
  let signedIn = false
  const api = { request: async () => { throw new Error('backend unreachable') } } as unknown as CollaborationClient
  const ports = {
    account: async () => (signedIn ? profile.user : undefined),
    login: async () => { signedIn = true; return profile },
    logout: async () => { signedIn = false },
    stopPreview: async () => {},
  } as unknown as HostPorts
  const app = new StudioApplication(store, api, ports)
  const reply = await app.command({ action: 'login', username: 'tester', password: 'fixture-password' } as StudioCommand)
  assert.equal(reply.ok, true, JSON.stringify(reply))
  if (reply.ok) {
    assert.equal(reply.state.connected, true)
    assert.deepEqual(reply.state.account, profile.user)
  }
})
