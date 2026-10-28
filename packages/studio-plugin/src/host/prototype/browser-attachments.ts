import { canonical } from '@eadp/asset-domain'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { prototypeBrowserRoute, type PrototypeBrowserScope } from './browser-scope.ts'

export type PrototypeBrowserAttachmentKind = 'screenshot' | 'trace'
export interface PrototypeBrowserAttachment { id: string; sha256: string }

const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const limits: Record<PrototypeBrowserAttachmentKind, number> = { screenshot: 16 * 1024 * 1024, trace: 64 * 1024 * 1024 }

/** Host-owned durable bytes and metadata; callers never supply a filesystem path. */
export class PrototypeBrowserAttachmentStore {
  constructor(private readonly root: string) {}

  async attach(scope: PrototypeBrowserScope, kind: 'screenshot', bytes: Buffer): Promise<PrototypeBrowserAttachment> {
    return this.persist(scope, kind, bytes)
  }

  async captureTrace(scope: PrototypeBrowserScope, write: (filename: string) => Promise<void>): Promise<PrototypeBrowserAttachment & { bytes: Buffer }> {
    prototypeBrowserRoute(scope, '/')
    const staging = path.join(this.root, 'staging')
    await mkdir(staging, { recursive: true, mode: 0o700 })
    if ((await lstat(this.root)).isSymbolicLink() || (await lstat(staging)).isSymbolicLink()) throw new Error('浏览器 trace 临时目录不能是符号链接')
    const temporary = path.join(staging, `${randomUUID()}.zip`)
    try {
      await write(temporary)
      const stat = await lstat(temporary)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > limits.trace) throw new Error('浏览器 trace 大小或文件类型无效')
      const bytes = await readFile(temporary)
      const attachment = await this.persist(scope, 'trace', bytes)
      return { ...attachment, bytes }
    } finally { await rm(temporary, { force: true }) }
  }

  private async persist(scope: PrototypeBrowserScope, kind: PrototypeBrowserAttachmentKind, bytes: Buffer): Promise<PrototypeBrowserAttachment> {
    prototypeBrowserRoute(scope, '/')
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > limits[kind]) throw new Error('浏览器附件大小无效')
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    if ((await lstat(this.root)).isSymbolicLink()) throw new Error('浏览器附件目录不能是符号链接')
    const directory = path.join(this.root, digest(Buffer.from(canonical(scope))))
    await mkdir(directory, { recursive: true, mode: 0o700 })
    if ((await lstat(directory)).isSymbolicLink()) throw new Error('浏览器附件范围目录不能是符号链接')
    const id = randomUUID(), extension = kind === 'trace' ? 'zip' : 'png'
    const filename = `${id}.${extension}`, target = path.join(directory, filename), metadata = path.join(directory, `${id}.json`)
    const sha256 = digest(bytes)
    try {
      await this.write(target, bytes)
      const persisted = await readFile(target)
      if (persisted.length !== bytes.length || digest(persisted) !== sha256) throw new Error('浏览器附件持久化字节不一致')
      await this.write(metadata, Buffer.from(`${JSON.stringify({ schemaVersion: 1, id, kind, file: filename, size: persisted.length, sha256, scope })}\n`))
      return { id, sha256 }
    } catch (error) {
      await rm(target, { force: true })
      await rm(metadata, { force: true })
      throw error
    }
  }

  private async write(filename: string, bytes: Buffer): Promise<void> {
    const temporary = `${filename}.${randomUUID()}.tmp`
    const file = await open(temporary, 'wx', 0o600)
    try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
    try { await rename(temporary, filename) } finally { await rm(temporary, { force: true }) }
  }
}
