import { lstat, mkdir, realpath, rename, rmdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsTarget, FsVersion } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-workspace'
import type { RequirementDocument, RequirementEntry } from '@eadp/contracts/files'

class FileBoundaryError extends Error {
  constructor(message: string, readonly code: 'INVALID_PATH' | 'PROJECT_NOT_FOUND') { super(message) }
}

const MAX_BYTES = 2 * 1024 * 1024
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu
const SENSITIVE = /^(?:\.env(?:\..*)?|\.git|node_modules|dist|\.umi.*)$|\.(?:pem|key|pfx|p12)$/iu

/** Reject ambiguous names before resolving them against the Workspace. */
function parts(relativePath: string): string[] {
  if (typeof relativePath !== 'string' || relativePath.length > 1024 || relativePath.includes('\\')) throw new FileBoundaryError('文件路径无效。', 'INVALID_PATH')
  const value = relativePath.split('/')
  if (value.some(name => !name || name === '.' || name === '..' || name.length > 120 || name.startsWith('.') || /[<>:"|?*\x00-\x1f]/u.test(name) || /[ .]$/u.test(name) || RESERVED.test(name) || SENSITIVE.test(name))) {
    throw new FileBoundaryError('文件名包含保留名称、敏感路径或非法字符。', 'INVALID_PATH')
  }
  return value
}
function requirementPath(relativePath: string, directory: boolean): void {
  const value = parts(relativePath)
  if (value[0] !== '需求' || (!directory && (value.length < 2 || !relativePath.toLowerCase().endsWith('.md')))) throw new FileBoundaryError('只允许操作需求目录中的 Markdown 文件。', 'INVALID_PATH')
}
function textLimit(text: string): void {
  if (typeof text !== 'string' || text.includes('\0')) throw new FsError('需求正文必须是纯文本。', 'FS_NOT_TEXT')
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new FsError('需求正文超过 2 MiB。', 'FS_TOO_LARGE')
}

/** File authority comes from a freshly resolved native Workspace for each operation. */
export class RequirementFiles {
  private readonly writes = new Map<string, Promise<unknown>>()
  constructor(private readonly ctx: Context) {}

  /** Serializes this module's mutations; external processes still require version checks. */
  async mutate<T>(projectId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.writes.get(projectId) ?? Promise.resolve()
    const operation = previous.catch(() => undefined).then(action)
    this.writes.set(projectId, operation)
    try { return await operation } finally { if (this.writes.get(projectId) === operation) this.writes.delete(projectId) }
  }

  async root(projectId: string): Promise<string> {
    const workspace = this.ctx.workspaceRegistry.get(WorkspaceId(projectId))
    if (!workspace) throw new FileBoundaryError('项目登记不存在。', 'PROJECT_NOT_FOUND')
    const canonical = await realpath(workspace.path)
    if (canonical !== workspace.path) throw new FsError('项目目录已变化，请重新打开。', 'FS_SANDBOX_DENIED')
    if (!(await lstat(canonical)).isDirectory()) throw new FsError('项目目录不可访问。', 'FS_NOT_DIRECTORY')
    return canonical
  }

  /** Rejects linked path components before ctx.fs canonical containment checks. */
  async target(root: string, relativePath: string): Promise<FsTarget> {
    const names = parts(relativePath)
    let current = root
    for (const name of names) {
      current = path.join(current, name)
      try { if ((await lstat(current)).isSymbolicLink()) throw new FsError('需求路径不允许符号链接。', 'FS_SANDBOX_DENIED') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    const parent = await this.ctx.fs.resolve(root)
    const target = await this.ctx.fs.resolve(relativePath, { cwd: root })
    if (!this.ctx.fs.contains(parent, target)) throw new FsError('文件路径超出当前项目。', 'FS_SANDBOX_DENIED')
    return target
  }

  async list(projectId: string): Promise<RequirementEntry[]> {
    const root = await this.root(projectId)
    const entries: RequirementEntry[] = []
    const walk = async (relativePath: string, depth: number): Promise<void> => {
      if (depth > 16 || entries.length > 2000) throw new FsError('需求目录超出扫描限额。', 'FS_TOO_LARGE')
      const target = await this.target(root, relativePath)
      const info = await this.ctx.fs.stat(target)
      if (!info) return
      if (info.type !== 'directory') throw new FsError('需求路径不是目录。', 'FS_NOT_DIRECTORY')
      const children = await this.ctx.fs.listDir(target)
      for (const child of children) {
        const next = relativePath + '/' + child.name
        try { parts(next) } catch { continue }
        if (child.type !== 'directory' && (child.type !== 'file' || !child.name.toLowerCase().endsWith('.md'))) continue
        // Listing does not follow project-owned links, including links into the same project.
        const raw = await lstat(path.join(root, next))
        if (raw.isSymbolicLink()) continue
        await this.target(root, next)
        entries.push({ relativePath: next, name: child.name, type: child.type, ...(child.size === undefined ? {} : { size: child.size }) })
        if (child.type === 'directory') await walk(next, depth + 1)
        if (entries.length > 2000) throw new FsError('需求目录超出扫描限额。', 'FS_TOO_LARGE')
      }
    }
    await walk('需求', 0)
    return entries.sort((a, b) => a.type === b.type ? a.relativePath.localeCompare(b.relativePath, 'zh-CN', { numeric: true }) : a.type === 'directory' ? -1 : 1)
  }

  async read(projectId: string, relativePath: string, context = false): Promise<RequirementDocument> {
    if (context) {
      if (relativePath !== 'CONTEXT.md') throw new FileBoundaryError('项目背景路径无效。', 'INVALID_PATH')
    } else requirementPath(relativePath, false)
    const target = await this.target(await this.root(projectId), relativePath)
    const before = await this.ctx.fs.stat(target)
    if (!before) throw new FsError('文件不存在。', 'FS_NOT_FOUND')
    if (before.type !== 'file') throw new FsError('不能编辑非普通文件。', 'FS_NOT_REGULAR_FILE')
    if (before.size === undefined || before.size > MAX_BYTES) throw new FsError('文件超过编辑大小上限。', 'FS_TOO_LARGE')
    const text = await this.ctx.fs.readText(target)
    textLimit(text)
    const after = await this.ctx.fs.stat(target)
    if (after?.version !== before.version) throw new FsError('读取期间文件已变化，请重试。', 'FS_STALE_VERSION')
    return { relativePath, text, version: before.version }
  }

  async write(projectId: string, relativePath: string, text: string, expectedVersion: string | null, context = false): Promise<RequirementDocument> {
    if (context) {
      if (relativePath !== 'CONTEXT.md') throw new FileBoundaryError('项目背景路径无效。', 'INVALID_PATH')
    } else requirementPath(relativePath, false)
    textLimit(text)
    if (expectedVersion !== null && (typeof expectedVersion !== 'string' || !expectedVersion)) throw new FsError('缺少保存版本。', 'FS_NOT_OBSERVED')
    const root = await this.root(projectId)
    if (expectedVersion === null && !context) await this.ensureRequirementParent(root, relativePath)
    const target = await this.target(root, relativePath)
    const result = await this.ctx.fs.writeText(target, text, expectedVersion === null ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version: expectedVersion as FsVersion }, undefined, { mode: 'workspace-write', workspaceRoot: root })
    return { relativePath, text: result.after, version: result.version }
  }

  /** Lazily create only the requirement root; nested parents must already exist. */
  private async ensureRequirementParent(root: string, relativePath: string): Promise<void> {
    const parentPath = path.posix.dirname(relativePath)
    const parent = await this.target(root, parentPath)
    const info = await this.ctx.fs.stat(parent)
    if (info) {
      if (info.type !== 'directory') throw new FsError('上级路径不是目录。', 'FS_NOT_DIRECTORY')
      return
    }
    if (parentPath !== '需求') throw new FsError('上级需求目录不存在。', 'FS_NOT_FOUND')
    await mkdir(path.join(root, '需求'))
    await this.target(root, '需求')
  }

  async makeDirectory(projectId: string, relativePath: string): Promise<void> {
    requirementPath(relativePath, true)
    const root = await this.root(projectId)
    const target = await this.target(root, relativePath)
    if (await this.ctx.fs.stat(target)) throw new FsError('目录已存在。', 'FS_NOT_OBSERVED')
    if (relativePath !== '需求') await this.ensureRequirementParent(root, relativePath)
    await mkdir(path.join(root, relativePath))
    await this.target(await this.root(projectId), relativePath)
  }

  async rename(projectId: string, relativePath: string, newRelativePath: string): Promise<void> {
    requirementPath(relativePath, false); requirementPath(newRelativePath, false)
    const root = await this.root(projectId)
    const from = await this.target(root, relativePath), to = await this.target(root, newRelativePath)
    if ((await this.ctx.fs.stat(from))?.type !== 'file') throw new FsError('要改名的文件不存在。', 'FS_NOT_FOUND')
    if (await this.ctx.fs.stat(to)) throw new FsError('目标文件已存在。', 'FS_NOT_OBSERVED')
    await rename(this.ctx.fs.processPath(from), this.ctx.fs.processPath(to))
    await this.target(await this.root(projectId), newRelativePath)
  }

  async remove(projectId: string, relativePath: string): Promise<void> {
    requirementPath(relativePath, true)
    if (relativePath === '需求') throw new FsError('不能删除需求根目录。', 'FS_SANDBOX_DENIED')
    const root = await this.root(projectId), target = await this.target(root, relativePath)
    const info = await this.ctx.fs.stat(target)
    if (!info) throw new FsError('文件不存在。', 'FS_NOT_FOUND')
    if (info.type === 'directory') await rmdir(this.ctx.fs.processPath(target))
    else { requirementPath(relativePath, false); await unlink(this.ctx.fs.processPath(target)) }
    await this.target(await this.root(projectId), path.posix.dirname(relativePath))
  }

  async statVersion(projectId: string, relativePath: string): Promise<string | null> {
    if (relativePath !== 'CONTEXT.md') requirementPath(relativePath, false)
    return (await this.ctx.fs.stat(await this.target(await this.root(projectId), relativePath)))?.version ?? null
  }
}
