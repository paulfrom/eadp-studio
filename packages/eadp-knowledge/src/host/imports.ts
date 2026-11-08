/**
 * 知识导入流程：接收文件、保存原件、排队转换、生成资料，并提供导入记录。
 *
 * 导入项以 `<用户资料根目录>/imports/<importId>.json` 独立持久化，原件由 store 保存；
 * 转换在独立 worker 中进行，失败保留原件并给出可重试或手工整理的出口。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { Context } from '@deepseek-ai/cordis'
import type {
  KnowledgeDocument,
  KnowledgeDraft,
  KnowledgeDraftResource,
  KnowledgeImportFile,
  KnowledgeImportItem,
  KnowledgeImports as KnowledgeImportsView,
  KnowledgeImportReceipt,
  KnowledgeImportStatus,
  KnowledgeSourceView,
} from '@eadp/contracts/knowledge'
import type { ConvertInput, ConvertWorkerResult, SourceMapFile } from './convert/blocks.ts'
import { describeFileType, detectFormat, isTextFormat } from './convert/detect.ts'
import { diagnosticOf } from './convert/failure.ts'
import { renderBlocks } from './convert/render.ts'
import { decodePlainText } from './convert/text.ts'
import { KnowledgeError, fail } from './store.ts'
import type { KnowledgeStore } from './store.ts'

/** 导入限制：命中限制时对具体文件给出失败记录，而不是整批静默失败。 */
export interface ImportLimits {
  maxFileBytes: number
  maxBatchFiles: number
  maxBatchBytes: number
}

const LIMITS: ImportLimits = {
  maxFileBytes: 100 * 1024 * 1024,
  maxBatchFiles: 20,
  maxBatchBytes: 200 * 1024 * 1024,
}

/** 单次转换的最长时间；超时按“需要处理”返回，保留原件。 */
const WORKER_TIMEOUT_MS = 120_000

/** 同时进行的转换数量。 */
const MAX_CONCURRENT_CONVERSIONS = 2

/** “查看原件”文本预览的最大字符数。 */
const MAX_PREVIEW_CHARS = 20000

/** 每种导入状态的业务短句；不含处理阶段或技术名词。 */
const MESSAGES: Readonly<Record<KnowledgeImportStatus, string>> = {
  received: '已接收，等待整理',
  converting: '正在整理',
  imported: '已加入资料',
  needs_handling: '需要处理',
  duplicate: '已有相同文件',
  cancelled: '已取消',
}

const IMPORT_STATUSES: readonly KnowledgeImportStatus[] = [
  'received', 'converting', 'imported', 'needs_handling', 'duplicate', 'cancelled',
]

/** 落盘的导入项：契约字段 + 内部 schemaVersion、查重标识与转换提示。 */
interface StoredImportItem extends KnowledgeImportItem {
  schemaVersion: 1
  sourceHash?: string
  /** 转换阶段产生的整理提示；sourceView 直接读这份持久化结果，不重新解析。 */
  warnings?: string[]
}

/** saveDocument 的来源参数类型；直接从 store 的方法签名取，不重复声明。 */
type SaveOrigin = NonNullable<Parameters<KnowledgeStore['saveDocument']>[4]>

/** 新建导入项时允许写入的字段。 */
interface NewImportItem {
  fileName: string
  size: number
  status: KnowledgeImportStatus
  fileType?: string
  sourceHash?: string
  documentId?: string
  documentTitle?: string
  problem?: string | null
  diagnostic?: string | null
  manual?: boolean
  warnings?: string[]
}

/** 转换超时：与线程自身错误区分，便于给出不同提示。 */
class ConvertTimeoutError extends Error {
  constructor() {
    super('convert worker timed out')
    this.name = 'ConvertTimeoutError'
  }
}

function isImportStatus(value: unknown): value is KnowledgeImportStatus {
  return typeof value === 'string' && (IMPORT_STATUSES as readonly string[]).includes(value)
}

/** 文件系统错误码判断，避免把不存在当成读取失败。 */
function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

/** 去掉路径成分，得到可直接展示的文件名。 */
function displayName(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop()?.trim() ?? ''
  return base === '' ? '导入文件' : base.replace(/\u0000/g, '').slice(0, 200)
}

/** 资料标题取去扩展名的文件名。 */
function titleOf(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, '').trim()
  return base === '' ? '导入文件' : base.slice(0, 200)
}

