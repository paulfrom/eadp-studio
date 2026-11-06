/** Prepare the current product and delegate desktop development to fixed DSH tooling. */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { acquireDesktopBuildLock } from '../apps/desktop-distribution/build/desktop-build-lock.mjs'
import { developmentAppPids } from '../apps/desktop-distribution/build/desktop-processes.mjs'
import { pnpmInvocation } from '../apps/desktop-distribution/build/run-pnpm.mjs'
import { recordWorkbenchBuild, verifyRuntimePayload, verifyWorkbenchBuild } from '../apps/desktop-distribution/build/workbench-payload.mjs'
import { workbenchStagingPaths } from '../apps/desktop-distribution/build/prepare-workbench.mjs'

const repo = fileURLToPath(new URL('../', import.meta.url))
let interruptedSignal
const help = `Usage: pnpm dev:desktop [--prepare | --help]

Prepare dependencies, fixed DSH source, current Workbench and development runtimes;
then launch upstream Electron with DevTools and main/renderer/Host inspectors.
--prepare performs the same preparation and build without launching Electron.
Requires native Windows x64, Node ^22.19.0 or >=24, pnpm 11.x, Git, tar,
real symbolic-link permission and download access on first preparation.
Unchanged inputs reuse installed dependencies and verified build outputs.
After source edits, quit the app from its tray menu and run this command again; no source watcher.
Development data stays in .local/build/local-workbench-dsh/apps/desktop/.desktop-build/development.
`

export function parseDevArguments(args) {
  if (args.length > 1 || args.some(arg => !['--help', '--prepare'].includes(arg))) throw new Error(help)
  return { help: args.includes('--help'), prepare: args.includes('--prepare') }
}

export function validateDevHost(platform = process.platform, arch = process.arch, version = process.versions.node) {
  if (platform !== 'win32' || arch !== 'x64') throw new Error('Desktop development requires native Windows x64 Node.')
  const [major, minor] = version.split('.').map(Number)
  if (!(major >= 24 || major === 22 && minor >= 19)) throw new Error(`DSH requires Node ^22.19.0 or >=24; actual ${version}.`)
}

const exists = target => stat(target).then(() => true, error => {
  if (error.code === 'ENOENT') return false
  throw error
})
const json = target => readFile(target, 'utf8').then(JSON.parse).catch(error => {
  if (error.code === 'ENOENT') return undefined
  throw error
})

export async function assertSharedSourceContract(root, sharedRoot) {
  if (path.resolve(root) === path.resolve(sharedRoot)) return
  const filename = 'apps/desktop-distribution/release.lock.json'
  const [current, shared] = await Promise.all([json(path.join(root, filename)), json(path.join(sharedRoot, filename))])
  if (!current?.dsh || !isDeepStrictEqual(current.dsh, shared?.dsh)) {
    throw new Error('This worktree and the primary checkout have different fixed DSH source contracts. Synchronize release.lock.json dsh before using the shared desktop build tree.')
  }
}

/** Mirror the fixed Windows install contract without loading Electron's auto-installing entry. */
export async function electronInstalled(desktop, environment = process.env) {
  try {
    const manifestPath = createRequire(path.join(desktop, 'package.json')).resolve('electron/package.json')
    const directory = path.dirname(manifestPath)
    const manifest = await json(manifestPath)
    const platformPath = await readFile(path.join(directory, 'path.txt'), 'utf8')
    if (platformPath !== 'electron.exe') return false
    const version = (await readFile(path.join(directory, 'dist/version'), 'utf8')).replace(/^v/, '')
    if (version !== manifest.version) return false
    const executable = path.join(environment.ELECTRON_OVERRIDE_DIST_PATH ?? path.join(directory, 'dist'), platformPath)
    return (await stat(executable)).isFile()
  } catch (error) {
    if (['ENOENT', 'MODULE_NOT_FOUND'].includes(error.code)) return false
    throw error
  }
}

/** The Chromium profile of the development app, resolved as the desktop launcher resolves it. */
export function developmentProfile(desktop) {
  return path.resolve(process.env.DSH_DESKTOP_USER_DATA_DIR ?? path.join(desktop, '.desktop-build/development/electron-user-data'))
}

