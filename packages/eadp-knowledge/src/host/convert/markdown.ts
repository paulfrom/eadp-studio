/**
 * Markdown 解析：mdast-util-from-markdown + GFM 扩展 → 结构块。
 *
 * 同时导出 `markdownToBlocks`，供 HTML / Word 解析器复用同一条
 * “Markdown 文本 → 结构块”的路径，保证所有格式最终走同一个渲染器。
 */
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import type { ConvertBlock, ConvertedDocument, ConvertListItem } from './blocks.ts'
import { emptyDocument } from './failure.ts'
import { escapeInlineText } from './render.ts'
import { decodePlainText } from './text.ts'

/** mdast 节点在本模块用到的最小字段面；不直接依赖 mdast 类型包。 */
interface MdNode {
  type: string
  children?: MdNode[] | undefined
  value?: string | null | undefined
  depth?: number | null | undefined
  ordered?: boolean | null | undefined
  start?: number | null | undefined
  lang?: string | null | undefined
  url?: string | null | undefined
  title?: string | null | undefined
  alt?: string | null | undefined
}

/** 行内序列化上下文：统计未提取的图片数量，供警告使用。 */
interface InlineState {
  images: number
  /** 表格单元格内需要额外转义竖线，否则会拆坏表格。 */
  inTable: boolean
}

/** 行内代码用比内容中最长反引号更长的定界符包裹。 */
function backtickFence(value: string): string {
  let longest = 0
  for (const match of value.matchAll(/`+/g)) longest = Math.max(longest, match[0].length)
  return '`'.repeat(longest + 1)
}

/** 链接目标含空白或括号时用尖括号包裹。 */
function renderLinkDestination(url: string, title: string | null | undefined): string {
  const target = /[\s()<>]/.test(url) ? `<${url.replace(/[<>]/g, '')}>` : url
  if (!title) return target
  return `${target} "${title.replace(/"/g, '\\"')}"`
}

/** 未提取图片的可见占位，用户仍能知道原位置有图片。 */
function imagePlaceholder(alt: string | null | undefined): string {
  const label = (alt ?? '').trim()
  return label === '' ? '（图片）' : `（图片：${label}）`
}

/** 去掉 HTML 标签，只留文字与常见实体；表格单元格保留分隔，避免文字粘连。 */
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\s*\/\s*(?:td|th)\s*>/gi, ' | ')
    .replace(/<\s*\/\s*tr\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&amp;/g, '&')
}

/** 把行内节点序列化成规范 Markdown。 */
function serializeInline(nodes: readonly MdNode[] | undefined, state: InlineState): string {
  let output = ''
  for (const node of nodes ?? []) {
    switch (node.type) {
      case 'text':
        output += state.inTable
          ? escapeInlineText(node.value ?? '').replace(/\|/g, '\\|')
          : escapeInlineText(node.value ?? '')
        break
      case 'strong':
        output += `**${serializeInline(node.children, state)}**`
        break
      case 'emphasis':
        output += `*${serializeInline(node.children, state)}*`
        break
      case 'inlineCode': {
        const value = (node.value ?? '').replace(/\r\n?/g, '\n')
        const fence = backtickFence(value)
        const printed = state.inTable ? value.replace(/\|/g, '\\|') : value
        const padded = /^`|`$/.test(printed) ? ` ${printed} ` : printed
        output += `${fence}${padded}${fence}`
        break
      }
      case 'link':
        output += `[${serializeInline(node.children, state)}](${renderLinkDestination(node.url ?? '', node.title)})`
        break
      case 'image':
        // 导入阶段不提取图片，保留位置说明并让调用方写警告。
        state.images += 1
        output += imagePlaceholder(node.alt)
        break
      case 'break':
        output += '\\\n'
        break
      case 'delete':
        output += serializeInline(node.children, state)
        break
      case 'html':
        output += escapeInlineText(stripHtml(node.value ?? ''))
        break
      case 'linkReference':
        output += serializeInline(node.children, state)
        break
      case 'imageReference':
        state.images += 1
        output += imagePlaceholder(node.alt)
        break
      default:
        output += serializeInline(node.children, state)
    }
  }
  return output
}

/** 标题文本只能是一行。 */
function headingText(nodes: readonly MdNode[] | undefined, state: InlineState): string {
  return serializeInline(nodes, state).replace(/\s*\n\s*/g, ' ').trim()
}

