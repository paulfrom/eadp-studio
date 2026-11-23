/** Package the last prepared Windows desktop payload without rebuilding or preparing it again. */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { acquireDesktopBuildLock } from '../apps/desktop-distribution/build/desktop-build-lock.mjs'
import { verifyWorkbenchDistribution } from '../apps/desktop-distribution/build/workbench-payload.mjs'
import { finalizeWindowsInstaller, prepareElectronBuilderCache, validateHost, windowsInstallerPath } from './build-desktop.mjs'

const repo = fileURLToPath(new URL('../', import.meta.url))
const DESKTOP_PAYLOAD_FILES = [
  'lib/main.js',
  'lib/preload-app.cjs',
  'lib/preload-mandatory.cjs',
  'lib/preload-platform-account.cjs',
  'lib/preload-update-dialog.cjs',
  'lib/preload-welcome.cjs',
  'lib/welcome/brand-font.css',
  'lib/welcome/montserrat-light.woff2',
  'lib/welcome/montserrat-medium.woff2',
  'lib/welcome/Montserrat-OFL.txt',
  'lib/welcome/montserrat-regular.woff2',
  'lib/welcome/welcome.css',
  'lib/welcome/welcome.js',
  'renderer/assets/welcome-brand.svg',
  'renderer/assets/window-material.css',
  'renderer/mandatory-update-frame.js',
  'renderer/mandatory-update.css',
  'renderer/mandatory-update.html',
  'renderer/mandatory-update.js',
  'renderer/policy-login-loading.html',
  'renderer/update-close.svg',
  'renderer/update-dialog.css',
  'renderer/update-dialog.html',
  'renderer/update-dialog.js',
  'renderer/welcome.css',
  'renderer/welcome.html',
  'package.json',
]
const help = `Usage: ./package-desktop.ps1 [--check | --help]
       node scripts/package-desktop.mjs [--check | --help]

Reuse the last prepared Windows x64 desktop payload and run only Electron/NSIS packaging,
the packaged-runtime smoke check, local artifact copy and SHA-256 receipt.
Does not run pnpm install, fetch sources, compile TypeScript/DSH or prepare runtimes again.
The official Electron/NSIS step still compiles its small native Windows installer helper.
Source changes are not rebuilt; run ./build-desktop.ps1 after changing product or DSH inputs.
--check validates the existing payload and packaging environment without creating an installer.
`

export function parsePackageArguments(args) {
  if (args.length > 1 || args.some(arg => !['--check', '--help'].includes(arg))) throw new Error(help)
  return { help: args.includes('--help'), check: args.includes('--check') }
}

