/**
 * 结构切分：按标题、段落、列表、表格与代码块从 canonical Markdown 生成检索片段。
 *
 * 所有范围都是 Unicode code-point 下标（Array.from 下标）；mdast 的 UTF-16 偏移
 * 在进入本模块时一次映射，避免混用字节或 UTF-16 下标。标题行与表格表头作为附加
 * 上下文保留，合并短块时不丢章节与表头信息。
 */
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'

/** 正文中的一个 code-point 范围。 */
export interface ChunkRange {
  start: number
  end: number
}

/** 结构切分结果：主正文范围与附加上下文范围分开记录。 */
export interface StructuralChunk {
  start: number
  end: number
  contextRanges: ChunkRange[]
  headingPath: string[]
  /** 附加上下文原文（当前为表格表头）；章节路径由 headingPath 表达。 */
  contextText: string
  content: string
}

/** 合并目标与单个片段上限：短块在同一章节内合并，超长块按结构拆分。 */
const TARGET_CHARS = 800
const MAX_CHARS = 1200
const MIN_CHARS = 120
/** 单篇资料的片段数量上限；超过时索引任务失败而不是悄悄截断。 */
const MAX_CHUNKS = 20_000
/** 附加上下文范围上限，避免一个片段携带过多历史范围。 */
const MAX_CONTEXT_RANGES = 4

const SENTENCE_END = new Set(['。', '！', '？', '!', '?', ';', '；', '\n'])

/** 本模块用到的 mdast 字段面；不直接依赖 mdast 类型包。 */
interface PositionedNode {
  type: string
  children?: PositionedNode[] | undefined
  value?: string | null | undefined
  depth?: number | null | undefined
  alt?: string | null | undefined
  position?: {
    start?: { offset?: number | undefined } | undefined
    end?: { offset?: number | undefined } | undefined
  } | undefined
}

/** 拆分后尚未合并的片段。 */
interface Piece {
  start: number
  end: number
  headingPath: string[]
  contextRanges: ChunkRange[]
  contextText: string
}

/** 正在合并的章节片段组。 */
interface Group {
  key: string
  headingPath: string[]
  start: number
  end: number
  pieces: Piece[]
}

/**
 * 把 canonical Markdown 切成结构片段。
 * @param markdown - 已保存的 canonical 正文。
 * @returns 按正文顺序排列的片段；正文为空时返回空数组，由调用方兜底。
 */
export function chunkMarkdown(markdown: string): StructuralChunk[] {
  const characters = Array.from(markdown)
  const offsets = new Utf16Offsets(markdown, characters.length)
  const root: PositionedNode = fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
  const pieces: Piece[] = []
  const headingRanges = new Map<string, ChunkRange>()
  const headingStack: { level: number; text: string }[] = []
  for (const node of root.children ?? []) {
    if (node.type === 'heading') {
      const level = typeof node.depth === 'number' ? node.depth : 1
      while (headingStack.length > 0 && (headingStack[headingStack.length - 1]?.level ?? 0) >= level) headingStack.pop()
      const title = inlineText(node)
      if (title !== '') headingStack.push({ level, text: title })
      const range = offsets.rangeOf(node)
      if (range === null) continue
      const headingPath = headingStack.map(entry => entry.text)
      const key = headingPath.join('\u0000')
      headingRanges.set(key, range)
      if (title !== '') pieces.push({ start: range.start, end: range.end, headingPath, contextRanges: [], contextText: '' })
      continue
    }
    const range = offsets.rangeOf(node)
    if (range === null) continue
    const headingPath = headingStack.map(entry => entry.text)
    emitPieces(node, range, headingPath, characters, offsets, pieces)
  }
  return packPieces(pieces, headingRanges, characters)
}

/** 标题等行内节点的可见文本；表格分隔行等无文本节点返回空串。 */
function inlineText(node: PositionedNode): string {
  if (typeof node.value === 'string') return node.value.trim()
  if (node.type === 'image') return (node.alt ?? '').trim()
  let text = ''
  for (const child of node.children ?? []) text += inlineText(child)
  return text.trim()
}

