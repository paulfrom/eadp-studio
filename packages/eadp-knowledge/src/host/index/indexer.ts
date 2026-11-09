/**
 * 本地查找索引的 Host 侧编排：启动核对、异步登记、状态与查询。
 *
 * 正文与清单始终由 KnowledgeStore 持有；切片、SQL 与词项在独立 worker 内完成，
 * 因此登记和查询都不阻塞保存与界面。索引库是衍生数据，放在 DSH 用户数据目录下，
 * 不写入业务工程。
 *
 * 查找编排在同一方法内完成：基础组（原问题与上下文）先检索，再由一次官方对话模型
 * 调用生成有界扩展查询并随后检索扩展组；两组各自组内融合后按组排名再融合。模型等待
 * 期间不持有 SQLite 事务，扩展组用发布围栏核对是否仍属同一索引代次；扩展失败只保留
 * 基础结果，由 supplement 如实报告。预算常量与理由：
 * - `SEARCH_TOTAL_BUDGET_MS = 15s`：搜索工具单次查找的内部总时限；自动注入在 8s 外层
 *   预算内调用，会先取消本次查找。
 * - `EXPANSION_TIMEOUT_MS = 3.8s`：扩展模型调用的等待上限，为自动注入 8s 总预算中的
 *   基础检索、扩展检索与回读核验留出余量。
 * - `RETRY_MIN_BUDGET_MS = 600ms`：发布围栏变化后统一重查所需的最小剩余预算；不足时
 *   不拼接新旧代次，保留基础结果并标记补充查找未完成。
 */
