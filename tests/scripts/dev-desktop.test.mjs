import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { assertNoRunningDevelopmentApp, assertSharedSourceContract, devDesktop, developmentProfile, electronInstalled, executeDev, inputDigest, parseDevArguments, validateDevHost, withDesktopLock } from '../../scripts/dev-desktop.mjs'
import { developmentAppPids } from '../../apps/desktop-distribution/build/desktop-processes.mjs'
import { removeDeletedSourceOutputs, studioStagingPaths } from '../../apps/desktop-distribution/build/prepare-studio-plugin.mjs'

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'studio dev 中文 & '))
  const put = async (relative, value = '{}') => {
    const file = path.join(root, relative)
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, value)
  }
  for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'scripts/dev-desktop.mjs', 'scripts/fetch-dsh.mjs', 'apps/desktop-distribution/release.lock.json', 'apps/desktop-distribution/build/studio-runtime.lock.json', 'apps/desktop-distribution/build/prepare-studio-tools.mjs', 'packages/studio-plugin/package.json', 'packages/studio-plugin/cordis.patch.yml', 'packages/contracts/package.json']) await put(name)
  for (const name of ['packages/studio-plugin/src', 'packages/studio-plugin/build', 'packages/studio-plugin/assets', 'packages/contracts/src']) await put(`${name}/sample.ts`, 'source')
  await put('packages/studio-plugin/assets/prototype-template.manifest.json', JSON.stringify({ files: [], addedFiles: [] }))
  const tree = '.local/build/dsh'
  const calls = []
  const environments = []
  let fail
  const execute = async (_command, args, cwd, environment) => {
    const command = args.join(' ')
    calls.push(command)
    environments.push({ command, environment })
    if (fail && command.includes(fail)) throw new Error('simulated failure')
    if (command.includes('install --frozen')) await put('node_modules/.modules.yaml')
    if (command.includes('--dev-stage')) {
      for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', ...studioStagingPaths]) await put(`${tree}/${path.extname(name) ? name : `${name}/sample.ts`}`)
    }
    if (command.includes('install --no-frozen')) await put(`${tree}/node_modules/.modules.yaml`)
    if (command.includes('run build:desktop')) for (const directory of ['apps/desktop/lib', 'apps/desktop-host/lib', 'apps/cli/lib', 'apps/web/dist', 'packages/eadp/contracts/lib']) await put(`${tree}/${directory}/built.js`, 'built')
  }
  const run = (options = {}) => withDesktopLock(path.join(root, '.local/build'), () => devDesktop({ root, sharedRoot: root, execute, verify: async () => {}, record: async () => put(`${tree}/packages/eadp/studio-plugin/assets/prototype-template.tar.gz`, 'generated archive'), tools: async () => calls.push('tools'), verifyTools: async () => {}, electronReady: async () => true, appPids: async () => [], ...options }))
  const clean = async () => { assert.equal(path.dirname(root), path.resolve(tmpdir())); await rm(root, { recursive: true, force: true }) }
  return { root, calls, environments, put, run, clean, setFail: value => { fail = value } }
}

test('root command accepts only help or prepare and validates the actual desktop target', () => {
  assert.deepEqual(parseDevArguments([]), { help: false, prepare: false })
  assert.equal(parseDevArguments(['--prepare']).prepare, true)
  assert.equal(parseDevArguments(['--help']).help, true)
  assert.throws(() => parseDevArguments(['--prepare', '--help']), /Usage/)
  assert.throws(() => parseDevArguments(['--skip-build']), /Usage/)
  assert.doesNotThrow(() => validateDevHost('win32', 'x64', '22.19.0'))
  assert.throws(() => validateDevHost('win32', 'x64', '22.18.0'), /requires Node/)
  assert.throws(() => validateDevHost('linux', 'x64', '24.0.0'), /native Windows/)
})

