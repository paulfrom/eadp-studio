import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'

const repo = path.resolve(import.meta.dirname, '../..')
const ts = createRequire(path.join(repo, '.local/build/dsh/package.json'))('typescript')
const source = await readFile(path.join(repo, 'packages/studio-plugin/src/client/studio/StudioPanel.tsx'), 'utf8')
const compiled = ts.transpileModule(source.replace(/^import .+\n/gm, '').replace(/\bexport /g, ''), { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } }).outputText
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const flush = () => new Promise(done => setImmediate(done))

function mount() {
  const restore = deferred(), ready = deferred(), calls = [], effects = [], slots = []
  let index = 0, retained = 0, released = 0
  const reference = { ready: ready.promise, release: () => { released++ } }
  const Component = new Function('React', 'useState', 'useEffect', 'css', `${compiled}; return NativeConversation`)(
    { createElement: (type, props, ...children) => ({ type, props, children }) },
    initial => { const key = index++; if (!(key in slots)) slots[key] = typeof initial === 'function' ? initial() : initial; return [slots[key], value => { slots[key] = typeof value === 'function' ? value(slots[key]) : value }] },
    effect => { effects.push(effect) }, {},
  )
  const props = { sessionId: 'studio-existing', call: async command => { calls.push(command); return restore.promise }, retainSession: () => { retained++; return reference }, SessionProvider: 'NativeProvider', renderFactorySlot: () => 'conversation' }
  const render = () => { index = 0; return Component(props) }
  render(); const clean = effects[0]()
  return { restore, ready, calls, render, clean, retained: () => retained, released: () => released }
}

test('cold native client binds the Host task before retain can promote an unconfigured writer', async () => {
  const f = mount()
  assert.equal(f.retained(), 0, 'retainSession must wait for trusted task restoration')
  assert.deepEqual(f.calls, [{ action: 'restoreSession', sessionId: 'studio-existing' }])
  f.restore.resolve({ ok: true, sessionId: 'studio-existing' }); await flush()
  assert.equal(f.retained(), 1)
  f.ready.resolve(); await flush()
  assert.equal(f.render().children[0].type, 'NativeProvider')
  f.clean(); assert.equal(f.released(), 1)
})

test('a denied task restoration never exposes an actionable native session', async () => {
  const f = mount()
  f.restore.resolve({ ok: false, code: 'STUDIO_OPERATION_FAILED', message: '占用已失效' }); await flush()
  assert.equal(f.retained(), 0)
  assert.equal(f.render().props.role, 'alert')
  f.clean()
})

test('unmount before a slow trusted restoration does not activate a late native writer', async () => {
  const f = mount(); f.clean()
  f.restore.resolve({ ok: true, sessionId: 'studio-existing' }); await flush()
  assert.equal(f.retained(), 0)
})
