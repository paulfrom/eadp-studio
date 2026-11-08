/**
 * HTML 解析：turndown（含 GFM 插件）把 HTML 转成 Markdown，再复用 Markdown 解析。
 *
 * 同时导出 `htmlToBlocks`，供 Word 解析器把 mammoth 产出的 HTML 走同一条路径。
 * 解析只把内容当数据：脚本、样式、嵌入对象和危险链接一律丢弃。
 */
import TurndownService from 'turndown'
import gfmPlugin from '@joplin/turndown-plugin-gfm'
import type { ConvertBlock, ConvertedDocument } from './blocks.ts'
import { diagnosticOf, emptyDocument, parseFailed } from './failure.ts'
import { markdownToBlocks } from './markdown.ts'
import { decodePlainText } from './text.ts'

/** 嵌套深度超过该值的网页按异常拒绝，避免解析栈过深拖垮 worker。 */
const MAX_HTML_DEPTH = 256

/** HTML 空元素：不参与嵌套深度计数。 */
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
])

/** 取出文档正文；完整 HTML 文档只保留 body 内的内容。 */
function bodyContent(html: string): string {
  const withoutDeclaration = html
    .replace(/^\uFEFF/, '')
    .replace(/<!doctype[^>]*>/gi, '')
    .replace(/<\?xml[^>]*\?>/gi, '')
  const body = withoutDeclaration.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)
  return body?.[1] ?? withoutDeclaration
}

/** 估算标签嵌套深度；正则只是保护性上限，精确解析交给 turndown。 */
function assertHtmlDepth(html: string): void {
  let depth = 0
  for (const match of html.matchAll(/<(\/?)([a-zA-Z][\w:-]*)([^>]*)>/g)) {
    const name = (match[2] ?? '').toLowerCase()
    if (VOID_ELEMENTS.has(name) || /\/\s*$/.test(match[3] ?? '')) continue
    if (match[1] === '/') {
      depth = Math.max(0, depth - 1)
      continue
    }
    depth += 1
    if (depth > MAX_HTML_DEPTH) {
      parseFailed(
        '网页内容结构过于复杂，暂时无法整理；可以查看原件、重试或手工整理成文档。',
        `html nesting depth exceeds ${MAX_HTML_DEPTH}`,
      )
    }
  }
}

/** 去掉 href 里的脚本与内联数据协议，导入内容不能变成可执行链接。 */
function stripUnsafeAttributes(html: string): string {
  return html.replace(/\shref\s*=\s*(['"])\s*(?:javascript|vbscript|data):[^'"]*\1/gi, '')
}

/** mammoth 等工具输出的表格没有表头单元格；按 Markdown 表格约定把首行提升为表头。 */
function promoteFirstTableRow(html: string): string {
  return html.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (table, inner: string) => {
    if (/<th\b/i.test(inner)) return table
    const firstRow = /<tr\b[^>]*>[\s\S]*?<\/tr>/i.exec(inner)
    if (firstRow === null) return table
    const promoted = firstRow[0].replace(/<td\b/gi, '<th').replace(/<\/td\s*>/gi, '</th>')
    return table.replace(firstRow[0], () => promoted)
  })
}

function turndownService(): TurndownService {
  const service = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    fence: '```',
    emDelimiter: '*',
    strongDelimiter: '**',
    linkStyle: 'inlined',
  })
  service.use(gfmPlugin.gfm)
  // 脚本、样式与嵌入对象属于页面行为，不属于文档内容。
  service.remove(['script', 'style', 'noscript', 'iframe', 'object', 'embed', 'svg', 'head', 'template'])
  return service
}

/** 递归检查是否还有“表头全空但存在数据行”的表格，说明表头未识别出来。 */
function hasDegradedTable(blocks: readonly ConvertBlock[]): boolean {
  for (const block of blocks) {
    if (block.kind === 'table') {
      if (block.rows.length > 0 && block.header.every(cell => cell.trim() === '')) return true
      continue
    }
    if (block.kind === 'quote' && hasDegradedTable(block.blocks)) return true
    if (block.kind === 'list' && block.items.some(item => hasDegradedTable(item.nested))) return true
  }
  return false
}

/** 把 HTML 片段转成结构块；Word 解析器复用这里。 */
export function htmlToBlocks(html: string): ConvertedDocument {
  const content = promoteFirstTableRow(stripUnsafeAttributes(bodyContent(html)))
  assertHtmlDepth(content)
  let markdown: string
  try {
    markdown = turndownService().turndown(content)
  }
  catch (error) {
    parseFailed(
      '无法读取网页内容，文件可能已损坏；可以查看原件、重试或手工整理成文档。',
      `turndown failed: ${diagnosticOf(error)}`,
    )
  }
  const parsed = markdownToBlocks(markdown)
  const warnings = [...parsed.warnings]
  // 合并单元格等复杂表格会被插件保留成 HTML，当前只提取文字。
  if (/<table[\s>]/i.test(markdown)) warnings.push('复杂表格未能完整整理，可查看原件核对。')
  if (hasDegradedTable(parsed.blocks)) warnings.push('部分表格的表头未自动识别，可查看原件核对。')
  return { blocks: parsed.blocks, warnings }
}

/** 解析 HTML 文件；编码回退与纯文本一致。 */
export function parseHtml(bytes: Uint8Array): ConvertedDocument {
  const decoded = decodePlainText(bytes)
  const parsed = htmlToBlocks(decoded.text)
  const warnings = [...decoded.warnings, ...parsed.warnings]
  if (parsed.blocks.length === 0)
    emptyDocument('文件里没有可整理的正文内容，可查看原件、重试或手工整理成文档。', 'html parsed to an empty document')
  return { blocks: parsed.blocks, warnings }
}
