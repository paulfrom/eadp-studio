/**
 * 转换结果的结构块与来源映射类型。
 *
 * 所有解析器只输出这里定义的结构块，正文统一由 `render.ts` 渲染成规范 Markdown，
 * 避免每个解析器各自拼装 Markdown 后产生不一致的格式与范围记录。
 */

/** 用户在“来源与原件”里看到的真实位置；只有实际取得的位置才填写。 */
export interface SourceLocator {
  /** 可直接展示的中文简短位置，例如“第 4 页”“工作表「汇总」”。 */
  label: string
  page?: number
  sheet?: string
  cell?: string
  slide?: number
  section?: string
}

/** 一行来源映射：`start`/`end` 是规范正文的 Unicode code-point 偏移，左闭右开。 */
export interface SourceMapEntry extends SourceLocator {
  start: number
  end: number
}

/** 来源映射文件，随资料一起保存；没有取得任何位置时 entries 为空。 */
export interface SourceMapFile {
  schemaVersion: 1
  entries: SourceMapEntry[]
}

/** 列表项：`text` 是已经转义好的行内 Markdown，`nested` 是缩进在项下的子块。 */
export interface ConvertListItem {
  text: string
  nested: ConvertBlock[]
}

export interface HeadingBlock {
  kind: 'heading'
  level: 1 | 2 | 3
  /** 行内 Markdown，不含换行。 */
  text: string
  locator?: SourceLocator
}

export interface ParagraphBlock {
  kind: 'paragraph'
  /** 行内 Markdown；软换行可以包含 `\n`。 */
  text: string
  locator?: SourceLocator
}

export interface ListBlock {
  kind: 'list'
  ordered: boolean
  /** 有序列表起始序号，缺省为 1。 */
  start?: number
  items: ConvertListItem[]
  locator?: SourceLocator
}

export interface QuoteBlock {
  kind: 'quote'
  blocks: ConvertBlock[]
  locator?: SourceLocator
}

export interface CodeBlock {
  kind: 'code'
  language?: string
  /** 原样保留的代码文本，不转义。 */
  text: string
  locator?: SourceLocator
}

export interface TableBlock {
  kind: 'table'
  header: string[]
  rows: string[][]
  locator?: SourceLocator
}

/** 指向已管理资源的图片；导入阶段未提取的图片由解析器转成提示文字并写入警告。 */
export interface ImageBlock {
  kind: 'image'
  alt: string
  /** 正文相对引用，例如 `assets/<hash>.png`。 */
  path: string
  locator?: SourceLocator
}

export interface DividerBlock {
  kind: 'divider'
  locator?: SourceLocator
}

/** 解析器输出的统一结构块。 */
export type ConvertBlock =
  | HeadingBlock
  | ParagraphBlock
  | ListBlock
  | QuoteBlock
  | CodeBlock
  | TableBlock
  | ImageBlock
  | DividerBlock

/** 单个解析器的结果：结构块与需要持续展示的整理提示。 */
export interface ConvertedDocument {
  blocks: ConvertBlock[]
  warnings: string[]
}

/** 转换失败时返回给导入流程的错误码。 */
export type ConvertFailureCode = 'UNSUPPORTED' | 'PARSE_FAILED' | 'EMPTY'

/** worker 与 Host 之间的转换结果；`problem` 面向用户，`diagnostic` 只进诊断。 */
export type ConvertWorkerResult =
  | { ok: true; blocks: ConvertBlock[]; warnings: string[] }
  | { ok: false; code: ConvertFailureCode; problem: string; diagnostic: string }

/** 转换输入；`fileTypeHint` 可以是被识别出的类型名或扩展名，仅作线索。 */
export interface ConvertInput {
  fileName: string
  fileTypeHint?: string
  bytes: Uint8Array
}
