import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { DESKTOP_POLICY_EDITS } from '../../apps/desktop-distribution/build/desktop-policy-edits.mjs'

// This regression executes edited fixed-upstream code with the build tree's real
// dependencies. Run fetch-dsh and prepare the DSH dependencies before this test.
const root = path.resolve(import.meta.dirname, '../..')
const upstream = path.join(root, '.local/upstream/dsh')
const desktop = path.join(root, '.local/build/dsh/apps/desktop')
await access(path.join(desktop, 'node_modules/@deepseek-ai/dsh-deepseek-account/lib/index.js')).catch(() => {
  throw new Error('The DSH build tree is not built. Run `node apps/desktop-distribution/build/prepare-studio-plugin.mjs` (installs and builds the workspace) before this regression.')
})
const directory = await mkdtemp(path.join(desktop, '.studio-policy-regression-'))
const original = new Map()
const generated = new Map()
for (const edit of DESKTOP_POLICY_EDITS) {
  const source = await readFile(path.join(upstream, edit.file), 'utf8')
  original.set(edit.file, source)
  generated.set(edit.file, edit.apply(source))
}
const policyFile = 'apps/desktop/src/mandatory-update-policy.ts'
const environmentFile = 'apps/desktop/scripts/desktop-policy-environment.mjs'
await writeFile(path.join(directory, 'policy.mjs'), stripTypeScriptTypes(generated.get(policyFile), { mode: 'transform' }))
await writeFile(path.join(directory, 'desktop-policy-environment.mjs'), generated.get(environmentFile))
await writeFile(path.join(directory, 'desktop-auto-update-environment.mjs'),
  await readFile(path.join(upstream, 'apps/desktop/scripts/desktop-auto-update-environment.mjs')))
const { DesktopMandatoryUpdatePolicy, resolveDesktopPolicyConfig, desktopPolicyPage } = await import(pathToFileURL(path.join(directory, 'policy.mjs')))
const { resolveDesktopPolicyEnvironment } = await import(pathToFileURL(path.join(directory, 'desktop-policy-environment.mjs')))

after(async () => {
  assert.equal(path.dirname(directory), desktop)
  await rm(directory, { recursive: true, force: true })
})

const environment = origin => ({ DSH_DESKTOP_AUTO_UPDATE_ENV: 'production', DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN: origin })
const allow = { code: 0, data: { biz_code: 0, biz_data: null } }
const force = { code: 40005, data: { show_content: { title: 'Update required' }, desktop_app_link: 'https://www.zyjsm.top/download' } }
function policy(origin) {
  const config = resolveDesktopPolicyConfig({
    ...resolveDesktopPolicyEnvironment(environment(origin)),
    allowedPageOrigins: ['https://www.zyjsm.top'], timeoutMs: 1000,
  })
  return new DesktopMandatoryUpdatePolicy(config, { platform: 'win32', arch: 'x64', bundledDshVersion: '0.2.1-alpha.4' },
    () => {}, undefined,
    () => ({ version: '0.2.1-alpha.4', locale: 'zh-CN', timezoneOffsetSeconds: 28800 }))
}

test('fixed-upstream edits reject drift, replay idempotently, and never modify the verified source', async () => {
  for (const edit of DESKTOP_POLICY_EDITS) {
    assert.equal(edit.apply(generated.get(edit.file)), generated.get(edit.file))
    assert.throws(() => edit.apply('upstream changed'), /anchor missing or duplicated/)
    const bytes = await readFile(path.join(upstream, edit.file))
    assert.equal(createHash('sha256').update(bytes).digest('hex'), createHash('sha256').update(original.get(edit.file)).digest('hex'))
  }
})

