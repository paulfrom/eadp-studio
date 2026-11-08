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

/** 已完成查找的命中片段；片段是真实正文范围，不是固定开头。 */
export interface KnowledgeHit {
  reference: KnowledgeDocumentRef
  title: string
  category: KnowledgeCategory
  excerpt: string
  source: string
  locations: string[]
}

export interface KnowledgeSearchResult {
  hits: KnowledgeHit[]
  issues: KnowledgeIssue[]
}

/** 分页读取结果；offset/length 按 Unicode code-point 计。 */
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