test('linked worktrees reject different fixed source contracts but allow different acceptance records', async () => {
  const f = await fixture()
  try {
    const shared = path.join(f.root, 'primary')
    const dsh = { commit: 'fixed', archive: { sha256: 'checked' } }
    await f.put('apps/desktop-distribution/release.lock.json', JSON.stringify({ dsh, acceptance: { releaseReady: false } }))
    await f.put('primary/apps/desktop-distribution/release.lock.json', JSON.stringify({ acceptance: { releaseReady: true }, dsh: { archive: { sha256: 'checked' }, commit: 'fixed' } }))
    await assertSharedSourceContract(f.root, shared)
    await f.put('primary/apps/desktop-distribution/release.lock.json', JSON.stringify({ dsh: { ...dsh, commit: 'other' } }))
    await assert.rejects(devDesktop({ root: f.root, sharedRoot: shared, execute: async () => assert.fail('contract rejection must precede install/fetch') }), /different fixed DSH source contracts/)
  } finally { await f.clean() }
})

test('first run prepares once, same inputs reuse, edits and deletions stage and rebuild before launch', async () => {
  const f = await fixture()
  try {
    await f.run()
    assert.equal(f.calls.filter(call => call.includes('run build:artifacts')).length, 1)
    assert.equal(f.calls.filter(call => call.includes('run build:lib')).length, 0)
    assert.ok(f.calls.at(-1).includes('run start:desktop'))
    f.calls.length = 0
    await f.run()
    assert.equal(f.calls.length, 2, f.calls.join('\n'))
    assert.ok(f.calls[0].includes('fetch-dsh'))
    assert.ok(f.calls[1].includes('start:desktop'))
    await f.put('packages/studio-plugin/assets/prototype-template/node_modules/untracked.js', 'local install')
    await f.put('packages/studio-plugin/assets/prototype-template/dist/index.html', 'local preview')
    f.calls.length = 0
    await f.run()
    assert.equal(f.calls.length, 2, 'template local dependencies/output do not invalidate prepared source')
    await f.put('packages/studio-plugin/src/sample.ts', 'modified')
    f.calls.length = 0
    await f.run({ prepare: true })
    assert.ok(f.calls.some(call => call.includes('--dev-stage')))
    assert.ok(f.calls.some(call => call.includes('build:artifacts')))
    assert.ok(f.calls.at(-1).includes('prepare:primary-runtime'))
    assert.ok(!f.calls.some(call => call.includes('start:desktop')))
    await rm(path.join(f.root, 'packages/studio-plugin/src/sample.ts'))
    f.calls.length = 0
    await f.run()
    assert.ok(f.calls.some(call => call.includes('--dev-stage')))
    assert.ok(f.calls.some(call => call.includes('build:artifacts')))
    await f.put('apps/desktop-distribution/build/prepare-studio-tools.mjs', 'changed maintenance')
    f.calls.length = 0
    await f.run()
    assert.ok(f.calls.some(call => call.includes('build:artifacts')))
    await f.put('.local/build/dsh/packages/eadp/studio-plugin/src/sample.ts', 'foreign worktree source')
    f.calls.length = 0
    await f.run()
    assert.ok(f.calls.some(call => call.includes('--dev-stage')))
    assert.ok(f.calls.some(call => call.includes('build:artifacts')))
  } finally { await f.clean() }
})

test('build failure never launches, releases the lock, and cannot reuse a partially built payload', async () => {
  const f = await fixture()
  try {
    f.setFail('run build:artifacts')
    await assert.rejects(f.run(), /simulated failure/)
    assert.ok(!f.calls.some(call => call.includes('start:desktop')))
    await assert.rejects(stat(path.join(f.root, '.local/build/.studio-desktop-build.lock')), { code: 'ENOENT' })
    assert.equal(JSON.parse(await readFile(path.join(f.root, '.local/build/.studio-desktop-dev.json'))).built, undefined)
    f.setFail(undefined)
    f.calls.length = 0
    await f.run()
    assert.ok(f.calls.some(call => call.includes('build:artifacts')))
  } finally { await f.clean() }
})

test('a launch refuses to start while a development app still owns its profile', async () => {
  const f = await fixture()
  try {
    const profiles = []
    await assert.rejects(
      f.run({ appPids: async profile => { profiles.push(profile); return [4242] } }),
      /Desktop development app PID 4242 still owns .*electron-user-data.*tray menu/,
    )
    assert.deepEqual(f.calls, [], 'a running development app is reported before any preparation')
    assert.equal(profiles[0], developmentProfile(path.join(f.root, '.local/build/dsh/apps/desktop')))
    await f.run({ prepare: true, appPids: async () => [4242] })
    assert.ok(f.calls.some(call => call.includes('prepare:primary-runtime')))
    assert.ok(!f.calls.some(call => call.includes('start:desktop')))
  } finally { await f.clean() }
})

