/**
 * 内容签名识别：扩展名只作线索，先按文件签名和容器结构判断真实格式。
 *
 * 识别失败时抛出 `ConvertFailure`，由 convert/index 统一转成用户可读的失败结果；
 * 这里不猜格式，也不把二进制文件当文本硬解。
 */
import { emptyDocument, parseFailed, unsupported } from './failure.ts'
import { decodePlainText } from './text.ts'

/** 支持的自动整理格式。 */
export type ConvertFormat = 'markdown' | 'text' | 'html' | 'csv' | 'docx' | 'xlsx' | 'pptx' | 'pdf'

/** 按内容判断是否为纯文本类格式，供“查看原件”的文本预览使用。 */
export function isTextFormat(format: ConvertFormat): boolean {
  return format === 'markdown' || format === 'text' || format === 'html' || format === 'csv'
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false
  return prefix.every((value, index) => bytes[index] === value)
}

/** 在字节区间上取 ASCII 字符串，用于容器魔数判断。 */
function ascii(bytes: Uint8Array, start: number, end: number): string {
  let output = ''
  for (let index = start; index < Math.min(end, bytes.length); index += 1) {
    const value = bytes[index]
    if (value === undefined) break
    output += String.fromCharCode(value)
  }
  return output
}

/** 已知图片签名；图片一律进入“需要处理”，不声称能识别文字。 */
function imageSignature(bytes: Uint8Array): string | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png'
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg'
  const gif = ascii(bytes, 0, 6)
  if (gif === 'GIF87a' || gif === 'GIF89a') return 'gif'
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'webp'
  if (startsWith(bytes, [0x42, 0x4d])) return 'bmp'
  if (ascii(bytes, 0, 4) === 'II*\0' || ascii(bytes, 0, 4) === 'MM\0*') return 'tiff'
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00])) return 'ico'
  if (startsWith(bytes, [0x38, 0x42, 0x50, 0x53])) return 'psd'
  if (ascii(bytes, 4, 8) === 'ftyp') {
    const brand = ascii(bytes, 8, 12)
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'avif', 'avis'].includes(brand)) return `heif/${brand}`
  }
  if (startsWith(bytes, [0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20])) return 'jpeg2000'
  return undefined
}

/** 文件扩展名（小写、去点）；没有扩展名时返回空串。 */
function extensionOf(fileName: string): string {
  const base = fileName.replace(/\\/g, '/').split('/').pop() ?? ''
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return ''
  return base.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** 文件类型提示可以是扩展名、文件名或 MIME；只取其中可用的线索。 */
function extensionHint(fileTypeHint: string | undefined): string {
  if (fileTypeHint === undefined) return ''
  const hint = fileTypeHint.trim().toLowerCase()
  if (hint.startsWith('.')) return hint.slice(1)
  if (hint.includes('/')) return hint
  if (hint.includes('.')) return extensionOf(hint)
  return hint
}

const MIME_FORMATS: Readonly<Record<string, ConvertFormat>> = {
  'application/pdf': 'pdf',
  'application/msword': 'docx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xlsx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'pptx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'text/markdown': 'markdown',
  'text/x-markdown': 'markdown',
  'text/html': 'html',
  'text/csv': 'csv',
  'text/tab-separated-values': 'csv',
  'text/plain': 'text',
}

/** 文本类文件按扩展名细分，再按内容特征兜底判断网页。 */
function classifyText(text: string, extension: string, hint: string): ConvertFormat {
  const fromMime = MIME_FORMATS[hint]
  if (fromMime !== undefined) return fromMime
  switch (extension) {
    case 'md':
    case 'markdown':
    case 'mdown':
    case 'mkd':
      return 'markdown'
    case 'html':
    case 'htm':
    case 'xhtml':
    case 'shtml':
      return 'html'
    case 'csv':
    case 'tsv':
      return 'csv'
    default:
      break
  }
  if (looksLikeHtml(text)) return 'html'
  return 'text'
}

function looksLikeHtml(text: string): boolean {
  const head = text.slice(0, 2048)
  if (/^\s*<!doctype\s+html/i.test(head) || /^\s*<html[\s>]/i.test(head)) return true
  return /^\s*</.test(head) && /<(?:body|head|title|div|p|table|span)\b/i.test(head)
}

function looksLikeSvg(text: string): boolean {
  return /<svg[\s>]/i.test(text.slice(0, 4096))
}

/** 采样字节里控制字符的占比；用来拒绝把二进制文件当文本硬解。 */
function looksBinary(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 8192))
  let controls = 0
  for (const value of sample) {
    if (value === 0x09 || value === 0x0a || value === 0x0d) continue
    if (value < 0x20) controls += 1
  }
  return controls / sample.length > 0.02
}

