import { createHash } from 'node:crypto'
import { lstat, unlink } from 'node:fs/promises'
import path from 'node:path'
import type { RequirementFiles } from './files.ts'
import type { RequirementDraft } from '@eadp/contracts/files'
import { readJsonFile, stateDirectory, writeJsonAtomically } from './state-files.ts'

/** 未提交正文与其基准版本；不作为需求文件的第二份权威正文。 */

/** 同一项目的草稿操作串行执行，避免晚到请求覆盖更新输入。 */
export class RequirementDrafts {
  private pending: Promise<unknown> = Promise.resolve()
  constructor(private readonly files: RequirementFiles) {}
  async access(projectId: string, relativePath: string, update?: RequirementDraft | null): Promise<RequirementDraft | null> {
    const operation = this.pending.catch(() => undefined).then(async () => {
      if (relativePath !== 'CONTEXT.md') {
        if (typeof relativePath !== 'string' || !relativePath.startsWith('需求/') || !relativePath.toLowerCase().endsWith('.md')) throw new Error('只允许保存项目背景或需求 Markdown 草稿。')
      }
      if (update !== undefined && update !== null && (typeof update !== 'object' || typeof update.text !== 'string' || update.text.includes('\0') || Buffer.byteLength(update.text, 'utf8') > 2 * 1024 * 1024 || (update.baseVersion !== null && (typeof update.baseVersion !== 'string' || !update.baseVersion)))) throw new Error('草稿正文或基准版本无效。')
      await this.files.target(await this.files.root(projectId), relativePath)
      const directory = await stateDirectory(this.files, projectId, ['.eadp', 'drafts'], update !== undefined && update !== null)
      if (!directory) return null
      const file = path.join(directory, `${createHash('sha256').update(relativePath).digest('hex')}.json`)
      const info = await lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
      if (info && (info.isSymbolicLink() || !info.isFile())) throw new Error('草稿记录必须是普通文件。')
      if (info && info.size > 16 * 1024 * 1024) throw new Error('草稿记录超过大小上限。')
      if (update === null) {
        await unlink(file).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
        return null
      }
      if (update !== undefined) {
        await writeJsonAtomically(file, { relativePath, ...update })
        return update
      }
      const value = await readJsonFile(file) as Record<string, unknown> | null
      if (value === null) return null
      if (value['relativePath'] !== relativePath || typeof value['text'] !== 'string' || value['text'].includes('\0') || Buffer.byteLength(value['text'], 'utf8') > 2 * 1024 * 1024 || (value['baseVersion'] !== null && typeof value['baseVersion'] !== 'string')) throw new Error('未保存内容记录损坏，原记录已保留。')
      return { text: value['text'], baseVersion: value['baseVersion'] }
    })
    this.pending = operation
    return operation
  }
}
