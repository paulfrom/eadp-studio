import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import vm from 'node:vm'
import test from 'node:test'
import { STUDIO_PACKAGING_EDIT, STUDIO_PACKAGED_COMMIT_EDIT, STUDIO_PACK_CONCURRENCY_EDIT, STUDIO_PACKAGE_SET_TAR_EDIT } from '../../apps/desktop-distribution/build/studio-packaging-edits.mjs'

const upstream = path.resolve(import.meta.dirname, '../../.local/upstream/dsh')

test('all packaging edits apply to the fixed alpha.4 sources and replay idempotently', async () => {
  for (const edit of [STUDIO_PACKAGING_EDIT, STUDIO_PACKAGED_COMMIT_EDIT, STUDIO_PACK_CONCURRENCY_EDIT, STUDIO_PACKAGE_SET_TAR_EDIT]) {
    const source = await readFile(path.join(upstream, edit.file), 'utf8')
    const edited = edit.apply(source)
    assert.notEqual(edited, source)
    assert.equal(edit.apply(edited), edited)
    assert.throws(() => edit.apply('drift'), /anchor/)
  }
  const source = await readFile(path.join(upstream, 'scripts/build.ts'), 'utf8')
  const begin = source.indexOf('export function parseBuildArguments(')
  const end = source.indexOf('\n/**', begin)
  assert.ok(begin >= 0 && end > begin)
  const parser = stripTypeScriptTypes(source.slice(begin, end), { mode: 'transform' }).replace('export function', 'function')
  const invocation = vm.runInNewContext(`${parser}\nparseBuildArguments(['--profile', 'official', '--scope', 'artifacts'])`, { parseArgs })
  assert.equal(invocation.scope, 'artifacts')
  assert.equal(invocation.profile, 'official')
  const pack = STUDIO_PACK_CONCURRENCY_EDIT.apply(await readFile(path.join(upstream, STUDIO_PACK_CONCURRENCY_EDIT.file), 'utf8'))
  const line = pack.split('\n').find(value => value.includes('const packArguments ='))
  assert.deepEqual(Array.from(vm.runInNewContext(`${line}\npackArguments`, { mac: undefined })), ['--concurrency', '4'])
  assert.deepEqual(Array.from(vm.runInNewContext(`${line}\npackArguments`, { mac: { packConcurrency: 8 } })), ['--concurrency', '8'])
})

test('packaging commit snapshot keeps real client receipts valid when checkout HEAD advances', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'studio packaged commit '))
  try {
    const original = await readFile(path.join(upstream, STUDIO_PACKAGED_COMMIT_EDIT.file), 'utf8')
    const source = STUDIO_PACKAGED_COMMIT_EDIT.apply(original)
    assert.throws(() => STUDIO_PACKAGED_COMMIT_EDIT.apply(`${original}\n${original}`), /anchor/)
    assert.throws(() => STUDIO_PACKAGED_COMMIT_EDIT.apply(`${source}\n${source}`), /anchor/)
    const desktop = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
    const clientSource = stripTypeScriptTypes(await readFile(path.join(upstream, 'scripts/client-build-environment.ts'), 'utf8'), { mode: 'transform' })
    const client = await import(`data:text/javascript;base64,${Buffer.from(clientSource).toString('base64')}`)
    const git = (...args) => execFileSync('git', ['-c', 'user.name=Packaging regression', '-c', 'user.email=packaging-regression@example.invalid', ...args], { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    git('init', '--quiet')
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ version: '1.0.0' }))
    git('add', 'package.json')
    git('commit', '--quiet', '-m', 'build source snapshot')
    const packaged = desktop.readDesktopBuildCommit(directory)
    const environment = desktop.desktopBuildCommitEnvironment(packaged)
    assert.equal(environment.DSH_CLIENT_COMMIT_HASH, packaged.commit)
    assert.equal(environment.DSH_DESKTOP_BUILD_COMMIT, packaged.commit)
    assert.deepEqual(desktop.resolveDesktopBuildCommit(environment), packaged)
    await mkdir(path.join(directory, 'apps/web/dist'), { recursive: true })
    await writeFile(path.join(directory, 'apps/web/dist/index.html'), '<title>client artifact</title>')
    const built = client.resolveClientBuildEnvironment(client.repositoryClientBuildEnvironment(directory, environment), 'official')
    assert.equal(built.DSH_CLIENT_COMMIT_HASH, packaged.commit.slice(0, 7))
    client.writeClientBuildRecord(directory, built)
    git('commit', '--quiet', '--allow-empty', '-m', 'external checkout advance during build')
    assert.notEqual(git('rev-parse', 'HEAD'), packaged.commit)
    assert.throws(() => client.readClientBuildRecord(directory, client.officialClientBuildEnvironment(directory, {})), /DSH_CLIENT_COMMIT_HASH/)
    const expected = client.officialClientBuildEnvironment(directory, environment)
    assert.equal(client.readClientBuildRecord(directory, expected).environment.DSH_CLIENT_COMMIT_HASH, packaged.commit.slice(0, 7))
  } finally {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()))
    await rm(directory, { recursive: true, force: true })
  }
})

