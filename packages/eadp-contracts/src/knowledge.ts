import type { ProposalDiffLine } from './requirements.js'

export type KnowledgePackId = 'builtin' | 'user'
export type KnowledgeErrorCode =
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'VERSION_MISMATCH'
  | 'RESOURCE_INVALID'
  | 'UNAVAILABLE'
  | 'LIMIT_EXCEEDED'
  | 'UNSUPPORTED'
  | 'EVIDENCE_INVALID'

/** 少量、稳定的主题结构；模型不得自动创建相近分类。 */
export const KNOWLEDGE_CATEGORIES = ['业务知识', '需求方法', '产品规范', '未分类'] as const
export type KnowledgeCategory = (typeof KNOWLEDGE_CATEGORIES)[number]
export const isKnowledgeCategory = (value: unknown): value is KnowledgeCategory =>
  typeof value === 'string' && (KNOWLEDGE_CATEGORIES as readonly string[]).includes(value)

/** 后台整理只维护辅助信息，不阻断阅读、编辑和保存。 */
export type KnowledgeOrganizeState = 'pending' | 'ready' | 'failed'

/**
 * 导入项状态。只有 `imported` 产生可阅读资料；`needs_handling` 表示可重试或手工整理。
 */
export type KnowledgeImportStatus =
  | 'received'
  | 'converting'
  | 'imported'
  | 'needs_handling'
  | 'duplicate'
  | 'cancelled'

/** 用户可理解的资料出处；技术标识只在诊断中使用。 */
export interface KnowledgeSourceSummary {
  kind: 'imported' | 'authored' | 'builtin' | 'copy'
  /** 直接可展示的中文出处，例如“用户导入 · 授信管理办法.pdf”。 */
  label: string
  fileName?: string
  size?: number
  /** 用户可读的文件类型，例如“PDF 文档”；无法识别时省略。 */
  fileType?: string
  importId?: string
  /** 可展示的来源补充说明；内置整理卡用它保留真实外部出处，不伪造原件。 */
  detail?: string
  /** 是否存在可查看信息的原件。 */
  hasOriginal: boolean
}

/** 内容身份：正文、资源与来源映射共同决定一次已保存内容。 */
export interface KnowledgeDocumentRef {
  packId: KnowledgePackId
  documentId: string
  contentRevisionId: string
}

/** 列表所需的最少信息，不含正文。 */
export interface KnowledgeDocumentSummary extends KnowledgeDocumentRef {
  title: string
  category: KnowledgeCategory
  scope: string
  tags: string[]
  /** 正文前段纯文本摘要，不等于全文，也不用于代替正文。 */
  excerpt: string
  bodyLength: number
  readOnly: boolean
  /** 参与需求沟通偏好；只影响后续查找，不改变既有内容。 */
  autoReference: boolean
  organize: KnowledgeOrganizeState
  /** 已取得的真实来源位置说明，例如“第 4 页”“工作表「汇总」”。 */
  locations: string[]
  /** 整理过程已确认的提示；例如“部分表格未自动整理”。 */
  warnings: string[]
  source: KnowledgeSourceSummary
  updatedAt: string
}

export interface KnowledgeResourceRef {
  /** 正文中的相对引用，例如 `assets/6f1c….png`。 */
  path: string
  fileName: string
}

/** 整页明细与编辑使用的完整资料。 */
export interface KnowledgeDocument extends KnowledgeDocumentSummary {
  /** 规范 Markdown 正文；只在整页明细与编辑时读取，不作为用户概念暴露。 */
  text: string
  resources: KnowledgeResourceRef[]
}

export interface KnowledgeCategoryCount {
  category: KnowledgeCategory
  count: number
}

export interface KnowledgePack {
  packId: KnowledgePackId
  packVersion: string
  readOnly: boolean
  exists: boolean
  categories: KnowledgeCategoryCount[]
  documents: KnowledgeDocumentSummary[]
}

export interface KnowledgeIssue {
  packId: KnowledgePackId
  code: KnowledgeErrorCode
  message: string
  documentId?: string
}

export interface KnowledgeCatalog {
  packs: KnowledgePack[]
  issues: KnowledgeIssue[]
}

/** 保存时由界面提交的业务字段；标签由后台整理维护，不要求用户填写。 */
export interface KnowledgeDraft {
  title: string
  category: KnowledgeCategory
  scope: string
  /** 规范 Markdown 正文；界面只呈现排版结果。 */
  text: string
  autoReference: boolean
}

/** 编辑中新插入的图片等资源；placeholder 是正文里的临时引用。 */
export interface KnowledgeDraftResource {
  placeholder: string
  fileName: string
  dataBase64: string
}

export interface KnowledgeSaveInput {
  documentId: string | null
  /** 新建时为空；修改时必须是已读到的当前内容身份。 */
  expectedRevisionId: string | null
  draft: KnowledgeDraft
  resources: KnowledgeDraftResource[]
}

