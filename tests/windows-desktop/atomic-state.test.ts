import assert from 'node:assert/strict'
import fs, { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { AtomicState } from '../../packages/studio-plugin/src/host/adapters/local-state/atomic-state.ts'

test('Windows transient replacement locks retry the same atomic file and preserve serialization', { skip: process.platform !== 'win32' }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'atomic-state-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const filename = path.join(root, 'state.json'), store = new AtomicState<{ version: number }>(filename)
  await store.write({ version: 0 })
  const rename = fs.rename, attempts: string[] = [], versions: number[] = []
  const codes = ['EPERM', 'EACCES', 'EBUSY']
  fs.rename = async (from, to) => {
    attempts.push(String(from))
    if (codes.length) {
      assert.equal(JSON.parse(await readFile(filename, 'utf8')).version, 0)
      throw Object.assign(new Error('temporarily locked'), { code: codes.shift() })
    }
    await rename(from, to)
    versions.push(JSON.parse(await readFile(filename, 'utf8')).version)
  }
  syncBuiltinESMExports()
  try { await Promise.all([store.write({ version: 1 }), store.write({ version: 2 })]) }
  finally { fs.rename = rename; syncBuiltinESMExports() }
  assert.equal(new Set(attempts.slice(0, 4)).size, 1)
  assert.deepEqual(versions, [1, 2]); assert.deepEqual(await store.read(), { version: 2 })
})

test('persistent Windows locks and unknown errors preserve the previous file and do not poison later saves', { skip: process.platform !== 'win32' }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'atomic-state-failure-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const filename = path.join(root, 'state.json'), store = new AtomicState<{ version: number }>(filename)
  await store.write({ version: 0 })
  const rename = fs.rename
  for (const code of ['EPERM', 'EBADF']) {
    let attempts = 0
    fs.rename = async () => { attempts++; throw Object.assign(new Error(code), { code }) }
    syncBuiltinESMExports()
    try { await assert.rejects(store.write({ version: 1 }), { code }) }
    finally { fs.rename = rename; syncBuiltinESMExports() }
    assert.equal(attempts, code === 'EPERM' ? 9 : 1)
    assert.deepEqual(await store.read(), { version: 0 })
    assert.deepEqual(await readdir(root), ['state.json'])
  }
  await store.write({ version: 2 }); assert.deepEqual(await store.read(), { version: 2 })
})
