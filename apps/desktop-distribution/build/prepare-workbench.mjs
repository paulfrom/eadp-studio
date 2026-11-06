/** Rebuildable isolated source assembly for the local workbench; never changes the upstream cache. */
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { WORKBENCH_EDITS } from './workbench-edits.mjs'

const root = fileURLToPath(new URL('../../../', import.meta.url))
export const workbenchTree = path.join(root, '.local/build/local-workbench-dsh')
const upstream = path.join(root, '.local/upstream/dsh')
const packages = ['eadp-contracts', 'eadp-shell', 'eadp-requirements', 'eadp-prototype', 'eadp-knowledge']
const json = async file => JSON.parse(await readFile(file, 'utf8'))
const save = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n')

/** Stages only maintained inputs, retaining dependency/compiler caches in the isolated assembly. */
export async function stageWorkbench() {
  const verified = spawnSync(process.execPath, [path.join(root, 'scripts/fetch-dsh.mjs')], { cwd: root, stdio: 'inherit' })
  if (verified.error) throw verified.error
  if (verified.status !== 0) throw new Error('Fixed upstream source verification failed')
  const lock = await json(path.join(root, 'apps/desktop-distribution/release.lock.json'))
  const metadata = await json(path.join(upstream, 'package.json'))
  if (metadata.version !== lock.dsh.package.version) throw new Error('Fixed DSH source version mismatch')
  if (!existsSync(workbenchTree)) {
    await cp(upstream, workbenchTree, { recursive: true, filter: source => !source.split(path.sep).includes('node_modules') })
  }
  for (const edit of WORKBENCH_EDITS) {
    const source = await readFile(path.join(upstream, edit.file), 'utf8')
    await writeFile(path.join(workbenchTree, edit.file), edit.apply(source))
  }
  const eadp = path.join(workbenchTree, 'packages/eadp')
  await mkdir(eadp, { recursive: true })
  for (const name of packages) {
    const source = path.join(root, 'packages', name), destination = path.join(eadp, name)
    await mkdir(destination, { recursive: true })
    // Generated compiler outputs are invalid after source changes; dependencies remain reconstructible.
    await rm(path.join(destination, 'src'), { recursive: true, force: true })
    await rm(path.join(destination, 'lib'), { recursive: true, force: true })
    await cp(path.join(source, 'src'), path.join(destination, 'src'), { recursive: true })
    const manifest = await json(path.join(source, 'package.json'))
    if (name === 'eadp-contracts') {
      manifest.main = 'lib/index.js'; manifest.types = 'lib/types/index.d.ts'
      manifest.exports = Object.fromEntries(Object.entries(manifest.exports).map(([key, value]) => [key, { types: value.replace('./src/', './lib/types/').replace(/\.ts$/, '.d.ts'), default: key === '.' ? './lib/index.js' : value.replace('./src/', './lib/types/').replace(/\.ts$/, '.js') }]))
      manifest.files = ['lib']
      delete manifest.scripts
      await writeFile(path.join(destination, 'tsconfig.json'), JSON.stringify({ extends: '../../../tsconfig.base.json', compilerOptions: { rootDir: 'src', outDir: 'lib/types' }, include: ['src/**/*.ts'], references: [{ path: '../../../vendor/cordis' }, { path: '../../client/ui-slots' }, { path: '../../typert/protocol' }] }, null, 2))
      await writeFile(path.join(destination, 'tsconfig.client.json'), JSON.stringify({ extends: '../../../tsconfig.base.client.json', compilerOptions: { rootDir: 'src', outDir: 'lib/types', tsBuildInfoFile: 'lib/client.tsbuildinfo' }, include: ['src/client.ts', 'src/local-workbench.ts'], references: [{ path: '../../../vendor/cordis' }, { path: '../../client/ui-slots' }, { path: '../../typert/protocol' }] }, null, 2))
      await writeFile(path.join(destination, 'tsdown.config.ts'), "export default { entry: ['lib/types/index.js'], outDir: 'lib', format: ['esm'], platform: 'node', fixedExtension: false, dts: false, clean: false }\n")
    } else {
      const dependencies = await json(path.join(source, 'build/dependencies.json'))
      const official = Object.fromEntries(dependencies.map(name => [name, 'workspace:*']))
      manifest.peerDependencies = official
      manifest.devDependencies = { ...manifest.devDependencies, ...official }
      for (const file of await readdir(path.join(source, 'build'))) {
        if (file !== 'dependencies.json') await cp(path.join(source, 'build', file), path.join(destination, file))
      }
      await cp(path.join(source, 'cordis.patch.yml'), path.join(destination, 'cordis.patch.yml'))
    }
    await save(path.join(destination, 'package.json'), manifest)
  }
  const base = await readFile(path.join(upstream, 'tsconfig.base.json'), 'utf8')
  const aliases = packages.flatMap(name => {
    const packageName = name === 'eadp-contracts' ? '@eadp/contracts' : `@eadp/${name.slice(5)}`
    const entry = name === 'eadp-contracts' ? 'src/index.ts' : 'src/host/index.ts'
    return [JSON.stringify(packageName) + ': ' + JSON.stringify([`./packages/eadp/${name}/${entry}`]) + ',',
      ...(name === 'eadp-contracts' ? ['"@eadp/contracts/*": ["./packages/eadp/eadp-contracts/src/*"],'] : [])]
  }).join('\n')
  if (base.split('"paths": {').length !== 2) throw new Error('Source paths anchor mismatch')
  await writeFile(path.join(workbenchTree, 'tsconfig.base.json'), base.replace('"paths": {', '"paths": {\n' + aliases))
  for (const face of ['host', 'client']) {
    const source = await readFile(path.join(upstream, `tsconfig.${face}.json`), 'utf8')
    if (source.split('"references": [').length !== 2) throw new Error(`Source ${face} references anchor mismatch`)
    const refs = packages.map(name => ({ path: `./packages/eadp/${name}/${name === 'eadp-contracts' ? face === 'host' ? 'tsconfig.json' : 'tsconfig.client.json' : `tsconfig.${face}.json`}` }))
    await writeFile(path.join(workbenchTree, `tsconfig.${face}.json`), source.replace('"references": [', '"references": [\n' + refs.map(ref => JSON.stringify(ref) + ',').join('\n')))
  }
  console.log('Local workbench source staged; no desktop or runtime started.')
}