/** base64 原文长度换算成解码后字节数；用于在解码前拦截超大文件。 */
function base64ByteLength(value: string): number {
  const compact = value.replace(/^data:[^;]*;base64,/i, '').replace(/\s+/g, '')
  if (compact === '') return 0
  const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((compact.length * 3) / 4) - padding)
}

/** base64 解码；非法内容返回 undefined，不抛底层异常。 */
function decodeBase64(value: string): Uint8Array | undefined {
  if (typeof value !== 'string') return undefined
  // 兼容 data URL 形式；契约本身要求纯 base64 字符串。
  const compact = value.replace(/^data:[^;]*;base64,/i, '').replace(/\s+/g, '')
  if (compact === '') return new Uint8Array(0)
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 !== 0) return undefined
  return Buffer.from(compact, 'base64')
}

/** 校验并读取一条导入项；损坏文件只报告诊断，不删除。 */
function isStoredImportItem(value: unknown): value is StoredImportItem {
  if (typeof value !== 'object' || value === null) return false
  if (!('schemaVersion' in value) || value.schemaVersion !== 1) return false
  if (!('importId' in value) || typeof value.importId !== 'string') return false
  if (!('fileName' in value) || typeof value.fileName !== 'string') return false
  if (!('size' in value) || typeof value.size !== 'number') return false
  if (!('status' in value) || !isImportStatus(value.status)) return false
  if (!('message' in value) || typeof value.message !== 'string') return false
  if (!('problem' in value) || !(typeof value.problem === 'string' || value.problem === null)) return false
  if (!('diagnostic' in value) || !(typeof value.diagnostic === 'string' || value.diagnostic === null)) return false
  if (!('manual' in value) || typeof value.manual !== 'boolean') return false
  if (!('createdAt' in value) || typeof value.createdAt !== 'string') return false
  if (!('updatedAt' in value) || typeof value.updatedAt !== 'string') return false
  if ('fileType' in value && value.fileType !== undefined && typeof value.fileType !== 'string') return false
  if ('sourceHash' in value && value.sourceHash !== undefined && typeof value.sourceHash !== 'string') return false
  if ('documentId' in value && value.documentId !== undefined && typeof value.documentId !== 'string') return false
  if ('documentTitle' in value && value.documentTitle !== undefined && typeof value.documentTitle !== 'string') return false
  if ('warnings' in value && value.warnings !== undefined) {
    if (!Array.isArray(value.warnings) || value.warnings.some(warning => typeof warning !== 'string')) return false
  }
  return true
}

/** 校验 worker 回传结果；跨线程数据按不可信输入处理。 */
function isWorkerResult(value: unknown): value is ConvertWorkerResult {
  if (typeof value !== 'object' || value === null || !('ok' in value)) return false
  if (value.ok === true) {
    return 'blocks' in value && Array.isArray(value.blocks)
      && 'warnings' in value && Array.isArray(value.warnings)
  }
  if (value.ok === false) {
    return 'code' in value && typeof value.code === 'string'
      && 'problem' in value && typeof value.problem === 'string'
      && 'diagnostic' in value && typeof value.diagnostic === 'string'
  }
  return false
}

/** 同内容原件是否已有资料或正在处理的导入项。 */
function findDuplicate(items: readonly StoredImportItem[], sourceHash: string): StoredImportItem | undefined {
  const sameSource = items.filter(item => item.sourceHash === sourceHash)
  return sameSource.find(item => item.status === 'imported')
    ?? sameSource.find(item => item.status === 'received' || item.status === 'converting')
}

function receiptOf(item: StoredImportItem): KnowledgeImportReceipt {
  if (item.documentId === undefined) return { importId: item.importId, fileName: item.fileName, status: item.status }
  return { importId: item.importId, fileName: item.fileName, status: item.status, documentId: item.documentId }
}

/**
 * 导入与转换编排：接收文件、排队转换、落资料、维护导入记录。
 *
 * 所有持久写入经由 `store.mutate` 串行化；转换并发上限 2，同一导入项只允许一个任务。
 */
export class KnowledgeImports {
  private readonly workers = new Map<string, Worker>()
  private readonly tasks = new Map<string, Promise<void>>()
  private readonly cancelled = new Set<string>()
  private queue: string[] = []
  private active = 0
  private disposed = false

