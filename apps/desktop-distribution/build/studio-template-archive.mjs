/** Preserve exact template filenames across npm's publication filtering. */
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, readFile, readdir, lstat, rename, rm } from 'node:fs/promises'
import path from 'node:path'

export const TEMPLATE_ARCHIVE = 'assets/prototype-template.tar.gz'
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const relativePath = filename => {
  if (typeof filename !== 'string' || !filename || /[\\:*?\[\]\r\n]/.test(filename)
    || path.posix.isAbsolute(filename) || filename.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid template archive path.')
  return filename
}
// This module runs only in the prepared DSH build tree, whose fixed lockfile
// already supplies tar. It is never a runtime dependency of the plugin.
const archiveTools = pluginRoot => createRequire(path.join(pluginRoot, 'package.json'))('tar')
async function entries(pluginRoot) {
  const manifest = JSON.parse(await readFile(path.join(pluginRoot, 'assets/prototype-template.manifest.json'), 'utf8'))
  const files = [...manifest.files, ...manifest.addedFiles]
  const seen = new Set()
  for (const file of files) {
    relativePath(file.path)
    if (seen.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid template archive manifest.')
    seen.add(file.path)
  }
  if (!files.length) throw new Error('Empty template archive manifest.')
  return files
}
async function verifyTree(root, files) {
  const expected = new Set(files.map(file => file.path))
  const visit = async (relative = '') => {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      const filename = path.posix.join(relative, entry.name)
      if (entry.isDirectory()) await visit(filename)
      else if (!entry.isFile() || !expected.has(filename)) throw new Error(`Unexpected template archive entry: ${filename}`)
    }
  }
  await visit()
  for (const file of files) {
    const filename = path.join(root, file.path)
    if (!(await lstat(filename)).isFile() || digest(await readFile(filename)) !== file.sha256) throw new Error(`Template archive integrity mismatch: ${file.path}`)
  }
}

export async function createStudioTemplateArchive(pluginRoot) {
  const files = await entries(pluginRoot)
  const source = path.join(pluginRoot, 'assets/prototype-template')
  for (const file of files) {
    const filename = path.join(source, file.path)
    if (!(await lstat(filename)).isFile() || digest(await readFile(filename)) !== file.sha256) throw new Error(`Template archive source mismatch: ${file.path}`)
  }
  await archiveTools(pluginRoot).create({ file: path.join(pluginRoot, TEMPLATE_ARCHIVE), cwd: source, gzip: true, portable: true, noMtime: true }, files.map(file => file.path))
}

/** Build-time only: run after production installation and before runtime descriptors. */
export async function materializeStudioTemplate(pluginRoot) {
  const archive = path.join(pluginRoot, TEMPLATE_ARCHIVE)
  const bytes = await readFile(archive)
  const receipt = JSON.parse(await readFile(path.join(pluginRoot, 'studio-build.json'), 'utf8'))
  const record = receipt.files?.find(file => file.path === TEMPLATE_ARCHIVE)
  if (!record || bytes.length !== record.bytes || digest(bytes) !== record.sha256) throw new Error('Template archive receipt mismatch.')
  const files = await entries(pluginRoot)
  const expected = new Set(files.map(file => file.path)), seen = new Set()
  let invalid
  const tar = archiveTools(pluginRoot)
  await tar.list({ file: archive, strict: true, onentry(entry) {
    if (entry.type !== 'File' || entry.linkpath || !expected.has(entry.path) || seen.has(entry.path)) invalid = `Unexpected template archive member: ${entry.path}`
    seen.add(entry.path)
  } })
  if (invalid || seen.size !== expected.size) throw new Error(invalid ?? 'Template archive members differ from the manifest.')
  const destination = path.join(pluginRoot, 'assets/prototype-template')
  const temporary = `${destination}.materializing`
  await rm(temporary, { recursive: true, force: true })
  await mkdir(temporary, { recursive: true })
  try {
    await tar.extract({ file: archive, cwd: temporary, strict: true, preservePaths: false })
    await verifyTree(temporary, files)
    await rm(destination, { recursive: true, force: true })
    await rename(temporary, destination)
  } finally { await rm(temporary, { recursive: true, force: true }) }
}
