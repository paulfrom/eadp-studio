/** DesktopSecretStore speaks parent/child IPC; exercise the real wire with a Node parent standing in for Electron. */
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'

const credentialsModule = new URL('../../packages/studio-plugin/src/host/adapters/platform/credentials.ts', import.meta.url).href

const childFixture = String.raw`
const { DesktopSecretStore } = await import(process.env.STUDIO_CREDENTIALS_MODULE)
const store = new DesktopSecretStore()
const report = (value) => { process.stdout.write('RESULT ' + JSON.stringify(value) + '\n') }
const scenario = process.argv[2]
try {
  if (scenario === 'roundtrip') {
    const session = { origin: 'http://studio.example.test', token: 'studio_' + 'a'.repeat(43), expiresAt: '2026-12-01T00:00:00.000Z', userId: 1 }
    await store.write('collaboration-session', session)
    const read = await store.read('collaboration-session')
    if (JSON.stringify(read) !== JSON.stringify(session)) throw new Error('roundtrip mismatch')
    await store.delete('collaboration-session')
    if (await store.read('collaboration-session') !== undefined) throw new Error('delete did not clear')
    report({ ok: true })
  } else if (scenario === 'rejected') {
    try { await store.read('collaboration-session'); report({ ok: false, message: 'a failed parent reply must reject' }) }
    catch (error) { report({ ok: true, message: String(error) }) }
  } else if (scenario === 'badkey') {
    try { await store.read('escaped-key'); report({ ok: false, message: 'invalid key must reject' }) }
    catch (error) { report({ ok: true, message: String(error) }) }
  } else report({ ok: false, message: 'unknown scenario ' + scenario })
} catch (error) { report({ ok: false, message: String(error) }) }
process.exit(0)
`

/** Stand-in for the Electron main handler: same request surface, plain in-memory vault. */
function serve(child, { failAll = false } = {}) {
  const vault = new Map()
  child.on('message', message => {
    if (!message || typeof message !== 'object' || message.type !== 'studio-secret-request') return
    if (failAll || !/^(?:collaboration-session|publication-[a-z0-9-]+)$/.test(message.key)) {
      child.send({ type: 'studio-secret-result', requestId: message.requestId, ok: false })
      return
    }
    if (message.action === 'delete') vault.delete(message.key)
    else if (message.action === 'write') vault.set(message.key, message.value)
    child.send({ type: 'studio-secret-result', requestId: message.requestId, ok: true, value: vault.get(message.key) })
  })
  return vault
}

async function runChild(fixturePath, scenario, failAll = false) {
  const child = spawn(process.execPath, ['--experimental-strip-types', fixturePath, scenario], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, STUDIO_CREDENTIALS_MODULE: credentialsModule },
  })
  serve(child, { failAll })
  let output = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => { output += chunk })
  const code = await new Promise((resolve, reject) => {
    child.once('exit', resolve)
    child.once('error', reject)
  })
  const line = output.split('\n').find(value => value.startsWith('RESULT '))
  return { code, result: line ? JSON.parse(line.slice('RESULT '.length)) : undefined }
}

test('session credentials survive a full write/read/delete cycle across the real IPC boundary', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-secret-ipc-'))
  try {
    const fixturePath = path.join(root, 'child.mjs')
    await writeFile(fixturePath, childFixture)
    const { code, result } = await runChild(fixturePath, 'roundtrip')
    assert.equal(code, 0)
    assert.deepEqual(result, { ok: true })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a failed parent reply and an invalid credential key reject instead of resolving', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-secret-ipc-'))
  try {
    const fixturePath = path.join(root, 'child.mjs')
    await writeFile(fixturePath, childFixture)
    const failed = await runChild(fixturePath, 'rejected', true)
    assert.equal(failed.result?.ok, true)
    assert.match(failed.result?.message ?? '', /凭据操作失败/)
    const invalid = await runChild(fixturePath, 'badkey')
    assert.equal(invalid.result?.ok, true)
    assert.match(invalid.result?.message ?? '', /凭据标识无效/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
