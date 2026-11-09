/**
 * 本地查找索引的 Host 侧编排：启动核对、异步登记、状态与查询。
 *
 * 正文与清单始终由 KnowledgeStore 持有；切片、SQL 与词项在独立 worker 内完成，
 * 因此登记和查询都不阻塞保存与界面。索引库是衍生数据，放在 DSH 用户数据目录下，
 * 不写入业务工程。
 */
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { KnowledgePackId } from '@eadp/contracts/knowledge'
import type { KnowledgeStore } from '../store.ts'
import type {
  KnowledgeCandidate,
  KnowledgeIndexer,
  KnowledgeSearchRequest,
  KnowledgeSearchResponse,
} from './search.ts'
import { documentKey, tagsHashOf } from './identity.ts'
import type { BuildResult, DocumentState, JobIdentity, OpenResult, SearchResult, WorkerOptions, WorkerRequestPayload, WorkerResponse } from './protocol.ts'
import { PROCESSING_SIGNATURE } from './tokenizer.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 本地查找索引；下游工具只依赖这个接口，不接触 worker 或数据库。 */
    eadpKnowledgeIndex: KnowledgeIndexer
  }
}

/** 单次查找返回的候选上限（冻结基线值）。 */
const MAX_CANDIDATES = 20
/** 查询文本上限：超长输入只取前段，仍按独立查询保留。 */
const MAX_QUERY_CHARS = 900
/** 单份资料失败后的最大尝试次数；超过后如实报告索引不完整。 */
const MAX_ATTEMPTS = 3
/** 单条 worker 请求超时；构建大资料时仍应远低于此值。 */
const REQUEST_TIMEOUT_MS = 60_000
/** 用户可见说明：不出现索引、worker、数据库等技术词。 */
const UNAVAILABLE_MESSAGE = '本次没完成查找，可以稍后再试或手工查找。'
const PARTIAL_MESSAGE = '部分资料暂时还查不到，可以稍后再试或手工查找。'

/** 排队中的索引任务；正文身份在执行时重新读取，不预先固定。 */
interface PendingJob {
  kind: 'index' | 'remove'
  packId: KnowledgePackId
  documentId: string
  jobId: string
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

/** 索引生命周期：未启动、启动与核对中、可用、失败、已关闭。 */
type Lifecycle = 'starting' | 'ready' | 'failed' | 'disposed'

const jobKeyOf = (job: { kind: string; packId: string; documentId: string }): string =>
  `${job.kind}:${job.packId}:${job.documentId}`

/**
 * 本地查找索引服务。
 *
 * `start()` 只在启动时调用一次；保存与删除只登记任务。任务串行执行，发布前
 * 重新读取正文核对版本，避免迟到版本覆盖新内容。
 */
export class KnowledgeIndex extends Service implements KnowledgeIndexer {
  private readonly dbPath: string
  private worker: Worker | null = null
  private opened: Promise<void> | null = null
  private lifecycle: Lifecycle = 'starting'
  private nextRequestId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private readonly queue: PendingJob[] = []
  private readonly queued = new Set<string>()
  private readonly attempts = new Map<string, number>()
  private readonly failing = new Set<string>()
  private pendingJobs = 0
  private issueCount = 0
  private pumping = false
  /** 启动核对是否仍在进行；核对完成前索引只能报告不完整。 */
  private reconciling = true

  constructor(
    ctx: Context,
    private readonly store: KnowledgeStore,
    private readonly diagnostic: (message: string) => void,
  ) {
    super(ctx, 'eadpKnowledgeIndex')
    this.dbPath = join(store.userRoot, 'index', 'index.sqlite')
  }

  /** 启动索引：打开 worker 并按 manifest／jobs 补齐任务；失败只记录诊断。 */
  start(): void {
    if (this.lifecycle !== 'starting' || this.opened !== null) return
    void this.open().catch(() => undefined)
  }

  /** 保存完成后登记；不等待完成，失败只记录诊断。 */
  enqueue(document: { packId: KnowledgePackId; documentId: string; contentRevisionId: string }): void {
    this.schedule('index', document.packId, document.documentId)
  }