export interface KnowledgeImportFile {
  fileName: string
  dataBase64: string
}

export interface KnowledgeImportReceipt {
  importId: string
  fileName: string
  status: KnowledgeImportStatus
  documentId?: string
}

export interface KnowledgeImportItem {
  importId: string
  fileName: string
  size: number
  fileType?: string
  status: KnowledgeImportStatus
  documentId?: string
  documentTitle?: string
  /** 业务状态短句，例如“已加入资料”；不包含处理阶段或技术名词。 */
  message: string
  /** 用户可处理的失败说明；成功项为空。 */
  problem: string | null
  /** 只在诊断入口展示的失败细节，不进入业务主界面。 */
  diagnostic: string | null
  /** 是否由手工整理加入资料；原失败信息仍保留在诊断中。 */
  manual: boolean
  createdAt: string
  updatedAt: string
}

export interface KnowledgeImports {
  items: KnowledgeImportItem[]
}

/** 原件信息与真实取得的来源位置；用于“查看原件”和来源说明。 */
export interface KnowledgeSourceView {
  importId: string
  fileName: string
  size: number
  fileType: string
  available: boolean
  importedAt: string
  locations: string[]
  warnings: string[]
  /** 只在诊断入口展示的失败细节，不进入业务主界面。 */
  diagnostic: string | null
  /** 可直接阅读的文本原件预览；二进制或无法解码时为空。 */
  textPreview: string | null
}

/** 正文中的一个真实 Unicode code-point 范围，供命中、读取和固定引用使用。 */
export interface KnowledgeRange {
  start: number
  end: number
}

/** 命中通道：词项与精确匹配分开统计，不合并成相关百分比。 */
export type KnowledgeHitChannel = '词项' | '精确'

/** 已完成查找的命中片段；片段是 canonic 正文的真实范围，不是固定开头。 */
export interface KnowledgeHit {
  reference: KnowledgeDocumentRef
  title: string
  category: KnowledgeCategory
  scope: string
  tags: string[]
  /** 覆盖命中范围的正文片段，保留必要前后文。 */
  excerpt: string
  /** 命中在完整正文中的真实范围；同一资料可有多段。 */
  ranges: KnowledgeRange[]
  /** 命中片段所在章节路径。 */
  headingPath: string[]
  source: string
  locations: string[]
  /** 该片段的命中通道，例如“词项”“精确”。 */
  channels: KnowledgeHitChannel[]
  /** 资料整理与来源提示，随片段返回。 */
  warnings: string[]
  /** 本次查找的能力说明；为空表示本次完整。 */
  limitations: string[]
}

/**
 * 查找能力状态：`ready` 表示当前资料都已参与；`partial` 表示部分资料或新内容
 * 可能暂时找不到；`unavailable` 表示查找能力暂不可用。三者不得互相冒充。
 */
export type KnowledgeIndexState = 'ready' | 'partial' | 'unavailable'

export interface KnowledgeSearchResult {
  hits: KnowledgeHit[]
  issues: KnowledgeIssue[]
  indexState: KnowledgeIndexState
  /** 可直接展示的能力说明；为空表示无需说明。 */
  message: string | null
}

/** 分页读取结果；offset/length 与 range 按 Unicode code-point 计。 */
export interface KnowledgeRead {
  reference: KnowledgeDocumentRef
  title: string
  category: KnowledgeCategory
  tags: string[]
  text: string
  offset: number
  length: number
  truncated: boolean
  nextOffset: number | null
  /** 本次返回内容在完整正文中的范围。 */
  range: KnowledgeRange
  source: string
  locations: string[]
  warnings: string[]
  /** 仅本次运行且所属会话／项目有效；为空表示本次不签发。 */
  evidenceId: string | null
}

/** 来源映射中的一条定位；偏移按正文 Unicode code-point 计。 */
export interface KnowledgeSourceLocation {
  start: number
  end: number
  label: string
  page?: number
  sheet?: string
  cell?: string
  slide?: number
  section?: string
}

/** 正文范围到原文件的真实来源映射；只记录实际取得的位置。 */
export interface KnowledgeSourceMap {
  schemaVersion: number
  entries: KnowledgeSourceLocation[]
}

/** Agent 或需求提案要求 Host 核验的证据项；范围必须包含在已读取范围内。 */
export interface KnowledgeEvidenceItem {
  evidenceId: string
  ranges: KnowledgeRange[]
}

/** 已核验的证据范围及该范围正文的 hash。 */
export interface KnowledgeEvidenceRange extends KnowledgeRange {
  textHash: string
}