function mapListItem(item: MdNode, state: InlineState): ConvertListItem {
  let text = ''
  const nested: ConvertBlock[] = []
  for (const child of item.children ?? []) {
    if (text === '' && child.type === 'paragraph')
      text = serializeInline(child.children, state).trim()
    else
      nested.push(...mapBlocks([child], state))
  }
  return { text, nested }
}

/** 把一组块级节点映射成结构块。 */
function mapBlocks(nodes: readonly MdNode[], state: InlineState): ConvertBlock[] {
  const blocks: ConvertBlock[] = []
  for (const node of nodes) {
    switch (node.type) {
      case 'heading': {
        const level = Math.min(Math.max(node.depth ?? 1, 1), 3) as 1 | 2 | 3
        const text = headingText(node.children, state)
        if (text !== '') blocks.push({ kind: 'heading', level, text })
        break
      }
      case 'paragraph': {
        // 独立成段的图片节点转成图片块（只支持指向已管理资源的路径）。
        const children = node.children ?? []
        const only = children.length === 1 ? children[0] : undefined
        if (only !== undefined && only.type === 'image' && (only.url ?? '').startsWith('assets/')) {
          blocks.push({ kind: 'image', alt: only.alt ?? '', path: only.url ?? '' })
          break
        }
        const text = serializeInline(children, state).trim()
        if (text !== '') blocks.push({ kind: 'paragraph', text })
        break
      }
      case 'list': {
        const items = (node.children ?? []).map(item => mapListItem(item, state))
        if (items.length === 0) break
        const ordered = node.ordered === true
        if (node.start === null || node.start === undefined)
          blocks.push({ kind: 'list', ordered, items })
        else
          blocks.push({ kind: 'list', ordered, start: node.start, items })
        break
      }
      case 'blockquote': {
        const inner = mapBlocks(node.children ?? [], state)
        if (inner.length > 0) blocks.push({ kind: 'quote', blocks: inner })
        break
      }
      case 'code': {
        const text = (node.value ?? '').replace(/\r\n?/g, '\n')
        if (text.trim() !== '') {
          if (node.lang) blocks.push({ kind: 'code', language: node.lang, text })
          else blocks.push({ kind: 'code', text })
        }
        break
      }
      case 'table': {
        const cellState: InlineState = { ...state, inTable: true }
        const rows = (node.children ?? []).map(row =>
          (row.children ?? []).map(cell => serializeInline(cell.children, cellState).trim()))
        const header = rows.shift() ?? []
        if (header.length > 0) blocks.push({ kind: 'table', header, rows })
        break
      }
      case 'thematicBreak':
        blocks.push({ kind: 'divider' })
        break
      case 'html': {
        for (const line of stripHtml(node.value ?? '').split(/\n{2,}/)) {
          const text = line.replace(/\s*\n\s*/g, ' ').trim()
          if (text !== '') blocks.push({ kind: 'paragraph', text: escapeInlineText(text) })
        }
        break
      }
      case 'listItem':
        blocks.push(...mapBlocks(node.children ?? [], state))
        break
      case 'definition':
      case 'footnoteDefinition':
      case 'yaml':
        break
      default:
        blocks.push(...mapBlocks(node.children ?? [], state))
    }
  }
  return blocks
}

/** 把 Markdown 文本解析成结构块；HTML / Word 解析器也复用这个入口。 */
export function markdownToBlocks(markdown: string): ConvertedDocument {
  const state: InlineState = { images: 0, inTable: false }
  const root: MdNode = fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  })
  const warnings: string[] = []
  if (state.images > 0) warnings.push(`文中有 ${state.images} 张图片未一并导入，可查看原件。`)
  return { blocks: mapBlocks(root.children ?? [], state), warnings }
}

/** 解析 Markdown 文件；编码回退与纯文本一致。 */
export function parseMarkdown(bytes: Uint8Array): ConvertedDocument {
  const decoded = decodePlainText(bytes)
  const parsed = markdownToBlocks(decoded.text)
  const warnings = [...decoded.warnings, ...parsed.warnings]
  if (parsed.blocks.length === 0)
    emptyDocument('文件里没有可整理的正文内容，可查看原件、重试或手工整理成文档。', 'markdown parsed to an empty document')
  return { blocks: parsed.blocks, warnings }
}
