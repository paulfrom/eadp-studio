import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { STUDIO_TYPERT_EDIT } from '../../apps/desktop-distribution/build/studio-typert-edits.mjs'

const git = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: path.resolve(import.meta.dirname, '../..'), encoding: 'utf8' })
if (git.status !== 0) throw new Error('Cannot locate the fixed DSH fixture source.')
const upstream = path.join(path.dirname(git.stdout.trim()), '.local/upstream/dsh')
const prepared = path.join(path.dirname(git.stdout.trim()), '.local/build/dsh')

test('Typert patch only changes the workspace analyzer invocation, is idempotent, and rejects drift', async () => {
  const source = await readFile(path.join(upstream, STUDIO_TYPERT_EDIT.file), 'utf8')
  const edited = STUDIO_TYPERT_EDIT.apply(source)
  assert.equal(edited.replace('}).analyzeInBatches()', '}).analyze()'), source)
  assert.equal(STUDIO_TYPERT_EDIT.apply(edited), edited)
  assert.throws(() => STUDIO_TYPERT_EDIT.apply('upstream drift'), /anchor/)
  assert.throws(() => STUDIO_TYPERT_EDIT.apply(`${source}\n${source}`), /anchor/)
  assert.throws(() => STUDIO_TYPERT_EDIT.apply(`${edited}\n${edited}`), /anchor/)
})

test('fixed upstream bounded analysis preserves the complete small Host/client fixture model', () => {
  // The fixed fixture is TypeScript with parameter properties. Node's default
  // strip-only loader cannot execute it, so the fixture runs in a child that
  // enables the transform this repository's Node 22 range provides.
  const analyzer = pathToFileURL(path.join(prepared, 'packages/typert/generator/src/analyzer.ts')).href
  const options = { root: path.join(prepared, 'packages/typert/generator/tests/fixtures/type-model'), packages: ['@fixture/host', '@fixture/client'], checkDiagnostics: false }
  const script = `
import assert from 'node:assert/strict'
const { WorkspaceAnalyzer } = await import(${JSON.stringify(analyzer)})
const options = ${JSON.stringify(options)}
const direct = new WorkspaceAnalyzer(options).analyze()
assert.deepEqual(new WorkspaceAnalyzer(options).analyzeInBatches(1), direct)
assert.deepEqual(new WorkspaceAnalyzer(options).analyzeInBatches(2), direct)
`
  const result = spawnSync(process.execPath, ['--experimental-transform-types', '--input-type=module', '--eval', script], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})
