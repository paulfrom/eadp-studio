import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { PrototypeBoundary, prototypeParts } from './boundary.ts'
interface TemplateFile { path: string; sha256: string }
interface TemplateManifest { schemaVersion: 1; version: string; files: TemplateFile[]; addedFiles: TemplateFile[]; contract: { node: string; packageManager: string } }
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/** Verify the complete asset inventory before copying any project bytes. */
async function verifiedTemplate(): Promise<{ root: string; files: TemplateFile[] }> {
  const assets = fileURLToPath(new URL('../assets/', import.meta.url))
  const root = await realpath(path.join(assets, 'prototype-template'))
  const manifest = JSON.parse(await readFile(path.join(assets, 'prototype-template.manifest.json'), 'utf8')) as TemplateManifest
  if (manifest.schemaVersion !== 1 || !manifest.version || !Array.isArray(manifest.files) || !Array.isArray(manifest.addedFiles) || manifest.contract?.node !== '22.22.3' || manifest.contract.packageManager !== 'pnpm@11.28.5') throw new Error('原型模板清单无效。')
  const files = [...manifest.files, ...manifest.addedFiles]
  const expected = new Set<string>()
  for (const entry of files) {
    prototypeParts(entry.path, false, true)
    if (expected.has(entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('原型模板文件清单无效。')
    expected.add(entry.path)
  }
  const actual = new Set<string>()
  const walk = async (directory: string, prefix: string): Promise<void> => {
    for (const child of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix + child.name
      if (child.isDirectory()) await walk(path.join(directory, child.name), relative + '/')
      else if (!child.isFile() || child.isSymbolicLink()) throw new Error('原型模板不允许链接或特殊文件。')
      else actual.add(relative)
    }
  }
  await walk(root, '')
  if (actual.size !== expected.size || [...actual].some(file => !expected.has(file))) throw new Error('原型模板实际文件与清单不同。')
  for (const entry of files) if (digest(await readFile(path.join(root, entry.path))) !== entry.sha256) throw new Error(`原型模板校验失败：${entry.path}`)
  return { root, files }
}

/** Empty destinations only; exclusive writes preserve any concurrent external edits. */
export async function createPrototype(ctx: Context, boundary: PrototypeBoundary, projectId: string): Promise<void> {
  const template = await verifiedTemplate()
  const target = await boundary.target(projectId, '')
  const destination = ctx.fs.processPath(target)
  const before = await ctx.fs.stat(target)
  if (before && (before.type !== 'directory' || (await readdir(destination)).length !== 0)) throw new RemoteError('eadp/prototype', '原型目录非空，未覆盖任何文件。', { code: 'PROJECT_NOT_EMPTY' })
  if (!before) await mkdir(destination)
  await boundary.directory(projectId)
  if ((await readdir(destination)).length !== 0) throw new RemoteError('eadp/prototype', '原型目录已被其他操作写入。', { code: 'PROJECT_NOT_EMPTY' })
  for (const entry of template.files) {
    const components = prototypeParts(entry.path, false, true)
    for (let index = 1; index < components.length; index++) {
      const relative = components.slice(0, index).join('/')
      const directory = ctx.fs.processPath(await boundary.target(projectId, relative, true))
      await mkdir(directory).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
      if (!(await lstat(directory)).isDirectory()) throw new Error('原型模板目标目录无效。')
      await boundary.target(projectId, relative, true)
    }
    const bytes = await readFile(path.join(template.root, entry.path))
    if (digest(bytes) !== entry.sha256) throw new Error('复制期间模板文件已变化。')
    const output = ctx.fs.processPath(await boundary.target(projectId, entry.path, true))
    await writeFile(output, bytes, { flag: 'wx' })
    await boundary.target(projectId, entry.path, true)
    if (digest(await readFile(output)) !== entry.sha256) throw new Error('复制后的原型文件校验失败。')
  }
}
