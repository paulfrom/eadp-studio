/**
 * 正文 Markdown 与编辑器节点树之间的转换规则，以及正文资源引用的双向映射。
 *
 * 载入时把正文里的 `assets/<hash>.<ext>` 相对引用换成可直接显示的地址；
 * 导出时把已有图片还原为相对引用，把新插入的图片换成占位并交给资料保存。
 */

import {
  $convertToMarkdownString,
  $generateNodesFromMarkdownString,
  BOLD_STAR,
  INLINE_CODE,
  ITALIC_STAR,
  LINK,
  STRIKETHROUGH,
  TRANSFORMERS,
  isTableRowDivider,
  type ElementTransformer,
  type MultilineElementTransformer,
  type Transformer,
} from '@lexical/markdown'
import {
  $createParagraphNode,
  $createTextNode,
  $isElementNode,
  $isParagraphNode,
  $isTextNode,
  type EditorState,
  type ElementNode,
  type LexicalEditor,
  type ParagraphNode,
} from 'lexical'
import {
  $createTableNodeWithDimensions,
  $isTableCellNode,
  $isTableNode,
  $isTableRowNode,
  TableCellNode,
  TableNode,
  TableRowNode,
} from '@lexical/table'
import { $createCodeNode, CodeNode } from '@lexical/code'
import {
  $createHorizontalRuleNode,
  $isHorizontalRuleNode,
  HorizontalRuleNode,
} from '@lexical/react/LexicalHorizontalRuleNode'
import type { KnowledgeDraftResource } from '@eadp/contracts/knowledge'
import { $createImageNode, $isImageNode, ImageNode } from './nodes.tsx'

/** 保存时交给面板的正文与新增图片资源。 */
export interface EditorSavePayload {
  text: string
  resources: KnowledgeDraftResource[]
}

/** 只匹配图片引用，避免误改普通链接。 */
const IMAGE_REFERENCE_PATTERN = /(!\[[^\]]*\]\()([^)\s]+)(\))/g

/** 表格单元格里只允许行内结构，避免把单元格内容解析成新的块级元素。 */
const INLINE_TRANSFORMERS: Transformer[] = [BOLD_STAR, ITALIC_STAR, INLINE_CODE, STRIKETHROUGH, LINK]

/** 带有前导竖线或以竖线结尾的行才可能是表格行；具体是否为表头由分隔行确认。 */
const TABLE_START_PATTERN = /^[ \t]*(?:\||[^|\n]*\|)/

/** 图片引用的完整行；替代文字里的方括号可用反斜杠转义。 */
const IMAGE_PATTERN = /^!\[((?:\\.|[^\]\\])*)\]\(([^)\s]+)\)[ \t]*$/

/** 与正文里图片占位对应的新资源编号前缀。 */
const RESOURCE_PLACEHOLDER_PREFIX = 'eadp-asset:'

/**
 * 把正文里的资源相对引用替换为可直接显示的地址。
 * 只有 `assets` 里登记过的引用会被替换，其它图片或链接保持原样。
 *
 * @param markdown - 保存形态的正文。
 * @param assets - 正文相对路径到可显示地址的映射。
 * @returns 可直接载入编辑器的正文。
 */
export function resolveAssetUrls(markdown: string, assets: Record<string, string>): string {
  if (Object.keys(assets).length === 0) return markdown
  return markdown.replace(
    IMAGE_REFERENCE_PATTERN,
    (reference: string, prefix: string, target: string, suffix: string) => {
      const display = assets[target]
      return display === undefined ? reference : `${prefix}${display}${suffix}`
    },
  )
}

/**
 * 建立显示地址到正文相对路径的反向映射，用于导出时还原资源引用。
 *
 * @param assets - 正文相对路径到可显示地址的映射。
 * @returns 显示地址到相对路径的只读映射。
 */
export function createAssetReverseMap(assets: Record<string, string>): ReadonlyMap<string, string> {
  const reverse = new Map<string, string>()
  for (const [path, display] of Object.entries(assets)) {
    if (!reverse.has(display)) reverse.set(display, path)
  }
  return reverse
}

/**
 * 规范化导出正文：首尾的空段落不进入正文，非空内容以单个换行结尾，空白内容保持为空。
 *
 * @param markdown - 编辑器导出的正文。
 * @returns 资料保存使用的正文。
 */
export function normalizeDocumentText(markdown: string): string {
  const trimmed = markdown.replace(/^\n+/, '').replace(/\n+$/, '')
  return trimmed === '' ? '' : `${trimmed}\n`
}

/**
 * 在编辑器读取状态下导出正文与新增图片资源。
 *
 * @param editor - 当前编辑器。
 * @param reverse - 显示地址到正文相对路径的映射。
 * @returns 保存所需正文与资源。
 */