test('the development app probe reads only main processes of the profile it is given', async () => {
  const invocations = []
  const spawn = (command, args, options) => {
    invocations.push({ command, args, options })
    return { status: 0, stdout: ' 4242 \r\n77\r\n', stderr: '' }
  }
  assert.deepEqual(developmentAppPids('C:\\profile dir', spawn), [4242, 77])
  const [{ command, args, options }] = invocations
  assert.equal(command, 'powershell.exe')
  assert.equal(options.env.EADP_DESKTOP_DEVELOPMENT_PROFILE, 'C:\\profile dir')
  assert.equal(options.encoding, 'utf8')
  assert.match(args.at(-1), /--type=/)
  assert.deepEqual(developmentAppPids('profile', () => ({ status: 0, stdout: '', stderr: '' })), [])
  assert.throws(() => developmentAppPids('profile', () => ({ status: 1, stdout: '', stderr: 'access denied' })), /access denied/)
  assert.throws(() => developmentAppPids('profile', () => ({ status: 1, stdout: '', stderr: '' })), /powershell exited with 1/)
  await assert.doesNotReject(assertNoRunningDevelopmentApp(process.cwd(), async () => []))
})

test('missing dependency links and modified output force the appropriate preparation', async () => {
  const f = await fixture()
  try {
    await f.run()
    await rm(path.join(f.root, '.local/build/dsh/node_modules/.modules.yaml'))
    f.calls.length = 0
    await f.run()
    assert.ok(f.calls.some(call => call.includes('install --no-frozen')))
    assert.ok(f.calls.some(call => call.includes('build:artifacts')))
    await f.put('.local/build/dsh/apps/desktop/lib/built.js', 'tampered')
    f.calls.length = 0
    await f.run()
    assert.ok(f.calls.some(call => call.includes('build:artifacts')))
  } finally { await f.clean() }
})

test('Electron installer uses only its workspace-owned cache and same-volume temporary directory', async () => {
  const f = await fixture()
  try {
    let checks = 0
    await f.run({ electronReady: async () => ++checks > 1 })
    const installation = f.environments.find(call => call.command.includes('exec install-electron'))
    assert.equal(installation.environment.electron_config_cache, path.join(f.root, '.local/cache/electron'))
    assert.equal(installation.environment.TMP, path.join(f.root, '.local/cache/electron/tmp'))
    assert.equal(installation.environment.TEMP, installation.environment.TMP)
    assert.equal(f.environments.find(call => call.command.includes('run start:desktop')).environment.TMP, path.join(f.root, '.local/cache/tmp'))
  } finally { await f.clean() }
})

test('every development subprocess receives writable workspace temporary storage without changing the parent', async () => {
  const f = await fixture()
  const parent = { TMP: process.env.TMP, TEMP: process.env.TEMP }
  try {
    await f.run({ tools: undefined })
    await f.run({ prepare: true })
    const temporary = path.join(f.root, '.local/cache/tmp')
    assert.ok((await stat(temporary)).isDirectory())
    for (const { command, environment } of f.environments) {
      assert.equal(environment.TMP, temporary, command)
      assert.equal(environment.TEMP, temporary, command)
      for (const [key, value] of Object.entries(process.env)) {
        if (!['TMP', 'TEMP', 'CI'].includes(key)) assert.equal(environment[key], value, `${command}: ${key}`)
      }
    }
    assert.ok(f.environments.some(call => call.command.includes('prepareStudioTools')))
    assert.ok(f.environments.some(call => call.command.includes('prepare:primary-runtime')))
    assert.deepEqual({ TMP: process.env.TMP, TEMP: process.env.TEMP }, parent)
  } finally { await f.clean() }
})