  constructor(
    _ctx: Context,
    private readonly store: KnowledgeStore,
    private readonly diagnostic: (message: string) => void,
  ) {}

  /** 导入项目录：与 store 的用户资料根目录一致。 */
  private get directory(): string {
    return join(this.store.userRoot, 'imports')
  }

  private itemPath(importId: string): string {
    if (!/^[a-zA-Z0-9-]{1,64}$/.test(importId)) fail('INVALID_ARGUMENT', '导入记录编号无效。')
    return join(this.directory, `${importId}.json`)
  }

  /** 读取全部导入项；损坏或未知文件只记诊断，不删除。 */
  private async readAll(): Promise<StoredImportItem[]> {
    await mkdir(this.directory, { recursive: true })
    const names = await readdir(this.directory)
    const items: StoredImportItem[] = []
    for (const name of names) {
      if (!name.endsWith('.json') || name.includes('.tmp')) continue
      const importId = name.slice(0, -5)
      if (!/^[a-zA-Z0-9-]{1,64}$/.test(importId)) continue
      const item = await this.readItem(importId)
      if (item !== null) items.push(item)
    }
    return items
  }

  private async readItem(importId: string): Promise<StoredImportItem | null> {
    let raw: string
    try {
      raw = await readFile(this.itemPath(importId), 'utf8')
    }
    catch (error) {
      if (isNotFound(error)) return null
      throw error
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      if (isStoredImportItem(parsed)) return parsed
      this.diagnostic(`导入记录格式无效，已忽略：${importId}`)
    }
    catch (error) {
      this.diagnostic(`导入记录无法读取，已忽略：${importId}：${diagnosticOf(error)}`)
    }
    return null
  }