export function readDocumentPayload(
  editor: LexicalEditor,
  reverse: ReadonlyMap<string, string>,
): EditorSavePayload {
  return readEditorStatePayload(editor.getEditorState(), reverse)
}

/**
 * 在指定的编辑器状态上导出正文与新增图片资源。
 *
 * @param state - 已提交的编辑器状态。
 * @param reverse - 显示地址到正文相对路径的映射。
 * @returns 保存所需正文与资源。
 */
export function readEditorStatePayload(
  state: EditorState,
  reverse: ReadonlyMap<string, string>,
): EditorSavePayload {
  const resources: KnowledgeDraftResource[] = []
  const text = state.read(() => $convertToMarkdownString(createExportTransformers(reverse, resources)))
  return { text: normalizeDocumentText(text), resources }
}

/**
 * 生成导出用的转换规则；图片规则需要收集新资源，因此每次导出单独创建。
 *
 * @param reverse - 显示地址到正文相对路径的映射。
 * @param resources - 收集新插入图片资源的数组，会被就地写入。
 * @returns 导出使用的转换规则。
 */
export function createExportTransformers(
  reverse: ReadonlyMap<string, string>,
  resources: KnowledgeDraftResource[],
): Transformer[] {
  return [...BASE_TRANSFORMERS, createImageExportTransformer(reverse, resources)]
}

/** 基础结构之外的自定义规则；图片只在载入时使用，导出时另行生成。 */
const IMAGE_IMPORT_TRANSFORMER: ElementTransformer = {
  type: 'element',
  dependencies: [ImageNode],
  regExp: IMAGE_PATTERN,
  export: (node) => ($isImageNode(node) ? imageMarkdown(node.getAlt(), node.getUrl()) : null),
  replace: (parentNode, _children, match) => {
    const url = match[2] ?? ''
    if (url === '') return false
    const alt = unescapeImageAlt(match[1] ?? '')
    parentNode.replace($createImageNode(url, alt === '' ? '图片' : alt, alt))
    return true
  },
}

/** 分隔线：载入 `---`/`***`/`___`，导出统一写 `---`。 */
const HORIZONTAL_RULE_TRANSFORMER: ElementTransformer = {
  type: 'element',
  dependencies: [HorizontalRuleNode],
  regExp: /^(?:---|\*\*\*|___)[ \t]*$/,
  export: (node) => ($isHorizontalRuleNode(node) ? '---' : null),
  replace: (parentNode) => {
    parentNode.replace($createHorizontalRuleNode())
    return true
  },
}

/** GFM 表格；载入时自己读取行，导出时逐单元格生成行内正文。 */
const TABLE_TRANSFORMER: MultilineElementTransformer = {
  type: 'multiline-element',
  dependencies: [TableNode, TableRowNode, TableCellNode],
  regExpStart: TABLE_START_PATTERN,
  export: (node, traverseChildren) =>
    $isTableNode(node) ? exportTable(node, traverseChildren) : null,
  handleImportAfterStartMatch: ({ lines, rootNode, startLineIndex }) =>
    importTable(lines, rootNode, startLineIndex),
  replace: () => false,
}

/** 代码围栏的语言标记；内置规则只认字母数字和连字符，`c++`、`c#` 等会被拆错。 */
const FENCE_START_PATTERN = /^([ \t]*`{3,})([^\s`]*)[ \t]?/

/** 内置规则可以正确处理的代码语言标记。 */
const SIMPLE_LANGUAGE_PATTERN = /^[\w-]*$/

/**
 * 围栏代码块载入：语言标记含 `+`、`#` 等字符时自行读取，
 * 避免内置规则把语言剩余部分当成代码内容（例如 `c++` 变成语言 c、内容多出 `++`）。
 */
const COMPLEX_FENCE_TRANSFORMER: MultilineElementTransformer = {
  type: 'multiline-element',
  dependencies: [CodeNode],
  regExpStart: FENCE_START_PATTERN,
  handleImportAfterStartMatch: ({ lines, rootNode, startLineIndex, startMatch }) => {
    const language = startMatch[2] ?? ''
    if (SIMPLE_LANGUAGE_PATTERN.test(language)) return null
    const fence = (startMatch[1] ?? '```').trim()
    const endPattern = new RegExp(`^[ \\t]*\`{${fence.length},}$`)
    const currentLine = lines[startLineIndex] ?? ''
    const afterFence = currentLine.slice(startMatch[0].length)
    let endLineIndex = -1
    for (let index = startLineIndex + 1; index < lines.length; index += 1) {
      if (endPattern.test(lines[index] ?? '')) {
        endLineIndex = index
        break
      }
    }
    const body = afterFence === '' ? [] : [afterFence]
    body.push(...lines.slice(startLineIndex + 1, endLineIndex === -1 ? lines.length : endLineIndex))
    while (body.length > 0 && body[body.length - 1] === '') body.pop()
    const codeNode = $createCodeNode(language)
    codeNode.append($createTextNode(body.join('\n')))
    rootNode.append(codeNode)
    return [true, endLineIndex === -1 ? lines.length - 1 : endLineIndex]
  },
  replace: () => false,
}