import { join } from 'node:path'
import { appendFile, mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { KnowledgePackId, KnowledgeSupplementState } from '@eadp/contracts/knowledge'
import type { KnowledgeStore } from '../store.ts'
import type {
  KnowledgeCandidate,
  KnowledgeIndexer,
  KnowledgeSearchRequest,
  KnowledgeSearchResponse,
} from './search.ts'
import { documentKey, tagsHashOf } from './identity.ts'
import type {
  BuildResult,
  DocumentState,
  JobIdentity,
  OpenResult,
  QueryRanking,
  SearchGroup,
  SearchQueryGroup,
  SearchResult,
  WorkerOptions,
  WorkerRequestPayload,
  WorkerResponse,
} from './protocol.ts'
import { requestExpansionQueries } from './expansion.ts'
import { fuseSearchGroups, rankSearchGroup } from './fusion.ts'
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
/** 搜索工具单次查找的内部总时限；自动注入另有更短的外层预算。 */
const SEARCH_TOTAL_BUDGET_MS = 15_000
/** 扩展模型调用的等待上限；包含在自动注入 8s 总预算内。 */
const EXPANSION_TIMEOUT_MS = 3_800
/** 发布围栏变化后统一重查所需的最小剩余预算。 */
const RETRY_MIN_BUDGET_MS = 600
/** 诊断中每个查询与每组排名的展示上限；只影响日志，不改变候选与顺序。 */
const DIAGNOSTIC_QUERY_DEPTH = 8
const DIAGNOSTIC_GROUP_DEPTH = 20
/** 用户可见说明：不出现索引、worker、数据库等技术词。 */
const UNAVAILABLE_MESSAGE = '本次没完成查找，可以稍后再试或手工查找。'
const PARTIAL_MESSAGE = '部分资料暂时还查不到，可以稍后再试或手工查找。'
const SUPPLEMENT_FAILED_MESSAGE = '本轮未完成补充查找，以上为已找到的结果。'
const SUPPLEMENT_FAILED_EMPTY_MESSAGE = '本轮未完成补充查找。'

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

/** 诊断中的一条候选摘要；只进日志，不进入业务结果。 */
interface DiagnosticCandidate {
  chunkKey: string
  packId: string
  documentId: string
  rank: number
  channels: readonly string[]
}

/** 诊断中的一个查询组：逐查询候选与组内排名。 */
interface DiagnosticGroup {
  group: 'base' | 'expansion'
  queries: { query: string; candidates: DiagnosticCandidate[] }[]
  ranking: DiagnosticCandidate[]
}

/** 一次查找的结构化诊断：查询来源、两组候选、命中原因、模型、耗时与版本，不含凭据。 */
interface SearchDiagnostic {
  query: string
  context: string | null
  admission: 'auto-reference' | 'all'
  packId: KnowledgePackId | null
  limit: number
  base: DiagnosticGroup | null
  expansion: DiagnosticGroup | null
  supplement: KnowledgeSupplementState
  /** 未执行补充查找的原因（例如未选择模型）；失败原因另见 `failure`。 */
  supplementReason: string | null
  model: string | null
  modelCalls: number
  failure: string | null
  indexState: KnowledgeSearchResponse['indexState']
  lagging: number
  fence: number | null
  processingSignature: string
  elapsedMs: number
  stages: { baseMs: number; expansionModelMs: number; expansionSearchMs: number; verifyMs: number }
  result: DiagnosticCandidate[]
}

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
  /** 诊断日志文件路径；首次写入时解析并创建目录。 */
  private diagnosticFile: Promise<string> | null = null
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
   * 查找：基础组（原问题与上下文）先执行，再由一次官方对话模型调用生成有界扩展查询并
   * 检索扩展组；两组各自组内融合后按组排名融合，最后回到最新清单与内容版本核验。
   * 扩展失败只终止补充查找步骤，已找到的基础结果照常返回并在 supplement 中如实标注；
   * 模型等待期间不持有 SQLite 事务，扩展组用发布围栏核对是否仍是同一索引代次。
   */
  async search(request: KnowledgeSearchRequest): Promise<KnowledgeSearchResponse> {
    const startedAt = Date.now()
    const deadline = startedAt + SEARCH_TOTAL_BUDGET_MS
    const stages: SearchDiagnostic['stages'] = { baseMs: 0, expansionModelMs: 0, expansionSearchMs: 0, verifyMs: 0 }
    if (this.lifecycle === 'failed' || this.lifecycle === 'disposed') return unavailable()
    try {
      await this.open()
    } catch {
      return unavailable()
    }
    if (this.lifecycle !== 'ready') return unavailable()
    // 原问题始终是独立查询；上下文非空时作为基础组内的第二个查询，二者互不替换。
    const baseQueries = [request.query, request.context]
      .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
      .map(value => value.slice(0, MAX_QUERY_CHARS))
    throwIfAborted(request.signal)
    const indexState = this.state()
    if (baseQueries.length === 0) {
      return {
        candidates: [],
        indexState,
        message: indexState === 'ready' ? null : PARTIAL_MESSAGE,
        lagging: [],
        supplement: { status: 'skipped', message: null },
      }
    }
    const limit = Math.min(Math.max(request.limit, 1), MAX_CANDIDATES)
    const diagnostic: SearchDiagnostic = {
      query: request.query,
      context: request.context,
      admission: request.admission,
      packId: request.packId,
      limit,
      base: null,
      expansion: null,
      supplement: { status: 'skipped', message: null },
      supplementReason: null,
      model: null,
      modelCalls: 0,
      failure: null,
      indexState,
      lagging: 0,
      fence: null,
      processingSignature: PROCESSING_SIGNATURE,
      elapsedMs: 0,
      stages,
      result: [],
    }
    try {
      const admitted = await this.store.admittedDocumentKeys(request.admission)
      throwIfAborted(request.signal)

      // 基础组先检索：即使扩展未配置、超时或输出不合法，原问题与上下文查询仍然有效。
      const baseStarted = Date.now()
      let base: SearchResult
      try {
        base = await this.searchWorker([{ key: 'base', queries: baseQueries }], admitted, request.packId, limit, null, deadline)
      } catch (error) {
        if (isAborted(request.signal)) throw error
        diagnostic.failure = messageOf(error)
        diagnostic.indexState = 'unavailable'
        diagnostic.elapsedMs = Date.now() - startedAt
        this.logSearchDiagnostic(diagnostic)
        this.diagnostic(`知识查找没有完成：${messageOf(error)}`)
        return unavailable()
      }
      stages.baseMs = Date.now() - baseStarted
      diagnostic.fence = base.fence
      diagnostic.base = diagnosticGroup(base.groups[0])
      let groups = base.groups
      let supplementStatus: KnowledgeSupplementState['status'] = 'skipped'
      throwIfAborted(request.signal)

      if (deadline - Date.now() < RETRY_MIN_BUDGET_MS) {
        supplementStatus = 'failed'
        diagnostic.failure = '剩余预算不足，未执行补充查找'
      } else {
        // 模型调用不持有 SQLite 事务：基础查询已在 worker 的短读事务内结束。
        const expansionStarted = Date.now()
        const outcome = await requestExpansionQueries(this.ctx, {
          query: request.query,
          context: request.context,
          signal: request.signal,
          timeoutMs: Math.min(EXPANSION_TIMEOUT_MS, deadline - Date.now()),
        })
        stages.expansionModelMs = Date.now() - expansionStarted
        diagnostic.model = outcome.model
        diagnostic.modelCalls = outcome.calls
        if (outcome.status === 'skipped') diagnostic.supplementReason = outcome.reason
        if (outcome.status === 'failed') {
          supplementStatus = 'failed'
          diagnostic.failure = outcome.reason
        } else if (outcome.status === 'completed') {
          const expansionSearchStarted = Date.now()
          try {
            const expansionResult = await this.searchWorker(
              [{ key: 'expansion', queries: outcome.queries }],
              admitted,
              request.packId,
              limit,
              base.fence,
              deadline,
            )
            throwIfAborted(request.signal)
            if (!expansionResult.changed) {
              groups = [...base.groups, ...expansionResult.groups]
              diagnostic.expansion = diagnosticGroup(expansionResult.groups[0])
              supplementStatus = 'completed'
            } else if (deadline - Date.now() >= RETRY_MIN_BUDGET_MS) {
              // 扩展等待期间发生发布变化：按剩余预算统一重查基础组与扩展组，只重试一次。
              const unified = await this.searchWorker(
                [{ key: 'base', queries: baseQueries }, { key: 'expansion', queries: outcome.queries }],
                admitted,
                request.packId,
                limit,
                expansionResult.fence,
                deadline,
              )
              throwIfAborted(request.signal)
              if (unified.changed) {
                supplementStatus = 'failed'
                diagnostic.failure = '发布代次再次变化，未拼接新旧代次'
              } else {
                groups = unified.groups
                diagnostic.base = diagnosticGroup(unified.groups.find(group => group.key === 'base'))
                diagnostic.expansion = diagnosticGroup(unified.groups.find(group => group.key === 'expansion'))
                supplementStatus = 'completed'
              }
            } else {
              supplementStatus = 'failed'
              diagnostic.failure = '发布代次变化且剩余预算不足，未统一重查'
            }
          } catch (error) {
            if (isAborted(request.signal)) throw error
            supplementStatus = 'failed'
            diagnostic.failure = messageOf(error)
          }
          stages.expansionSearchMs = Date.now() - expansionSearchStarted
        }
      }

      throwIfAborted(request.signal)
      // 返回前按最新清单与内容版本核验；两部分结果都先过滤再融合，避免旧代次候选占名额。
      const verifyStarted = Date.now()
      const verified = await this.verifyGroups(groups, request)
      const candidates = fuseSearchGroups(verified.groups, limit)
      stages.verifyMs = Date.now() - verifyStarted
      const supplement: KnowledgeSupplementState = {
        status: supplementStatus,
        message:
          supplementStatus === 'failed'
            ? candidates.length === 0
              ? SUPPLEMENT_FAILED_EMPTY_MESSAGE
              : SUPPLEMENT_FAILED_MESSAGE
            : null,
      }
      const partial = this.state() === 'partial' || verified.lagging.length > 0
      diagnostic.supplement = supplement
      diagnostic.lagging = verified.lagging.length
      diagnostic.indexState = partial ? 'partial' : 'ready'
      diagnostic.result = candidates
        .slice(0, DIAGNOSTIC_GROUP_DEPTH)
        .map((candidate, rank) => diagnosticCandidate(candidate, rank))
      diagnostic.elapsedMs = Date.now() - startedAt
      this.logSearchDiagnostic(diagnostic)
      return {
        candidates,
        indexState: partial ? 'partial' : 'ready',
        message: partial ? PARTIAL_MESSAGE : null,
        lagging: verified.lagging,
        supplement,
      }
    } catch (error) {
      if (isAborted(request.signal)) throw error
      diagnostic.failure = messageOf(error)
      diagnostic.indexState = 'unavailable'
      diagnostic.elapsedMs = Date.now() - startedAt
      this.logSearchDiagnostic(diagnostic)
      this.diagnostic(`知识查找没有完成：${messageOf(error)}`)
      return unavailable()
    }
  }

  /**
   * 返回前核验候选：最新偏好或资料范围已排除的直接丢弃；内容版本变化或资料读取失败的
   * 丢弃并报告索引滞后。按资料去重读取清单，避免同一份资料的多个候选重复核验。
   */
  private async verifyGroups(
    groups: SearchGroup[],
    request: KnowledgeSearchRequest,
  ): Promise<{ groups: SearchGroup[]; lagging: KnowledgeSearchResponse['lagging'] }> {
    const current = await this.store.admittedDocumentKeys(request.admission)
    const revisions = new Map<string, string | null>()
    const reported = new Set<string>()
    const lagging: KnowledgeSearchResponse['lagging'] = []
    const revisionOf = async (packId: KnowledgePackId, documentId: string): Promise<string | null> => {
      const key = documentKey(packId, documentId)
      if (!revisions.has(key)) revisions.set(key, await this.store.currentRevision(packId, documentId))
      return revisions.get(key) ?? null
    }
    const verified: SearchGroup[] = []
    for (const group of groups) {
      const queries: QueryRanking[] = []
      for (const ranking of group.queries) {
        const candidates: KnowledgeCandidate[] = []
        for (const candidate of ranking.candidates) {
          const key = documentKey(candidate.packId, candidate.documentId)
          if (!current.has(key)) continue
          const revision = await revisionOf(candidate.packId, candidate.documentId)
          if (revision === null || revision !== candidate.contentRevisionId) {
            if (!reported.has(key)) {
              reported.add(key)
              lagging.push({
                packId: candidate.packId,
                documentId: candidate.documentId,
                reason: revision === null ? '资料已删除或暂时无法读取' : '资料已更新，查找结果尚未跟上',
              })
            }
            continue
          }
          candidates.push(candidate)
        }
        queries.push({ query: ranking.query, candidates })
      }
      verified.push({ key: group.key, queries })
    }
    return { groups: verified, lagging }
  }

  /** 发送一次分组查询；等待上限取本次查找剩余预算与单请求上限的较小值。 */
  private searchWorker(
    groups: SearchQueryGroup[],
    admitted: Set<string>,
    packId: KnowledgePackId | null,
    limit: number,
    expectedFence: number | null,
    deadline: number,
  ): Promise<SearchResult> {
    const timeout = Math.max(1, Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now()))
    return this.request<SearchResult>(
      { type: 'search', query: { groups, admittedKeys: [...admitted], packId, limit, expectedFence } },
      timeout,
    )
  }

  /**
   * 结构化诊断只写日志；技术细节不进入业务文案，也不记录任何凭据。
   * 桌面宿主默认只把日志留在内存缓冲，排查时看不到，因此同时追加到
   * `<DSH_HOME>/logs/knowledge-search.jsonl`（每行一条，含时间与完整字段）。
   */
  private logSearchDiagnostic(diagnostic: SearchDiagnostic): void {
    this.ctx.logger.warn(`知识查找诊断：${JSON.stringify(diagnostic)}`)
    void this.appendDiagnostic(diagnostic).catch(() => undefined)
  }

  /** 诊断落盘；首次写入时创建日志目录。 */
  private async appendDiagnostic(diagnostic: SearchDiagnostic): Promise<void> {
    this.diagnosticFile ??= (async () => {
      const directory = join(resolveDshHome(), 'logs')
      await mkdir(directory, { recursive: true })
      return join(directory, 'knowledge-search.jsonl')
    })()
    const path = await this.diagnosticFile
    await appendFile(path, `${JSON.stringify({ at: new Date().toISOString(), ...diagnostic })}\n`, 'utf8')
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
  private request<T>(payload: WorkerRequestPayload, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    const worker = this.worker
    if (worker === null) return Promise.reject(new Error('索引线程尚未启动。'))
    const id = this.nextRequestId
    this.nextRequestId += 1
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('索引线程响应超时。'))
      }, timeoutMs)
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
  return {
    candidates: [],
    indexState: 'unavailable',
    message: UNAVAILABLE_MESSAGE,
    lagging: [],
    supplement: { status: 'skipped', message: null },
  }
}

/** 把一组查询结果压缩为诊断摘要；只列前若干名，不改变实际候选与顺序。 */
function diagnosticGroup(group: SearchGroup | undefined): DiagnosticGroup | null {
  if (group === undefined) return null
  return {
    group: group.key,
    queries: group.queries.map(ranking => ({
      query: ranking.query,
      candidates: ranking.candidates
        .slice(0, DIAGNOSTIC_QUERY_DEPTH)
        .map((candidate, rank) => diagnosticCandidate(candidate, rank)),
    })),
    ranking: rankSearchGroup(group)
      .slice(0, DIAGNOSTIC_GROUP_DEPTH)
      .map((entry, rank) => diagnosticCandidate(entry.candidate, rank, [...entry.channels])),
  }
}

/** 单条候选的诊断摘要；chunkKey 只用于诊断定位，不作为公开引用。 */
function diagnosticCandidate(
  candidate: KnowledgeCandidate,
  rank: number,
  channels: readonly string[] = candidate.channels,
): DiagnosticCandidate {
  return {
    chunkKey: candidate.chunkKey,
    packId: candidate.packId,
    documentId: candidate.documentId,
    rank,
    channels: [...channels],
  }
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
