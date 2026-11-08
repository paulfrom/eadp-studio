/**
 * Excel（.xlsx）解析：exceljs 读取工作簿。
 *
 * 每个工作表输出一个二级标题 + 一张表格；行、列超过上限时截断并写警告，
 * 单元格内容按显示文本转成行内 Markdown。
 */
import ExcelJS from 'exceljs'
import type { ConvertBlock, ConvertedDocument } from './blocks.ts'
import { diagnosticOf, emptyDocument, parseFailed } from './failure.ts'
import { escapeHeadingText, escapeInlineText, escapeTableCell } from './render.ts'

/** 单个工作表最多整理的数据行数（含表头），其余内容提示查看原件。 */
const MAX_ROWS = 201

/** 单个工作表最多整理的列数。 */
const MAX_COLUMNS = 30

/** 把 Uint8Array 转成 exceljs 读取接口需要的 ArrayBuffer；共享底层时直接借用。 */
function arrayBufferOf(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer)
    return bytes.buffer
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

/** 日期按 UTC 输出，保证同一文件在任何时区整理结果一致。 */
function formatDate(value: Date): string {
  const iso = value.toISOString()
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')
}

/** 公式结果、共享字符串等对象值转成可读文本；无法读取的部分留空。 */
function cellText(cell: ExcelJS.Cell): string {
  const value = cell.value
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return formatDate(value)
  if (typeof value === 'object') {
    if ('richText' in value) return value.richText.map(part => part.text).join('')
    if ('text' in value) return String(value.text)
    if ('result' in value) {
      const result = value.result
      if (result === null || result === undefined) return ''
      if (result instanceof Date) return formatDate(result)
      if (typeof result === 'object') return ''
      return String(result)
    }
    return ''
  }
  return String(value)
}

/** 一个工作表的行数据；跳过整行为空的记录。 */
function sheetRows(sheet: ExcelJS.Worksheet): string[][] {
  const usedRows = Math.min(Math.max(sheet.actualRowCount, 1), MAX_ROWS)
  const usedColumns = Math.min(Math.max(sheet.columnCount, 1), MAX_COLUMNS)
  const rows: string[][] = []
  for (let rowIndex = 1; rowIndex <= usedRows; rowIndex += 1) {
    const row = sheet.getRow(rowIndex)
    const cells: string[] = []
    for (let columnIndex = 1; columnIndex <= usedColumns; columnIndex += 1)
      cells.push(escapeTableCell(cellText(row.getCell(columnIndex))))
    while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop()
    if (cells.some(value => value !== '')) rows.push(cells)
  }
  return rows
}

/** 解析 Excel 工作簿；每个工作表一个标题 + 表格。 */
export async function parseXlsx(bytes: Uint8Array): Promise<ConvertedDocument> {
  const workbook = new ExcelJS.Workbook()
  try {
    await workbook.xlsx.load(arrayBufferOf(bytes))
  }
  catch (error) {
    parseFailed(
      '无法读取表格文件，文件可能已损坏或受保护；可以查看原件、重试或手工整理成文档。',
      `exceljs load failed: ${diagnosticOf(error)}`,
    )
  }

  const blocks: ConvertBlock[] = []
  const warnings: string[] = []
  for (const sheet of workbook.worksheets) {
    const rows = sheetRows(sheet)
    if (rows.length === 0) continue
    const locator = { sheet: sheet.name, label: `工作表「${sheet.name}」` }
    const heading = escapeHeadingText(sheet.name) || '未命名工作表'
    blocks.push({ kind: 'heading', level: 2, text: heading, locator })
    // 合并单元格的标题行在每列重复同一内容，不能当表头；先作为一段文字保留。
    let titleRow: string | undefined
    if (rows.length >= 2) {
      const first = rows[0] ?? []
      const filled = first.filter(value => value !== '')
      if (filled.length >= 3 && new Set(filled).size === 1) {
        titleRow = filled[0]
        rows.shift()
      }
    }
    if (titleRow !== undefined && titleRow !== '')
      blocks.push({ kind: 'paragraph', text: escapeInlineText(titleRow), locator })
    const header = rows[0] ?? []
    const body = rows.slice(1)
    const width = Math.max(header.length, ...body.map(row => row.length))
    while (header.length < width) header.push('')
    for (const row of body) while (row.length < width) row.push('')
    blocks.push({ kind: 'table', header, rows: body, locator })
    if (sheet.actualRowCount >= MAX_ROWS || sheet.columnCount > MAX_COLUMNS) {
      const rowLimit = MAX_ROWS - 1
      warnings.push(`工作表「${sheet.name}」内容较多，只整理了前 ${rowLimit} 行、${MAX_COLUMNS} 列；其余内容可查看原件。`)
    }
  }
  if (blocks.length === 0)
    emptyDocument('文件里没有可整理的表格内容，可查看原件、重试或手工整理成文档。', 'xlsx contains no non-empty worksheet')
  return { blocks, warnings }
}