/** 段落导出：行首若会被重新载入当成标题、列表或分隔线，就补上转义，保证保存后再次打开结构不变。 */
const PARAGRAPH_TRANSFORMER: ElementTransformer = {
  type: 'element',
  dependencies: [],
  regExp: /(?!)/,
  export: (node, traverseChildren) =>
    $isParagraphNode(node) ? escapeParagraphLines(traverseChildren(node)) : null,
  replace: () => false,
}

/** 载入与导出共用的基础规则；导出时在末尾追加收集资源的图片规则。 */
const BASE_TRANSFORMERS: Transformer[] = [
  COMPLEX_FENCE_TRANSFORMER,
  ...TRANSFORMERS,
  TABLE_TRANSFORMER,
  HORIZONTAL_RULE_TRANSFORMER,
  PARAGRAPH_TRANSFORMER,
]

/** 载入正文使用的完整规则，包含把图片引用变成图片节点的规则。 */
export const IMPORT_TRANSFORMERS: Transformer[] = [...BASE_TRANSFORMERS, IMAGE_IMPORT_TRANSFORMER]

/**
 * 图片导出规则：已有图片还原为相对引用，新图片转为占位并收集资源。
 *
 * @param reverse - 显示地址到正文相对路径的映射。
 * @param resources - 收集新图片资源的数组。
 * @returns 导出用图片转换规则。
 */
function createImageExportTransformer(
  reverse: ReadonlyMap<string, string>,
  resources: KnowledgeDraftResource[],
): ElementTransformer {
  return {
    type: 'element',
    dependencies: [ImageNode],
    regExp: IMAGE_PATTERN,
    export: (node) => {
      if (!$isImageNode(node)) return null
      const url = node.getUrl()
      const relative = reverse.get(url)
      if (relative !== undefined) return imageMarkdown(node.getAlt(), relative)
      if (url.startsWith('data:image/')) {
        const separator = url.indexOf(';base64,')
        if (separator !== -1) {
          const placeholder = `${RESOURCE_PLACEHOLDER_PREFIX}${resources.length + 1}`
          resources.push({
            placeholder,
            fileName: node.getFileName(),
            dataBase64: url.slice(separator + ';base64,'.length),
          })
          return imageMarkdown(node.getAlt(), placeholder)
        }
      }
      return imageMarkdown(node.getAlt(), url)
    },
    replace: () => false,
  }
}

/** 生成一条图片引用；替代文字里的方括号与反斜杠需要转义。 */
function imageMarkdown(alt: string, url: string): string {
  return `![${alt.replace(/([[\]\\])/g, '\\$1')}](${url})`
}

