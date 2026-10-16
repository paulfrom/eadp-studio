import assert from 'node:assert/strict'
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildDesktop, ensureWindowsEnvironment, parseBuildArguments, validateHost } from '../../scripts/build-desktop.mjs'
import { runPnpm } from '../../apps/desktop-distribution/build/run-pnpm.mjs'

test('entry validates parameters and the upstream native host contract', () => {
  assert.deepEqual(parseBuildArguments(['--check']), { help: false, check: true })
  assert.equal(parseBuildArguments(['--help']).help, true)
  for (const args of [['--signed'], ['--check', '--help'], ['extra']]) assert.throws(() => parseBuildArguments(args), /Usage/)
  validateHost('win32', 'x64', '22.19.0')
  validateHost('win32', 'x64', '24.0.0')
  for (const [platform, arch, version] of [['linux', 'x64', '24.0.0'], ['win32', 'arm64', '24.0.0'], ['win32', 'x64', '22.18.0'], ['win32', 'x64', '23.0.0']]) {
    assert.throws(() => validateHost(platform, arch, version))
  }
})

test('source pipeline propagates failures, preserves paths and packages the actual installer with a digest', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'eadp 中文 & (source) '))
  const desktop = path.join(root, '.local/build/dsh/apps/desktop')
  try {
    await mkdir(desktop, { recursive: true })
    await writeFile(path.join(desktop, 'package.json'), JSON.stringify({ version: '0.2.1-alpha.2' }))
    const calls = []
    const runner = {
      root, sharedRoot: root,
      runNode: (script, args, cwd) => calls.push(['node', path.relative(root, script), args, cwd]),
      configure: async target => calls.push(['configure', target]),
      pnpm: (operation, cwd, environment) => {
        calls.push(['pnpm', operation, cwd])
        if (operation === 'packageWindows') {
          assert.equal(environment.DSH_DESKTOP_PACKED_EXTRA, path.join(root, '.local/build/packed-studio'))
          assert.equal(environment.ELECTRON_BUILDER_CACHE, path.join(root, '.local/cache/electron-builder'))
        }
      },
    }
    await buildDesktop({ ...runner, check: true })
    assert.deepEqual(calls.map(call => call.slice(0, 2)), [
      ['pnpm', 'productInstall'], ['node', path.join('scripts', 'fetch-dsh.mjs')],
      ['node', path.join('apps', 'desktop-distribution', 'build', 'prepare-studio-plugin.mjs')],
      ['configure', desktop], ['pnpm', 'install'], ['pnpm', 'checkWindows'],
    ])
    assert.deepEqual(calls[2][2], ['--stage-only'])
    calls.length = 0
    await assert.rejects(buildDesktop({ ...runner, pnpm: operation => { calls.push(operation); if (operation === 'install') throw new Error('failed install') } }), /failed install/)
    assert.ok(!calls.includes('checkWindows'))
    assert.ok(!calls.includes('packageWindows'))
    const name = 'eadp-studio-0.2.1-alpha.2-win-x64-unsigned.exe'
    const outputs = path.join(desktop, '.desktop-build/targets/win-x64/unsigned-artifacts')
    await mkdir(outputs, { recursive: true })
    await writeFile(path.join(outputs, name), 'installer fixture')
    const receipt = await buildDesktop(runner)
    assert.equal(receipt.path, path.join(root, 'artifacts/windows', name))
    assert.equal(receipt.sha256, 'b97d800ba8d0420dc6a0342045a15a97d785bd61d4cf9902d0c334ba32ec188b')
    assert.equal(await readFile(receipt.path, 'utf8'), 'installer fixture')
    assert.deepEqual(JSON.parse(await readFile(`${receipt.path}.json`, 'utf8')), receipt)
  } finally {
    assert.equal(path.dirname(root), path.resolve(tmpdir()))
    await rm(root, { recursive: true, force: true })
  }
})

