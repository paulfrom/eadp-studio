/**
 * CSV / TSV 解析：自写 RFC 4180 状态机，不依赖第三方解析器。
 *
 * 首行作为表头；数据行超过上限时截断并在警告里写明保留范围。
 */
import type { ConvertBlock, ConvertedDocument } from './blocks.ts'
import { emptyDocument } from './failure.ts'
import { escapeInlineText, escapeTableCell } from './render.ts'
import { decodePlainText } from './text.ts'

/** 单个文件最多整理的数据行数（不含表头），其余内容提示查看原件。 */
const MAX_DATA_ROWS = 500

/** 用第一行的分隔符数量判断逗号还是制表符分隔。 */
function sniffDelimiter(text: string): string {
  const firstLine = text.split('\n', 1)[0] ?? ''
  const commas = (firstLine.match(/,/g) ?? []).length
  const tabs = (firstLine.match(/\t/g) ?? []).length
  return tabs > commas ? '\t' : ','
}

/** 解析 RFC 4180 行；超过 `limit` 行后停止并报告截断。 */
function parseRows(text: string, delimiter: string, limit: number): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = []
  let field = ''
  let row: string[] = []
  let quoted = false
  let index = 0
  const endRow = (): boolean => {
    row.push(field)
    field = ''
    if (!(row.length === 1 && row[0] === '')) rows.push(row)
    row = []
    return rows.length > limit
  }
  while (index < text.length) {
    const character = text[index]
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index += 2
          continue
        }
        quoted = false
        index += 1
        continue
      }
      field += character
      index += 1
      continue
    }
    if (character === '"' && field === '') {
      quoted = true
      index += 1
      continue
    }
    if (character === delimiter) {
      row.push(field)
      field = ''
      index += 1
      continue
    }
    if (character === '\n' || character === '\r') {
      if (endRow()) return { rows: rows.slice(0, limit), truncated: true }
      index += character === '\r' && text[index + 1] === '\n' ? 2 : 1
      continue
    }
    field += character
    index += 1
  }
  if (field !== '' || row.length > 0) {
    if (endRow()) return { rows: rows.slice(0, limit), truncated: true }
  }
  return { rows, truncated: false }
}

/** 把表格单元格整理成行内 Markdown，并转义会拆坏表格的竖线。 */
function cell(value: string): string {
  return escapeTableCell(escapeInlineText(value))
}

/** 解析 CSV / TSV 文件；分隔符按内容嗅探。 */
export function parseCsv(bytes: Uint8Array): ConvertedDocument {
  const decoded = decodePlainText(bytes)
  const delimiter = sniffDelimiter(decoded.text)
  const { rows, truncated } = parseRows(decoded.text, delimiter, MAX_DATA_ROWS + 1)
  if (rows.length === 0)
    emptyDocument('文件里没有可整理的表格内容，可查看原件、重试或手工整理成文档。', 'csv contains no rows')

  const header = (rows[0] ?? []).map(cell)
  const body = rows.slice(1).map(line => line.map(cell))
  const width = Math.max(header.length, ...body.map(line => line.length))
  while (header.length < width) header.push('')
  for (const line of body)
    while (line.length < width) line.push('')

  const blocks: ConvertBlock[] = [{ kind: 'table', header, rows: body }]
  const warnings = [...decoded.warnings]
  if (truncated) warnings.push(`内容较多，只整理了前 ${MAX_DATA_ROWS} 行；其余内容可查看原件。`)
  if (body.length === 0) warnings.push('文件只有表头行，没有可整理的数据行。')
  return { blocks, warnings }
}
