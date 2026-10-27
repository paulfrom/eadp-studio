import { createHash, randomUUID } from 'node:crypto'
import { lstat, open, readdir, realpath, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import type { PrototypeFileCommand, PrototypeFileResult } from '../../shared/prototype.ts'
import { readTemplateManifest } from './template.js'

const MAX_BYTES = 1024 * 1024
const MAX_FILES = 5000
const ignored = new Set(['.git', 'node_modules', 'dist', '.umi', '.umi-production', 'coverage', '.cache'])
const secret = /(^|\/)(?:\.env(?:\..*)?|\.npmrc\.local|\.DS_Store)$|\.(?:pem|key|pfx|p12|log)$/i
type FileCommand = Extract<PrototypeFileCommand, { action: 'listPrototypeDirectory' | 'searchPrototypeFiles' | 'readPrototypeFile' }>
interface Entry { path: string; name: string; kind: 'file' | 'directory'; readOnly: boolean; size: number; mtimeMs: number }
interface Snapshot { observation: string; entries: Entry[]; truncated: boolean }
export interface PrototypeFileWorkspace { projectId: string; prototypeTaskId: string; root: string; manifestPath: string; writablePaths: readonly string[] }

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
  return { values, truncated: incomplete || next < all.length, ...(next < all.length ? { nextCursor: Buffer.from(JSON.stringify({ observation, query, offset: next })).toString('base64url') } : {}) }
}
function limit(value: number | undefined, maximum: number): number {
  return value === undefined ? maximum : Math.max(1, Math.min(maximum, Math.floor(value) || 1))
}

/** Resolves only a Host-registered workspace; clients never supply a filesystem root. */
export class PrototypeFiles {
  private readonly writes = new Map<string, Promise<unknown>>()

