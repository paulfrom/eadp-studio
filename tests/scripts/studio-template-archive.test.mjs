import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, link } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { createStudioTemplateArchive, materializeStudioTemplate, TEMPLATE_ARCHIVE } from '../../apps/desktop-distribution/build/studio-template-archive.mjs'
import { STUDIO_TEMPLATE_EDIT } from '../../apps/desktop-distribution/build/studio-template-edits.mjs'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const common = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', cwd: path.resolve(import.meta.dirname, '../..') })
if (common.status !== 0) throw new Error('Cannot locate the fixed package-manager runtime.')
const primary = path.dirname(common.stdout.trim())

test('real pnpm pack preserves original ignored template filenames through its declared archive asset', async () => {
  const root = await mkdtemp(path.join(primary, '.local/build/dsh/.studio-template-pack-'))
  const plugin = path.join(root, 'plugin'), output = path.join(root, 'packed'), extracted = path.join(root, 'extracted')
  const files = [{ path: '.gitignore', bytes: 'node_modules\ndist\n' }, { path: '.npmrc', bytes: 'save-exact=true\n' }, { path: '中文 空格.md', bytes: '模板规则\n' }]
  try {
    await mkdir(path.join(plugin, 'assets/prototype-template/node_modules'), { recursive: true })
    for (const file of files) await writeFile(path.join(plugin, 'assets/prototype-template', file.path), file.bytes)
    await writeFile(path.join(plugin, 'assets/prototype-template/node_modules/local-cache'), 'must not ship')
    await writeFile(path.join(plugin, 'assets/prototype-template.manifest.json'), JSON.stringify({ files: files.map(file => ({ path: file.path, sha256: digest(file.bytes) })), addedFiles: [] }))
    await writeFile(path.join(plugin, 'package.json'), JSON.stringify({ name: '@fixture/template-assets', version: '0.0.0', files: [TEMPLATE_ARCHIVE, 'assets/prototype-template.manifest.json', 'studio-build.json'] }))
    await createStudioTemplateArchive(plugin)
    const archive = await readFile(path.join(plugin, TEMPLATE_ARCHIVE))
    await writeFile(path.join(plugin, 'studio-build.json'), JSON.stringify({ schemaVersion: 1, files: [{ path: TEMPLATE_ARCHIVE, bytes: archive.length, sha256: digest(archive) }] }))
    const packed = spawnSync(process.execPath, [path.join(primary, '.local/build/dsh/node_modules/pnpm/bin/pnpm.mjs'), '--dir', plugin, 'pack', '--pack-destination', output], { encoding: 'utf8', windowsHide: true })
    assert.equal(packed.status, 0, packed.stdout + packed.stderr)
    const tarball = (await readdir(output)).find(file => file.endsWith('.tgz'))
    await mkdir(extracted)
    const unpacked = spawnSync('tar', ['-xzf', path.join(output, tarball), '-C', extracted], { encoding: 'utf8', windowsHide: true })
    assert.equal(unpacked.status, 0, unpacked.stderr)
    const installed = path.join(extracted, 'package')
    await assert.rejects(readFile(path.join(installed, 'assets/prototype-template/.gitignore')), /ENOENT/)
    await materializeStudioTemplate(installed)
    for (const file of files) assert.equal(await readFile(path.join(installed, 'assets/prototype-template', file.path), 'utf8'), file.bytes)
    assert.deepEqual((await readdir(path.join(installed, 'assets/prototype-template'))).sort(), files.map(file => file.path).sort())
    const tar = createRequire(path.join(installed, 'package.json'))('tar')
    const updateArchiveReceipt = async () => {
      const bytes = await readFile(path.join(installed, TEMPLATE_ARCHIVE))
      await writeFile(path.join(installed, 'studio-build.json'), JSON.stringify({ schemaVersion: 1, files: [{ path: TEMPLATE_ARCHIVE, bytes: bytes.length, sha256: digest(bytes) }] }))
    }
    const template = path.join(installed, 'assets/prototype-template')
    await writeFile(path.join(template, 'extra'), 'extra')
    await tar.create({ cwd: template, file: path.join(installed, TEMPLATE_ARCHIVE), gzip: true }, [...files.map(file => file.path), 'extra'])
    await updateArchiveReceipt()
    await assert.rejects(materializeStudioTemplate(installed), /Unexpected template archive member: extra/)
    await tar.create({ cwd: template, file: path.join(installed, TEMPLATE_ARCHIVE), gzip: true, prefix: '../' }, files.map(file => file.path))
    await updateArchiveReceipt()
    await assert.rejects(materializeStudioTemplate(installed), /Unexpected template archive member/)
    await rm(path.join(template, '.npmrc'))
    await link(path.join(template, '.gitignore'), path.join(template, '.npmrc'))
    await tar.create({ cwd: template, file: path.join(installed, TEMPLATE_ARCHIVE), gzip: true }, files.map(file => file.path))
    await updateArchiveReceipt()
    await assert.rejects(materializeStudioTemplate(installed), /Unexpected template archive member: .npmrc/)
    await writeFile(path.join(installed, TEMPLATE_ARCHIVE), 'tampered')
    await assert.rejects(materializeStudioTemplate(installed), /receipt mismatch/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('official preparation materializes assets before descriptors with exact anchors', async () => {
  const source = await readFile(path.join(primary, '.local/upstream/dsh', STUDIO_TEMPLATE_EDIT.file), 'utf8')
  const edited = STUDIO_TEMPLATE_EDIT.apply(source)
  assert.ok(edited.indexOf("'prepare:studio-template'") < edited.indexOf("'runtime:manifests'"))
  assert.equal(STUDIO_TEMPLATE_EDIT.apply(edited), edited)
  assert.throws(() => STUDIO_TEMPLATE_EDIT.apply('drift'), /anchor/)
  assert.throws(() => STUDIO_TEMPLATE_EDIT.apply(source + source), /anchor/)
})