test('packaging child receives the workspace cache and real electron-builder resolves it with Chinese and shell-character paths', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'eadp 中文 & (builder cache) '))
  const desktop = path.join(root, '.local/build/dsh/apps/desktop')
  const originalCache = process.env.ELECTRON_BUILDER_CACHE
  try {
    const builder = createRequire(path.resolve(import.meta.dirname, '../../.local/build/dsh/apps/desktop/package.json'))
      .resolve('app-builder-lib/out/util/electronGet.js')
    await mkdir(desktop, { recursive: true })
    await writeFile(path.join(desktop, 'package.json'), JSON.stringify({ version: '1.0.0' }))
    const output = path.join(desktop, '.desktop-build/targets/win-x64/unsigned-artifacts')
    await mkdir(output, { recursive: true })
    await writeFile(path.join(output, 'eadp-studio-1.0.0-win-x64-unsigned.exe'), 'cache regression installer')
    await writeFile(path.join(root, 'capture.mjs'), `import { writeFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
const { getCacheDirectory } = createRequire(import.meta.url)(${JSON.stringify(builder)});
const configured = process.env.ELECTRON_BUILDER_CACHE;
writeFileSync('captured-cache.json', JSON.stringify({ configured, resolved: getCacheDirectory({ allowEnvVarOverride: true }), directoryExists: statSync(configured).isDirectory() }));
`)
    const shim = path.join(root, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')
    await writeFile(shim, process.platform === 'win32'
      ? `@"${process.execPath}" "%~dp0capture.mjs" %*\r\n`
      : `#!${process.execPath}\nimport './capture.mjs'\n`)
    if (process.platform !== 'win32') await chmod(shim, 0o755)
    process.env.ELECTRON_BUILDER_CACHE = path.join(root, 'unrelated-global-cache')
    await buildDesktop({
      root, sharedRoot: root, runNode: () => {}, configure: async () => {},
      pnpm: (operation, cwd, environment) => {
        if (operation !== 'packageWindows') return
        const child = Object.fromEntries(Object.entries(environment).filter(([key]) => key.toLowerCase() !== 'path'))
        child[process.platform === 'win32' ? 'Path' : 'PATH'] = `${root}${path.delimiter}${process.env.PATH ?? process.env.Path ?? ''}`
        runPnpm(operation, cwd, child)
      },
    })
    const cache = path.join(root, '.local/cache/electron-builder')
    assert.deepEqual(JSON.parse(await readFile(path.join(root, '.local/build/dsh/captured-cache.json'), 'utf8')), {
      configured: cache, resolved: cache, directoryExists: true,
    })
    assert.equal(process.env.ELECTRON_BUILDER_CACHE, path.join(root, 'unrelated-global-cache'))
  } finally {
    if (originalCache === undefined) delete process.env.ELECTRON_BUILDER_CACHE
    else process.env.ELECTRON_BUILDER_CACHE = originalCache
    assert.equal(path.dirname(root), path.resolve(tmpdir()))
    await rm(root, { recursive: true, force: true })
  }
})

test('first-use public configuration is created once; existing private configuration is retained and identity conflicts fail', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'eadp desktop config '))
  const target = path.join(root, '.env.windows')
  try {
    await ensureWindowsEnvironment(root)
    assert.ok((await readFile(target, 'utf8')).includes('http://100.119.183.44:6972'))
    const configured = 'DSH_DESKTOP_APP_ID=io.github.paulfrom.eadp.studio\nDSH_DESKTOP_WINDOWS_TOKEN_PIN=private-test-value\n'
    await writeFile(target, configured)
    await ensureWindowsEnvironment(root)
    assert.equal(await readFile(target, 'utf8'), configured)
    await writeFile(target, 'DSH_DESKTOP_APP_ID=com.deepseek.harness\n')
    await assert.rejects(ensureWindowsEnvironment(root), /file preserved/)
    assert.equal(await readFile(target, 'utf8'), 'DSH_DESKTOP_APP_ID=com.deepseek.harness\n')
  } finally {
    assert.equal(path.dirname(root), path.resolve(tmpdir()))
    await rm(root, { recursive: true, force: true })
  }
})