  /** 资料删除后立即推出准入并清理衍生数据。 */
  remove(packId: KnowledgePackId, documentId: string): void {
    this.schedule('remove', packId, documentId)
  }

  /** 索引是否完整可用；不触发任何 I/O。 */
  state(): 'ready' | 'partial' | 'unavailable' {
    if (this.lifecycle !== 'ready') return 'unavailable'
    if (this.reconciling || this.pendingJobs > 0 || this.failing.size > 0 || this.issueCount > 0) return 'partial'
    return 'ready'
  }

  /**
   * 查找：交给 worker 做词项／精确通道融合，再由 Host 按当前清单与版本核验。
   * 迟到结果、已删除资料与旧版本不返回；未完成与不可用分别如实报告。
   */
  async search(request: KnowledgeSearchRequest): Promise<KnowledgeSearchResponse> {
    if (this.lifecycle === 'failed' || this.lifecycle === 'disposed') return unavailable()
    try {
      await this.open()
    } catch {
      return unavailable()
    }
    if (this.lifecycle !== 'ready') return unavailable()
    const queries = [request.query, request.context]
      .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
      .map(value => value.slice(0, MAX_QUERY_CHARS))
    throwIfAborted(request.signal)
    const state = this.state()
    if (queries.length === 0) return { candidates: [], indexState: state, message: state === 'ready' ? null : PARTIAL_MESSAGE, lagging: [] }
    try {
      const admitted = await this.store.admittedDocumentKeys(request.admission)
      throwIfAborted(request.signal)
      const result = await this.request<SearchResult>({
        type: 'search',
        query: {
          queries,
          admittedKeys: [...admitted],
          packId: request.packId,
          limit: Math.min(Math.max(request.limit, 1), MAX_CANDIDATES),
        },
      })
      throwIfAborted(request.signal)
      const current = await this.store.admittedDocumentKeys(request.admission)
      const candidates: KnowledgeCandidate[] = []
      const lagging: KnowledgeSearchResponse['lagging'] = []
      for (const candidate of result.candidates) {
        const key = documentKey(candidate.packId, candidate.documentId)
        if (!current.has(key)) continue
        const revision = await this.store.currentRevision(candidate.packId, candidate.documentId)
        if (revision === null) {
          lagging.push({ packId: candidate.packId, documentId: candidate.documentId, reason: '资料已删除或暂时无法读取' })
          continue
        }
        if (revision !== candidate.contentRevisionId) {
          lagging.push({ packId: candidate.packId, documentId: candidate.documentId, reason: '资料已更新，查找结果尚未跟上' })
          continue
        }
        candidates.push(candidate)
      }
      const partial = this.state() === 'partial' || lagging.length > 0
      return {
        candidates: candidates.slice(0, MAX_CANDIDATES),
        indexState: partial ? 'partial' : 'ready',
        message: partial ? PARTIAL_MESSAGE : null,
        lagging,
      }
    } catch (error) {
      if (isAborted(request.signal)) throw error
      this.diagnostic(`知识查找没有完成：${messageOf(error)}`)
      return unavailable()
    }
  }

  /** 关闭 worker 并拒绝未完成请求；已登记但未执行的任务随索引库在下次启动核对。 */
  async dispose(): Promise<void> {
    if (this.lifecycle === 'disposed') return
    this.lifecycle = 'disposed'
    this.queue.length = 0
    this.queued.clear()
    this.rejectPending(new Error('索引已关闭。'))
    const worker = this.worker
    this.worker = null
    this.opened = null
    if (worker !== null) await worker.terminate().catch(() => undefined)
  }

  /** 打开 worker 并完成启动核对；并发调用共享同一个 promise。 */
  private open(): Promise<void> {
    if (this.opened !== null) return this.opened
    this.opened = this.launch().catch((error: unknown) => {
      this.fail(error)
      throw error instanceof Error ? error : new Error(messageOf(error))
    })
    return this.opened
  }

