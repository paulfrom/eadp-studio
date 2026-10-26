/**
 * The local recovery record of a previous version must never block the current
 * workbench: its file is preserved beside the record, a current-version record is
 * written, and the projection can say where the old bytes went.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { StudioStore } from '../../packages/studio-plugin/src/host/application/state.ts'

/** A record as this version writes it: every collection and the check flag present. */
const currentRecord = { formatVersion: 2, clientId: 'client-current', scenarioStructureCheck: true, projects: [], tasks: [], candidates: [], operations: [], reviews: [], adoptions: [], projectInitializations: [], materialReservations: [], templateOperations: [], scenarios: [], scenarioRepairs: [], consistencyComparisons: [] }
/** A record an earlier version wrote: later collections are absent. */
const previousRecord = { clientId: 'client-previous', projects: [], tasks: [], candidates: [], operations: [], reviews: [], adoptions: [], projectInitializations: [] }

async function harness(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-state-recovery-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new StudioStore(path.join(root, 'state'))
  store.useUser(1)
  await mkdir(store.directory, { recursive: true })
  return { store, directory: store.directory, root: path.join(root, 'state') }
}

/** Files left beside the record, sorted for stable assertions. */
async function files(directory: string): Promise<string[]> { return (await readdir(directory)).sort() }

test('a current-version record is read as it is and nothing is preserved', async t => {
  const { store, directory } = await harness(t)
  await writeFile(path.join(directory, 'studio-state.json'), JSON.stringify(currentRecord))
  const state = await store.read()
  assert.equal(state.clientId, 'client-current')
  assert.equal(state.scenarioStructureCheck, true)
  assert.deepEqual(await files(directory), ['studio-state.json'])
  assert.equal(store.preservedRecord, undefined)
})

test('a complete pre-confirmation-format record preserves its exact bytes instead of reinterpreting an old confirmation', async t => {
  const { store, directory } = await harness(t)
  const previous = structuredClone(currentRecord) as Record<string, unknown>
  delete previous.formatVersion
  previous.scenarios = [{ projectId: 'project', entityId: 'requirement', sources: [], sourcePaths: {}, requirementConfirmation: { operationId: 'old-intent', choice: { method: 'direct' } } }]
  const original = JSON.stringify(previous)
  await writeFile(path.join(directory, 'studio-state.json'), original)
  const state = await store.read()
  assert.equal(state.formatVersion, 2); assert.equal(state.clientId, currentRecord.clientId)
  assert.deepEqual(state.scenarios, []); assert.deepEqual(state.operations, [])
  assert.ok(store.preservedRecord)
  assert.equal(await readFile(store.preservedRecord.preservedPath, 'utf8'), original)
})

test('a previous-version record is preserved beside the record and rebuilt for this version', async t => {
  const { store, directory, root } = await harness(t)
  const record = path.join(directory, 'studio-state.json')
  const original = JSON.stringify(previousRecord, null, 2)
  await writeFile(record, original)
  const state = await store.read()
  // The workbench starts from empty local work instead of failing at startup.
  assert.deepEqual(state.projects, [])
  assert.deepEqual(state.scenarioRepairs, [])
  assert.equal(state.scenarioStructureCheck, false)
  // Occupations on the backend are bound to this identity, so the rebuilt record
  // keeps it: the local work is gone but the device's tasks stay releasable.
  assert.equal(state.clientId, 'client-previous')
  // The old bytes are untouched under a name that says what they are.
  const preserved = store.preservedRecord?.preservedPath
  assert.ok(preserved, 'the projection can report where the previous record went')
  assert.match(path.basename(preserved), /^studio-state\.json\.invalid-/)
  assert.equal(await readFile(preserved, 'utf8'), original)
  assert.deepEqual(await files(directory), ['studio-state.json', path.basename(preserved)].sort())
  // The record itself is now the current version, so the next start reads it.
  const written = JSON.parse(await readFile(record, 'utf8')) as Record<string, unknown>
  assert.equal(typeof written.clientId, 'string')
  assert.equal(written.scenarioStructureCheck, false)
  for (const name of ['projects', 'tasks', 'candidates', 'operations', 'reviews', 'adoptions', 'projectInitializations', 'materialReservations', 'templateOperations', 'scenarios', 'scenarioRepairs']) assert.deepEqual(written[name], [], name)
  const restarted = new StudioStore(root); restarted.useUser(1)
  assert.equal((await restarted.read()).clientId, written.clientId, 'the next start reads the rebuilt record as the current version')
  assert.equal(restarted.preservedRecord, undefined, 'a current-version record is not preserved again')
})

test('a malformed record is preserved instead of stopping the workbench', async t => {
  const { store, directory } = await harness(t)
  await writeFile(path.join(directory, 'studio-state.json'), '{ not json')
  const state = await store.read()
  assert.deepEqual(state.tasks, [])
  // Unreadable bytes name no identity, so the device starts under a fresh one.
  assert.match(state.clientId, /^[0-9a-f-]{36}$/)
  const preserved = store.preservedRecord?.preservedPath
  assert.ok(preserved)
  assert.equal(await readFile(preserved, 'utf8'), '{ not json')
})

test('another user starts from that user own record, without the earlier recovery notice', async t => {
  const { store, directory } = await harness(t)
  await writeFile(path.join(directory, 'studio-state.json'), '{ not json')
  await store.read()
  assert.ok(store.preservedRecord)
  store.useUser(2)
  assert.equal(store.preservedRecord, undefined)
  const state = await store.read()
  assert.deepEqual(state.projects, [])
  assert.match(store.directory, /users[\\/]2$/)
})
