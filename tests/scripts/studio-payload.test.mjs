import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { assertStudioHost, productionPluginManifest, recordStudioBuild, verifyStudioPlugin, verifyRuntimePayload } from '../../apps/desktop-distribution/build/studio-payload.mjs'
import { STUDIO_PACKAGING_EDIT, STUDIO_PACK_CONCURRENCY_EDIT, STUDIO_PACKAGE_SET_TAR_EDIT } from '../../apps/desktop-distribution/build/studio-packaging-edits.mjs'
import { STUDIO_PLATFORM_EDITS } from '../../apps/desktop-distribution/build/studio-platform-edits.mjs'

test('runtime preparation has one fixed cache call when replayed into fresh or older staging', () => {
  const edit = STUDIO_PLATFORM_EDITS.find(edit => edit.file === 'apps/desktop/scripts/prepare-runtime.ts')
  const original = "import { prepareCommandLink } from './prepare-command-link.ts'\n  const { pnpm } = await readPrimaryRuntime(join(RUNTIME_ROOT, 'primary-runtime'))"
  const current = edit.apply(original)
  assert.equal(edit.apply(current), current)
  assert.equal((current.match(/\(\) => prepareStudioTools\(/g) ?? []).length, 1)
  const older = current.replace(
    "prepareStudioTools(join(RUNTIME_ROOT, 'studio-tools'), join(BUILD_PATHS.downloads, 'studio-tools-archives'))",
    "prepareStudioTools(join(RUNTIME_ROOT, 'studio-tools'))",
  )
  assert.equal(edit.apply(older), current)
})

test('a corrupted fixed archive cache fails before download or extraction', { skip: process.platform !== 'win32' || process.arch !== 'x64' }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-archive-fixture-'))
  const originalFetch = globalThis.fetch
  try {
    await mkdir(path.join(root, 'node_modules/extract-zip'), { recursive: true })
    await writeFile(path.join(root, 'node_modules/extract-zip/package.json'), JSON.stringify({ type: 'module', exports: './index.js' }))
    await writeFile(path.join(root, 'node_modules/extract-zip/index.js'), 'export default function extract() { throw new Error("extraction must not run") }')
    for (const filename of ['prepare-studio-tools.mjs', 'studio-runtime.lock.json']) await writeFile(path.join(root, filename), await readFile(new URL(`../../apps/desktop-distribution/build/${filename}`, import.meta.url)))
    await mkdir(path.join(root, 'cache'))
    await writeFile(path.join(root, 'cache/node.zip'), 'corrupt')
    globalThis.fetch = () => { throw new Error('download must not run') }
    const { prepareStudioTools } = await import(pathToFileURL(path.join(root, 'prepare-studio-tools.mjs')).href)
    await assert.rejects(prepareStudioTools(path.join(root, 'runtime'), path.join(root, 'cache')), /node archive integrity mismatch/)
    assert.equal(await readFile(path.join(root, 'cache/node.zip'), 'utf8'), 'corrupt')
  } finally { globalThis.fetch = originalFetch; await rm(root, { recursive: true, force: true }) }
})

test('official packaging keeps checked artifact compilation and rejects upstream drift', () => {
  const original = "await execute(['run', 'build:official'], buildEnv, REPOSITORY_ROOT)"
  const edited = STUDIO_PACKAGING_EDIT.apply(original)
  assert.match(edited, /scripts\/build\.ts.*--profile.*official.*--scope.*artifacts/)
  assert.equal(STUDIO_PACKAGING_EDIT.apply(edited), edited)
  assert.throws(() => STUDIO_PACKAGING_EDIT.apply('drift'), /anchor/)
})

test('Windows release packing uses the official bounded concurrency and rejects upstream drift', () => {
  const original = "  const packArguments = mac === undefined ? [] : ['--concurrency', String(mac.packConcurrency)]"
  const edited = STUDIO_PACK_CONCURRENCY_EDIT.apply(original)
  assert.match(edited, /mac\?\.packConcurrency \?\? 4/)
  assert.equal(STUDIO_PACK_CONCURRENCY_EDIT.apply(edited), edited)
  assert.throws(() => STUDIO_PACK_CONCURRENCY_EDIT.apply('drift'), /anchor/)
})

test('package-set tar reads stay local for both tar flavors and rejects upstream drift', () => {
  const original = "  const value: unknown = JSON.parse(capture('tar', ['-xOzf', tarball, 'package/package.json']))"
  const edited = STUDIO_PACKAGE_SET_TAR_EDIT.apply(original)
  assert.match(edited, /basename\(tarball\).*cwd: resolve\(tarball, '\.\.'\)/)
  assert.equal(STUDIO_PACKAGE_SET_TAR_EDIT.apply(edited), edited)
  assert.throws(() => STUDIO_PACKAGE_SET_TAR_EDIT.apply('drift'), /anchor/)
})

