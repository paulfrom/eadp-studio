/**
 * PDF 解析：pdfjs-dist 逐页提取文字，按行距合并成段落并记录页码。
 *
 * 扫描件没有可直接读取的文字，明确提示暂未提供识别图片文字的能力；
 * 加密 PDF 明确失败，不尝试绕过密码。
 */
import { createRequire } from 'node:module'
import { dirname, join, sep } from 'node:path'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import type { ConvertBlock, ConvertedDocument } from './blocks.ts'
import { diagnosticOf, parseFailed, unsupported } from './failure.ts'

/** 标准字体数据目录：pdfjs 按“前缀 + 文件名”拼路径读文件，必须以 `/` 结尾。 */
function standardFontDataUrl(): string {
  const packageJson = createRequire(import.meta.url).resolve('pdfjs-dist/package.json')
  return `${join(dirname(packageJson), 'standard_fonts').split(sep).join('/')}/`
}

/** pdfjs 文本项在本模块用到的最小字段面。 */
type PdfTextItem = Extract<Awaited<ReturnType<PDFPageProxy['getTextContent']>>['items'][number], { str: string }>

/** 同一行内相邻文本片段拼起来；只在明确是拉丁词边界时补空格。 */
function joinRuns(parts: readonly { text: string }[]): string {
  let output = ''
  for (const part of parts) {
    if (output !== '' && !/\s$/.test(output) && !/^\s/.test(part.text)) {
      const left = output.charAt(output.length - 1)
      const right = part.text.charAt(0)
      if (/[A-Za-z0-9]/.test(left) && /[A-Za-z0-9]/.test(right)) output += ' '
    }
    output += part.text
  }
  return output.trim()
}

/** 中文与全角标点之间不补空格，避免把换行折行拼成多余空格。 */
function needsSpace(current: string, next: string): boolean {
  const left = current.charAt(current.length - 1)
  const right = next.charAt(0)
  if (/[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef]/.test(left) && /[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef]/.test(right)) return false
  if (/[\u3000-\u303f\uff00-\uffef]/.test(right)) return false
  return !/\s$/.test(current) && !/^\s/.test(next)
}

/** 把页面文本片段按 y 坐标归并成行，再按行距合并成段落。 */
function pageParagraphs(items: readonly PdfTextItem[]): string[] {
  const lines: { y: number; height: number; parts: { x: number; text: string }[] }[] = []
  for (const item of items) {
    const text = item.str
    if (text.trim() === '') continue
    const x = item.transform[4] ?? 0
    const y = item.transform[5] ?? 0
    const height = Math.abs(item.transform[3] ?? 0) || item.height || 10
    const last = lines[lines.length - 1]
    if (last !== undefined && Math.abs(last.y - y) <= Math.max(1, height * 0.3)) {
      last.parts.push({ x, text })
      last.height = Math.max(last.height, height)
    }
    else {
      lines.push({ y, height, parts: [{ x, text }] })
    }
  }
  // PDF 坐标从下往上：y 越大越靠上。
  lines.sort((left, right) => right.y - left.y)
  const paragraphs: string[] = []
  let current = ''
  let previous: { y: number; height: number } | undefined
  for (const line of lines) {
    const text = joinRuns([...line.parts].sort((left, right) => left.x - right.x))
    if (text === '') continue
    // 常规行距约为一倍字号，段间距更大：取 1.6 倍较大字号与 2 倍较小字号的上限，
    // 既能把折行拼回段落，又不会把标题和正文并成一段。
    const gap = previous === undefined ? 0 : previous.y - line.y
    const threshold = previous === undefined
      ? 0
      : Math.max(Math.max(previous.height, line.height) * 1.6, Math.min(previous.height, line.height) * 2)
    if (previous === undefined || gap > threshold) {
      if (current !== '') paragraphs.push(current)
      current = text
    }
    else {
      current += needsSpace(current, text) ? ` ${text}` : text
    }
    previous = { y: line.y, height: line.height }
  }
  if (current !== '') paragraphs.push(current)
  return paragraphs
}

/** 解析 PDF 文件。 */
export async function parsePdf(bytes: Uint8Array): Promise<ConvertedDocument> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const loadingTask = getDocument({
    data: bytes,
    standardFontDataUrl: standardFontDataUrl(),
    useSystemFonts: true,
    disableFontFace: true,
    useWorkerFetch: false,
    verbosity: 0,
  })
  let document: PDFDocumentProxy
  try {
    document = await loadingTask.promise
  }
  catch (error) {
    await loadingTask.destroy().catch(() => undefined)
    const name = error instanceof Error ? error.name : ''
    if (name === 'PasswordException') {
      parseFailed(
        '文件已加密，暂时无法整理；可以查看原件、重试或手工整理成文档。',
        `pdfjs password required: ${diagnosticOf(error)}`,
      )
    }
    parseFailed(
      '无法读取 PDF 文件，文件可能已损坏；可以查看原件、重试或手工整理成文档。',
      `pdfjs getDocument failed (${name || 'unknown'}): ${diagnosticOf(error)}`,
    )
  }

  const blocks: ConvertBlock[] = []
  let emptyPages = 0
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber)
      const content = await page.getTextContent()
      const items = content.items.filter((item): item is PdfTextItem => 'str' in item && typeof item.str === 'string')
      const paragraphs = pageParagraphs(items)
      page.cleanup()
      if (paragraphs.length === 0) {
        emptyPages += 1
        continue
      }
      const locator = { page: pageNumber, label: `第 ${pageNumber} 页` }
      for (const paragraph of paragraphs)
        blocks.push({ kind: 'paragraph', text: paragraph, locator })
    }
  }
  finally {
    await loadingTask.destroy().catch(() => undefined)
  }

  if (blocks.length === 0) {
    unsupported(
      '文件里没有可直接读取的文字，可能是扫描件或图片；暂未提供识别图片文字的能力，可以查看原件、重试或手工整理成文档。',
      `pdf has ${document.numPages} pages but no extractable text`,
    )
  }
  const warnings: string[] = []
  if (emptyPages > 0) warnings.push(`有 ${emptyPages} 页没有可直接读取的文字，可查看原件。`)
  return { blocks, warnings }
}