test('Electron presence probe checks fixed version/path/files without executing download-capable package code', async () => {
  const f = await fixture()
  try {
    const desktop = path.join(f.root, 'desktop')
    const electron = 'desktop/node_modules/electron'
    await f.put('desktop/package.json', '{}')
    await f.put(`${electron}/package.json`, JSON.stringify({ name: 'electron', version: '44.7.0', main: 'index.js' }))
    const sideEffect = "require('node:fs').writeFileSync(require('node:path').join(__dirname, 'unexpected-download'), 'download invoked'); throw new Error('package code executed')"
    await f.put(`${electron}/index.js`, sideEffect)
    await f.put(`${electron}/install.js`, sideEffect)
    assert.equal(await electronInstalled(desktop, {}), false)
    await f.put(`${electron}/path.txt`, 'electron.exe')
    await f.put(`${electron}/dist/version`, '44.6.0')
    await f.put(`${electron}/dist/electron.exe`, 'binary')
    assert.equal(await electronInstalled(desktop, {}), false)
    await f.put(`${electron}/dist/version`, '44.7.0')
    assert.equal(await electronInstalled(desktop, {}), true)
    await f.put(`${electron}/path.txt`, 'electron')
    assert.equal(await electronInstalled(desktop, {}), false)
    await f.put(`${electron}/path.txt`, 'electron.exe')
    await rm(path.join(f.root, `${electron}/dist/electron.exe`))
    assert.equal(await electronInstalled(desktop, {}), false)
    await f.put('override/electron.exe', 'binary')
    assert.equal(await electronInstalled(desktop, { ELECTRON_OVERRIDE_DIST_PATH: path.join(f.root, 'override') }), true)
    await assert.rejects(stat(path.join(f.root, `${electron}/unexpected-download`)), { code: 'ENOENT' })
  } finally { await f.clean() }
})

test('a competing dev/build lock is preserved, action failure releases only its own lock', async () => {
  const f = await fixture()
  const build = path.join(f.root, '.local/build')
  try {
    await withDesktopLock(build, async () => {
      await assert.rejects(withDesktopLock(build, async () => assert.fail()), /owns/)
      assert.ok((await stat(path.join(build, '.studio-desktop-build.lock'))).isDirectory())
    })
    await assert.rejects(withDesktopLock(build, async () => { throw new Error('failed') }), /failed/)
    await assert.rejects(stat(path.join(build, '.studio-desktop-build.lock')), { code: 'ENOENT' })
  } finally { await f.clean() }
})

test('stale, reused-process and incomplete locks are reclaimed automatically', async () => {
  const f = await fixture()
  const build = path.join(f.root, '.local/build')
  const lock = path.join(build, '.studio-desktop-build.lock')
  const owner = '.local/build/.studio-desktop-build.lock/owner.json'
  try {
    const exited = spawnSync(process.execPath, ['-e', ''], { windowsHide: true })
    assert.equal(exited.status, 0)
    assert.ok(Number.isInteger(exited.pid))
    await f.put(owner, JSON.stringify({ pid: exited.pid, startTime: 'exited', id: 'exited' }))
    await withDesktopLock(build, async () => {})
    await assert.rejects(stat(lock), { code: 'ENOENT' })
    await f.put(owner, JSON.stringify({ pid: process.pid, startTime: 'reused-process', id: 'reused' }))
    await withDesktopLock(build, async () => {})
    await assert.rejects(stat(lock), { code: 'ENOENT' })
    await mkdir(lock, { recursive: true })
    const expired = new Date(Date.now() - 5000)
    await utimes(lock, expired, expired)
    await withDesktopLock(build, async () => {})
    await assert.rejects(stat(lock), { code: 'ENOENT' })
  } finally { await f.clean() }
})

test('a lock retained for process-tree inspection is never reclaimed automatically', async () => {
  const f = await fixture()
  const build = path.join(f.root, '.local/build')
  try {
    const failure = new Error('cleanup failed')
    failure.code = 'DESKTOP_PROCESS_CLEANUP_FAILED'
    await assert.rejects(withDesktopLock(build, async () => { throw failure }), /cleanup failed/)
    const owner = JSON.parse(await readFile(path.join(build, '.studio-desktop-build.lock/owner.json'), 'utf8'))
    assert.equal(owner.requiresInspection, true)
    await assert.rejects(withDesktopLock(build, async () => assert.fail('retained lock must block the action')), /retained for inspection/)
  } finally { await f.clean() }
})