/** 按节点结构拆分超出上限的块；未知结构按换行与句末切分。 */
function emitPieces(
  node: PositionedNode,
  range: ChunkRange,
  headingPath: string[],
  characters: readonly string[],
  offsets: Utf16Offsets,
  pieces: Piece[],
): void {
  if (range.end - range.start <= MAX_CHARS) {
    pieces.push({ ...range, headingPath, contextRanges: [], contextText: '' })
    return
  }
  switch (node.type) {
    case 'list':
      emitChildren(node, headingPath, characters, offsets, pieces)
      return
    case 'table':
      emitTable(node, headingPath, characters, offsets, pieces)
      return
    case 'blockquote':
      emitChildren(node, headingPath, characters, offsets, pieces)
      return
    default:
      for (const part of splitRange(characters, range, MAX_CHARS))
        pieces.push({ ...part, headingPath, contextRanges: [], contextText: '' })
  }
}

/** 列表与引用：按子项范围拆分；子项仍超长时继续按换行切分。 */
function emitChildren(
  node: PositionedNode,
  headingPath: string[],
  characters: readonly string[],
  offsets: Utf16Offsets,
  pieces: Piece[],
): void {
  let emitted = false
  for (const child of node.children ?? []) {
    const range = offsets.rangeOf(child)
    if (range === null) continue
    emitted = true
    for (const part of splitRange(characters, range, MAX_CHARS))
      pieces.push({ ...part, headingPath, contextRanges: [], contextText: '' })
  }
  if (emitted) return
  const range = offsets.rangeOf(node)
  if (range === null) return
  for (const part of splitRange(characters, range, MAX_CHARS))
    pieces.push({ ...part, headingPath, contextRanges: [], contextText: '' })
}

/** 表格：按行拆分，表头行作为每个片段的附加上下文；只有表头时单独成块。 */
function emitTable(
  node: PositionedNode,
  headingPath: string[],
  characters: readonly string[],
  offsets: Utf16Offsets,
  pieces: Piece[],
): void {
  const rows: ChunkRange[] = []
  for (const child of node.children ?? []) {
    const range = offsets.rangeOf(child)
    if (range !== null) rows.push(range)
  }
  const header = rows[0]
  let emitted = false
  for (const row of rows.slice(1)) {
    emitted = true
    for (const part of splitRange(characters, row, MAX_CHARS))
      pieces.push({ ...part, headingPath, contextRanges: header === undefined ? [] : [header], contextText: '' })
  }
  if (emitted) return
  if (header === undefined) return
  pieces.push({ ...header, headingPath, contextRanges: [], contextText: '' })
}

/**
 * 把范围切成不超过 maxChars 的片段：优先在句末或换行处切断，实在没有边界时按长度切。
 * 只按 code-point 计数，保证与正文范围口径一致。
 */
function splitRange(characters: readonly string[], range: ChunkRange, maxChars: number): ChunkRange[] {
  const ranges: ChunkRange[] = []
  let cursor = range.start
  while (range.end - cursor > maxChars) {
    const limit = cursor + maxChars
    let cut = -1
    for (let index = limit; index > cursor; index -= 1) {
      if (SENTENCE_END.has(characters[index - 1] ?? '')) {
        cut = index
        break
      }
    }
    if (cut < 0) {
      for (let index = limit; index > cursor; index -= 1) {
        if (/\s/.test(characters[index - 1] ?? '')) {
          cut = index
          break
        }
      }
    }
    if (cut <= cursor) cut = limit
    ranges.push({ start: cursor, end: cut })
    cursor = cut
  }
  if (range.end > cursor) ranges.push({ start: cursor, end: range.end })
  return ranges
}