test('current source receipt detects stale bundles and omitted generated Remote outputs', async () => {
  const common = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' })
  assert.equal(common.status, 0)
  const root = await mkdtemp(path.join(path.dirname(common.stdout.trim()), '.local/build/dsh/.studio-payload-fixture-'))
  const repo = path.join(root, 'repo'), plugin = path.join(root, 'plugin')
  const put = async (base, filename, bytes) => { await mkdir(path.dirname(path.join(base, filename)), { recursive: true }); await writeFile(path.join(base, filename), bytes) }
  try {
    for (const filename of ['packages/studio-plugin/src/index.ts', 'packages/studio-plugin/build/config.ts', 'packages/contracts/src/index.ts', 'packages/studio-plugin/package.json', 'packages/contracts/package.json', 'packages/studio-plugin/cordis.patch.yml']) await put(repo, filename, 'current')
    const template = JSON.stringify({ files: [{ path: 'AGENT.md', sha256: createHash('sha256').update('rules').digest('hex') }], addedFiles: [] })
    await put(repo, 'packages/studio-plugin/assets/prototype-template.manifest.json', template)
    await put(plugin, 'assets/prototype-template.manifest.json', template)
    await put(plugin, 'assets/prototype-template/AGENT.md', 'rules')
    await put(plugin, 'package.json', JSON.stringify(productionPluginManifest({})))
    await put(plugin, 'cordis.patch.yml', 'patch')
    await put(plugin, 'lib/index.js', 'class StudioService {} function composeStudio() {} class StudioApplication {}')
    await put(plugin, 'lib/client.js', 'client')
    await assert.rejects(recordStudioBuild(plugin, repo), /typert.host.js/)
    await put(plugin, 'lib/typert.host.js', 'host remote')
    await put(plugin, 'lib/typert.remote-client.js', 'client remote')
    await put(plugin, 'lib/typert.remote-client.d.ts.map', 'development navigation only')
    await put(plugin, 'lib/typert.host.d.ts', 'development types only')
    await put(plugin, 'lib/types/host/index.d.ts', 'development types only')
    await put(plugin, 'lib/tsconfig.host.tsbuildinfo', 'not publishable')
    await recordStudioBuild(plugin, repo)
    await rm(path.join(plugin, 'lib/tsconfig.host.tsbuildinfo'))
    await rm(path.join(plugin, 'lib/typert.remote-client.d.ts.map'))
    await rm(path.join(plugin, 'lib/typert.host.d.ts'))
    await rm(path.join(plugin, 'lib/types/host/index.d.ts'))
    await verifyStudioPlugin(plugin, repo)
    await put(repo, 'packages/studio-plugin/src/index.ts', 'new source')
    await assert.rejects(verifyStudioPlugin(plugin, repo), /different product source/)
    await put(repo, 'packages/studio-plugin/src/index.ts', 'current')
    await put(plugin, 'lib/client.js', 'stale bundle')
    await assert.rejects(verifyStudioPlugin(plugin, repo), /lib\/client.js/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('old minimal Host is rejected even though both bundle filenames exist', () => {
  assert.throws(() => assertStudioHost('function apply() {}\nexport { apply };'), /complete Studio Host/)
  assert.throws(() => assertStudioHost('export function apply(ctx) { ctx.plugin(StudioService) }'), /complete Studio Host/)
  assert.doesNotThrow(() => assertStudioHost('class StudioService {} function composeStudio() {} class StudioApplication {} export { StudioService, apply };'))
})

test('contracts used by material validation belong to the production package closure', () => {
  const source = { name: '@eadp-studio/studio-plugin', files: ['lib/index.js'], devDependencies: { '@eadp/contracts': 'workspace:*' } }
  const manifest = productionPluginManifest(source)
  assert.equal(manifest.dependencies['@eadp/contracts'], 'workspace:*')
  assert.equal(manifest.devDependencies['@eadp/contracts'], undefined)
  assert.ok(manifest.files.includes('studio-build.json'))
  assert.equal(source.devDependencies['@eadp/contracts'], 'workspace:*')
})

test('runtime inventory rejects missing companion DLL and modified payload', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-tools-fixture-'))
  try {
    const digest = bytes => createHash('sha256').update(bytes).digest('hex')
    const files = ['node.exe', 'pnpm.mjs', 'git.exe', 'ssh.exe', 'git-runtime.dll']
    for (const filename of files) await writeFile(path.join(root, filename), filename)
    const tools = Object.fromEntries(['node', 'pnpm', 'git', 'ssh'].map((name, i) => [name, { path: files[i], sha256: digest(files[i]), version: 'fixed', source: 'https://example.test/tool', license: 'MIT' }]))
    const manifest = { schemaVersion: 1, platform: process.platform, arch: process.arch, tools, files: files.map(filename => ({ path: filename, bytes: Buffer.byteLength(filename), sha256: digest(filename) })) }
    await writeFile(path.join(root, 'runtime-manifest.json'), JSON.stringify(manifest))
    await verifyRuntimePayload(root)
    await rm(path.join(root, 'git-runtime.dll'))
    await assert.rejects(verifyRuntimePayload(root), /git-runtime.dll/)
    await writeFile(path.join(root, 'git-runtime.dll'), 'tampered')
    await assert.rejects(verifyRuntimePayload(root), /git-runtime.dll/)
    await writeFile(path.join(root, 'git-runtime.dll'), 'git-runtime.dll')
    await mkdir(path.join(root, 'extra'))
    await writeFile(path.join(root, 'extra', 'untracked.exe'), 'unexpected')
    await assert.rejects(verifyRuntimePayload(root), /untracked.exe/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
