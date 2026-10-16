/** Source-to-installer entry point; uses the maintained assembly and upstream NSIS pipeline. */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, readFile, rmdir, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseEnv } from 'node:util'
import { runPnpm } from '../apps/desktop-distribution/build/run-pnpm.mjs'
import { STUDIO_APP_ID } from '../apps/desktop-distribution/build/desktop-brand-edits.mjs'

const repo = fileURLToPath(new URL('../', import.meta.url))
const help = `Usage: ./build-desktop.ps1 [--check | --help]
       node scripts/build-desktop.mjs [--check | --help]

Build eadp studio from this checkout into artifacts/windows/*.exe (Windows x64, unsigned).
Requires Windows x64, Node ^22.19.0 or >=24, pnpm 11.x, Git, tar,
Visual Studio C++ build tools, real symlink permission, and download access.
The DSH source/version and bundled runtimes are fixed by the maintained lock files.
--check validates the host, stages source, installs build dependencies, and runs
the upstream packaging preflight. It does not compile or create an installer.
Existing .local/build/dsh/apps/desktop/.env.windows is preserved; on first use
the public windows-package.env.example is copied there. No signing/upload occurs.
Electron-builder tools use .local/cache/electron-builder under the primary checkout.
`

export function parseBuildArguments(args) {
  if (args.length > 1 || args.some(arg => !['--check', '--help'].includes(arg))) throw new Error(help)
  return { help: args.includes('--help'), check: args.includes('--check') }
}

function execute(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, { cwd, windowsHide: true, stdio: 'inherit', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${path.basename(command)} exited with ${String(result.status ?? result.signal)}`)
  return result
}

export function validateHost(platform = process.platform, arch = process.arch, version = process.versions.node) {
  if (platform !== 'win32' || arch !== 'x64') throw new Error('Desktop installer builds require a native Windows x64 Node process.')
  const [major, minor] = version.split('.').map(Number)
  if (!(major >= 24 || major === 22 && minor >= 19)) throw new Error(`DSH requires Node ^22.19.0 or >=24; actual ${version}.`)
}

async function checkPrerequisites(root) {
  validateHost()
  execute('git', ['--version'], root)
  execute('tar', ['--version'], root)
  const pnpm = execute('cmd.exe', ['/d', '/s', '/c', 'pnpm --version'], root, { encoding: 'utf8', stdio: 'pipe' })
  if (!/^11\./.test(pnpm.stdout.trim())) throw new Error('pnpm 11.x is required on PATH.')
  const vswhere = path.join(process.env['ProgramFiles(x86)'] ?? '', 'Microsoft Visual Studio/Installer/vswhere.exe')
  const vs = execute(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], root, { encoding: 'utf8', stdio: 'pipe' })
  if (!vs.stdout.trim()) throw new Error('Install Visual Studio C++ build tools (VC.Tools.x86.x64).')
}

export async function ensureWindowsEnvironment(desktop) {
  const target = path.join(desktop, '.env.windows')
  const sample = path.join(repo, 'apps/desktop-distribution/build/windows-package.env.example')
  try { await copyFile(sample, target, 1) } catch (error) { if (error.code !== 'EEXIST') throw error }
  const config = parseEnv((await readFile(target, 'utf8')).replace(/^\uFEFF/u, ''))
  if (config.DSH_DESKTOP_APP_ID !== STUDIO_APP_ID) {
    throw new Error(`Existing ${target} must set DSH_DESKTOP_APP_ID=${STUDIO_APP_ID}; file preserved. Update this identifier explicitly before rebuilding.`)
  }
}

async function checkSymlinks(buildRoot) {
  const target = path.join(buildRoot, '.studio-symlink-target')
  const link = path.join(buildRoot, '.studio-symlink-probe')
  await writeFile(target, 'probe', { flag: 'wx' })
  try {
    await symlink(path.basename(target), link, 'file')
    await unlink(link)
  } catch (error) {
    throw new Error(`Real symbolic-link permission is required (${error.code}); enable it for this Windows development account.`, { cause: error })
  } finally { await unlink(target) }
}

/** Sequential source pipeline; the same runner is used by the CLI and the failure-propagation regression. */
export async function buildDesktop({ root, sharedRoot, check = false, runNode, pnpm = runPnpm, configure = ensureWindowsEnvironment }) {
  const tree = path.join(sharedRoot, '.local/build/dsh')
  const desktop = path.join(tree, 'apps/desktop')
  pnpm('productInstall', root)
  runNode(path.join(sharedRoot, 'scripts/fetch-dsh.mjs'), [], sharedRoot)
  runNode(path.join(root, 'apps/desktop-distribution/build/prepare-studio-plugin.mjs'), ['--stage-only'], root)
  await configure(desktop)
  pnpm('install', tree)
  pnpm('checkWindows', tree)
  if (check) return undefined
  runNode(path.join(root, 'apps/desktop-distribution/build/prepare-studio-plugin.mjs'), [], root)
  const builderCache = path.join(sharedRoot, '.local/cache/electron-builder')
  await mkdir(builderCache, { recursive: true })
  const environment = {
    ...process.env,
    DSH_DESKTOP_PACKED_EXTRA: path.join(sharedRoot, '.local/build/packed-studio'),
    ELECTRON_BUILDER_CACHE: builderCache,
  }
  pnpm('packageWindows', tree, environment)
  const manifest = JSON.parse(await readFile(path.join(desktop, 'package.json'), 'utf8'))
  const name = `eadp-studio-${manifest.version}-win-x64-unsigned.exe`
  const source = path.join(desktop, '.desktop-build/targets/win-x64/unsigned-artifacts', name)
  if (!(await stat(source)).isFile()) throw new Error(`Installer missing after packaging: ${source}`)
  const destination = path.join(root, 'artifacts/windows', name)
  await mkdir(path.dirname(destination), { recursive: true })
  await copyFile(source, destination)
  const digest = createHash('sha256')
  for await (const bytes of createReadStream(destination)) digest.update(bytes)
  const receipt = { productName: 'eadp studio', target: 'win-x64', unsigned: true, path: destination, bytes: (await stat(destination)).size, sha256: digest.digest('hex') }
  await writeFile(`${destination}.json`, `${JSON.stringify(receipt, null, 2)}\n`)
  console.log(`Installer: ${destination}\nSHA256: ${receipt.sha256}\nUnsigned development installer; release qualification remains separate.`)
  return receipt
}

async function main(args) {
  const options = parseBuildArguments(args)
  if (options.help) { console.log(help); return }
  await checkPrerequisites(repo)
  const common = execute('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], repo, { encoding: 'utf8', stdio: 'pipe' })
  const sharedRoot = path.dirname(common.stdout.trim())
  const buildRoot = path.join(sharedRoot, '.local/build')
  await mkdir(buildRoot, { recursive: true })
  const lock = path.join(buildRoot, '.studio-desktop-build.lock')
  try { await mkdir(lock) } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`A desktop build owns ${lock}. If interrupted, inspect running processes before manually removing the empty lock.`)
    throw error
  }
  try {
    await checkSymlinks(buildRoot)
    await buildDesktop({ root: repo, sharedRoot, check: options.check, runNode: (script, args, cwd) => execute(process.execPath, [script, ...args], cwd) })
    if (options.check) console.log('Desktop preflight passed; installer compilation was not requested.')
  } finally { await rmdir(lock) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(`build-desktop: ${error.message}`); process.exitCode = 1 })
}