/** ZIP 容器按内部结构识别 Office 格式；其余压缩包明确不支持。 */
async function detectZip(bytes: Uint8Array): Promise<ConvertFormat> {
  const { default: JSZipService } = await import('jszip')
  let zip: Awaited<ReturnType<typeof JSZipService.loadAsync>>
  try {
    zip = await JSZipService.loadAsync(bytes)
  }
  catch (error) {
    parseFailed(
      '文件已加密或已损坏，暂时无法整理；可以查看原件、重试或手工整理成文档。',
      `zip open failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const names = new Set(Object.keys(zip.files))
  if (names.has('word/document.xml')) return 'docx'
  if (names.has('xl/workbook.xml')) return 'xlsx'
  if (names.has('ppt/presentation.xml')) return 'pptx'
  const sample = [...names].slice(0, 8).join(', ')
  unsupported(
    '这种压缩文件暂不能自动整理；可以查看原件、重试或手工整理成文档。',
    `zip container without supported office part (entries: ${sample})`,
  )
}

/**
 * 识别文件真实格式。
 * @param fileName - 原始文件名，只用于扩展名线索。
 * @param fileTypeHint - 可选的文件类型提示（扩展名或 MIME），优先级低于内容签名。
 * @param bytes - 文件原始字节。
 * @returns 识别出的格式。
 * @throws {ConvertFailure} 空文件、图片、旧版 Office、加密/损坏文件或无法识别的内容。
 */
export async function detectFormat(fileName: string, fileTypeHint: string | undefined, bytes: Uint8Array): Promise<ConvertFormat> {
  if (bytes.length === 0) emptyDocument('文件是空的，没有可整理的内容。', 'empty byte sequence')

  const image = imageSignature(bytes)
  if (image !== undefined) {
    unsupported(
      '这是图片文件，暂未提供识别图片文字的能力；可以查看原件、重试或手工整理成文档。',
      `image signature detected: ${image}`,
    )
  }

  const head = bytes.subarray(0, Math.min(bytes.length, 1024))
  if (ascii(head, 0, head.length).includes('%PDF-')) return 'pdf'

  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]))
    return await detectZip(bytes)

  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    unsupported(
      '旧版 Office 文件需要先另存为新格式再导入；也可以查看原件、手工整理成文档。',
      'OLE compound document signature detected (legacy Office binary)',
    )
  }

  const extension = extensionOf(fileName)
  const hint = extensionHint(fileTypeHint)
  const utf16Bom = startsWith(bytes, [0xff, 0xfe]) || startsWith(bytes, [0xfe, 0xff])
  if (!utf16Bom && looksBinary(bytes)) {
    unsupported(
      '暂时无法自动整理这种文件；可以查看原件、重试或手工整理成文档。',
      `binary content without supported signature (first bytes: ${ascii(bytes, 0, 8).replace(/[^\x20-\x7e]/g, '.')})`,
    )
  }

  let text: string
  try {
    text = decodePlainText(bytes).text
  }
  catch (error) {
    unsupported(
      '暂时无法自动整理这种文件；可以查看原件、重试或手工整理成文档。',
      `text decode failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (text.trim() === '') emptyDocument('文件是空的，没有可整理的内容。', 'file contains only whitespace')
  if (looksLikeSvg(text)) {
    unsupported(
      '这是图片文件，暂未提供识别图片文字的能力；可以查看原件、重试或手工整理成文档。',
      'svg image content detected',
    )
  }
  return classifyText(text, extension, hint)
}

const DISPLAY_TYPES: Readonly<Record<string, string>> = {
  pdf: 'PDF 文档',
  doc: 'Word 文档',
  docx: 'Word 文档',
  xls: 'Excel 表格',
  xlsx: 'Excel 表格',
  xlsm: 'Excel 表格',
  csv: '表格文件',
  tsv: '表格文件',
  ppt: '演示文稿',
  pptx: '演示文稿',
  md: '文本文件',
  markdown: '文本文件',
  txt: '文本文件',
  text: '文本文件',
  log: '文本文件',
  json: '文本文件',
  xml: '文本文件',
  html: '网页文件',
  htm: '网页文件',
  png: '图片',
  jpg: '图片',
  jpeg: '图片',
  gif: '图片',
  webp: '图片',
  bmp: '图片',
  tif: '图片',
  tiff: '图片',
  svg: '图片',
  heic: '图片',
  zip: '压缩文件',
  rar: '压缩文件',
  '7z': '压缩文件',
}

/** 给“来源与原件”展示的猜类型文字；猜不到时只说“文件”。 */
export function describeFileType(fileName: string): string {
  return DISPLAY_TYPES[extensionOf(fileName)] ?? '文件'
}
