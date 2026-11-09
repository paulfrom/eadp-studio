import type { KnowledgePackId } from '@eadp/contracts/knowledge'

/** 查找候选：由索引返回，尚未回到正文核验。 */
export interface KnowledgeCandidate {
  packId: KnowledgePackId
  documentId: string
  contentRevisionId: string
  /** 真实正文范围；同一 chunk 可有多段（正文与上下文分开给出）。 */
  ranges: { start: number; end: number }[]
  headingPath: string[]
  /** 命中通道；“精确”与“词项”分列，不合并成相关度。 */
  channels: ('词项' | '精确')[]
  /** 稳定 chunk 身份；用于去重与相邻合并，不作为公开引用。 */
  chunkKey: string
}

/** 一次查找请求；准入由索引器按当前 manifest 与偏好计算。 */
export interface KnowledgeSearchRequest {
  /** 本轮原始业务问题；始终作为独立查询保留。 */
  query: string
  /** 结合当前需求形成的上下文查询；可为空。 */
  context: string | null
  limit: number
  /** `auto-reference` 只含参与需求沟通且存在的资料；`all` 为手工查找。 */
  admission: 'auto-reference' | 'all'
  /** 用户明确指定的资料范围；空表示不限制。 */
  packId: KnowledgePackId | null
  signal: AbortSignal
}

/** 查找结果；能力状态与候选分开，禁止把不完整索引冒充成空结果。 */
export interface KnowledgeSearchResponse {
  candidates: KnowledgeCandidate[]
  indexState: 'ready' | 'partial' | 'unavailable'
  message: string | null
  /** 索引尚未跟上正文的资料；返回前如实报告。 */
  lagging: { packId: KnowledgePackId; documentId: string; reason: string }[]
}

/** 索引器对 Host 暴露的最小面：Host 只编排，切片、SQL 与词项在 worker 内。 */
export interface KnowledgeIndexer {
  /** 启动时按 manifest 与 jobs 核对，补齐缺失或过期的索引任务。 */
  start(): void
  /** 正文保存成功后异步登记索引；不等待索引完成。 */
  enqueue(document: { packId: KnowledgePackId; documentId: string; contentRevisionId: string }): void
  /** 资料删除后立即退出查找准入并清理衍生数据。 */
  remove(packId: KnowledgePackId, documentId: string): void
  /** 查询索引是否就绪；不阻塞 UI。 */
  state(): 'ready' | 'partial' | 'unavailable'
  search(request: KnowledgeSearchRequest): Promise<KnowledgeSearchResponse>
  dispose(): Promise<void>
}