function command(args, cwd = workbenchTree) {
  const result = spawnSync(process.platform === 'win32' ? 'cmd.exe' : 'pnpm', process.platform === 'win32' ? ['/d', '/s', '/c', `pnpm ${args.join(' ')}`] : args, { cwd, stdio: 'inherit', env: { ...process.env, CI: 'true' } })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Static workbench build failed (${result.status})`)
}

/** Host compilation and generated Remote descriptors precede Client compilation. */
export async function buildWorkbench() {
  command(['install', '--no-frozen-lockfile'])
  command(['exec', 'tsc', '-b', ...packages.map(name => `packages/eadp/${name}/${name === 'eadp-contracts' ? 'tsconfig.json' : 'tsconfig.host.json'}`)])
  command(['exec', 'tsx', path.join(root, 'apps/desktop-distribution/build/workbench-typert.ts'), workbenchTree])
  command(['exec', 'tsc', '-b', ...packages.map(name => `packages/eadp/${name}/tsconfig.client.json`)])
  for (const name of packages) {
    const cwd = path.join(workbenchTree, 'packages/eadp', name)
    command(['exec', 'tsc', '--noEmit', '-p', name === 'eadp-contracts' ? 'tsconfig.json' : 'tsconfig.host.json'], cwd)
    command(['exec', 'tsc', '--noEmit', '-p', 'tsconfig.client.json'], cwd)
    if (name === 'eadp-contracts') command(['exec', 'tsdown', '--config-loader', 'native'], cwd)
    else for (const face of ['host', 'client']) command(['exec', 'tsdown', '--config-loader', 'native', '--env.DSH_BUILD_FACE', face], cwd)
    for (const artifact of name === 'eadp-contracts' ? ['lib/index.js'] : ['lib/index.js', 'lib/client.js']) {
      const bytes = await readFile(path.join(cwd, artifact), 'utf8')
      if (!bytes.trim()) throw new Error(`Empty build artifact: ${name}/${artifact}`)
      if (artifact === 'lib/client.js' && /require\(["']@eadp\//.test(bytes)) throw new Error(`Unbundled product import: ${name}/${artifact}`)
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.slice(2).some(arg => arg !== '--stage-only')) throw new Error('Usage: prepare-workbench.mjs [--stage-only]')
  await stageWorkbench()
  if (!process.argv.includes('--stage-only')) await buildWorkbench()
}