const tarTools = []
if (process.platform === 'win32') {
  const system = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/tar.exe')
  if (existsSync(system)) tarTools.push(['bsdtar', system])
  const gitPaths = spawnSync('where.exe', ['git'], { encoding: 'utf8' }).stdout?.trim().split(/\r?\n/) ?? []
  for (const git of gitPaths) {
    const candidate = path.resolve(path.dirname(git), '../usr/bin/tar.exe')
    if (existsSync(candidate)) { tarTools.push(['GNU tar', candidate]); break }
  }
} else tarTools.push(['tar', 'tar'])

for (const [name, executable] of tarTools) {
  test(`fixed package-set manifest reads work with ${name} and Chinese/space drive paths`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'studio 中文 (package set) '))
    try {
      const source = STUDIO_PACKAGE_SET_TAR_EDIT.apply(await readFile(path.join(upstream, STUDIO_PACKAGE_SET_TAR_EDIT.file), 'utf8'))
      const begin = source.indexOf('function packedManifest(')
      const end = source.indexOf('\nfunction packedPackages(', begin)
      assert.ok(begin >= 0 && end > begin)
      const helper = stripTypeScriptTypes(source.slice(begin, end), { mode: 'transform' })
      const processSource = stripTypeScriptTypes(await readFile(path.join(upstream, 'scripts/release/process.ts'), 'utf8'), { mode: 'transform' })
      const { capture } = await import(`data:text/javascript;base64,${Buffer.from(processSource).toString('base64')}`)
      const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'))
      const searchPath = process.env.PATH ?? process.env.Path ?? ''
      environment[process.platform === 'win32' ? 'Path' : 'PATH'] = executable === 'tar'
        ? searchPath : `${path.dirname(executable)}${path.delimiter}${searchPath}`
      const runTar = (args, options) => capture(executable, args, { ...options, env: environment })
      await mkdir(path.join(directory, 'package'))
      const manifest = { name: '@eadp/test-package', version: '1.0.0' }
      await writeFile(path.join(directory, 'package/package.json'), JSON.stringify(manifest))
      runTar(['-czf', 'fixture.tgz', 'package/package.json'], { cwd: directory })
      const result = vm.runInNewContext(`${helper}\npackedManifest(tarball)`, {
        tarball: path.join(directory, 'fixture.tgz'), basename: path.basename, resolve: path.resolve,
        capture: (_command, args, options) => runTar(args, options),
      })
      assert.equal(result.name, manifest.name)
      assert.equal(result.version, manifest.version)
    } finally {
      assert.equal(path.dirname(directory), path.resolve(tmpdir()))
      await rm(directory, { recursive: true, force: true })
    }
  })
}
