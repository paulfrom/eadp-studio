import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { DESKTOP_PLUGIN_EDIT, STUDIO_PACKAGE } from '../../apps/desktop-distribution/build/desktop-plugin-edits.mjs'

// Real fixed-upstream resolution APIs and the prepared package graph; prepare
// Desktop dependencies/resources before running this integration regression.
const repository = path.resolve(import.meta.dirname, '../..')
const prepared = path.join(repository, '.local/build/dsh/apps/desktop/.desktop-build/targets/win-x64/dsh')
const { loadProfileDirectory, createRuntimeResolution } = await import(pathToFileURL(
  path.join(prepared, 'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js')))

test('built-in Studio must belong to the launcher production closure, beyond package/profile membership', async (t) => {
  const root = path.join(repository, '.local/diagnostics')
  await mkdir(root, { recursive: true })
  const fixture = await mkdtemp(path.join(root, 'studio-resolution-'))
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(fixture)), root)
    assert.equal(await realpath(fixture), fixture)
    await rm(fixture, { recursive: true, force: true })
  })
  const modules = path.join(fixture, 'node_modules')
  await mkdir(path.join(modules, '@deepseek-ai'), { recursive: true })
  // Only the DSH launcher manifest varies; every other package is the real
  // prepared production package exposed through a test-owned directory link.
  for (const entry of await readdir(path.join(prepared, 'node_modules'), { withFileTypes: true })) {
    if (entry.name === '.bin') continue
    if (entry.name === '@deepseek-ai') {
      for (const name of await readdir(path.join(prepared, 'node_modules/@deepseek-ai'))) {
        if (name !== 'dsh') await symlink(path.join(prepared, 'node_modules/@deepseek-ai', name), path.join(modules, '@deepseek-ai', name), 'dir')
      }
    } else await symlink(path.join(prepared, 'node_modules', entry.name), path.join(modules, entry.name), 'dir')
  }
  const launcher = path.join(modules, '@deepseek-ai/dsh')
  await cp(path.join(prepared, 'node_modules/@deepseek-ai/dsh'), launcher, { recursive: true })
  const source = await readFile(path.join(repository, '.local/upstream/dsh/apps/cli/package.json'), 'utf8')
  const profile = path.join(fixture, 'home/profiles/desktop')
  await mkdir(profile, { recursive: true })
  await writeFile(path.join(profile, 'package.json'), JSON.stringify({ private: true,
    dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', STUDIO_PACKAGE] } } }))
  const resolve = async manifest => {
    await writeFile(path.join(launcher, 'package.json'), manifest)
    const installAnchor = path.join(launcher, 'package.json')
    const loaded = loadProfileDirectory('dsh', profile, installAnchor)
    assert.deepEqual(loaded.skippedBundles, [])
    assert.ok(loaded.layers.some(layer => layer.packageName === STUDIO_PACKAGE))
    return createRuntimeResolution({ installAnchor, profile: loaded, home: path.join(fixture, 'home') })
  }
  const diagnostic = path.join(fixture, 'host-diagnostic.mjs')
  await writeFile(diagnostic, `
    import path from 'node:path'; import {pathToFileURL} from 'node:url'; import {writeFile} from 'node:fs/promises';
    const fixture=process.argv[2], output=process.argv[3], modules=path.join(fixture,'node_modules');
    const boot=await import(pathToFileURL(path.join(modules,'@deepseek-ai/dsh-app-boot/lib/index.js')));
    const {runProfile}=await import(pathToFileURL(path.join(modules,'@deepseek-ai/dsh/lib/profile-boot.js')));
    const installAnchor=path.join(modules,'@deepseek-ai/dsh/package.json');
    const profile=boot.loadProfileDirectory('dsh',path.join(fixture,'home/profiles/desktop'),installAnchor);
    const app=await runProfile({environment:boot.loadLayeredEnv('dsh'),profile:'desktop',resolvedProfile:{profile,installAnchor},
      patchFiles:[],args:['--no-open','--host','127.0.0.1','--port','0']});
    try {
      await app.ctx.loader.await(); await Promise.resolve();
      const rows=[...app.ctx.loader.entries()].filter(row=>row.options.name==='${STUDIO_PACKAGE}')
        .map(row=>({name:row.options.name,disabled:row.disabled,hasFiber:!!row.fiber,state:row.fiber?.state}));
      await writeFile(output,JSON.stringify({rows,studio:app.ctx.clientModules.graph().entries.filter(row=>row.id==='${STUDIO_PACKAGE}')}));
    } finally {await app.shutdown.shutdown(0)}
  `)
  const host = async label => {
    const output = path.join(fixture, `${label}.json`)
    const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
      !/KEY|SECRET|TOKEN|PASSWORD|^DSH_|^NODE_OPTIONS$|^NODE_PATH$/iu.test(name)))
    const electron = path.join(prepared, '../electron/electron.exe')
    await promisify(execFile)(electron, ['--expose-internals', diagnostic, fixture, output], { cwd: fixture,
      env: { ...environment, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: path.join(fixture, 'home'),
        DSH_AGENTS_HOME: path.join(fixture, 'agents'), DSH_TELEMETRY_DISABLED: '1', NARB_NATIVE_CACHE_DIR: path.join(fixture, 'native-cache') },
      windowsHide: true, timeout: 90_000, maxBuffer: 1024 * 1024 })
    return JSON.parse(await readFile(output, 'utf8'))
  }
  assert.equal((await resolve(source)).entries.some(entry => entry.name === STUDIO_PACKAGE), false,
    'the prior package-set root + enabled bundle still omit the plugin from actual runtime resolution')
  const prior = await host('before')
  assert.equal(prior.studio.length, 1, 'a materialized directory can import the package outside the explicit resolution table; ASAR needs the declared closure')
  const edited = DESKTOP_PLUGIN_EDIT.apply(source)
  assert.equal(DESKTOP_PLUGIN_EDIT.apply(edited), edited)
  const entry = (await resolve(edited)).entries.find(entry => entry.name === STUDIO_PACKAGE)
  assert.equal(entry?.scope, 'installation')
  assert.equal(entry.version, '0.0.0')
  const after = await host('after')
  assert.equal(after.rows.length, 1)
  assert.equal(after.rows[0].hasFiber, true)
  assert.equal(after.studio.length, 1, 'real Host discovers Studio from the production dependency closure')
  assert.equal(await readFile(path.join(repository, '.local/upstream/dsh/apps/cli/package.json'), 'utf8'), source)
})

test('CLI production dependency edit rejects unrelated or conflicting manifests', () => {
  assert.throws(() => DESKTOP_PLUGIN_EDIT.apply('{}'), /fixed dsh CLI/)
  assert.throws(() => DESKTOP_PLUGIN_EDIT.apply(JSON.stringify({ name: '@deepseek-ai/dsh',
    dependencies: { [STUDIO_PACKAGE]: '1.0.0' } })), /differs/)
})

