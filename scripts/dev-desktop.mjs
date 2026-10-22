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
import { recordStudioBuild, verifyRuntimePayload, verifyStudioPlugin } from '../apps/desktop-distribution/build/studio-payload.mjs'
import { studioStagingPaths } from '../apps/desktop-distribution/build/prepare-studio-plugin.mjs'

const repo = fileURLToPath(new URL('../', import.meta.url))
let interruptedSignal
const help = `Usage: pnpm dev:desktop [--prepare | --help]

Prepare dependencies, fixed DSH source, current Studio and development runtimes;
then launch upstream Electron with DevTools and main/renderer/Host inspectors.
--prepare performs the same preparation and build without launching Electron.
Requires native Windows x64, Node ^22.19.0 or >=24, pnpm 11.x, Git, tar,
real symbolic-link permission and download access on first preparation.
Unchanged inputs reuse installed dependencies and verified build outputs.
After source edits, quit the app from its tray menu and run this command again; no source watcher.
Development data stays in .local/build/dsh/apps/desktop/.desktop-build/development.
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

/** Stable content keys include deleted files; generated styles are rebuilt from their inputs. */
export async function inputDigest(root, paths, { ignoreGeneratedStyles = false } = {}) {
  const hash = createHash('sha256')
  const visit = async relative => {
    const target = path.join(root, relative)
    if ((await stat(target)).isDirectory()) {
      for (const child of (await readdir(target)).sort()) await visit(path.join(relative, child))
    } else if (!(ignoreGeneratedStyles && relative.endsWith('studio.tw.generated.css'))) {
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
    // A detached Windows process cannot inherit a PTY's console handles.
    // Pipe output explicitly; this keeps the owned process group hidden and debuggable.
    const child = spawn(command, args, { cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: true })
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

const PRODUCT_DEPENDENCIES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'packages/studio-plugin/package.json', 'packages/contracts/package.json']
const PRODUCT_INPUTS = [...PRODUCT_DEPENDENCIES, 'scripts/dev-desktop.mjs', 'scripts/fetch-dsh.mjs', 'apps/desktop-distribution/release.lock.json', 'apps/desktop-distribution/build', 'packages/studio-plugin/src', 'packages/studio-plugin/build', 'packages/studio-plugin/assets/prototype-template.manifest.json', 'packages/studio-plugin/cordis.patch.yml', 'packages/contracts/src']
const BUILT_OUTPUTS = ['apps/desktop/lib', 'apps/desktop-host/lib', 'apps/cli/lib', 'apps/web/dist', 'packages/eadp/contracts/lib']

/** One build graph, followed by the official --skip-build launcher; failures never launch Electron. */
export async function devDesktop({ root, sharedRoot, prepare = false, execute = executeDev, verify = verifyStudioPlugin, record = recordStudioBuild, tools, electronReady, verifyTools = verifyRuntimePayload, appPids = developmentAppPids }) {
  await assertSharedSourceContract(root, sharedRoot)
  const tree = path.join(sharedRoot, '.local/build/dsh')
  const desktop = path.join(tree, 'apps/desktop')
  if (!prepare) await assertNoRunningDevelopmentApp(desktop, appPids)
  const statePath = path.join(sharedRoot, '.local/build/.studio-desktop-dev.json')
  const state = await json(statePath) ?? {}
  const pnpm = (operation, cwd, environment = {}) => {
    const invocation = pnpmInvocation(operation)
    return execute(invocation.command, invocation.args, cwd, { ...process.env, ...environment, CI: 'true' })
  }
  const runNode = (file, args = [], cwd = root) => execute(process.execPath, [file, ...args], cwd)
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
  const template = await json(path.join(root, 'packages/studio-plugin/assets/prototype-template.manifest.json'))
  const templatePaths = [...template.files, ...template.addedFiles].map(entry => {
    if (!entry.path || entry.path.includes('\\') || entry.path.includes(':') || path.posix.isAbsolute(entry.path) || entry.path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid template bundle entry')
    return `packages/studio-plugin/assets/prototype-template/${entry.path}`
  })
  const inputs = await inputDigest(root, [...PRODUCT_INPUTS, ...templatePaths], { ignoreGeneratedStyles: true })
  const plugin = path.join(tree, 'packages/eadp/studio-plugin')
  let stagedOutputs
  try { stagedOutputs = await inputDigest(tree, studioStagingPaths) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (state.staged !== inputs || state.stageOutputs !== stagedOutputs || !stagedOutputs) {
    console.log('Desktop development: staging current Studio source and template...')
    delete state.built
    await save()
    await runNode(path.join(root, 'apps/desktop-distribution/build/prepare-studio-plugin.mjs'), ['--dev-stage'])
    state.staged = inputs
    state.stageOutputs = await inputDigest(tree, studioStagingPaths)
    await save()
  } else console.log('Desktop development: reusing verified Studio staging.')
  const treeDependencies = () => inputDigest(tree, ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'packages/eadp/studio-plugin/package.json', 'packages/eadp/contracts/package.json'])
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
      await verify(plugin, root)
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
    console.log('Desktop development: verifying current Studio build outputs...')
    await record(plugin, root)
    await verify(plugin, root)
    state.built = { inputs, outputs: await inputDigest(tree, BUILT_OUTPUTS) }
    await save()
  } else console.log('Reusing verified desktop and Studio build outputs.')
  const runtime = path.join(desktop, '.desktop-build/targets/win-x64/runtime/studio-tools')
  const runtimeKey = await inputDigest(root, ['apps/desktop-distribution/build/studio-runtime.lock.json', 'apps/desktop-distribution/build/prepare-studio-tools.mjs'])
  let toolsReady = state.tools === runtimeKey
  if (toolsReady) {
    try { await verifyTools(runtime) } catch { toolsReady = false }
  }
  if (!toolsReady) {
    console.log('Desktop development: preparing fixed Studio runtime tools...')
    const archiveCache = path.join(desktop, '.desktop-build/downloads/studio-tools-archives')
    if (tools) await tools(runtime, archiveCache)
    else await execute(process.execPath, ['--input-type=module', '-e', 'const { prepareStudioTools } = await import(process.argv[1]); await prepareStudioTools(process.argv[2], process.argv[3])', pathToFileURL(path.join(desktop, 'scripts/prepare-studio-tools.mjs')).href, runtime, archiveCache], tree)
    await verifyTools(runtime)
    state.tools = runtimeKey
    await save()
  } else console.log('Desktop development: reusing verified Studio runtime tools.')
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
