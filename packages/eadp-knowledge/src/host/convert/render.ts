/**
 * 唯一 Markdown 渲染器：结构块 → 规范 Markdown，同时记录来源映射。
 *
 * 渲染规则是确定性的：空块跳过、块之间恰好一个空行、正文以单个 `\n` 结尾，
 * 所有行内文本都经过本文件的转义函数，避免原始文本被误读成 Markdown 结构。
 */
import type { ConvertBlock, ConvertListItem, SourceLocator, SourceMapEntry, SourceMapFile } from './blocks.ts'

/** 行内文本中必须转义的 Markdown 标点；`|` 只在表格单元格里单独处理。 */
const INLINE_ESCAPES = /([\\`*_[\]<>~])/g

/** 统计 Unicode code-point 数量，与契约的分页/范围语义一致。 */
function codePointLength(text: string): number {
  let length = 0
  for (const _ of text) length += 1
  return length
}

/** 把纯文本转成可安全放进段落/标题的行内 Markdown，保留软换行。 */
export function escapeInlineText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => {
      const escaped = line.replace(INLINE_ESCAPES, '\\$1')
      // 行首的块级标记会让这一行变成标题、列表、引用或分隔线。
      if (/^[#>+\-=]/.test(escaped)) return `\\${escaped}`
      if (/^\d+[.)]/.test(escaped)) return escaped.replace(/^(\d+)([.)])/, '$1\\$2')
      return escaped
    })
    .join('\n')
}

/** 标题文本只能是一行，转义后折叠换行与首尾空白。 */
export function escapeHeadingText(value: string): string {
  return escapeInlineText(value.replace(/\s*\n\s*/g, ' ')).trim()
}

/** 表格单元格文本：转义行内标点与竖线，换行折成空格。 */
export function escapeTableCell(value: string): string {
  return escapeInlineText(value.replace(/\s*\n\s*/g, ' '))
    .replace(/\|/g, '\\|')
    .trim()
}

/** 有序/无序列表项的第一行。 */
function renderListItem(item: ConvertListItem, marker: string): string {
  const text = item.text.trim()
  const lines = [text ? `${marker} ${text}` : marker]
  if (item.nested.length > 0) {
    const nested = item.nested.map(block => renderBlock(block)).filter(rendered => rendered !== '')
    if (nested.length > 0) {
      for (const line of nested.join('\n\n').split('\n'))
        lines.push(line === '' ? '' : `    ${line}`)
    }
  }
  return lines.join('\n')
}

function renderList(block: Extract<ConvertBlock, { kind: 'list' }>): string {
  const start = block.ordered ? Math.max(1, Math.trunc(block.start ?? 1)) : 1
  return block.items
    .map((item, index) => renderListItem(item, block.ordered ? `${start + index}.` : '-'))
    .join('\n')
}

function indentQuote(text: string): string {
  return text
    .split('\n')
    .map(line => (line === '' ? '>' : `> ${line}`))
    .join('\n')
}

function renderTable(block: Extract<ConvertBlock, { kind: 'table' }>): string {
  const width = Math.max(block.header.length, ...block.rows.map(row => row.length), 0)
  if (width === 0) return ''
  // 单元格里的行内 Markdown 由解析器负责转义（含竖线），这里只对齐列数。
  const pad = (row: readonly string[]): string[] =>
    Array.from({ length: width }, (_, index) => (row[index] ?? '').replace(/\s*\n\s*/g, ' ').trim())
  const header = pad(block.header)
  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...block.rows.map(row => `| ${pad(row).join(' | ')} |`),
  ]
  return lines.join('\n')
}

/** 图片路径含空白或括号时用尖括号包裹，否则按普通目标输出。 */
function renderImage(alt: string, path: string): string {
  const destination = /[\s()<>]/.test(path) ? `<${path.replace(/[<>]/g, '')}>` : path
  return `![${escapeInlineText(alt)}](${destination})`
}

/** 单个结构块的 Markdown 文本；返回空串表示整个块没有内容。 */
function renderBlock(block: ConvertBlock): string {
  switch (block.kind) {
    case 'heading': {
      const text = block.text.replace(/\s*\n\s*/g, ' ').trim()
      return text === '' ? '' : `${'#'.repeat(block.level)} ${text}`
    }
    case 'paragraph':
      return block.text.trim()
    case 'list':
      return block.items.length === 0 ? '' : renderList(block)
    case 'quote': {
      const inner = block.blocks.map(block => renderBlock(block)).filter(rendered => rendered !== '').join('\n\n')
      return inner === '' ? '' : indentQuote(inner)
    }
    case 'code': {
      const language = (block.language ?? '').replace(/[^\w+#.-]/g, '').slice(0, 40)
      const body = block.text.replace(/\r\n?/g, '\n').replace(/\n+$/, '')
      return `\`\`\`${language}\n${body}\n\`\`\``
    }
    case 'table':
      return renderTable(block)
    case 'image':
      return block.path === '' ? '' : renderImage(block.alt, block.path)
    case 'divider':
      return '---'
    default:
      return ''
  }
}

/** 构造一条来源映射；只写实际取得的字段，缺省字段不落空值。 */
function sourceMapEntry(locator: SourceLocator, start: number, end: number): SourceMapEntry {
  const entry: SourceMapEntry = { start, end, label: locator.label }
  if (locator.page !== undefined) entry.page = locator.page
  if (locator.sheet !== undefined) entry.sheet = locator.sheet
  if (locator.cell !== undefined) entry.cell = locator.cell
  if (locator.slide !== undefined) entry.slide = locator.slide
  if (locator.section !== undefined) entry.section = locator.section
  return entry
}

/**
 * 把解析器输出的结构块渲染成规范 Markdown，并记录每块对应的来源范围。
 * @param blocks - 解析器输出的结构块，按阅读顺序。
 * @returns 规范正文（以单个 `\n` 结尾，无块时为 `''`）与来源映射文件。
 */
export function renderBlocks(blocks: readonly ConvertBlock[]): { text: string; sourceMap: SourceMapFile } {
  const parts: string[] = []
  const entries: SourceMapEntry[] = []
  let offset = 0
  for (const block of blocks) {
    const rendered = renderBlock(block)
    if (rendered.trim() === '') continue
    if (parts.length > 0) {
      parts.push('\n\n')
      offset += 2
    }
    const start = offset
    parts.push(rendered)
    offset += codePointLength(rendered)
    if (block.locator !== undefined) entries.push(sourceMapEntry(block.locator, start, offset))
  }
  const body = parts.join('')
  return {
    text: body === '' ? '' : `${body}\n`,
    sourceMap: { schemaVersion: 1, entries },
  }
}