test('removed source clears orphaned TypeScript output; modified source preserves incremental output', async () => {
  const f = await fixture()
  try {
    const source = path.join(f.root, 'source')
    const destination = path.join(f.root, 'staged')
    await f.put('source/keep.ts', 'new')
    await f.put('staged/src/keep.ts', 'old')
    await f.put('staged/lib/tsconfig.tsbuildinfo')
    await removeDeletedSourceOutputs(source, destination)
    assert.ok(await stat(path.join(destination, 'lib/tsconfig.tsbuildinfo')))
    await f.put('staged/src/removed.ts')
    await f.put('staged/lib/types/removed.js')
    await removeDeletedSourceOutputs(source, destination)
    await assert.rejects(stat(path.join(destination, 'lib')), { code: 'ENOENT' })
  } finally { await f.clean() }
})

test('runner propagates child failure and removes signal listeners', async () => {
  const before = process.listenerCount('SIGINT')
  await assert.rejects(executeDev(process.execPath, ['-e', 'process.exit(17)'], process.cwd()), /17/)
  assert.equal(process.listenerCount('SIGINT'), before)
})

test('runner forwards child output and leaves both parent streams open', () => {
  const moduleUrl = pathToFileURL(path.resolve(import.meta.dirname, '../../scripts/dev-desktop.mjs')).href
  const childCode = "process.stdout.write('child-out\\n'); process.stderr.write('child-err\\n')"
  const code = `import { executeDev } from ${JSON.stringify(moduleUrl)}; await executeDev(process.execPath, ['-e', ${JSON.stringify(childCode)}], process.cwd()); process.stdout.write('parent-out\\n'); process.stderr.write('parent-err\\n')`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, 'child-out\nparent-out\n')
  assert.equal(result.stderr, 'child-err\nparent-err\n')
})

test('Windows runner forwards cmd descendant output on both streams', { skip: process.platform !== 'win32' }, async () => {
  const f = await fixture()
  try {
    await f.put('probe.cjs', "process.stdout.write('nested-out\\n'); process.stderr.write('nested-err\\n')")
    const moduleUrl = pathToFileURL(path.resolve(import.meta.dirname, '../../scripts/dev-desktop.mjs')).href
    const code = `import { executeDev } from ${JSON.stringify(moduleUrl)}; await executeDev('cmd.exe', ['/d', '/s', '/c', 'node probe.cjs'], ${JSON.stringify(f.root)})`
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', windowsHide: true })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, 'nested-out\n')
    assert.equal(result.stderr, 'nested-err\n')
  } finally { await f.clean() }
})

test('Ctrl+C stops the owned child and grandchild before releasing the lock', async () => {
  const f = await fixture()
  try {
    const pids = path.join(f.root, 'child-pids.json')
    const code = `const { spawn } = require('node:child_process'); const { writeFileSync } = require('node:fs'); const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' }); writeFileSync(process.argv[1], JSON.stringify([process.pid, child.pid])); setInterval(() => {}, 1000)`
    const running = withDesktopLock(path.join(f.root, '.local/build'), () => executeDev(process.execPath, ['-e', code, pids], f.root)).then(() => undefined, error => error)
    let owned
    for (let attempt = 0; attempt < 200; attempt++) {
      try { owned = JSON.parse(await readFile(pids, 'utf8')); break } catch (error) { if (error.code !== 'ENOENT') throw error }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.ok(owned, 'owned process tree started')
    process.emit('SIGINT')
    assert.match((await running).message, /interrupted|exited/)
    for (const pid of owned) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
    await assert.rejects(stat(path.join(f.root, '.local/build/.studio-desktop-build.lock')), { code: 'ENOENT' })
  } finally { await f.clean() }
})

test('input digest includes file deletion and ignores generated stylesheet bytes', async () => {
  const f = await fixture()
  try {
    const before = await inputDigest(f.root, ['packages/studio-plugin/src'], { ignoreGeneratedStyles: true })
    await f.put('packages/studio-plugin/src/studio.tw.generated.css', 'generated')
    assert.equal(await inputDigest(f.root, ['packages/studio-plugin/src'], { ignoreGeneratedStyles: true }), before)
    await rm(path.join(f.root, 'packages/studio-plugin/src/sample.ts'))
    assert.notEqual(await inputDigest(f.root, ['packages/studio-plugin/src'], { ignoreGeneratedStyles: true }), before)
  } finally { await f.clean() }
})