  private async launch(): Promise<void> {
    const options: WorkerOptions = { dbPath: this.dbPath, processingSignature: PROCESSING_SIGNATURE }
    const worker = new Worker(new URL('./index-worker.js', import.meta.url), { workerData: options })
    this.worker = worker
    worker.on('message', (message: WorkerResponse) => this.onMessage(message))
    worker.on('error', error => this.fail(error))
    worker.on('exit', code => {
      if (this.lifecycle !== 'disposed') this.fail(new Error(`索引线程提前结束（退出码 ${code}）。`))
    })
    const opened = await this.request<OpenResult>({ type: 'open' })
    this.lifecycle = 'ready'
    // 启动核对读取全部正文，放到后台执行，避免首次查找等待整库读取；
    // 核对完成前 state() 报告不完整，查找结果不会被当成完整结果。
    void this.reconcile(opened)
      .catch(error => {
        this.diagnostic(`资料查找索引启动核对失败：${messageOf(error)}`)
        this.failing.add('startup:reconcile')
      })
      .finally(() => {
        this.reconciling = false
      })
  }

  /** 启动核对：manifest 与已发布状态比对，未完成任务重排；删除项清理衍生数据。 */
  private async reconcile(opened: OpenResult): Promise<void> {
    const inputs = await this.store.indexInputs()
    this.issueCount = inputs.issues.length
    const published = new Map(opened.documents.map(state => [documentKey(state.packId, state.documentId), state]))
    const existing = new Set<string>()
    for (const input of inputs.documents) {
      const key = documentKey(input.packId, input.documentId)
      existing.add(key)
      const state = published.get(key)
      if (state === undefined) {
        this.schedule('index', input.packId, input.documentId)
        continue
      }
      if (
        state.processingSignature !== PROCESSING_SIGNATURE ||
        state.contentRevisionId !== input.contentRevisionId ||
        state.tagsHash !== tagsHashOf(input.tags)
      ) {
        this.schedule('index', input.packId, input.documentId)
      }
    }
    for (const state of opened.documents) {
      if (!existing.has(documentKey(state.packId, state.documentId))) this.schedule('remove', state.packId, state.documentId)
    }
    for (const job of opened.jobs) {
      if (job.status === 'done') continue
      this.schedule(job.kind === 'remove' ? 'remove' : 'index', job.packId, job.documentId)
    }
  }

  /** 登记任务：按资料去重，立即返回；由串行泵执行。 */
  private schedule(kind: 'index' | 'remove', packId: KnowledgePackId, documentId: string): void {
    if (this.lifecycle === 'failed' || this.lifecycle === 'disposed') return
    const key = jobKeyOf({ kind, packId, documentId })
    if (this.queued.has(key)) return
    this.queued.add(key)
    this.queue.push({ kind, packId, documentId, jobId: randomUUID() })
    this.pendingJobs += 1
    void this.pump()
  }

