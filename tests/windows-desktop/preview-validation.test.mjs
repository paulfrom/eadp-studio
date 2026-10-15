import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'

// Exercise the production composition closures with process/browser boundaries
// injected. These checks do not substitute for native Electron acceptance.
const source = await readFile(new URL('../../packages/studio-plugin/src/host/composition.ts', import.meta.url), 'utf8')
const checks = source.slice(source.indexOf('  const runChecks ='), source.indexOf('  const publication ='))
const preview = source.slice(source.indexOf('    preview: async task => {'), source.indexOf('    }, stopPreview,')).replace('    preview:', 'const requestPreview =') + '    };'
assert.ok(checks && preview.includes('requestPreview'))

function fixture() {
  return new Function(`
    let preview, starts = 0, stops = 0, browserCalls = 0;
    const errors = { browser: false, engineering: false, binding: false };
    const checkResults = new Map(), runtime = {};
    const bind = async () => { if (errors.binding) throw Error('binding failed'); return { input: {}, binding: {} }; };
    const installPrototypeDependencies = async () => {};
    const runPrototypeChecks = async () => { if (errors.engineering) throw Error('engineering failed'); return { inputHash: 'same' }; };
    const stopPreview = async () => { if (preview) { stops++; preview = undefined; } };
    const startPrototypePreview = async () => { starts++; return { url: 'http://127.0.0.1:4173' }; };
    const checkStaticPreview = async () => { browserCalls++; if (errors.browser) throw Error('browser failed'); return 'verified-browser'; };
    const digest = () => 'hash';
    ${stripTypeScriptTypes(checks, { mode: 'transform' })}
    ${stripTypeScriptTypes(preview, { mode: 'transform' })}
    return { runChecks, requestPreview, errors, snapshot: () => ({ starts, stops, browserCalls, cached: checkResults.size, running: !!preview }) };
  `)()
}
const task = { sessionId: 'acceptance-session', entityId: 'requirement', inputHash: 'input' }

test('failed browser/Mock validation cannot leave a preview or reusable evidence', async () => {
  const f = fixture(); f.errors.browser = true
  await assert.rejects(f.runChecks(task, 'a'.repeat(40)), /browser failed/)
  await assert.rejects(f.requestPreview(task), /请先运行工程检查/)
  assert.deepEqual(f.snapshot(), { starts: 1, stops: 1, browserCalls: 1, cached: 0, running: false })
})

test('a failed recheck invalidates a previous successful result before engineering work', async () => {
  const f = fixture(); await f.runChecks(task, 'a'.repeat(40)); f.errors.engineering = true
  await assert.rejects(f.runChecks(task, 'b'.repeat(40)), /engineering failed/)
  await assert.rejects(f.requestPreview(task), /请先运行工程检查/)
  assert.equal(f.snapshot().cached, 0); assert.equal(f.snapshot().running, false)
})

test('even a binding failure invalidates old evidence and closes the owned preview', async () => {
  const f = fixture(); await f.runChecks(task, 'a'.repeat(40)); f.errors.binding = true
  await assert.rejects(f.runChecks(task, 'b'.repeat(40)), /binding failed/)
  assert.equal(f.snapshot().cached, 0); assert.equal(f.snapshot().running, false)
})

test('restarted previews must pass browser validation and failure requires fresh checks', async () => {
  const f = fixture(); await f.runChecks(task, 'a'.repeat(40)); f.errors.browser = true
  await assert.rejects(f.requestPreview(task), /browser failed/)
  assert.equal(f.snapshot().cached, 0); assert.equal(f.snapshot().running, false)
  f.errors.browser = false
  await assert.rejects(f.requestPreview(task), /请先运行工程检查/)
  await f.runChecks(task, 'a'.repeat(40))
  assert.deepEqual(await f.requestPreview(task), { url: 'http://127.0.0.1:4173' })
  assert.equal(f.snapshot().browserCalls, 4)
})