/** 还原图片替代文字里的 Markdown 转义。 */
function unescapeImageAlt(alt: string): string {
  return alt.replace(/\\([!-/:-@[-`{-~])/g, '$1')
}

/**
 * 逐行转义段落的行首结构前缀；只有会被载入规则识别成块级结构的行才补反斜杠，
 * 避免破坏加粗、斜体等合法的行内格式。
 *
 * @param markdown - 段落的行内 Markdown，可能包含换行。
 * @returns 重新载入后结构不变的段落文本。
 */
function escapeParagraphLines(markdown: string): string {
  return markdown.split('\n').map(escapeParagraphLine).join('\n')
}

/** 判断单行是否需要转义；规则与载入时的块级正则一一对应。 */
function escapeParagraphLine(line: string): string {
  if (/^#{1,6}\s/.test(line)) return `\\${line}`
  if (/^[>+-]\s/.test(line)) return `\\${line}`
  if (/^\*\s/.test(line)) return `\\${line}`
  if (/^\d{1,9}[.)]\s/.test(line)) return line.replace(/^(\d{1,9})([.)])/, '$1\\$2')
  if (/^(?:---|\*\*\*|___)\s*$/.test(line)) return `\\${line}`
  if (line.startsWith('|')) return `\\${line}`
  return line
}

/**
 * 导出一个表格：首行为表头，其后是分隔行与数据行。
 *
 * @param table - 表格节点。
 * @param traverseChildren - 把元素节点内容导出为行内正文的回调。
 * @returns 表格正文；列数按最宽行对齐。
 */
function exportTable(
  table: TableNode,
  traverseChildren: (node: ElementNode) => string,
): string {
  const rows = table
    .getChildren()
    .filter((child): child is TableRowNode => $isTableRowNode(child))
    .map((row) =>
      row
        .getChildren()
        .filter((cell): cell is TableCellNode => $isTableCellNode(cell))
        .map((cell) => exportTableCell(cell, traverseChildren)),
    )
  const columns = rows.reduce((maximum, row) => Math.max(maximum, row.length), 1)
  const formatRow = (cells: string[]): string =>
    `| ${Array.from({ length: columns }, (_item, index) => cells[index] ?? '').join(' | ')} |`
  const [header = [], ...body] = rows
  const divider = formatRow(Array.from({ length: columns }, () => '---'))
  return [formatRow(header), divider, ...body.map(formatRow)].join('\n')
}

/** 单元格内容必须在一行内且不能带未转义的竖线，否则会破坏表格结构。 */
function exportTableCell(
  cell: TableCellNode,
  traverseChildren: (node: ElementNode) => string,
): string {
  return traverseChildren(cell).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim()
}

/**
 * 从连续的表格行创建表格节点；分隔行确认后才会消费这些行。
 *
 * @param lines - 正文的全部行。
 * @param rootNode - 当前导入的根节点。
 * @param startLineIndex - 表头所在行。
 * @returns 是否成功导入以及最后一行的下标；不是表格时返回 null 交给其它规则。
 */
function importTable(
  lines: string[],
  rootNode: ElementNode,
  startLineIndex: number,
): [boolean, number] | null {
  const header = lines[startLineIndex]
  const divider = lines[startLineIndex + 1]
  if (header === undefined || divider === undefined) return null
  if (!isTableRowDivider(divider.trimStart())) return null
  const rows = [splitTableRow(header)]
  let lastLineIndex = startLineIndex + 1
  for (let index = startLineIndex + 2; index < lines.length; index += 1) {
    const line = lines[index]
    if (line === undefined || line.trim() === '' || !line.includes('|')) break
    rows.push(splitTableRow(line))
    lastLineIndex = index
  }
  rootNode.append(createTable(rows))
  return [true, lastLineIndex]
}

/**
 * 按行创建矩形表格；首行标记为表头。
 *
 * @param rows - 每行的单元格文字。
 * @returns 已填充内容的表格节点。
 */
function createTable(rows: string[][]): TableNode {
  const columns = rows.reduce((maximum, row) => Math.max(maximum, row.length), 1)
  const table = $createTableNodeWithDimensions(rows.length, columns, {
    rows: true,
    columns: false,
  })
  const rowNodes = table.getChildren()
  rows.forEach((cells, rowIndex) => {
    const rowNode = rowNodes[rowIndex]
    if (rowNode === undefined || !$isTableRowNode(rowNode)) return
    const cellNodes = rowNode.getChildren()
    cells.forEach((text, columnIndex) => {
      const cell = cellNodes[columnIndex]
      if (cell === undefined || !$isTableCellNode(cell)) return
      fillTableCell(cell, text)
    })
  })
  return table
}

/** 用一个段落承载单元格文字；行内格式按正文规则解析。 */
function fillTableCell(cell: TableCellNode, text: string): void {
  const paragraph = $createParagraphNode()
  if (text !== '') appendInlineMarkdown(paragraph, text)
  cell.clear()
  cell.append(paragraph)
}

/**
 * 把一段行内正文解析为格式化文本节点并放入段落。
 *
 * @param paragraph - 承载内容的段落。
 * @param text - 单元格文字。
 */
function appendInlineMarkdown(paragraph: ParagraphNode, text: string): void {
  for (const node of $generateNodesFromMarkdownString(text, INLINE_TRANSFORMERS)) {
    if ($isParagraphNode(node)) paragraph.append(...node.getChildren())
    else if ($isElementNode(node) || $isTextNode(node)) paragraph.append(node)
    else paragraph.append($createTextNode(node.getTextContent()))
  }
}

/**
 * 按未转义的竖线拆分表格行。
 *
 * @param line - 一行表格正文。
 * @returns 单元格文字；首尾竖线不产生空单元格。
 */
function splitTableRow(line: string): string[] {
  let value = line.trim()
  if (value.startsWith('|')) value = value.slice(1)
  if (value.endsWith('|') && !value.endsWith('\\|')) value = value.slice(0, -1)
  const cells: string[] = []
  let current = ''
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? ''
    if (character === '\\' && value[index + 1] === '|') {
      current += '|'
      index += 1
      continue
    }
    if (character === '|') {
      cells.push(current.trim())
      current = ''
      continue
    }
    current += character
  }
  cells.push(current.trim())
  return cells
}