test('package and runtime accept HTTP/HTTPS policy origins while retaining URL and login/page restrictions', () => {
  for (const origin of ['http://100.119.183.44', 'https://www.zyjsm.top']) {
    const config = resolveDesktopPolicyEnvironment(environment(origin))
    assert.equal(resolveDesktopPolicyConfig(config).origin, origin)
    assert.deepEqual(config.allowedPageOrigins, [origin])
  }
  for (const origin of ['ftp://example.com', 'http://user:secret@example.com', 'http://example.com/path',
    'http://example.com/?x=1', 'http://example.com/#fragment']) {
    assert.throws(() => resolveDesktopPolicyEnvironment(environment(origin)))
    assert.throws(() => resolveDesktopPolicyConfig({ origin, allowedPageOrigins: ['https://www.zyjsm.top'] }))
  }
  assert.throws(() => resolveDesktopPolicyConfig({ origin: 'http://100.119.183.44',
    allowedPageOrigins: ['https://www.zyjsm.top'], authentication: 'feishu-test', allowedAuthOrigins: ['http://login.example.com'] }))
  assert.equal(desktopPolicyPage('http://www.zyjsm.top/download', ['http://www.zyjsm.top']), undefined)
  assert.equal(desktopPolicyPage('https://www.zyjsm.top/download', ['https://www.zyjsm.top']), 'https://www.zyjsm.top/download')
})

test('desktop startup enables the Windows preload only after policy IPC is registered', () => {
  const main = generated.get('apps/desktop/src/main.ts')
  const windowFactory = main.slice(main.indexOf('function createWindow('), main.indexOf('\nasync function main()'))
  const startup = main.slice(main.indexOf("  if (typeof manifest !== 'object'"), main.indexOf('\n  automaticCheck()\n  await reconcileBackend()'))
  const preload = stripTypeScriptTypes(generated.get('apps/desktop/src/preload-app.ts').replace(/^import .*\n/gm, ''), { mode: 'transform' })
  for (const enabled of [false, true]) {
    for (const platform of ['win32', 'darwin']) {
      const handlers = new Map()
      let options
      let subscriptions = 0
      let queries = 0
      let mandatoryPolicy
      let mandatoryUI
      let mainWindow
      const context = {
        process: { platform, arch: 'x64', env: enabled ? { DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: '{}' } : {} },
        app: { isPackaged: false, getVersion: () => 'test' }, manifest: {}, URL, policyAuth: undefined,
        resolveDesktopPolicyConfig: input => input === undefined ? undefined : { allowedPageOrigins: [] },
        DesktopMandatoryUpdatePolicy: class {
          state = { blocking: false, checking: false }
          check() { return Promise.resolve(this.state) }
        },
        DesktopMandatoryUpdateWindow: class {
          constructor() { handlers.set('status', () => mandatoryPolicy.state) }
          sync() { assert.ok(mainWindow); subscriptions++ }
        },
        BrowserWindow: class {
          constructor(value) {
            options = value
            if (enabled) assert.ok(handlers.has('status'), 'register policy IPC before creating the renderer')
          }
          webContents = { setWindowOpenHandler() {}, on() {} }
          on() {}
        },
        nativeTheme: { shouldUseDarkColors: false }, chromeFallbackFill: () => '#fff', WINDOWS_TITLEBAR_HEIGHT: 40,
        updateChannel: 'test', updateOverlays: {}, locale: {}, updates: { state: {} },
        fileURLToPath: () => 'preload', updateSchedule: {}, downloadUpdate() {}, checkPolicyManually() {},
        get mandatoryPolicy() { return mandatoryPolicy }, set mandatoryPolicy(value) { mandatoryPolicy = value },
        get mandatoryUI() { return mandatoryUI }, set mandatoryUI(value) { mandatoryUI = value },
        get mainWindow() { return mainWindow }, set mainWindow(value) { mainWindow = value },
      }
      runInNewContext(`${stripTypeScriptTypes(windowFactory)}\nglobalThis.createWindow = createWindow`, context)
      context.createMainWindow = () => context.createWindow('preload', false, true, mandatoryPolicy !== undefined)
      runInNewContext(stripTypeScriptTypes(startup.replace('import.meta.url', "'file:///desktop/main.js'")), context)
      assert.equal(subscriptions, enabled ? 1 : 0)
      for (let load = 0; load < 2; load++) {
        runInNewContext(preload, {
          location: { protocol: 'dsh-app:', hostname: 'app' }, SCHEME: 'dsh-app',
          process: { platform, argv: options.webPreferences.additionalArguments, isMainFrame: true },
          contextBridge: { exposeInMainWorld() {} }, ipcRenderer: { on() {} }, DESKTOP_IPC: {},
          createDesktopBrowserBridge() {}, markDocumentPlatform() {}, syncWindowFullscreen() {}, syncNativeTheme() {}, syncWindowsAppearance() {},
          installMandatoryUpdateOverlay() {
            queries++
            assert.ok(handlers.has('status'), 'preload must never invoke an unregistered policy handler')
            assert.equal(handlers.get('status')().blocking, false)
          },
        })
      }
      assert.equal(queries, enabled && platform === 'win32' ? 2 : 0)
    }
  }
})