  /** 串行执行任务；同资料保留尝试次数，超过上限后进入未完整状态。 */
  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      while (true) {
        if (this.lifecycle === 'disposed' || this.lifecycle === 'failed') return
        if (this.lifecycle === 'starting') {
          try {
            await this.open()
          } catch {
            return
          }
          continue
        }
        const job = this.queue.shift()
        if (job === undefined) return
        this.queued.delete(jobKeyOf(job))
        const done = await this.runJob(job)
        if (done) {
          this.pendingJobs -= 1
          this.attempts.delete(documentKey(job.packId, job.documentId))
          this.failing.delete(documentKey(job.packId, job.documentId))
          continue
        }
        const key = documentKey(job.packId, job.documentId)
        const attempt = (this.attempts.get(key) ?? 0) + 1
        this.attempts.set(key, attempt)
        if (attempt < MAX_ATTEMPTS) {
          this.queue.push(job)
          this.queued.add(jobKeyOf(job))
          continue
        }
        this.pendingJobs -= 1
        this.failing.add(key)
        // 下次登记重新给足尝试次数；当前失败状态保留到那份任务成功。
        this.attempts.delete(key)
      }
    } finally {
      this.pumping = false
    }
  }

  /**
   * 执行一个索引任务：读取当前正文 → 复用或重建 → 重新核对版本 → 发布。
   * 返回 false 表示本次失败；由调用方决定重试或报告未完整。
   */
  private async runJob(job: PendingJob): Promise<boolean> {
    const identity = (contentRevisionId: string): JobIdentity => ({
      kind: job.kind,
      contentRevisionId,
      jobId: job.jobId,
    })
    try {
      if (job.kind === 'remove') {
        await this.request<null>({ type: 'drop', job: identity(''), packId: job.packId, documentId: job.documentId })
        return true
      }
      const input = await this.store.indexDocument(job.packId, job.documentId)
      if (input === null) {
        await this.request<null>({ type: 'drop', job: identity(''), packId: job.packId, documentId: job.documentId })
        return true
      }
      const tagsHash = tagsHashOf(input.tags)
      const state = await this.request<DocumentState | null>({
        type: 'state',
        packId: job.packId,
        documentId: job.documentId,
      })
      if (
        state !== null &&
        state.processingSignature === PROCESSING_SIGNATURE &&
        state.contentRevisionId === input.contentRevisionId &&
        state.tagsHash === tagsHash
      ) {
        return true
      }
      if (
        state !== null &&
        state.processingSignature === PROCESSING_SIGNATURE &&
        state.contentRevisionId === input.contentRevisionId
      ) {
        await this.request<null>({ type: 'refresh', job: identity(input.contentRevisionId), document: input })
        return true
      }
      const reuseGenerationId =
        state !== null && state.processingSignature === PROCESSING_SIGNATURE && state.bodyHash === input.bodyHash
          ? state.generationId
          : null
      const build = await this.request<BuildResult>({
        type: 'build',
        job: identity(input.contentRevisionId),
        document: input,
        reuseGenerationId,
      })
      const current = await this.store.indexDocument(job.packId, job.documentId)
      if (current === null || current.contentRevisionId !== input.contentRevisionId || tagsHashOf(current.tags) !== tagsHash) {
        await this.request<null>({ type: 'discard', buildId: build.buildId }).catch(() => undefined)
        return false
      }
      await this.request<null>({ type: 'publish', job: identity(input.contentRevisionId), buildId: build.buildId })
      return true
    } catch (error) {
      const message = messageOf(error)
      this.diagnostic(`资料查找索引登记失败：${job.packId}:${job.documentId}：${message}`)
      await this.request<null>({
        type: 'fail-job',
        job: identity(''),
        packId: job.packId,
        documentId: job.documentId,
        error: message,
      }).catch(() => undefined)
      return false
    }
  }

  /** 发送一条请求并等待对应响应；超时或 worker 退出时失败。 */
  private request<T>(payload: WorkerRequestPayload): Promise<T> {
    const worker = this.worker
    if (worker === null) return Promise.reject(new Error('索引线程尚未启动。'))
    const id = this.nextRequestId
    this.nextRequestId += 1
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('索引线程响应超时。'))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, {
        resolve: value => {
          clearTimeout(timer)
          resolve(value as T)
        },
        reject: error => {
          clearTimeout(timer)
          reject(error)
        },
      })
      try {
        worker.postMessage({ ...payload, id })
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(messageOf(error)))
      }
    })
  }

  private onMessage(message: WorkerResponse): void {
    if (typeof message !== 'object' || message === null || typeof message.id !== 'number') return
    const pending = this.pending.get(message.id)
    if (pending === undefined) return
    this.pending.delete(message.id)
    if (message.ok) pending.resolve(message.result)
    else pending.reject(new Error(message.error))
  }

  /** 索引不可用：拒绝未完成请求，状态改为失败；只记录一次诊断。 */
  private fail(error: unknown): void {
    if (this.lifecycle === 'failed' || this.lifecycle === 'disposed') return
    this.lifecycle = 'failed'
    this.diagnostic(`本地资料查找索引不可用：${messageOf(error)}`)
    this.rejectPending(new Error(messageOf(error)))
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}

function unavailable(): KnowledgeSearchResponse {
  return { candidates: [], indexState: 'unavailable', message: UNAVAILABLE_MESSAGE, lagging: [] }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  const reason: unknown = signal.reason
  if (reason instanceof Error) throw reason
  throw new Error('知识查找已取消。')
}
