import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { DESKTOP_STARTUP_EDIT } from '../../apps/desktop-distribution/build/desktop-startup-edits.mjs'

// Execute the actual cold-start function from the fixed fetched release with
// account/backend boundaries stubbed; no Electron launch or credential writes.
const upstream = path.resolve(import.meta.dirname, '../../.local/upstream/dsh')
const main = await readFile(path.join(upstream, 'apps/desktop/src/main.ts'), 'utf8')
const welcomeApi = await readFile(path.join(upstream, 'apps/desktop/src/welcome-api.ts'), 'utf8')
const needsWelcomeSource = welcomeApi.slice(welcomeApi.indexOf('export function needsWelcome('))
const needsWelcome = new Function(`${stripTypeScriptTypes(needsWelcomeSource).replace('export ', '')}; return needsWelcome`)()

function initialWindow(source) {
  const start = source.indexOf('  const openInitialWindow = async (): Promise<void> => {')
  const end = source.indexOf('\n  focusPrimaryWindow =', start)
  assert.ok(start >= 0 && end > start, 'fixed upstream cold-start function must exist')
  return source.slice(start, end)
}

async function boot(source, options = {}) {
  const run = new Function('needsWelcome', 'options', `
    const events = []
    const quitting = options.quitting ?? false
    const recovery = { active: options.recovering ?? false }
    const backend = { state: { phase: options.backend ?? 'ready' } }
    const isQuitting = () => options.quittingAfterRead ?? quitting
    const enteredWorkspace = false
    let raiseAfterUpdate = true
    let locale, windowsLanguage
    const systemLanguages = ['zh-CN']
    const readWelcomeState = async () => ({ loggedIn: false, hasApiKey: false,
      localePreference: 'zh-CN', ...options.account })
    const resolveDesktopStartupLocale = (preference, languages) => ({ id: preference ?? languages[0] })
    const refreshApplicationMenu = () => events.push('menu')
    const showWelcome = async () => events.push('welcome')
    const enterWorkspace = async () => events.push('workspace')
    ${stripTypeScriptTypes(initialWindow(source))}
    return openInitialWindow().then(() => ({ events, locale, windowsLanguage, raiseAfterUpdate }))
  `)
  return run(needsWelcome, options)
}

test('fixed upstream reproduces account welcome instead of Studio on first launch', async () => {
  const result = await boot(main)
  assert.deepEqual(result.events, ['menu', 'welcome'])
  assert.equal(result.raiseAfterUpdate, false)
})

test('product cold start enters Studio with no account/key and retains locale', async () => {
  const edited = DESKTOP_STARTUP_EDIT.apply(main)
  for (const account of [{ loggedIn: false, hasApiKey: false }, { loggedIn: true }, { hasApiKey: true }]) {
    const result = await boot(edited, { account })
    assert.deepEqual(result.events, ['menu', 'workspace'])
    assert.equal(result.locale.id, 'zh-CN')
    assert.equal(result.windowsLanguage, 'zh-CN')
    assert.equal(result.raiseAfterUpdate, true)
  }
  // Every account/key callback outside cold-start selection remains byte-for-byte
  // unchanged; the product adds no key, completion marker or startup bypass flag.
  assert.equal(edited.replace(initialWindow(edited), ''), main.replace(initialWindow(main), ''))
})

test('product cold start still refuses exit/recovery and an unready backend', async () => {
  const edited = DESKTOP_STARTUP_EDIT.apply(main)
  for (const options of [{ quitting: true }, { recovering: true }, { backend: 'starting' }, { quittingAfterRead: true }]) {
    assert.deepEqual((await boot(edited, options)).events, [])
  }
})

test('startup edit is idempotent and fails on missing or duplicate fixed source', async () => {
  const edited = DESKTOP_STARTUP_EDIT.apply(main)
  assert.equal(DESKTOP_STARTUP_EDIT.apply(edited), edited)
  assert.throws(() => DESKTOP_STARTUP_EDIT.apply('upstream drift'), /anchor missing or duplicated/)
  assert.throws(() => DESKTOP_STARTUP_EDIT.apply(`${main}\n${initialWindow(main)}`), /anchor missing or duplicated/)
  assert.throws(() => DESKTOP_STARTUP_EDIT.apply(`${edited}\n${initialWindow(edited)}`), /anchor duplicated/)
  assert.equal(await readFile(path.join(upstream, DESKTOP_STARTUP_EDIT.file), 'utf8'), main)
})
