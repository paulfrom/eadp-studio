import { createHash } from 'node:crypto'
import { open, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { OfficeSourceKey, type OfficeExtension } from '@deepseek-ai/dsh-office-to-pdf'
import type { ScenarioSourceRead } from '../../application/ports.ts'

const MAX_FILE_BYTES = 50 * 1024 * 1024
const MAX_TEXT_CHARACTERS = 250_000
const MAX_PDF_PAGES = 300
const OFFICE_EXTENSIONS = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'])
const TEXT_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'xml', 'yaml', 'yml', 'log'])
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif'])
const failed = (error: string): ScenarioSourceRead => ({ status: 'failed', ranges: [], text: '', error })
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** Bound file reads before allocation; imported source paths are owned by Host. */
async function sourceBytes(filename: string, maxBytes = MAX_FILE_BYTES): Promise<Uint8Array> {
  const handle = await open(filename, 'r')
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > maxBytes) throw new Error('资料必须是 50 MB 以内的普通文件')
    const bytes = new Uint8Array(info.size + 1)
    let offset = 0
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, null)
      if (result.bytesRead === 0) break
      offset += result.bytesRead
    }
    if (offset > info.size || (await handle.stat()).size !== info.size) throw new Error('资料读取期间发生变化，请重新导入')
    return bytes.slice(0, offset)
  } finally { await handle.close() }
}

/** Extract actual PDF text and retain exact page coverage, including omissions. */
async function pdfText(bytes: Uint8Array): Promise<ScenarioSourceRead> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const packageUrl = import.meta.resolve('pdfjs-dist/package.json')
  // pdfjs appends a file name to each asset directory, so the setting keeps its
  // trailing separator, which a filesystem path conversion would drop.
  const assetDirectory = (name: string): string => `${fileURLToPath(new URL(name, packageUrl)).replaceAll('\\', '/').replace(/\/?$/, '/')}`
  const loading = getDocument({ data: bytes, useSystemFonts: false, disableFontFace: true,
    standardFontDataUrl: assetDirectory('standard_fonts/'),
    cMapUrl: assetDirectory('cmaps/'), cMapPacked: true, useWorkerFetch: false })
  const ranges: string[] = [], parts: string[] = [], missing: number[] = []
  let count = 0, truncated = false
  try {
    const document = await loading.promise
    const pageLimit = Math.min(document.numPages, MAX_PDF_PAGES)
    for (let number = 1; number <= pageLimit; number++) {
      const page = await document.getPage(number)
      try {
        const content = await page.getTextContent()
        const text = content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('').trim()
        if (!text) { missing.push(number); continue }
        const remaining = MAX_TEXT_CHARACTERS - count
        if (text.length > remaining) { parts.push(`[第 ${number} 页，部分文字]\n${text.slice(0, remaining)}`); ranges.push(`page:${number}:partial`); truncated = true; break }
        parts.push(`[第 ${number} 页]\n${text}`); ranges.push(`page:${number}`); count += text.length
      } finally { page.cleanup() }
    }
    if (!parts.length) return failed('PDF 未提取到文字；扫描页、图形、图片与公式尚未读取，不能作为已读依据')
    truncated ||= document.numPages > pageLimit
    const limitations = [
      ...(missing.length ? [`第 ${missing.join('、')} 页没有可提取文字`] : []),
      ...(truncated ? ['文字或页数超过读取上限，仅上述范围已读'] : []),
      '仅提取文字；内嵌图片、图表视觉信息与公式语义未读取',
    ]
    // PDF text extraction cannot attest that charts or raster contents were read.
    return { status: 'partial', ranges, text: parts.join('\n\n'), error: limitations.join('；') }
  } finally { await loading.destroy() }
}

/** Reuse DSH's shared Office converter and its document preview's PDF engine. */
export async function readScenarioSource(ctx: Context, source: { path: string; name: string }): Promise<ScenarioSourceRead> {
  const extension = path.extname(source.name).slice(1).toLowerCase()
  if (IMAGE_EXTENSIONS.has(extension)) return failed('图片尚未发送给支持图片的模型；请在场景会话中使用原生 read_image 读取此资料')
  try {
    if (OFFICE_EXTENSIONS.has(extension)) {
      const converter = ctx.get('officeToPdf')
      if (!converter) return failed('当前 DSH 未启用 Office 转换服务，办公资料未读取')
      const info = await stat(source.path)
      if (!info.isFile() || info.size > MAX_FILE_BYTES) return failed('办公资料必须是 50 MB 以内的普通文件')
      const version = `${info.size}:${info.mtimeMs}:${info.ctimeMs}`
      const result = await converter.convert({ extension: extension as OfficeExtension, priority: 'foreground', source: {
        key: OfficeSourceKey(JSON.stringify(['studio-import', path.resolve(source.path)])), version, bytes: info.size,
        read: async (signal, maxBytes) => {
          signal.throwIfAborted()
          const bytes = await sourceBytes(source.path, maxBytes)
          const current = await stat(source.path)
          signal.throwIfAborted()
          return { bytes, version: `${current.size}:${current.mtimeMs}:${current.ctimeMs}` }
        },
      } })
      const extracted = await pdfText(result.pdf)
      if (result.missingFonts.length && extracted.status !== 'failed') extracted.error += `；转换缺少字体：${result.missingFonts.join('、')}`
      return extracted
    }
    const bytes = await sourceBytes(source.path)
    if (extension === 'pdf') return await pdfText(bytes)
    if (!TEXT_EXTENSIONS.has(extension)) return failed(`暂不支持实际读取 .${extension || '未知'} 格式，请转换为文本或受支持的办公资料`)
    const full = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (full.includes('\0')) return failed('资料包含二进制内容，不能按文本读取')
    const text = full.slice(0, MAX_TEXT_CHARACTERS), partial = text.length !== full.length
    return { status: partial ? 'partial' : 'read', text,
      ranges: [`lines:1-${text.split('\n').length}${partial ? ':partial' : ''}; sha256:${hash(bytes)}`],
      ...(partial ? { error: '文字超过读取上限，仅上述范围已读' } : {}),
    }
  } catch (error) { return failed(`资料读取失败：${error instanceof Error ? error.message : String(error)}`) }
}