/** 同一章节内的片段合并成不超过上限的块；不同章节不跨块合并。 */
function packPieces(pieces: readonly Piece[], headingRanges: Map<string, ChunkRange>, characters: readonly string[]): StructuralChunk[] {
  const chunks: StructuralChunk[] = []
  let group: Group | null = null
  const flush = (): void => {
    if (group === null) return
    const chunk = toChunk(group, headingRanges, characters)
    if (chunk !== null) chunks.push(chunk)
    group = null
  }
  for (const piece of pieces) {
    const key = piece.headingPath.join('\u0000')
    if (group === null) {
      group = { key, headingPath: piece.headingPath, start: piece.start, end: piece.end, pieces: [piece] }
      continue
    }
    const currentChars = group.end - group.start
    const pieceChars = piece.end - piece.start
    const fits = currentChars + pieceChars <= TARGET_CHARS
    const short = currentChars < MIN_CHARS && currentChars + pieceChars <= MAX_CHARS
    if (group.key === key && (fits || short)) {
      group.end = Math.max(group.end, piece.end)
      group.pieces.push(piece)
      continue
    }
    flush()
    group = { key, headingPath: piece.headingPath, start: piece.start, end: piece.end, pieces: [piece] }
  }
  flush()
  if (chunks.length > MAX_CHUNKS) throw new Error(`结构片段数量 ${chunks.length} 超过上限 ${MAX_CHUNKS}`)
  return chunks
}

function toChunk(group: Group, headingRanges: Map<string, ChunkRange>, characters: readonly string[]): StructuralChunk | null {
  const content = sliceRange(characters, group.start, group.end)
  if (content.trim() === '') return null
  const contextRanges: ChunkRange[] = []
  let contextText = ''
  for (const piece of group.pieces) {
    for (const range of piece.contextRanges) {
      if (range.start >= group.start && range.end <= group.end) continue
      contextRanges.push(range)
    }
    if (piece.contextText !== '') contextText = contextText === '' ? piece.contextText : `${contextText}\n${piece.contextText}`
  }
  const heading = headingRanges.get(group.key)
  if (heading !== undefined && !(heading.start >= group.start && heading.end <= group.end)) contextRanges.push(heading)
  const boundedContext = boundRanges(contextRanges)
  if (contextText === '' && boundedContext.length > 0) contextText = boundedContext.map(range => sliceRange(characters, range.start, range.end)).join('\n')
  return {
    start: group.start,
    end: group.end,
    contextRanges: boundedContext,
    headingPath: group.headingPath,
    contextText,
    content,
  }
}

/** 合并重叠的上下文范围并限制数量；上下文只用于读取，不改变主范围。 */
function boundRanges(ranges: readonly ChunkRange[]): ChunkRange[] {
  const sorted = ranges
    .filter(range => Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end) && range.end > range.start)
    .sort((left, right) => left.start - right.start || left.end - right.end)
  const merged: ChunkRange[] = []
  for (const range of sorted) {
    const last = merged[merged.length - 1]
    if (last !== undefined && range.start <= last.end) last.end = Math.max(last.end, range.end)
    else merged.push({ ...range })
  }
  return merged.slice(0, MAX_CONTEXT_RANGES)
}

function sliceRange(characters: readonly string[], start: number, end: number): string {
  return characters.slice(start, end).join('')
}

/** mdast 偏移是 UTF-16 下标；一次扫描映射到 code-point 下标。 */
class Utf16Offsets {
  private readonly positions: Int32Array

  constructor(markdown: string, codePointLength: number) {
    this.positions = new Int32Array(markdown.length + 1)
    let codePoint = 0
    let offset = 0
    while (offset < markdown.length) {
      const code = markdown.charCodeAt(offset)
      const width = code >= 0xd800 && code <= 0xdbff && offset + 1 < markdown.length ? 2 : 1
      this.positions[offset] = codePoint
      if (width === 2) this.positions[offset + 1] = codePoint
      offset += width
      codePoint += 1
    }
    this.positions[markdown.length] = codePointLength
  }

  at(offset: number | null | undefined): number | null {
    if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || offset >= this.positions.length) return null
    const position = this.positions[offset]
    return position === undefined ? null : position
  }

  rangeOf(node: PositionedNode): ChunkRange | null {
    const start = this.at(node.position?.start?.offset)
    const end = this.at(node.position?.end?.offset)
    if (start === null || end === null || end <= start) return null
    return { start, end }
  }
}
