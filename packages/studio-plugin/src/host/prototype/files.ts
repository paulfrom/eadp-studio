import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import type { PrototypeFileCommand, PrototypeFileResult, PrototypeFileSource } from '../../shared/prototype.ts'
import { readTemplateManifest } from './template.ts'
import { withPathWriteLock } from '../adapters/platform/path-write-lock.ts'

const MAX_BYTES = 1024 * 1024
const MAX_FILES = 5000
const MAX_HASH_FILE_BYTES = 16 * 1024 * 1024
const MAX_SCAN_BYTES = 64 * 1024 * 1024
const MAX_SCAN_MS = 5000
const MAX_RANGE_LINES = 2000
const ignored = new Set(['.git', 'node_modules', 'dist', '.umi', '.umi-production', 'coverage', '.cache'])
const secret = /(^|\/)(?:\.env(?:\..*)?|\.npmrc\.local|\.DS_Store)$|\.(?:pem|key|pfx|p12|log)$/i
type FileCommand = Extract<PrototypeFileCommand, { action: 'listPrototypeDirectory' | 'searchPrototypeFiles' | 'readPrototypeFile' }>
interface Entry { path: string; name: string; kind: 'file' | 'directory'; readOnly: boolean; size: number; mtimeMs: number; hash?: string }
interface Snapshot { observation: string; entries: Entry[]; truncated: boolean; truncationReason?: string }
class ScanDeadline extends Error {}
export interface PrototypeFileWorkspace { source: PrototypeFileSource; root: string; manifestPath: string; writablePaths: readonly string[] }

function normalize(value: string, allowEmpty = false): string {
  if (allowEmpty && !value) return ''
  if (!value || path.isAbsolute(value) || value.includes('\\') || value.includes('\0') || value.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('原型文件路径无效')
  return value
}
function visible(relative: string): boolean {
  return !relative.split('/').some(part => ignored.has(part) || part.startsWith('.umi')) && (!secret.test(relative) || relative.endsWith('.env.example'))
}
function writable(relative: string, prefixes: readonly string[], protectedPaths: readonly string[]): boolean {
  return !protectedPaths.some(item => relative === item || relative.startsWith(`${item}/`)) && prefixes.some(item => item.endsWith('/') ? relative.startsWith(item) : relative === item)
}
async function contained(root: string, relative: string): Promise<string> {
  const parts = normalize(relative).split('/')
  let current = root
  for (const part of parts) {
    current = path.join(current, part)
    if ((await lstat(current)).isSymbolicLink()) throw new Error('原型文件不能通过符号链接访问')
  }
  const actual = await realpath(current), rel = path.relative(root, actual)
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error('原型文件不在工程目录中')
  return actual
}
function cursorOffset(cursor: string | undefined, observation: string, query: string): number {
  if (!cursor) return 0
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { observation: string; query: string; offset: number }
    if (value.observation !== observation || value.query !== query || !Number.isSafeInteger(value.offset) || value.offset < 0) throw new Error()
    return value.offset
  } catch { throw new Error('工程或查询已变化，请重新读取文件列表') }
}
function page<T>(all: T[], offset: number, size: number, observation: string, query: string, incomplete: boolean): { values: T[]; truncated: boolean; nextCursor?: string } {
  const values = all.slice(offset, offset + size), next = offset + values.length
  return { values, truncated: incomplete || next < all.length, ...(!incomplete && next < all.length ? { nextCursor: Buffer.from(JSON.stringify({ observation, query, offset: next })).toString('base64url') } : {}) }
}
function limit(value: number | undefined, maximum: number): number {
  return value === undefined ? maximum : Math.max(1, Math.min(maximum, Math.floor(value) || 1))
}

