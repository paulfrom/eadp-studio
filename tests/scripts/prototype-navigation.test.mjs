import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'

const source = readFileSync('apps/desktop-distribution/build/studio-prototype-view.ts', 'utf8')
const url = 'data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(source)).toString('base64')
const { StudioPrototypeView } = await import(url)
const identity = { projectId: 'p', source: { kind: 'task', prototypeTaskId: 't' }, previewId: 'v', generation: 1, buildHash: 'a'.repeat(64), url: 'http://127.0.0.1:31234/' }

test('native preview navigation reloads and stays within its registered origin and identity', async () => {
  const view = new StudioPrototypeView(), owner = {}, calls = []
  view.view = { webContents: { isDestroyed: () => false, reload: () => calls.push('reload'), loadURL: async url => calls.push(url) } }
  view.instance = identity; view.owner = owner
  await view.navigate(owner, identity)
  await view.navigate(owner, identity, '/orders?q=1#details')
  assert.deepEqual(calls, ['reload', 'http://127.0.0.1:31234/orders?q=1#details'])
  for (const path of ['https://example.com', '//example.com', '/\\example.com', 'orders']) await assert.rejects(view.navigate(owner, identity, path))
  await assert.rejects(view.navigate(owner, { ...identity, generation: 2 }, '/orders'))
  await assert.rejects(view.navigate({}, identity, '/orders'))
  assert.equal(calls.length, 2)
})

test('bridge rejects navigation for a non-selected identity', async () => {
  const source = readFileSync('apps/desktop-distribution/build/studio-prototype-bridge.ts', 'utf8').replace("'./studio-prototype-view.ts'", JSON.stringify(url))
  const { studioPrototypeBridge: bridge } = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(source)).toString('base64'))
  bridge.instances.set(identity.previewId, identity)
  bridge.selected = { ...identity, generation: 2 }
  await assert.rejects(bridge.layout({}, { identity, sequence: 1, visible: true, bounds: { x: 0, y: 0, width: 50, height: 50 }, navigation: { reload: true } }), /not selected/)
})
