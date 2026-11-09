/**
 * 索引 worker 的消息定义。
 *
 * Host 负责读取 canonical 正文、核对清单与内容身份；worker 只接收已核对的输入，
 * 执行 SQLite 读写、结构切分与词项计算。每条响应按请求 id 对应；跨线程边界不传
 * Error 实例，失败只回传文本说明。
 */
import type { KnowledgePackId } from '@eadp/contracts/knowledge'
import type { IndexedDocument } from '../store.ts'
import type { KnowledgeCandidate } from './search.ts'

/** 已发布索引的资料状态；Host 用它比对 manifest 决定补建、复用或刷新。 */
export interface DocumentState {
  packId: KnowledgePackId
  documentId: string
  contentRevisionId: string
  bodyHash: string
  metadataHash: string
  tagsHash: string
  generationId: string
  processingSignature: string
  chunkCount: number
}

/** 索引任务记录；跨重启保留未完成与失败原因。 */
export interface JobState {
  jobId: string
  packId: KnowledgePackId
  documentId: string
  kind: 'index' | 'remove'
  contentRevisionId: string
  status: 'pending' | 'running' | 'failed' | 'done'
  attempt: number
  error: string | null
}

/** 打开索引库的结果：已发布资料状态、未完成任务与当前发布围栏。 */
export interface OpenResult {
  documents: DocumentState[]
  jobs: JobState[]
  /** 发布围栏：worker 进程内单调递增，每次发布、刷新或删除后变化；用于识别代次切换。 */
  fence: number
}

/** 一次构建的暂存结果；发布前 Host 还要重新核验正文身份。 */
export interface BuildResult {
  buildId: string
  chunkCount: number
}

/** 一个查询内词项／精确通道融合后的排名；两个查询组共享同一索引代次与准入集合。 */
export interface QueryRanking {
  /** 该排名的查询文本；原问题与上下文各自独立，不被扩展替换。 */
  query: string
  /** 按该查询内通道 RRF 排序的候选；只含真实命中的 chunk。 */
  candidates: KnowledgeCandidate[]
}

/** 基础查询组或扩展查询组；组内每个查询一票，组间再按组排名融合。 */
export interface SearchGroup {
  key: 'base' | 'expansion'
  queries: QueryRanking[]
}

/** 查找请求中的分组查询文本；结果按同一分组返回排名。 */
export interface SearchQueryGroup {
  key: 'base' | 'expansion'
  queries: string[]
}

/** 查找请求：准入集合由 Host 按 manifest 计算，worker 只做过滤、排序与围栏核对。 */
export interface SearchQuery {
  /** 基础组先执行，扩展组随后执行；两组使用同一准入集合与资料范围。 */
  groups: SearchQueryGroup[]
  /** 允许参与查找的资料键 `${packId}:${documentId}`。 */
  admittedKeys: string[]
  packId: KnowledgePackId | null
  limit: number
  /**
   * 扩展组要求的发布围栏；与当前围栏不一致时不执行查询，
   * 由 Host 按剩余预算统一重查，避免拼接新旧代次。
   */
  expectedFence: number | null
}

/** 查找结果：按查询返回组内排名；Host 再完成两组融合与最终候选约束。 */
export interface SearchResult {
  groups: SearchGroup[]
  /** 本次读取时的发布围栏。 */
  fence: number
  /** 期望围栏已变化：本次没有执行查询，调用方不得把本次结果与旧结果拼接。 */
  changed: boolean
}

/** 工作线程启动参数。 */
export interface WorkerOptions {
  dbPath: string
  processingSignature: string
}

/** 一次索引任务的身份；worker 把它记入 jobs 表。 */
export interface JobIdentity {
  jobId: string
  kind: 'index' | 'remove'
  contentRevisionId: string
}

export type WorkerRequestPayload =
  | { type: 'open' }
  | { type: 'state'; packId: KnowledgePackId; documentId: string }
  | { type: 'build'; job: JobIdentity; document: IndexedDocument; reuseGenerationId: string | null }
  | { type: 'publish'; job: JobIdentity; buildId: string }
  | { type: 'discard'; buildId: string }
  | { type: 'refresh'; job: JobIdentity; document: IndexedDocument }
  | { type: 'drop'; job: JobIdentity; packId: KnowledgePackId; documentId: string }
  | { type: 'fail-job'; job: JobIdentity; packId: KnowledgePackId; documentId: string; error: string }
  | { type: 'search'; query: SearchQuery }
  | { type: 'dispose' }

export type WorkerRequest = WorkerRequestPayload & { id: number }

export type WorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string }