function execute(command, args, cwd, environment = process.env, options = {}) {
  const result = spawnSync(command, args, { cwd, env: environment, windowsHide: true, stdio: 'inherit', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${path.basename(command)} exited with ${String(result.status ?? result.signal)}`)
  return result
}

async function importDesktopModule(desktop, relative) {
  return import(pathToFileURL(path.join(desktop, relative)).href)
}

/** Reuse the official payload integrity checks before handing the prepared tree to electron-builder. */
async function verifyPreparedPayload(root, desktop, paths, target, runtimeTools) {
  for (const relative of DESKTOP_PAYLOAD_FILES) {
    const file = await stat(path.join(desktop, relative))
    if (!file.isFile() || file.size === 0) throw new Error(`Prepared desktop file is missing or empty: ${relative}`)
  }
  const manifest = JSON.parse(await readFile(path.join(desktop, 'package.json'), 'utf8'))
  await runtimeTools.verifyDesktopRuntime(paths.dsh, manifest.version, target)
  await verifyWorkbenchDistribution(paths.dsh, path.join(paths.runtime, 'eadp-tools'), root)
  return manifest.version
}

export async function packageDesktop({ root, sharedRoot, check = false }) {
  const tree = path.join(sharedRoot, '.local/build/local-workbench-dsh')
  const desktop = path.join(tree, 'apps/desktop')
  const [targetTools, environmentTools, pathTools, commitTools, runtimeTools] = await Promise.all([
    importDesktopModule(desktop, 'scripts/package-target.ts'),
    importDesktopModule(desktop, 'scripts/desktop-package-environment.mjs'),
    importDesktopModule(desktop, 'scripts/desktop-build-paths.mjs'),
    importDesktopModule(desktop, 'scripts/desktop-build-commit.mjs'),
    importDesktopModule(desktop, 'lib/types/runtime-tree.js'),
  ])
  const target = targetTools.resolveDesktopPackageTarget('win-x64')
  const paths = pathTools.desktopTargetBuildPaths(target.name)
  console.log('Packaging only: verifying the prepared desktop and Workbench payload...')
  const productVersion = await verifyPreparedPayload(root, desktop, paths, target, runtimeTools).catch(error => {
    throw new Error(`Prepared desktop payload is incomplete or stale. Run ./build-desktop.ps1 first. ${error.message}`, { cause: error })
  })

  const builderCache = path.join(sharedRoot, '.local/cache/electron-builder')
  const selected = environmentTools.loadDesktopPackageEnvironment(target.platform, process.env, desktop, { unsigned: true })
  const base = targetTools.withoutWindowsSigningEnvironment(targetTools.withoutDesktopUploadCredentials(selected))
  const targetEnvironment = {
    ...base,
    DSH_DESKTOP_MACOS_SKIP_NOTARIZATION: '0',
    DSH_DESKTOP_TARGET_PLATFORM: target.platform,
    DSH_DESKTOP_TARGET_ARCH: target.arch,
    DSH_DESKTOP_BUILD_VERSION: productVersion,
    ELECTRON_BUILDER_CACHE: builderCache,
  }
  const packaged = commitTools.readDesktopBuildCommit(tree)
  const environment = {
    ...targetTools.desktopElectronBuilderEnvironment(targetEnvironment, true),
    ...commitTools.desktopBuildCommitEnvironment(packaged),
  }
  environmentTools.validateDesktopPackageEnvironment(environment, target, { unsigned: true })
  if (check) {
    console.log('Prepared desktop payload and packaging environment are valid; packaging was not requested.')
    return undefined
  }

  const sourceInstaller = windowsInstallerPath(desktop, productVersion)
  // The last published artifact remains intact; only the rebuildable builder output is cleared.
  await rm(sourceInstaller, { force: true })
  await rm(`${sourceInstaller}.blockmap`, { force: true })
  await prepareElectronBuilderCache(sharedRoot)
  const require = createRequire(path.join(desktop, 'package.json'))
  const pnpmManifestPath = require.resolve('pnpm')
  const pnpmManifest = JSON.parse(await readFile(pnpmManifestPath, 'utf8'))
  const pnpmEntry = path.join(path.dirname(pnpmManifestPath), pnpmManifest.bin.pnpm)
  const run = args => execute(process.execPath, [pnpmEntry, ...args], desktop, environment)

  console.log('Packaging only: running electron-builder; no TypeScript/DSH compilation or runtime preparation follows.')
  await run(targetTools.desktopElectronBuilderArguments(target, false))
  console.log('Packaging only: checking the packaged runtime...')
  await run(['exec', 'tsx', 'scripts/smoke-packaged-runtime.ts', '--unsigned'])
  return finalizeWindowsInstaller(desktop, root)
}

async function main(args) {
  const options = parsePackageArguments(args)
  if (options.help) { console.log(help); return }
  validateHost()
  const common = execute('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], repo, process.env, { encoding: 'utf8', stdio: 'pipe' })
  const sharedRoot = path.dirname(common.stdout.trim())
  const desktopLock = await acquireDesktopBuildLock(path.join(sharedRoot, '.local/build'))
  try {
    await packageDesktop({ root: repo, sharedRoot, check: options.check })
  } finally {
    await desktopLock.release()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(`package-desktop: ${error.message}`); process.exitCode = 1 })
}