/** Resolves only a Host-registered workspace; clients never supply a filesystem root. */
export class PrototypeFiles {
  private async snapshot(workspace: PrototypeFileWorkspace, directory = '', recursive = true): Promise<Snapshot> {
    const root = await realpath(workspace.root), manifest = await readTemplateManifest(workspace.manifestPath), entries: Entry[] = []
    const deadline = Date.now() + MAX_SCAN_MS
    let truncationReason: string | undefined, scannedBytes = 0
    const walk = async (directory: string): Promise<void> => {
      if (Date.now() > deadline) { truncationReason ??= '工程扫描时间已达上限'; return }
      const actual = directory ? await contained(root, directory) : root
      for (const entry of (await readdir(actual, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (Date.now() > deadline) { truncationReason ??= '工程扫描时间已达上限'; return }
        const relative = directory ? `${directory}/${entry.name}` : entry.name
        if (!visible(relative) || entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) continue
        if (entries.length >= MAX_FILES) { truncationReason ??= '工程文件数量已达上限'; return }
        const info = await lstat(await contained(root, relative))
        if ((entry.isFile() && !info.isFile()) || (entry.isDirectory() && !info.isDirectory())) throw new Error('工程在扫描期间发生变化，请重新读取')
        let hash: string | undefined
        if (entry.isFile()) {
          if (info.size > MAX_HASH_FILE_BYTES || scannedBytes + info.size > MAX_SCAN_BYTES) {
            truncationReason ??= '工程内容超过扫描上限，分页观察不完整'
          } else {
            try {
              hash = await this.hashFile(root, relative, info.size, deadline)
              scannedBytes += info.size
            } catch (error) {
              if (!(error instanceof ScanDeadline)) throw error
              truncationReason ??= '工程扫描时间已达上限'
            }
          }
        }
        entries.push({ path: relative, name: entry.name, kind: entry.isDirectory() ? 'directory' : 'file', readOnly: !writable(relative, workspace.writablePaths, manifest.contract.protectedPaths), size: info.size, mtimeMs: info.mtimeMs, ...(hash ? { hash } : {}) })
        if (entry.isDirectory() && recursive) await walk(relative)
        if (entries.length >= MAX_FILES) { truncationReason ??= '工程文件数量已达上限'; return }
        if (Date.now() > deadline) { truncationReason ??= '工程扫描时间已达上限'; return }
      }
    }
    if (directory && !visible(directory)) throw new Error('目录不存在或不可读取')
    await walk(directory)
    // An incomplete scan cannot safely bind a later page to the same engineering state.
    const observation = createHash('sha256').update(JSON.stringify(entries)).update(truncationReason ? randomUUID() : '').digest('hex')
    return { observation, entries, truncated: !!truncationReason, ...(truncationReason ? { truncationReason } : {}) }
  }

  /** Open the selected file without following a final symlink and recheck the opened object. */
  private async openFile(root: string, relative: string) {
    const actual = await contained(root, relative)
    const file = await open(actual, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const info = await file.stat(), current = await lstat(await contained(root, relative))
      if (!info.isFile() || !current.isFile() || info.dev !== current.dev || info.ino !== current.ino) throw new Error('工程文件在打开期间发生变化')
      return { file, info }
    } catch (error) { await file.close(); throw error }
  }

  private async hashFile(root: string, relative: string, size: number, deadline: number): Promise<string> {
    const { file, info } = await this.openFile(root, relative)
    try {
      if (info.size !== size) throw new Error('工程文件在扫描期间发生变化')
      const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024)
      let position = 0
      while (position < info.size) {
        if (Date.now() > deadline) throw new ScanDeadline()
        const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, info.size - position), position)
        if (!bytesRead) throw new Error('工程文件在扫描期间发生变化')
        hash.update(buffer.subarray(0, bytesRead)); position += bytesRead
      }
      const after = await file.stat(), current = await lstat(await contained(root, relative))
      if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs || current.dev !== info.dev || current.ino !== info.ino) throw new Error('工程文件在扫描期间发生变化')
      return hash.digest('hex')
    } finally { await file.close() }
  }

  async read(workspace: PrototypeFileWorkspace, command: FileCommand): Promise<PrototypeFileResult> {
    const source = workspace.source, requested = command.source
    if (source.kind !== requested.kind || source.projectId !== requested.projectId ||
        (source.kind === 'task' && requested.kind === 'task' && source.prototypeTaskId !== requested.prototypeTaskId) ||
        (source.kind === 'baseline' && requested.kind === 'baseline' && (source.baselineId !== requested.baselineId || source.commitSha !== requested.commitSha))) throw new Error('工程来源与读取请求不一致')
    const directory = command.action === 'readPrototypeFile' ? normalize(command.path).split('/').slice(0, -1).join('/') : normalize(command.directory ?? '', true)
    const recursive = command.action === 'searchPrototypeFiles'
    const snapshot = await this.snapshot(workspace, directory, recursive), identity = { source: workspace.source }
    const root = await realpath(workspace.root)
    if (command.action === 'listPrototypeDirectory') {
      const query = `directory:${directory}`
      const prefix = directory ? `${directory}/` : ''
      const entries = snapshot.entries.filter(entry => entry.path.startsWith(prefix) && !entry.path.slice(prefix.length).includes('/')).map(({ path, name, kind, readOnly }) => ({ path, name, kind, readOnly }))
      const result = page(entries, cursorOffset(command.cursor, snapshot.observation, query), limit(command.limit, 200), snapshot.observation, query, snapshot.truncated)
      if (!snapshot.truncated && (await this.snapshot(workspace, directory, recursive)).observation !== snapshot.observation) throw new Error('工程已变化，请重新读取目录')
      return { kind: 'directory', ...identity, observation: snapshot.observation, entries: result.values, truncated: result.truncated, ...(snapshot.truncationReason ? { truncationReason: snapshot.truncationReason } : {}), ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) }
    }
    if (command.action === 'readPrototypeFile') {
      const relative = normalize(command.path), entry = snapshot.entries.find(item => item.path === relative && item.kind === 'file')
      if (!entry) throw new Error(snapshot.truncated ? '工程扫描不完整，无法确定文件是否存在' : '文件不存在或不可读取')
      if (command.lineRange) return this.readRange(root, relative, entry, identity, snapshot.observation, command.lineRange)
      if (entry.size > MAX_BYTES) return { kind: 'file', ...identity, observation: snapshot.observation, path: relative, ...(entry.hash ? { hash: entry.hash } : {}), size: entry.size, readOnly: true, binary: null, truncated: true, truncationReason: '文件超过 1 MiB，请按行范围读取。' }
      const bytes = await this.readBytes(root, relative, entry.size)
      const hash = createHash('sha256').update(bytes).digest('hex')
      if (entry.hash && hash !== entry.hash) throw new Error('工程文件已变化，请重新读取')
      const binary = bytes.includes(0) || !Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)
      return { kind: 'file', ...identity, observation: snapshot.observation, path: relative, hash, size: entry.size, readOnly: entry.readOnly, binary, truncated: false, ...(!binary ? { content: bytes.toString('utf8') } : {}) }
    }
    const query = command.query.trim()
    if (!query || query.length > 200) throw new Error('搜索文字须为 1 至 200 个字符')
    const cursorQuery = `search:${directory}:${query}`, matches: Array<{ path: string; line: number; column: number; excerpt: string; hash: string }> = []
    const deadline = Date.now() + MAX_SCAN_MS
    let searchReason = snapshot.truncationReason
    for (const entry of snapshot.entries) {
      if (entry.kind !== 'file' || (directory && !entry.path.startsWith(`${directory}/`))) continue
      if (Date.now() > deadline) { searchReason ??= '搜索时间已达上限'; break }
      if (entry.size > MAX_BYTES) { searchReason ??= '搜索跳过超过 1 MiB 的文件'; continue }
      const bytes = await this.readBytes(root, entry.path, entry.size)
      if (entry.hash && createHash('sha256').update(bytes).digest('hex') !== entry.hash) throw new Error('工程文件已变化，请重新搜索')
      if (bytes.includes(0) || !Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) continue
      const hash = createHash('sha256').update(bytes).digest('hex')
      for (const [index, line] of bytes.toString('utf8').split('\n').entries()) {
        let from = 0, column: number
        while ((column = line.indexOf(query, from)) !== -1) {
          matches.push({ path: entry.path, line: index + 1, column: column + 1, excerpt: line.slice(Math.max(0, column - 120), column + query.length + 120), hash })
          from = column + query.length
          if (matches.length >= 10000) { searchReason ??= '搜索匹配数量已达上限'; break }
        }
        if (matches.length >= 10000) break
      }
      if (matches.length >= 10000) break
    }
    const result = page(matches, cursorOffset(command.cursor, snapshot.observation, cursorQuery), limit(command.limit, 100), snapshot.observation, cursorQuery, !!searchReason)
    if (!snapshot.truncated && (await this.snapshot(workspace, directory, recursive)).observation !== snapshot.observation) throw new Error('工程已变化，请重新搜索')
    return { kind: 'search', ...identity, observation: snapshot.observation, matches: result.values, truncated: result.truncated, ...(searchReason ? { truncationReason: searchReason } : {}), ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) }
  }

  /** Compare only visible prototype paths against the task's Host-selected Git base. */
  async diff(workspace: PrototypeFileWorkspace, baseSha: string, changes: Array<{ path: string; status: 'added' | 'modified' | 'deleted' }>, readBase: (path: string) => Promise<Buffer | undefined>, command: Extract<PrototypeFileCommand, { action: 'readPrototypeDiff' }>): Promise<PrototypeFileResult> {
    const snapshot = await this.snapshot(workspace), root = await realpath(workspace.root)
    const filtered = changes.filter(change => { try { return visible(normalize(change.path)) } catch { return false } })
    const query = `diff:${baseSha}`, offset = cursorOffset(command.cursor, snapshot.observation, query)
    const selected = page(filtered, offset, limit(command.limit, 100), snapshot.observation, query, snapshot.truncated)
    const files: Extract<PrototypeFileResult, { kind: 'diff' }>['files'] = []
    let remainingBytes = MAX_BYTES, remainingLines = 2000, incomplete = false
    for (const change of selected.values) {
      const entry = snapshot.entries.find(value => value.kind === 'file' && value.path === change.path)
      let base: Buffer | undefined, current: Buffer | undefined, missing = false
      try { base = await readBase(change.path) } catch { missing = true }
      if (entry) { try { current = await this.readBytes(root, change.path, entry.size) } catch { missing = true } }
      else if (change.status !== 'deleted') missing = true
      const binary = [base, current].some(bytes => !!bytes && (bytes.includes(0) || !Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)))
      const file: Extract<PrototypeFileResult, { kind: 'diff' }>['files'][number] = { path: change.path, status: change.status, binary, truncated: missing,
        ...(base ? { baseHash: createHash('sha256').update(base).digest('hex') } : {}), ...(current ? { currentHash: createHash('sha256').update(current).digest('hex') } : {}) }
      const include = (bytes: Buffer | undefined): string | undefined => {
        if (!bytes || binary) return undefined
        const text = bytes.toString('utf8'), lines = text.split('\n')
        if (bytes.length > remainingBytes || lines.length > remainingLines) { file.truncated = true; return undefined }
        remainingBytes -= bytes.length; remainingLines -= lines.length
        return text
      }
      const baseContent = include(base), currentContent = include(current)
      if (baseContent !== undefined) file.baseContent = baseContent
      if (currentContent !== undefined) file.currentContent = currentContent
      if (file.truncated) incomplete = true
      files.push(file)
    }
    if (!snapshot.truncated && (await this.snapshot(workspace)).observation !== snapshot.observation) throw new Error('工程已变化，请重新读取差异')
    return { kind: 'diff', source: workspace.source, observation: snapshot.observation, baseSha, files,
      truncated: selected.truncated || incomplete, ...(snapshot.truncationReason ? { truncationReason: snapshot.truncationReason } : {}), ...(selected.nextCursor ? { nextCursor: selected.nextCursor } : {}) }
  }

  private async readBytes(root: string, relative: string, size: number): Promise<Buffer> {
    if (size > MAX_BYTES) throw new Error('文件超过 1 MiB，请使用范围读取')
    const { file, info } = await this.openFile(root, relative)
    try {
      if (info.size !== size || info.size > MAX_BYTES) throw new Error('工程文件已变化，请重新读取')
      const bytes = await file.readFile(), after = await file.stat(), current = await lstat(await contained(root, relative))
      if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs || current.dev !== info.dev || current.ino !== info.ino) throw new Error('工程文件在读取期间发生变化')
      return bytes
    } finally { await file.close() }
  }

  /** Read a bounded line range without loading an oversized file into memory. */
  private async readRange(root: string, relative: string, entry: Entry, identity: { source: PrototypeFileSource }, observation: string, range: { start: number; end: number }): Promise<PrototypeFileResult> {
    if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 1 || range.end < range.start || range.end - range.start + 1 > MAX_RANGE_LINES) throw new Error('文件行范围无效或超过 2000 行')
    const { file, info } = await this.openFile(root, relative), deadline = Date.now() + MAX_SCAN_MS
    try {
      if (info.size !== entry.size) throw new Error('工程文件已变化，请重新读取')
      const chunks: Buffer[] = [], buffer = Buffer.allocUnsafe(64 * 1024)
      let position = 0, line = 1, used = 0, finished = false, truncated = false, hasMore = false
      while (position < info.size && !finished) {
        if (Date.now() > deadline || position >= MAX_HASH_FILE_BYTES) { truncated = true; break }
        const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, info.size - position, MAX_HASH_FILE_BYTES - position), position)
        if (!bytesRead) throw new Error('工程文件在读取期间发生变化')
        let segment = 0
        for (let i = 0; i < bytesRead; i++) {
          if (buffer[i] !== 10) continue
          if (line >= range.start && line <= range.end) {
            const length = i + 1 - segment
            if (used + length > MAX_BYTES) { truncated = true; finished = true; break }
            chunks.push(Buffer.from(buffer.subarray(segment, i + 1))); used += length
          }
          line++; segment = i + 1
          if (line > range.end) { finished = true; hasMore = i + 1 < bytesRead || position + bytesRead < info.size; break }
        }
        if (!finished && line >= range.start && line <= range.end && segment < bytesRead) {
          const length = bytesRead - segment
          if (used + length > MAX_BYTES) { truncated = true; finished = true } else { chunks.push(Buffer.from(buffer.subarray(segment, bytesRead))); used += length }
        }
        position += bytesRead
      }
      const after = await file.stat(), current = await lstat(await contained(root, relative))
      if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs || current.dev !== info.dev || current.ino !== info.ino) throw new Error('工程文件在读取期间发生变化')
      if (entry.hash && await this.hashFile(root, relative, info.size, Date.now() + MAX_SCAN_MS) !== entry.hash) throw new Error('工程文件已变化，请重新读取')
      const bytes = Buffer.concat(chunks), binary = bytes.includes(0) || !Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)
      return { kind: 'file', ...identity, observation, path: relative, ...(entry.hash ? { hash: entry.hash } : {}), size: info.size, readOnly: true, binary, truncated, lineRange: { start: range.start, end: Math.max(range.start, Math.min(range.end, finished && !truncated ? line - 1 : line)) }, rangeComplete: !truncated, ...(!truncated && hasMore ? { nextLine: range.end + 1 } : {}), ...(!binary ? { content: bytes.toString('utf8') } : {}), ...(truncated ? { truncationReason: '行范围内容或扫描已达上限，请缩小范围。' } : range.start > line ? { truncationReason: '请求行范围超出文件末尾。' } : {}) }
    } finally { await file.close() }
  }

  async save(workspace: PrototypeFileWorkspace, command: Extract<PrototypeFileCommand, { action: 'savePrototypeFile' }>, refresh: () => Promise<PrototypeFileWorkspace>): Promise<PrototypeFileResult> {
    const relative = normalize(command.path)
    if (workspace.source.kind !== 'task') throw new Error('已接受基线只能读取')
    const source = workspace.source
    return withPathWriteLock(path.join(workspace.root, relative), async () => {
      if (!visible(relative) || Buffer.byteLength(command.content) > MAX_BYTES) throw new Error('文件不可写或内容超过大小限制')
      const currentWorkspace = await refresh()
      const root = await realpath(workspace.root)
      if (currentWorkspace.source.kind !== 'task' || currentWorkspace.source.projectId !== source.projectId || currentWorkspace.source.prototypeTaskId !== source.prototypeTaskId || await realpath(currentWorkspace.root) !== root || currentWorkspace.manifestPath !== workspace.manifestPath) throw new Error('事项工程身份已变化，请保留编辑内容并核对')
      const manifest = await readTemplateManifest(currentWorkspace.manifestPath)
      if (!writable(relative, currentWorkspace.writablePaths, manifest.contract.protectedPaths)) throw new Error('文件不在事项授权的可写范围内')
      const target = await contained(root, relative), info = await lstat(target)
      const current = await this.readBytes(root, relative, info.size), hash = createHash('sha256').update(current).digest('hex')
      const contentHash = createHash('sha256').update(command.content).digest('hex')
      if (hash === contentHash) return { kind: 'saved', source, path: relative, hash: contentHash } as const
      if (hash !== command.expectedHash) throw new Error('磁盘文件已变化，请保留编辑内容并合并最新版本')
      const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`)
      const file = await open(temporary, 'wx', info.mode)
      try { await file.writeFile(command.content, 'utf8'); await file.sync() } finally { await file.close() }
      try {
        if (await contained(root, relative) !== target || createHash('sha256').update(await this.readBytes(root, relative, info.size)).digest('hex') !== hash) throw new Error('磁盘文件已变化，请保留编辑内容并合并最新版本')
        await rename(temporary, target)
      } finally { await rm(temporary, { force: true }) }
      return { kind: 'saved', source, path: relative, hash: contentHash } as const
    })
  }
}
