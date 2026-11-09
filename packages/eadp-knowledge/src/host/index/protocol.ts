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

/** 打开索引库的结果：已发布资料状态与未完成任务。 */
export interface OpenResult {
  documents: DocumentState[]
  jobs: JobState[]
}

/** 一次构建的暂存结果；发布前 Host 还要重新核验正文身份。 */
export interface BuildResult {
  buildId: string
  chunkCount: number
}

/** 查找请求：准入集合由 Host 按 manifest 计算，worker 只做过滤与排序。 */
export interface SearchQuery {
  /** 独立查询文本；原始问题与需求上下文各占一项，互不替换。 */
  queries: string[]
  /** 允许参与查找的资料键 `${packId}:${documentId}`。 */
  admittedKeys: string[]
  packId: KnowledgePackId | null
  limit: number
}

/** 查找结果；候选已按 RRF 融合，只含真实命中的 chunk。 */
export interface SearchResult {
  candidates: KnowledgeCandidate[]
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
