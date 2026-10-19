import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import vm from 'node:vm'
import { STUDIO_MODEL_SELECTION_EDITS } from '../../apps/desktop-distribution/build/model-selection-edits.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim()
const sharedRoot = path.dirname(common)
const fixtures = await Promise.all(STUDIO_MODEL_SELECTION_EDITS.map(async edit => ({ edit, source: await readFile(path.join(sharedRoot, '.local/upstream/dsh', edit.file), 'utf8') })))
const { edit: selectionEdit, source } = fixtures[0]
function installer() {
  const edited = selectionEdit.apply(source)
  const begin = edited.indexOf('const modelSelectionNotices =')
  const executable = stripTypeScriptTypes(edited.slice(begin), { mode: 'transform' }).replace('export function', 'function')
  return vm.runInNewContext(executable + '\ninstallModelSelection', { createUserMessage: value => value, boundContextSummary: value => value })
}
function scope() {
  const listeners = new Map(), effects = []
  return {
    listeners,
    on(name, listener) { const values = listeners.get(name) ?? []; values.push(listener); listeners.set(name, values); return () => { const index = values.indexOf(listener); if (index >= 0) values.splice(index, 1) } },
    effect(register) { effects.push(register()); return () => {} },
    close() { for (const dispose of effects) dispose(); for (const values of listeners.values()) values.length = 0 },
    async invoke(name, payload, next) { let index = 0; const values = [...(listeners.get(name) ?? [])]; const dispatch = () => { const listener = values[index++]; return listener ? listener(payload, dispatch) : next() }; return dispatch() },
  }
}
const payload = (variables = { provider: 'final', model: 'route' }) => ({ agent: { session: { requestHeader: () => ({ config: { provider: 'old', model: 'old' } }) } }, messages: [{}], signal: new AbortController().signal, step: 1, assembly: { variables } })
const decision = () => Promise.resolve({ kind: 'enter', messages: [{}] })

test('three model selection edits are exact, idempotent and reject missing, duplicate and partial anchors', () => {
  for (const { edit, source } of fixtures) {
    const edited = edit.apply(source)
    assert.notEqual(edited, source)
    assert.equal(edit.apply(edited), edited)
    for (const invalid of ['drift', source + source, edited + edited]) assert.throws(() => edit.apply(invalid), /anchor/)
  }
  const edited = selectionEdit.apply(source)
  assert.throws(() => selectionEdit.apply(edited.replace('  let sharedNotice =', '  let driftedNotice =')), /anchor/)
})

test('one notice listener survives either installer release and disposes only after the last idempotent release', async () => {
  const install = installer(), ctx = scope()
  const first = install(ctx, { current: undefined, assembled: undefined })
  const second = install(ctx, { current: undefined, assembled: undefined })
  assert.equal(ctx.listeners.get('agent/pre-step').length, 1)
  assert.equal((await ctx.invoke('agent/pre-step', payload(), decision)).messages.length, 2)
  first(); first()
  assert.equal(ctx.listeners.get('agent/pre-step').length, 1)
  assert.equal((await ctx.invoke('agent/pre-step', payload(), decision)).messages.length, 2)
  second(); second()
  assert.equal(ctx.listeners.get('agent/pre-step').length, 0)
  assert.equal((await ctx.invoke('agent/pre-step', payload(), decision)).messages.length, 1)
  ctx.close()
})

test('notice uses final assembly route and skips missing variables without reading an entry-point selection capture', async () => {
  const install = installer(), ctx = scope()
  install(ctx, { current: { provider: 'picked', model: 'picked' }, assembled: { provider: 'picked', model: 'picked' } })
  const result = await ctx.invoke('agent/pre-step', payload(), decision)
  assert.match(JSON.stringify(result.messages.at(-1)), /session continues with final\/route/)
  assert.doesNotMatch(JSON.stringify(result.messages.at(-1)), /picked/)
  assert.equal((await ctx.invoke('agent/pre-step', payload({ provider: undefined, model: 'route' }), decision)).messages.length, 1)
  assert.equal((await ctx.invoke('agent/pre-step', payload({ provider: 'final', model: '' }), decision)).messages.length, 1)
  ctx.close()
  assert.equal(ctx.listeners.get('agent/pre-step').length, 0)
})

test('actual Cordis scope shutdown releases the shared notice and both installer subscriptions', async () => {
  const { Context } = await import(pathToFileURL(path.join(sharedRoot, '.local/build/dsh/apps/desktop/.desktop-build/targets/win-x64/dsh/node_modules/@deepseek-ai/cordis/lib/index.js')))
  const install = installer(), ctx = new Context()
  const first = install(ctx, { current: undefined, assembled: undefined })
  const second = install(ctx, { current: undefined, assembled: undefined })
  assert.equal((await ctx.waterfall('agent/pre-step', payload(), decision)).messages.length, 2)
  await ctx.fiber.dispose()
  first(); second()
  assert.equal((await ctx.waterfall('agent/pre-step', payload(), decision)).messages.length, 1)
})
