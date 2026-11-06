import { lstat } from 'node:fs/promises'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { PrototypeContent, PrototypeFileList } from '@eadp/contracts/prototype'
import { PrototypeBoundary, prototypeParts } from './boundary.ts'
const MAX_BYTES = 1024 * 1024

/** Read-only, single-directory file browsing with bounded text decoding. */
export class PrototypeFiles {
  constructor(private readonly ctx: Context, readonly boundary: PrototypeBoundary) {}
  async list(projectId: string, directory: string): Promise<PrototypeFileList> {
    const target = await this.boundary.target(projectId, directory)
    const info = await this.ctx.fs.stat(target)
    if (!info) return { entries: [], hiddenCount: 0, exists: false }
    if (info.type !== 'directory') throw new FsError('原型路径不是目录。', 'FS_NOT_DIRECTORY')
    const children = await this.ctx.fs.listDir(target)
    if (children.length > 5000) throw new FsError('目录文件过多，请缩小范围。', 'FS_TOO_LARGE')
    const result: PrototypeFileList = { entries: [], hiddenCount: 0, exists: true }
    for (const child of children) {
      const relativePath = directory ? directory + '/' + child.name : child.name
      try { prototypeParts(relativePath) } catch { result.hiddenCount++; continue }
      if (child.type !== 'directory' && child.type !== 'file') { result.hiddenCount++; continue }
      const raw = await this.ctx.fs.lstat('原型/' + relativePath, { cwd: await this.boundary.root(projectId) })
      if (!raw || raw.type === 'symlink' || raw.type === 'other') { result.hiddenCount++; continue }
      const resolved = await this.boundary.target(projectId, relativePath)
      const current = await this.ctx.fs.stat(resolved)
      if (!current || (current.type !== 'file' && current.type !== 'directory')) continue
      result.entries.push({ relativePath, name: child.name, type: current.type, ...(current.size === undefined ? {} : { size: current.size }) })
    }
    result.entries.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name, 'zh-CN', { numeric: true }) : a.type === 'directory' ? -1 : 1)
    return result
  }
  async read(projectId: string, relativePath: string): Promise<PrototypeContent> {
    prototypeParts(relativePath)
    const target = await this.boundary.target(projectId, relativePath)
    const before = await this.ctx.fs.stat(target)
    if (!before) throw new FsError('原型文件不存在。', 'FS_NOT_FOUND')
    if (before.type !== 'file') throw new FsError('只能查看普通文件。', 'FS_NOT_REGULAR_FILE')
    const size = before.size ?? (await lstat(this.ctx.fs.processPath(target))).size
    if (size > MAX_BYTES) return { relativePath, kind: 'too-large', size, truncated: false }
    const bytes = await this.ctx.fs.readBytes(target, undefined, MAX_BYTES)
    await this.boundary.target(projectId, relativePath)
    if ((await this.ctx.fs.stat(target))?.version !== before.version) throw new FsError('读取期间文件已变化，请刷新。', 'FS_STALE_VERSION')
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      if (text.includes('\0')) return { relativePath, kind: 'binary', size, truncated: false }
    } catch { return { relativePath, kind: 'binary', size, truncated: false } }
    return { relativePath, kind: 'text', text, size, truncated: false }
  }
  async runnable(projectId: string, requireDependencies: boolean): Promise<string> {
    const directory = await this.boundary.directory(projectId)
    const content = await this.read(projectId, 'package.json')
    if (content.kind !== 'text') throw new Error('原型 package.json 无效。')
    const manifest = JSON.parse(content.text) as { scripts?: { start?: unknown }; packageManager?: unknown }
    if (typeof manifest.scripts?.start !== 'string' || !manifest.scripts.start.trim() || manifest.packageManager !== 'pnpm@11.28.5') throw new Error('原型工程需要 start 脚本及固定 pnpm@11.28.5。')
    if ((await this.ctx.fs.stat(await this.boundary.target(projectId, 'pnpm-lock.yaml')))?.type !== 'file') throw new Error('原型缺少 pnpm-lock.yaml。')
    if (requireDependencies) {
      const info = await this.ctx.fs.lstat('node_modules', { cwd: directory })
      if (info?.type !== 'directory') throw new RemoteError('eadp/prototype', '原型依赖不存在或目录包含链接，请先安装依赖。', { code: 'DEPENDENCIES_MISSING' })
      const root = await this.boundary.target(projectId, '')
      const dependencies = await this.ctx.fs.resolve('node_modules', { cwd: directory })
      if (!this.ctx.fs.contains(root, dependencies) || this.ctx.fs.processPath(dependencies) !== path.join(directory, 'node_modules')) throw new RemoteError('eadp/prototype', '原型依赖目录越界。', { code: 'DEPENDENCIES_MISSING' })
    }
    return directory
  }
}
