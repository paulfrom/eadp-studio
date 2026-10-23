import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'

const repo = path.resolve(import.meta.dirname, '../..')
const require = createRequire(path.join(repo, '.local/build/dsh/package.json'))
const ts = require('typescript')
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

function sessionFixture(call) {
  const settled = []
  let projection
  const source = readFileSync(path.join(repo, 'packages/studio-plugin/src/client/session.ts'), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', compiled)(specifier => {
    if (specifier === './state.ts') return { emptyStudioState: () => ({ connected: false }) }
    if (specifier === './store.ts') return { createStudioProjectionStore: () => ({ create: () => ({ getSnapshot: () => ({ projection }), actions: { settle: state => { projection = state; settled.push(state) }, start() {}, fail() {}, report() {} } }) }) }
    throw new Error(`unexpected dependency ${specifier}`)
  }, module, module.exports)
  return { session: module.exports.createStudioSession(call, async () => []), settled }
}

test('an older background comparison reply cannot replace a newer saved material projection', async () => {
  const earlier = deferred()
  const saved = { connected: true, project: { id: 'p' }, account: { id: 1 }, drafts: [{ entityId: 'req', sha256: 'new-hash', body: '新正文' }] }
  const { session, settled } = sessionFixture(async command => command.action === 'listConsistencySummaries' ? earlier.promise : { ok: true, state: saved })
  const reading = session.run({ action: 'listConsistencySummaries' })
  await session.run({ action: 'saveRequirement', entityId: 'req' })
  earlier.resolve({ ok: true, state: { ...saved, consistencyLatest: [{ id: 'cmp', entityId: 'req', createdAt: '2026-10-23T00:00:00Z' }], drafts: [{ entityId: 'req', sha256: 'old-hash', body: '旧正文' }] } })
  await reading
  assert.deepEqual(settled.at(-1).drafts, saved.drafts)
  assert.equal(settled.at(-1).consistencyLatest[0].id, 'cmp')
})

test('history and source queries never settle a full projection or block an earlier material save', async () => {
  const earlier = deferred()
  const current = { connected: true, drafts: [{ entityId: 'req', body: '刚保存的正文' }] }
  const { session, settled } = sessionFixture(async command => command.action === 'saveRequirement' ? earlier.promise : { ok: true, state: { connected: true, drafts: [] }, comparisons: [] })
  const saving = session.run({ action: 'saveRequirement', entityId: 'req' })
  await session.run({ action: 'listConsistencyComparisons', entityId: 'req', limit: 20, offset: 0 })
  await session.run({ action: 'readRequirementSource', entityId: 'req', sourceEntityId: 's', expectedVersion: 2 })
  await session.run({ action: 'listConsistencySummaries' })
  assert.deepEqual(settled, [])
  earlier.resolve({ ok: true, state: current })
  await saving
  assert.deepEqual(settled, [current])
})

test('a summary response from a previous project cannot enter the newly selected project', async () => {
  const earlier = deferred()
  const current = { connected: true, project: { id: 'new-project' }, account: { id: 1 }, consistencyLatest: [] }
  const { session, settled } = sessionFixture(async command => command.action === 'listConsistencySummaries' ? earlier.promise : { ok: true, state: current })
  const reading = session.run({ action: 'listConsistencySummaries' })
  await session.run({ action: 'openProject', projectId: 'new-project' })
  earlier.resolve({ ok: true, state: { ...current, project: { id: 'old-project' }, consistencyLatest: [{ id: 'old', entityId: 'req' }] } })
  await reading
  assert.deepEqual(settled, [current])
})

test('a summary completing before an earlier save never prevents the save or regresses a newer comparison', async () => {
  const saving = deferred()
  const newer = { entityId: 'req', id: 'new-comparison', createdAt: '2026-10-23T02:00:00Z' }
  const base = { connected: true, project: { id: 'p' }, account: { id: 1 }, drafts: [{ entityId: 'req', body: '旧正文' }], consistencyLatest: [newer] }
  const { session, settled } = sessionFixture(async command => command.action === 'saveRequirement' ? saving.promise : { ok: true, state: base })
  await session.run({ action: 'openProject', projectId: 'p' })
  const write = session.run({ action: 'saveRequirement', entityId: 'req' })
  await session.run({ action: 'listConsistencySummaries' })
  saving.resolve({ ok: true, state: { ...base, drafts: [{ entityId: 'req', body: '新正文' }], consistencyLatest: [{ entityId: 'req', id: 'old-comparison', createdAt: '2026-10-23T01:00:00Z' }] } })
  await write
  assert.equal(settled.at(-1).drafts[0].body, '新正文')
  assert.deepEqual(settled.at(-1).consistencyLatest, [newer])
})