  /** 原子写入一条导入项；调用方必须已持有 store.mutate。 */
  private async writeItem(item: StoredImportItem): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    const target = this.itemPath(item.importId)
    const temporary = `${target}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(item, null, 2)}\n`, { flag: 'wx', encoding: 'utf8' })
      await rename(temporary, target)
    }
    finally {
      await unlink(temporary).catch(error => {
        if (!isNotFound(error)) this.diagnostic(`导入记录临时文件清理失败：${temporary}：${diagnosticOf(error)}`)
      })
    }
  }

  /** 在串行化写队列里更新一条导入项；记录不存在时返回 null。 */
  private async patchItem(importId: string, patch: (item: StoredImportItem) => StoredImportItem): Promise<StoredImportItem | null> {
    return this.store.mutate(async () => {
      const item = await this.readItem(importId)
      if (item === null) return null
      const next = { ...patch(item), updatedAt: new Date().toISOString() }
      await this.writeItem(next)
      return next
    })
  }

  private async createItem(fields: NewImportItem): Promise<StoredImportItem> {
    const now = new Date().toISOString()
    const item: StoredImportItem = {
      importId: randomUUID(),
      schemaVersion: 1,
      fileName: fields.fileName,
      size: fields.size,
      status: fields.status,
      message: MESSAGES[fields.status],
      problem: fields.problem ?? null,
      diagnostic: fields.diagnostic ?? null,
      manual: fields.manual ?? false,
      createdAt: now,
      updatedAt: now,
      ...(fields.fileType === undefined ? {} : { fileType: fields.fileType }),
      ...(fields.sourceHash === undefined ? {} : { sourceHash: fields.sourceHash }),
      ...(fields.documentId === undefined ? {} : { documentId: fields.documentId }),
      ...(fields.documentTitle === undefined ? {} : { documentTitle: fields.documentTitle }),
      ...(fields.warnings === undefined ? {} : { warnings: fields.warnings }),
    }
    await this.store.mutate(() => this.writeItem(item))
    return item
  }

  /** 命中限制或输入无效时创建“需要处理”记录并返回回执。 */
  private async rejectFile(fileName: string, size: number, problem: string, diagnostic: string): Promise<KnowledgeImportReceipt> {
    const item = await this.createItem({ fileName, size, status: 'needs_handling', problem, diagnostic })
    return receiptOf(item)
  }

  /** 列出全部导入记录，最新在前。 */
  async list(): Promise<KnowledgeImportsView> {
    const items = await this.readAll()
    items.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.importId.localeCompare(right.importId))
    return { items }
  }

  /**
   * 接收一批文件。
   *
   * 每个文件先保存原件，再按内容查重、写导入项并异步开始转换；
   * 单文件超限、整批数量或总大小超限、空文件等只对相应文件返回失败记录。
   * @param files - 文件名与 base64 内容。
   * @returns 与输入顺序一致的导入回执。
   */
  async importFiles(files: KnowledgeImportFile[]): Promise<KnowledgeImportReceipt[]> {
    if (!Array.isArray(files) || files.length === 0) fail('INVALID_ARGUMENT', '请选择要导入的文件。')
    const receipts: KnowledgeImportReceipt[] = []
    let batchBytes = 0
    let acceptedFiles = 0
    for (const file of files) {
      const fileName = displayName(typeof file.fileName === 'string' ? file.fileName : '')
      // 先按 base64 长度估算大小，超大文件不解码，避免一次性占用大量内存。
      const encoded = typeof file.dataBase64 === 'string' ? file.dataBase64 : ''
      const estimatedSize = base64ByteLength(encoded)
      if (estimatedSize > LIMITS.maxFileBytes) {
        receipts.push(await this.rejectFile(
          fileName,
          estimatedSize,
          '文件超过 100 MB，未能导入；请压缩或拆分后重试。',
          `file size ${estimatedSize} exceeds maxFileBytes ${LIMITS.maxFileBytes}`,
        ))
        continue
      }
      const bytes = decodeBase64(encoded)
      if (bytes === undefined) {
        receipts.push(await this.rejectFile(fileName, 0, '文件内容读取失败，请重新导入。', 'invalid base64 payload'))
        continue
      }
      if (bytes.length === 0) {
        receipts.push(await this.rejectFile(fileName, 0, '文件是空的，没有可整理的内容。', 'empty file'))
        continue
      }
      if (bytes.length > LIMITS.maxFileBytes) {
        receipts.push(await this.rejectFile(
          fileName,
          bytes.length,
          '文件超过 100 MB，未能导入；请压缩或拆分后重试。',
          `file size ${bytes.length} exceeds maxFileBytes ${LIMITS.maxFileBytes}`,
        ))
        continue
      }
      if (acceptedFiles >= LIMITS.maxBatchFiles) {
        receipts.push(await this.rejectFile(
          fileName,
          bytes.length,
          `一次最多导入 ${LIMITS.maxBatchFiles} 个文件，请分批导入。`,
          'batch file count limit exceeded',
        ))
        continue
      }
      if (batchBytes + bytes.length > LIMITS.maxBatchBytes) {
        receipts.push(await this.rejectFile(
          fileName,
          bytes.length,
          '本批文件总大小超过 200 MB，请分批导入。',
          'batch byte limit exceeded',
        ))
        continue
      }
      batchBytes += bytes.length
      acceptedFiles += 1
      receipts.push(await this.acceptFile(fileName, bytes))
    }
    return receipts
  }

  /** 保存原件、查重并创建导入项，随后异步开始转换。 */
  private async acceptFile(fileName: string, bytes: Uint8Array): Promise<KnowledgeImportReceipt> {
    const guessedType = describeFileType(fileName)
    let saved: { sourceHash: string; size: number; fileType?: string }
    try {
      saved = await this.store.mutate(() => this.store.saveSource(bytes, fileName, guessedType))
    }
    catch (error) {
      if (error instanceof KnowledgeError)
        return this.rejectFile(fileName, bytes.length, error.message, diagnosticOf(error))
      throw error
    }
    const fileType = saved.fileType ?? guessedType
    const existing = findDuplicate(await this.readAll(), saved.sourceHash)
    if (existing !== undefined) {
      const item = await this.createItem({
        fileName,
        size: saved.size,
        fileType,
        sourceHash: saved.sourceHash,
        status: 'duplicate',
        ...(existing.documentId === undefined ? {} : { documentId: existing.documentId }),
        ...(existing.documentTitle === undefined ? {} : { documentTitle: existing.documentTitle }),
        problem: null,
        diagnostic: null,
      })
      return receiptOf(item)
    }
    const item = await this.createItem({
      fileName,
      size: saved.size,
      fileType,
      sourceHash: saved.sourceHash,
      status: 'received',
    })
    this.enqueue(item.importId)
    return receiptOf(item)
  }

  /** 队列调度：最多两个并发，同一导入项只保留一个任务。 */
  private enqueue(importId: string): void {
    if (this.disposed || this.tasks.has(importId) || this.queue.includes(importId)) return
    this.queue.push(importId)
    this.pump()
  }

  private pump(): void {
    while (!this.disposed && this.active < MAX_CONCURRENT_CONVERSIONS && this.queue.length > 0) {
      const importId = this.queue.shift()
      if (importId === undefined || this.tasks.has(importId)) continue
      this.active += 1
      const task = this.convert(importId)
        .catch(error => this.diagnostic(`导入转换异常：${importId}：${diagnosticOf(error)}`))
        .finally(() => {
          this.active -= 1
          this.tasks.delete(importId)
          this.pump()
        })
      this.tasks.set(importId, task)
    }
  }

  /** 一条导入项的完整转换：读取原件、跑 worker、生成资料或失败记录。 */
  private async convert(importId: string): Promise<void> {
    if (this.disposed) return
    const started = await this.patchItem(importId, item => item.status === 'received'
      ? { ...item, status: 'converting', message: MESSAGES.converting, problem: null, diagnostic: null }
      : item)
    if (started === null || started.status !== 'converting') return

    const sourceHash = started.sourceHash
    if (sourceHash === undefined || !this.store.hasSource(sourceHash)) {
      await this.failItem(importId, '原件文件缺失，无法整理；请重新导入或手工整理成文档。', 'source payload is missing for import item')
      return
    }
    let bytes: Uint8Array
    try {
      bytes = await this.store.readSource(sourceHash)
    }
    catch (error) {
      await this.failItem(importId, '原件文件无法读取，请重新导入或手工整理成文档。', `readSource failed: ${diagnosticOf(error)}`)
      return
    }

    const input: ConvertInput = { fileName: started.fileName, bytes }
    let result: ConvertWorkerResult
    try {
      result = await this.spawnWorker(importId, input)
    }
    catch (error) {
      if (this.cancelled.has(importId) || this.disposed) return
      if (error instanceof ConvertTimeoutError) {
        await this.failItem(importId, '整理超时，文件内容较多或较复杂；可以重试或手工整理成文档。', 'convert worker timed out')
        return
      }
      await this.failItem(importId, '整理没有完成，可以重试或手工整理成文档。', `worker failed: ${diagnosticOf(error)}`)
      return
    }
    if (this.cancelled.has(importId) || this.disposed) return
    if (!result.ok) {
      await this.failItem(importId, result.problem, result.diagnostic)
      return
    }

    const rendered = renderBlocks(result.blocks)
    if (rendered.text.trim() === '') {
      await this.failItem(importId, '文件里没有可整理的正文内容，可查看原件、重试或手工整理成文档。', 'worker returned renderable blocks but empty markdown')
      return
    }
    const draft: KnowledgeDraft = {
      title: titleOf(started.fileName),
      category: '未分类',
      scope: '',
      text: rendered.text,
      autoReference: true,
    }
    let document: KnowledgeDocument
    try {
      document = await this.store.mutate(() =>
        this.store.saveDocument(null, null, draft, [], this.originOf(started, rendered.sourceMap, result.warnings)))
    }
    catch (error) {
      await this.failItem(importId, this.saveProblem(error), `saveDocument failed: ${diagnosticOf(error)}`)
      return
    }
    await this.patchItem(importId, item => item.status === 'converting'
      ? {
          ...item,
          status: 'imported',
          documentId: document.documentId,
          documentTitle: document.title,
          message: MESSAGES.imported,
          problem: null,
          diagnostic: null,
          warnings: [...result.warnings],
        }
      : item)
  }

  /** 构造资料的来源信息：原件、映射与整理警告。 */
  private originOf(item: StoredImportItem, sourceMap: SourceMapFile, warnings: string[]): SaveOrigin {
    return {
      source: {
        kind: 'imported',
        label: `用户导入 · ${item.fileName}`,
        fileName: item.fileName,
        size: item.size,
        importId: item.importId,
        ...(item.fileType === undefined ? {} : { fileType: item.fileType }),
        ...(item.sourceHash === undefined ? {} : { sourceHash: item.sourceHash }),
      },
      sourceMap,
      warnings,
    }
  }

  private saveProblem(error: unknown): string {
    if (error instanceof KnowledgeError && (error.code === 'LIMIT_EXCEEDED' || error.code === 'INVALID_ARGUMENT' || error.code === 'RESOURCE_INVALID'))
      return '资料无法保存，可能内容过大或格式不支持；可以查看原件、手工整理成文档。'
    return '资料保存失败，可以重试或手工整理成文档。'
  }

  /** 把仍处于未完成状态的导入项写成“需要处理”。 */
  private async failItem(importId: string, problem: string, diagnostic: string): Promise<void> {
    if (this.disposed) return
    await this.patchItem(importId, item => item.status === 'converting' || item.status === 'received'
      ? { ...item, status: 'needs_handling', message: MESSAGES.needs_handling, problem, diagnostic }
      : item)
  }

  /** 启动一个转换线程；超时或异常都通过 Promise 拒绝返回。 */
  private spawnWorker(importId: string, input: ConvertInput): Promise<ConvertWorkerResult> {
    const worker = new Worker(new URL('./convert-worker.js', import.meta.url), { workerData: input })
    this.workers.set(importId, worker)
    // 创建线程与取消可能交错：取消先到就不要继续占用线程。
    if (this.cancelled.has(importId) || this.disposed) {
      this.workers.delete(importId)
      void worker.terminate()
      return Promise.reject(new Error('转换已取消'))
    }
    return new Promise<ConvertWorkerResult>((resolve, reject) => {
      let settled = false
      let timer: NodeJS.Timeout | undefined
      const settle = (action: () => void): void => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        action()
      }
      timer = setTimeout(() => settle(() => reject(new ConvertTimeoutError())), WORKER_TIMEOUT_MS)
      worker.once('message', (message: unknown) => {
        settle(() => {
          if (isWorkerResult(message)) resolve(message)
          else reject(new Error('转换结果格式无效'))
        })
      })
      worker.once('error', error => settle(() => reject(error)))
      worker.once('exit', code => {
        if (!settled) settle(() => reject(new Error(`转换线程提前结束（退出码 ${code}）`)))
      })
    }).finally(() => {
      this.workers.delete(importId)
      void worker.terminate()
    })
  }

  /** 重试“需要处理”的导入项：重置为已接收并重新排队。 */
  async retry(importId: string): Promise<void> {
    const item = await this.readItem(importId)
    if (item === null) return fail('NOT_FOUND', '导入记录不存在。')
    if (item.status !== 'needs_handling') return fail('INVALID_ARGUMENT', '只有需要处理的导入记录可以重试。')
    if (item.sourceHash === undefined) return fail('INVALID_ARGUMENT', '原件未保存，无法重试；可以重新导入或手工整理成文档。')
    if (!this.store.hasSource(item.sourceHash)) return fail('NOT_FOUND', '原件已丢失，无法重试；可以重新导入或手工整理成文档。')
    this.cancelled.delete(importId)
    const updated = await this.patchItem(importId, current => ({
      ...current,
      status: 'received',
      message: MESSAGES.received,
      problem: null,
      diagnostic: null,
      warnings: [],
    }))
    if (updated !== null) this.enqueue(importId)
  }

  /** 取消尚未完成的导入项；已开始的转换线程被终止，不再创建资料。 */
  async cancel(importId: string): Promise<void> {
    const item = await this.readItem(importId)
    if (item === null) return fail('NOT_FOUND', '导入记录不存在。')
    if (item.status !== 'received' && item.status !== 'converting') return
    this.cancelled.add(importId)
    this.queue = this.queue.filter(queued => queued !== importId)
    const worker = this.workers.get(importId)
    if (worker !== undefined) void worker.terminate()
    await this.patchItem(importId, current => current.status === 'received' || current.status === 'converting'
      ? { ...current, status: 'cancelled', message: MESSAGES.cancelled, problem: null }
      : current)
  }

  /** 清除已结束的导入记录；只删除记录文件，不删除资料与原件。 */
  async clearFinished(): Promise<void> {
    const items = await this.readAll()
    const removable = items.filter(item => item.status === 'imported' || item.status === 'duplicate' || item.status === 'cancelled')
    if (removable.length === 0) return
    await this.store.mutate(async () => {
      for (const item of removable) {
        this.cancelled.delete(item.importId)
        try {
          await unlink(this.itemPath(item.importId))
        }
        catch (error) {
          if (!isNotFound(error)) this.diagnostic(`导入记录清理失败：${item.importId}：${diagnosticOf(error)}`)
        }
      }
    })
  }

  /** 查看原件信息：能否查看、来源位置、整理提示与文本预览。 */
  async sourceView(importId: string): Promise<KnowledgeSourceView> {
    const item = await this.readItem(importId)
    if (item === null) return fail('NOT_FOUND', '导入记录不存在。')
    const available = item.sourceHash !== undefined && this.store.hasSource(item.sourceHash)
    let importedAt = item.createdAt
    let textPreview: string | null = null
    if (available && item.sourceHash !== undefined) {
      try {
        const metadata = await this.store.readSourceMetadata(item.sourceHash)
        importedAt = metadata.importedAt
        textPreview = await this.previewOf(await this.store.readSource(item.sourceHash))
      }
      catch (error) {
        this.diagnostic(`查看原件失败：${importId}：${diagnosticOf(error)}`)
      }
    }
    let locations: string[] = []
    if (item.documentId !== undefined) {
      try {
        const catalog = await this.store.catalog()
        const document = catalog.packs
          .find(pack => pack.packId === 'user')
          ?.documents.find(candidate => candidate.documentId === item.documentId)
        if (document !== undefined) locations = [...document.locations]
      }
      catch (error) {
        this.diagnostic(`读取资料位置失败：${importId}：${diagnosticOf(error)}`)
      }
    }
    return {
      importId: item.importId,
      fileName: item.fileName,
      size: item.size,
      fileType: item.fileType ?? '文件',
      available,
      importedAt,
      locations,
      warnings: [...(item.warnings ?? [])],
      diagnostic: item.diagnostic,
      textPreview,
    }
  }

  /** 只对可解码的文本类原件给预览；二进制或无法解码返回 null。 */
  private async previewOf(bytes: Uint8Array): Promise<string | null> {
    try {
      const format = await detectFormat('', undefined, bytes)
      if (!isTextFormat(format)) return null
      return Array.from(decodePlainText(bytes).text).slice(0, MAX_PREVIEW_CHARS).join('')
    }
    catch {
      return null
    }
  }

  /** 用户基于原件手工整理：保存为资料并关联原导入项，保留原失败信息。 */
  async saveManual(importId: string, draft: KnowledgeDraft, resources: KnowledgeDraftResource[]): Promise<KnowledgeDocument> {
    const item = await this.readItem(importId)
    if (item === null) return fail('NOT_FOUND', '导入记录不存在。')
    if (item.status === 'imported') return fail('INVALID_ARGUMENT', '这条导入记录已经加入资料，不能重复保存。')
    const origin: SaveOrigin = {
      source: {
        kind: 'imported',
        label: `用户导入 · ${item.fileName}`,
        fileName: item.fileName,
        size: item.size,
        importId: item.importId,
        ...(item.fileType === undefined ? {} : { fileType: item.fileType }),
        ...(item.sourceHash === undefined ? {} : { sourceHash: item.sourceHash }),
      },
      sourceMap: null,
      warnings: ['手工整理内容，未生成原文件位置'],
    }
    const document = await this.store.mutate(() => this.store.saveDocument(null, null, draft, resources, origin))
    await this.patchItem(importId, current => ({
      ...current,
      status: 'imported',
      documentId: document.documentId,
      documentTitle: document.title,
      message: MESSAGES.imported,
      problem: null,
      manual: true,
      diagnostic: current.diagnostic ?? current.problem,
      warnings: [],
    }))
    return document
  }

  /** 启动恢复：把已接收或转换中的项重新排队；不删除未知文件。 */
  async resume(): Promise<void> {
    const items = await this.readAll()
    for (const item of items) {
      if (item.status !== 'received' && item.status !== 'converting') continue
      const updated = await this.patchItem(item.importId, current => ({
        ...current,
        status: 'received',
        message: MESSAGES.received,
        problem: null,
      }))
      if (updated !== null) this.enqueue(item.importId)
    }
  }

  /** 停止调度并终止所有转换线程；未完成项留给下次启动恢复。 */
  async dispose(): Promise<void> {
    this.disposed = true
    this.queue = []
    const tasks = [...this.tasks.values()]
    const workers = [...this.workers.values()]
    this.workers.clear()
    await Promise.allSettled(workers.map(worker => worker.terminate()))
    await Promise.allSettled(tasks)
  }
}