/** A running development app owns its profile, so a second launch exits without a window. */
export async function assertNoRunningDevelopmentApp(desktop, appPids = developmentAppPids) {
  const profile = developmentProfile(desktop)
  const pids = await appPids(profile)
  if (pids.length === 0) return
  const owners = pids.map(pid => `PID ${String(pid)}`).join(', ')
  throw new Error(`Desktop development app ${owners} still owns ${profile}. Quit it from the tray menu, then run this command again.`)
}

/** Stable content keys include deleted files. */
export async function inputDigest(root, paths) {
  const hash = createHash('sha256')
  const visit = async relative => {
    const target = path.join(root, relative)
    if ((await stat(target)).isDirectory()) {
      for (const child of (await readdir(target)).sort()) await visit(path.join(relative, child))
    } else {
      hash.update(relative.split(path.sep).join('/')).update('\0').update(await readFile(target)).update('\0')
    }
  }
  for (const entry of [...paths].sort()) await visit(entry)
  return hash.digest('hex')
}

/** Own only this invocation's process tree; wait for it to stop before releasing the build lock. */
export async function executeDev(command, args, cwd, environment = process.env) {
  if (interruptedSignal) throw new Error(`Desktop development interrupted (${interruptedSignal}).`)
  await new Promise((resolve, reject) => {
    // Windows cmd descendants lose their output handles when detached; taskkill owns that tree.
    // POSIX needs a separate process group for signal-based tree cleanup.
    const child = spawn(command, args, { cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' })
    child.stdout.pipe(process.stdout, { end: false })
    child.stderr.pipe(process.stderr, { end: false })
    let interrupted
    let stopping = Promise.resolve()
    const stop = signal => {
      if (interrupted) return
      interrupted = signal
      if (!child.pid) return
      if (process.platform === 'win32') {
        stopping = new Promise(done => {
          const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
          const killed = failure => {
            if (failure) failure.code = 'DESKTOP_PROCESS_CLEANUP_FAILED'
            done(failure)
            if (failure) void finish(failure)
          }
          killer.once('error', killed)
          killer.once('close', code => killed(code === 0 ? undefined : new Error(`Cannot stop desktop process tree ${child.pid}; inspect it before restarting.`)))
        })
      } else {
        try { process.kill(-child.pid, signal) } catch (error) { if (error.code !== 'ESRCH') throw error }
      }
    }
    const onInt = () => stop('SIGINT')
    const onTerm = () => stop('SIGTERM')
    process.on('SIGINT', onInt); process.on('SIGTERM', onTerm)
    let finished = false
    const finish = async error => {
      if (finished) return
      finished = true
      error = await stopping ?? error
      process.off('SIGINT', onInt); process.off('SIGTERM', onTerm)
      if (error || interrupted) reject(error ?? new Error(`Desktop development interrupted (${interrupted}).`))
      else resolve()
    }
    child.once('error', finish)
    child.once('close', (code, signal) => finish(code === 0 ? undefined : new Error(`${path.basename(command)} exited with ${String(code ?? signal)}`)))
  })
}

export async function withDesktopLock(buildRoot, action) {
  const desktopLock = await acquireDesktopBuildLock(buildRoot)
  const onInt = () => { interruptedSignal = 'SIGINT' }
  const onTerm = () => { interruptedSignal = 'SIGTERM' }
  process.on('SIGINT', onInt); process.on('SIGTERM', onTerm)
  let retain = false
  try {
    const result = await action()
    if (interruptedSignal) throw new Error(`Desktop development interrupted (${interruptedSignal}).`)
    return result
  } catch (error) {
    retain = error.code === 'DESKTOP_PROCESS_CLEANUP_FAILED'
    throw error
  } finally {
    process.off('SIGINT', onInt); process.off('SIGTERM', onTerm)
    interruptedSignal = undefined
    if (retain) await desktopLock.preserveForInspection()
    else await desktopLock.release()
  }
}

const WORKBENCH_PACKAGES = ['eadp-contracts', 'eadp-shell', 'eadp-requirements', 'eadp-prototype', 'eadp-knowledge']
const PRODUCT_DEPENDENCIES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', ...WORKBENCH_PACKAGES.map(name => `packages/${name}/package.json`)]
const PRODUCT_INPUTS = [
  ...PRODUCT_DEPENDENCIES, 'scripts/dev-desktop.mjs', 'scripts/fetch-dsh.mjs',
  'apps/desktop-distribution/release.lock.json', 'apps/desktop-distribution/build',
  ...WORKBENCH_PACKAGES.flatMap(name => [`packages/${name}/src`, ...(name === 'eadp-contracts' ? [] : [`packages/${name}/build`, `packages/${name}/cordis.patch.yml`])]),
  'packages/eadp-prototype/assets/prototype-template.manifest.json', 'packages/eadp-knowledge/resources/builtin',
]
const BUILT_OUTPUTS = ['apps/desktop/lib', 'apps/desktop-host/lib', 'apps/cli/lib', 'apps/web/dist', ...WORKBENCH_PACKAGES.map(name => `packages/eadp/${name}/lib`)]

/** One build graph, followed by the official --skip-build launcher; failures never launch Electron. */
export async function devDesktop({ root, sharedRoot, prepare = false, execute = executeDev, verify = verifyWorkbenchBuild, record = recordWorkbenchBuild, tools, electronReady, verifyTools = verifyRuntimePayload, appPids = developmentAppPids }) {
  await assertSharedSourceContract(root, sharedRoot)
  const tree = path.join(sharedRoot, '.local/build/local-workbench-dsh')
  const desktop = path.join(tree, 'apps/desktop')
  if (!prepare) await assertNoRunningDevelopmentApp(desktop, appPids)
  const statePath = path.join(sharedRoot, '.local/build/.workbench-desktop-dev.json')
  const state = await json(statePath) ?? {}
  // Build tools and runtime preparation share a writable, workspace-owned temp directory.
  const temporary = path.join(sharedRoot, '.local/cache/tmp')
  await mkdir(temporary, { recursive: true })
  const environment = { ...process.env, TMP: temporary, TEMP: temporary }
  const pnpm = (operation, cwd, overlay = {}) => {
    const invocation = pnpmInvocation(operation)
    return execute(invocation.command, invocation.args, cwd, { ...environment, ...overlay, CI: 'true' })
  }
  const runNode = (file, args = [], cwd = root) => execute(process.execPath, [file, ...args], cwd, environment)
  const save = () => writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`)
  const dependencies = await inputDigest(root, PRODUCT_DEPENDENCIES)
  if (state.productDependencies !== dependencies || !await exists(path.join(root, 'node_modules/.modules.yaml'))) {
    console.log('Desktop development: installing product dependencies...')
    await pnpm('productInstall', root)
    state.productDependencies = dependencies
    await save()
  } else console.log('Desktop development: reusing product dependencies.')
  console.log('Desktop development: verifying fixed DSH source...')
  await runNode(path.join(sharedRoot, 'scripts/fetch-dsh.mjs'), [], sharedRoot)
  const template = await json(path.join(root, 'packages/eadp-prototype/assets/prototype-template.manifest.json'))
  const templatePaths = [...template.files, ...template.addedFiles].map(entry => {
    if (!entry.path || entry.path.includes('\\') || entry.path.includes(':') || path.posix.isAbsolute(entry.path) || entry.path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid template bundle entry')
    return `packages/eadp-prototype/assets/prototype-template/${entry.path}`
  })
  const inputs = await inputDigest(root, [...PRODUCT_INPUTS, ...templatePaths])
  let stagedOutputs
  try { stagedOutputs = await inputDigest(tree, workbenchStagingPaths) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (state.staged !== inputs || state.stageOutputs !== stagedOutputs || !stagedOutputs) {
    console.log('Desktop development: staging current Workbench source and resources...')
    delete state.built
    await save()
    await runNode(path.join(root, 'apps/desktop-distribution/build/prepare-workbench.mjs'), ['--stage-only'])
    state.staged = inputs
    state.stageOutputs = await inputDigest(tree, workbenchStagingPaths)
    await save()
  } else console.log('Desktop development: reusing verified Workbench staging.')
  const treeDependencies = () => inputDigest(tree, ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', ...WORKBENCH_PACKAGES.map(name => `packages/eadp/${name}/package.json`)])
  if (state.treeDependencies !== await treeDependencies() || !await exists(path.join(tree, 'node_modules/.modules.yaml'))) {
    console.log('Desktop development: installing DSH build dependencies...')
    delete state.built
    await save()
    await pnpm('install', tree)
    state.treeDependencies = await treeDependencies()
    await save()
  } else console.log('Desktop development: reusing DSH build dependencies.')
  const checkElectron = electronReady ?? (() => electronInstalled(desktop))
  if (!await checkElectron()) {
    console.log('Desktop development: installing the fixed Electron binary...')
    const electronCache = path.join(sharedRoot, '.local/cache/electron')
    const temporary = path.join(electronCache, 'tmp')
    await mkdir(temporary, { recursive: true })
    await pnpm('electron', tree, { electron_config_cache: electronCache, TMP: temporary, TEMP: temporary })
  } else console.log('Desktop development: reusing the installed Electron binary.')
  if (!await checkElectron()) throw new Error('Electron executable is unavailable after installation.')
  let reusable = state.built?.inputs === inputs
  if (reusable) {
    try {
      await verify(tree, root)
      reusable = state.built.outputs === await inputDigest(tree, BUILT_OUTPUTS)
    } catch { reusable = false }
  }
  if (!reusable) {
    console.log('Desktop development: building Host and client artifacts (this can take several minutes)...')
    delete state.built
    await save()
    await pnpm('artifacts', tree)
    console.log('Desktop development: building the Electron desktop shell...')
    await pnpm('desktop', tree)
    console.log('Desktop development: verifying current Workbench build outputs...')
    await record(tree, root)
    await verify(tree, root)
    state.built = { inputs, outputs: await inputDigest(tree, BUILT_OUTPUTS) }
    await save()
  } else console.log('Reusing verified desktop and Workbench build outputs.')
  const runtime = path.join(desktop, '.desktop-build/targets/win-x64/runtime/eadp-tools')
  const runtimeKey = await inputDigest(root, ['apps/desktop-distribution/build/eadp-runtime.lock.json', 'apps/desktop-distribution/build/prepare-eadp-tools.mjs'])
  let toolsReady = state.tools === runtimeKey
  if (toolsReady) {
    try { await verifyTools(runtime) } catch { toolsReady = false }
  }
  if (!toolsReady) {
    console.log('Desktop development: preparing fixed EADP runtime tools...')
    const archiveCache = path.join(desktop, '.desktop-build/downloads/eadp-tools-archives')
    if (tools) await tools(runtime, archiveCache)
    else await execute(process.execPath, ['--input-type=module', '-e', 'const { prepareEadpTools } = await import(process.argv[1]); await prepareEadpTools(process.argv[2], process.argv[3])', pathToFileURL(path.join(desktop, 'scripts/prepare-eadp-tools.mjs')).href, runtime, archiveCache], tree, environment)
    await verifyTools(runtime)
    state.tools = runtimeKey
    await save()
  } else console.log('Desktop development: reusing verified EADP runtime tools.')
  // The upstream start path prepares and smoke-tests primary-runtime before Electron.
  // Preparation-only must exercise the same runtime step without opening a window.
  if (prepare) {
    console.log('Desktop development: preparing and checking the primary runtime...')
    await pnpm('primaryRuntime', tree)
    console.log('Desktop development prepared and verified. Run pnpm dev:desktop to open Electron.')
  } else {
    console.log('Desktop development: preparing the primary runtime and launching Electron debugging...')
    await pnpm('startDesktop', tree)
  }
}

async function main(args) {
  const options = parseDevArguments(args)
  if (options.help) { console.log(help); return }
  validateDevHost()
  const common = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repo, encoding: 'utf8', windowsHide: true })
  if (common.status !== 0) throw new Error('Cannot resolve the Git common directory.')
  const sharedRoot = path.dirname(common.stdout.trim())
  await withDesktopLock(path.join(sharedRoot, '.local/build'), () => devDesktop({ root: repo, sharedRoot, prepare: options.prepare }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(`dev-desktop: ${error.message}`); process.exitCode = 1 })
}
