import type { FileVersion } from './files.js'
import type { FixedKnowledgeCitation, KnowledgePackId, KnowledgeRange, KnowledgeSnapshotRange } from './knowledge.js'
/** A bounded line comparison; the candidate and original remain available for complete review. */
export interface ProposalDiffLine { kind: 'context' | 'added' | 'removed'; text: string }

/** 提案提出时由模型申报、Host 负责核验的知识采用项。 */
export interface RequirementKnowledgeAdoption {
  /** 本会话实际取得内容时由 Host 签发的证据标识。 */
  evidenceId: string
  /** 采用范围；必须包含在本会话已读取范围内。 */
  ranges: KnowledgeRange[]
  /** 采用说明：为什么把该内容作为需求依据。 */
  note: string
}

/** 提案绑定的项目固定依据；`snapshotId` 对应 `.eadp/knowledge-sources/` 下的快照。 */
export interface RequirementKnowledgeCitation {
  snapshotId: string
  packId: KnowledgePackId
  documentId: string
  contentRevisionId: string
  title: string
  /** 可直接展示的来源说明。 */
  sourceLabel: string
  locations: string[]
  warnings: string[]
  ranges: KnowledgeSnapshotRange[]
  note: string
}

/** An unapplied in-memory suggestion, never a second authority for the project file. */
export interface RequirementProposal {
  proposalId: string
  projectId: string
  relativePath: string
  target: 'requirement' | 'context'
  baseVersion: FileVersion | null
  text: string
  baseText: string
  summary: string
  diff: ProposalDiffLine[]
  diffTruncated: boolean
  /** 提案显式关联并已固定到项目的知识依据；没有关联时为空。 */
  citations: RequirementKnowledgeCitation[]
  /** 提案与依据是否已持久化到项目 `.eadp/`；只有持久化成功才宣称可跨重启恢复。 */
  persisted: boolean
  createdAt: string
  sessionId: string
}

/** 需求界面回读的已固定依据，资料更新或删除后仍可查看当时内容。 */
export interface RequirementKnowledgeBasis {
  citations: FixedKnowledgeCitation[]
  /** 部分依据暂时无法读取时的业务说明；全部可读时为空或省略。 */
  problems?: string[]
}