  private async snapshot(workspace: PrototypeFileWorkspace): Promise<Snapshot> {
    const root = await realpath(workspace.root), manifest = await readTemplateManifest(workspace.manifestPath), entries: Entry[] = []
    let truncated = false
    const walk = async (directory: string): Promise<void> => {
      const actual = directory ? await contained(root, directory) : root
      for (const entry of (await readdir(actual, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const relative = directory ? `${directory}/${entry.name}` : entry.name
        if (!visible(relative) || entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) continue
        if (entries.length >= MAX_FILES) { truncated = true; return }
        const info = await lstat(await contained(root, relative))
        entries.push({ path: relative, name: entry.name, kind: entry.isDirectory() ? 'directory' : 'file', readOnly: !writable(relative, workspace.writablePaths, manifest.contract.protectedPaths), size: info.size, mtimeMs: info.mtimeMs })
        if (entry.isDirectory()) await walk(relative)
        if (truncated) return
      }
    }
    await walk('')
    const observation = createHash('sha256').update(JSON.stringify(entries)).digest('hex')
    return { observation, entries, truncated }
  }

  async read(workspace: PrototypeFileWorkspace, command: FileCommand): Promise<PrototypeFileResult> {
    const snapshot = await this.snapshot(workspace), identity = { projectId: workspace.projectId, prototypeTaskId: workspace.prototypeTaskId }
    const root = await realpath(workspace.root)
    if (command.action === 'listPrototypeDirectory') {
      const directory = normalize(command.directory ?? '', true), query = `directory:${directory}`
      if (directory && !snapshot.entries.some(entry => entry.path === directory && entry.kind === 'directory')) throw new Error('目录不存在或不可读取')
      const prefix = directory ? `${directory}/` : ''
      const entries = snapshot.entries.filter(entry => entry.path.startsWith(prefix) && !entry.path.slice(prefix.length).includes('/')).map(({ path, name, kind, readOnly }) => ({ path, name, kind, readOnly }))
      const result = page(entries, cursorOffset(command.cursor, snapshot.observation, query), limit(command.limit, 200), snapshot.observation, query, snapshot.truncated)
      return { kind: 'directory', ...identity, observation: snapshot.observation, entries: result.values, truncated: result.truncated, ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) }
    }
    if (command.action === 'readPrototypeFile') {
      const relative = normalize(command.path), entry = snapshot.entries.find(item => item.path === relative && item.kind === 'file')
      if (!entry) throw new Error('文件不存在或不可读取')
      const bytes = await this.readBytes(root, relative, entry.size)
      const binary = bytes.includes(0) || !Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)
      return { kind: 'file', ...identity, observation: snapshot.observation, path: relative, hash: createHash('sha256').update(bytes).digest('hex'), size: entry.size, readOnly: entry.readOnly, binary, truncated: false, ...(!binary ? { content: bytes.toString('utf8') } : {}) }
    }
    const query = command.query.trim(), directory = normalize(command.directory ?? '', true)
    if (!query || query.length > 200) throw new Error('搜索文字须为 1 至 200 个字符')
    if (directory && !snapshot.entries.some(entry => entry.path === directory && entry.kind === 'directory')) throw new Error('目录不存在或不可读取')
    const cursorQuery = `search:${directory}:${query}`, matches: Array<{ path: string; line: number; column: number; excerpt: string; hash: string }> = []
    for (const entry of snapshot.entries) {
      if (entry.kind !== 'file' || entry.size > MAX_BYTES || (directory && !entry.path.startsWith(`${directory}/`))) continue
      const bytes = await this.readBytes(root, entry.path, entry.size)
      if (bytes.includes(0) || !Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) continue
      const hash = createHash('sha256').update(bytes).digest('hex')
      for (const [index, line] of bytes.toString('utf8').split('\n').entries()) {
        let from = 0, column: number
        while ((column = line.indexOf(query, from)) !== -1) {
          matches.push({ path: entry.path, line: index + 1, column: column + 1, excerpt: line.slice(Math.max(0, column - 120), column + query.length + 120), hash })
          from = column + query.length
        }
      }
    }
    const result = page(matches, cursorOffset(command.cursor, snapshot.observation, cursorQuery), limit(command.limit, 100), snapshot.observation, cursorQuery, snapshot.truncated)
    return { kind: 'search', ...identity, observation: snapshot.observation, matches: result.values, truncated: result.truncated, ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) }
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
    if ((await this.snapshot(workspace)).observation !== snapshot.observation) throw new Error('工程已变化，请重新读取差异')
    return { kind: 'diff', projectId: workspace.projectId, prototypeTaskId: workspace.prototypeTaskId, observation: snapshot.observation, baseSha, files,
      truncated: selected.truncated || incomplete, ...(selected.nextCursor ? { nextCursor: selected.nextCursor } : {}) }
  }

  private async readBytes(root: string, relative: string, size: number): Promise<Buffer> {
    if (size > MAX_BYTES) throw new Error('文件超过 1 MiB，请使用范围读取')
    const file = await open(await contained(root, relative), 'r')
    try { const info = await file.stat(); if (!info.isFile() || info.size > MAX_BYTES) throw new Error('文件无法读取或超过大小限制'); return await file.readFile() } finally { await file.close() }
  }

  async save(workspace: PrototypeFileWorkspace, command: Extract<PrototypeFileCommand, { action: 'savePrototypeFile' }>): Promise<PrototypeFileResult> {
    const relative = normalize(command.path), key = `${workspace.root}\0${relative}`, previous = this.writes.get(key) ?? Promise.resolve()
    const running = previous.catch(() => undefined).then(async () => {
      if (!visible(relative) || Buffer.byteLength(command.content) > MAX_BYTES) throw new Error('文件不可写或内容超过大小限制')
      const manifest = await readTemplateManifest(workspace.manifestPath)
      if (!writable(relative, workspace.writablePaths, manifest.contract.protectedPaths)) throw new Error('文件不在事项授权的可写范围内')
      const root = await realpath(workspace.root), target = await contained(root, relative), info = await lstat(target)
      const current = await this.readBytes(root, relative, info.size), hash = createHash('sha256').update(current).digest('hex')
      if (hash !== command.expectedHash) throw new Error('磁盘文件已变化，请保留编辑内容并合并最新版本')
      const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`)
      const file = await open(temporary, 'wx', info.mode)
      try { await file.writeFile(command.content, 'utf8'); await file.sync() } finally { await file.close() }
      try {
        if (await contained(root, relative) !== target || createHash('sha256').update(await this.readBytes(root, relative, info.size)).digest('hex') !== hash) throw new Error('磁盘文件已变化，请保留编辑内容并合并最新版本')
        await rename(temporary, target)
      } finally { await rm(temporary, { force: true }) }
      return { kind: 'saved', projectId: workspace.projectId, prototypeTaskId: workspace.prototypeTaskId, path: relative, hash: createHash('sha256').update(command.content).digest('hex') } as const
    })
    this.writes.set(key, running)
    try { return await running } finally { if (this.writes.get(key) === running) this.writes.delete(key) }
  }
}
