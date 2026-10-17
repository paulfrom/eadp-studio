import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { stripTypeScriptTypes } from 'node:module'
import path from 'node:path'
import vm from 'node:vm'
import test from 'node:test'
import { DESKTOP_BRAND_EDITS, STUDIO_APP_ID } from '../../apps/desktop-distribution/build/desktop-brand-edits.mjs'

const upstream = path.resolve(import.meta.dirname, '../../.local/upstream/dsh')
const generated = new Map()

test('all branding edits anchor to fixed source, reject drift, and replay without duplication', async () => {
  for (const edit of DESKTOP_BRAND_EDITS) {
    const target = path.join(upstream, edit.file)
    const source = await readFile(target, 'utf8')
    const next = edit.apply(source)
    assert.notEqual(source, next, edit.file)
    assert.equal(edit.apply(next), next, edit.file)
    assert.throws(() => edit.apply('upstream changed'), /brand anchor missing or duplicated/)
    assert.throws(() => edit.apply(`${next}\n${next}`), /brand anchor missing or duplicated/)
    assert.equal(await readFile(target, 'utf8'), source)
    generated.set(edit.file, next)
  }
})

test('product startup isolates app data and the host home before Electron paths are used', async () => {
  const source = generated.get('apps/desktop/src/main.ts')
  const start = source.indexOf("app.setName('eadp studio')")
  const end = source.indexOf('app.setAppLogsPath()', start) + 'app.setAppLogsPath()'.length
  const calls = []
  const environment = { DSH_HOME: '/official/data' }
  vm.runInNewContext(source.slice(start, end), {
    join: path.join, process: { platform: 'win32', env: environment },
    app: {
      isPackaged: true,
      setName: value => calls.push(['name', value]), getPath: name => { calls.push(['path', name]); return '/user/home' },
      setAppUserModelId: value => calls.push(['id', value]), setAppLogsPath: () => calls.push(['logs']),
    },
  })
  assert.equal(environment.DSH_HOME, path.join('/user/home', '.eadp-studio'))
  const devEnvironment = { DSH_HOME: '/isolated/development/home' }
  vm.runInNewContext(source.slice(start, end), {
    join: path.join, process: { platform: 'win32', env: devEnvironment },
    app: { isPackaged: false, setName() {}, setAppUserModelId() {}, setAppLogsPath() {}, getPath() { assert.fail('development must keep launcher home') } },
  })
  assert.equal(devEnvironment.DSH_HOME, '/isolated/development/home')
  assert.deepEqual(calls, [['name', 'eadp studio'], ['path', 'home'], ['id', STUDIO_APP_ID], ['logs']])
  assert.ok(end < source.indexOf("readDesktopSettings(app.getPath('userData'))"))
  assert.ok(source.includes("app.setAsDefaultProtocolClient('eadp-studio')"))
  assert.ok(!source.includes("'dsh://open'"))
})

test('both real locale dictionaries expose the product name in about, welcome, menu, and tray text', async () => {
  const source = stripTypeScriptTypes(generated.get('apps/desktop/src/locale.ts'), { mode: 'transform' })
  const { resolveDesktopLocale } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
  for (const language of ['en', 'zh-CN']) {
    const { messages } = resolveDesktopLocale(language)
    assert.equal(messages.aboutProduct, 'eadp studio')
    for (const field of ['aboutMenu', 'quitApplication', 'openApplication', 'welcomeTitle', 'updateTitle']) {
      assert.ok(messages[field].includes('eadp studio'), `${language}.${field}`)
    }
  }
})

test('official client title reaches HTML, dynamic session titles, and the validated artifact record', async () => {
  const source = stripTypeScriptTypes(generated.get('scripts/client-build-environment.ts'), { mode: 'transform' })
  const client = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
  const directory = await mkdtemp(path.join(tmpdir(), 'eadp client title '))
  try {
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ version: '0.2.1-alpha.2' }))
    const expected = client.officialClientBuildEnvironment(directory, { DSH_CLIENT_COMMIT_HASH: 'a'.repeat(40) })
    const environment = client.resolveClientBuildEnvironment({ ...expected, DSH_CLIENT_TITLE: 'Inherited old brand' }, 'official')
    assert.equal(environment.DSH_CLIENT_TITLE, 'eadp studio')
    assert.deepEqual(environment, expected)
    assert.equal(client.clientBuildEnvironmentDefines(environment)['process.env.DSH_CLIENT_TITLE'], '"eadp studio"')
    const vite = await readFile(path.join(upstream, 'apps/web/vite.config.ts'), 'utf8')
    const start = vite.indexOf('function clientDocumentTitle(): Plugin {')
    const end = vite.indexOf('\n/** Keep the redistribution license', start)
    assert.ok(start >= 0 && end > start)
    const html = vm.runInNewContext(`${stripTypeScriptTypes(vite.slice(start, end), { mode: 'transform' })}\nclientDocumentTitle().transformIndexHtml('<title>DSH Local Build</title>')`, {
      process: { env: environment }, escapeHtmlText: text => text,
    })
    assert.equal(html, '<title>eadp studio</title>')
    const titleSource = stripTypeScriptTypes(await readFile(path.join(upstream, 'packages/client/ui-layout/src/client/DocumentTitle.tsx'), 'utf8'), { mode: 'transform' })
      .replace(/^import .*from 'react';?\s*$/m, '').replace('export function DocumentTitle', 'function DocumentTitle')
    const document = { title: '' }
    vm.runInNewContext(`${titleSource}\nDocumentTitle({ usePanelInfo: () => true, useSessions: () => 'Scene', productTitle })`, {
      document, productTitle: environment.DSH_CLIENT_TITLE, useEffect: callback => callback(),
    })
    assert.equal(document.title, 'Scene — eadp studio')
    await mkdir(path.join(directory, 'apps/web/dist'), { recursive: true })
    await writeFile(path.join(directory, 'apps/web/dist/index.html'), html)
    const record = client.writeClientBuildRecord(directory, environment)
    assert.equal(record.environment.DSH_CLIENT_TITLE, 'eadp studio')
    assert.deepEqual(client.readClientBuildRecord(directory, expected), record)
    assert.throws(() => client.readClientBuildRecord(directory, { ...expected, DSH_CLIENT_TITLE: 'DeepSeek Harness' }), /DSH_CLIENT_TITLE/)
  } finally {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()))
    await rm(directory, { recursive: true, force: true })
  }
})