test('real HTTP failures remain unavailable without gating launch; force survives failures until a valid allow', async () => {
  let mode = 'not-found'
  const requests = []
  const server = createServer((request, response) => {
    requests.push({ url: request.url, headers: request.headers })
    if (mode === 'timeout') return
    response.statusCode = mode === 'not-found' ? 404 : 200
    response.setHeader('content-type', mode === 'html' ? 'text/html' : 'application/json')
    response.end(mode === 'html' ? '<html>not the policy API</html>'
      : JSON.stringify(mode === 'not-found' ? { error: { code: 'NOT_FOUND' } } : mode === 'force' ? force : allow))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  const instances = []
  const makePolicy = () => { const instance = policy(origin); instances.push(instance); return instance }
  try {
    for (const failure of ['not-found', 'html']) {
      mode = failure
      assert.deepEqual(await makePolicy().check('launch'), { blocking: false, checking: false, error: 'unavailable' })
    }
    mode = 'timeout'
    const instance = makePolicy()
    const main = generated.get('apps/desktop/src/main.ts')
    const start = main.indexOf("    void mandatoryPolicy.check('launch').then((state) => {")
    const end = main.indexOf('\n  }\n  mainWindow = createMainWindow()', start)
    assert.ok(start >= 0 && end > start, 'main must launch the policy check without awaiting its result')
    let continued = false
    const launch = new Function('mandatoryPolicy', 'app', 'isQuitting', 'queuePolicyAuthentication', 'continueStartup',
      `${stripTypeScriptTypes(main.slice(start, end), { mode: 'transform' })}\ncontinueStartup()`)
    launch(instance, { isPackaged: true }, () => false, () => assert.fail('anonymous failure must not request login'), () => { continued = true })
    assert.equal(continued, true, 'startup continues before the network request settles')
    assert.deepEqual(await instance.check('launch'), { blocking: false, checking: false, error: 'unavailable' })
    mode = 'force'
    assert.equal((await instance.check('manual', true)).blocking, true)
    mode = 'not-found'
    assert.deepEqual(await instance.check('manual', true), { blocking: true, checking: false,
      title: 'Update required', page: force.data.desktop_app_link, error: 'unavailable' })
    mode = 'allow'
    assert.deepEqual(await instance.check('manual', true), { blocking: false, checking: false })
    assert.equal(requests[0].url, '/api/v0/check_client_update?scenario=launch')
    assert.equal(requests[0].headers['x-client-platform'], 'desktop-win')
    assert.equal(requests[0].headers['x-client-arch'], 'x64')
  } finally {
    await Promise.all(instances.map(instance => instance.dispose()))
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
  const refused = policy(origin)
  try {
    assert.deepEqual(await refused.check('launch'), { blocking: false, checking: false, error: 'unavailable' })
  } finally { await refused.dispose() }
})