/** 证据核验结果：完整正文、实际范围与可固定到项目的来源资产。 */
export interface KnowledgeEvidenceResolution {
  packId: KnowledgePackId
  documentId: string
  contentRevisionId: string
  title: string
  category: KnowledgeCategory
  scope: string
  tags: string[]
  source: KnowledgeSourceSummary
  warnings: string[]
  locations: string[]
  /** 完整 Markdown 正文；固定快照与引用说明都从这里生成。 */
  text: string
  ranges: KnowledgeEvidenceRange[]
  resources: { path: string; fileName: string; hash: string; dataBase64: string }[]
  sourceMap: KnowledgeSourceMap | null
  original: { fileName: string; size: number; fileType: string; hash: string; dataBase64: string } | null
}

/**
 * 知识插件向需求插件提供的只读核验接口。证据只在当前运行且所属会话／项目内有效；
 * 需求提案据此生成项目固定快照，不信任模型自报内容。
 */
export interface KnowledgeReferenceService {
  /** 按当前会话与项目核验证据，返回 canonical 内容与来源资产。 */
  resolveEvidence(input: { sessionId: string; projectId: string; items: KnowledgeEvidenceItem[] }): Promise<KnowledgeEvidenceResolution[]>
  /** 当前 canonical 内容身份；资料不存在、已删除或暂时不可读时为空，供回读已固定依据的变化状态。 */
  currentContentRevision(packId: KnowledgePackId, documentId: string): Promise<string | null>
  /** 该需求会话是否自动参考知识；默认开启。 */
  autoReferenceFor(sessionId: string): Promise<boolean>
  /** 保存该需求会话的自动参考开关；关闭后仍可手工查找与引用。 */
  setAutoReferenceFor(sessionId: string, enabled: boolean): Promise<void>
}

/** 固定快照中的一个已核验范围。 */
export interface KnowledgeSnapshotRange extends KnowledgeRange {
  textHash: string
}

/** 固定快照中的图片等资源副本条目。 */
export interface KnowledgeSnapshotResource {
  path: string
  fileName: string
  hash: string
  /** 快照目录内的相对文件名。 */
  file: string
}

/** 固定快照中的原件副本条目；没有随包原件时为空。 */
export interface KnowledgeSnapshotOriginal {
  fileName: string
  size: number
  fileType: string
  hash: string
  /** 快照目录内的相对文件名。 */
  file: string
}

/**
 * 项目内 `.eadp/knowledge-sources/<snapshotId>/manifest.json` 的格式。
 * 快照身份由格式版本、来源包、资料、完整内容版本、来源元数据／映射与关联范围共同决定。
 */
export interface KnowledgeSnapshotManifest {
  schemaVersion: 1
  formatVersion: 'eadp-knowledge-snapshot@1'
  snapshotId: string
  packId: KnowledgePackId
  documentId: string
  contentRevisionId: string
  title: string
  category: KnowledgeCategory
  scope: string
  tags: string[]
  source: KnowledgeSourceSummary
  warnings: string[]
  locations: string[]
  bodyHash: string
  metadataHash: string
  assetsHash: string
  sourceMapHash: string
  ranges: KnowledgeSnapshotRange[]
  resources: KnowledgeSnapshotResource[]
  sourceMapFile: string | null
  original: KnowledgeSnapshotOriginal | null
  fixedAt: string
}

/**
 * 已固定的需求依据（供需求界面回读）。资料更新只改变 `state/latestContentRevisionId`，
 * 不使快照失效；资料删除后快照仍可读取当时内容。
 */
export interface FixedKnowledgeCitation {
  snapshotId: string
  packId: KnowledgePackId
  documentId: string
  contentRevisionId: string
  title: string
  category: KnowledgeCategory
  scope: string
  source: KnowledgeSourceSummary
  locations: string[]
  warnings: string[]
  ranges: KnowledgeSnapshotRange[]
  /** 采用说明：为什么把该内容作为需求依据。 */
  note: string
  state: 'current' | 'updated' | 'removed'
  latestContentRevisionId: string | null
  /** 固定的完整 Markdown 正文。 */
  body: string
  resources: { path: string; fileName: string; dataBase64: string }[]
  sourceMap: KnowledgeSourceMap | null
  original: { fileName: string; fileType: string; size: number; dataBase64: string } | null
}

/** Agent 提出的知识修改建议，应用前不写正文。 */
export interface KnowledgeProposal {
  proposalId: string
  action: 'create' | 'update'
  documentId: string
  /** 基线内容身份；应用时必须仍是当前身份。 */
  baseRevisionId: string
  draft: KnowledgeDraft
  baseText: string
  summary: string
  diff: ProposalDiffLine[]
  diffTruncated: boolean
  createdAt: string
  sessionId: string
}

/** 图片等资源的读取结果；dataUrl 只用于当前界面显示。 */
export interface KnowledgeAssetData {
  path: string
  dataUrl: string
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'eadp/knowledge': { code: KnowledgeErrorCode; documentId?: string; importId?: string }
  }
}
