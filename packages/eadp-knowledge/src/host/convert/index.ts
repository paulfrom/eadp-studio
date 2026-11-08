/**
 * 转换入口：按内容签名识别格式、分派解析器，并做可保存性校验。
 *
 * `convertFile` 是 worker 内唯一入口：只做解析与渲染前校验，不接触存储、
 * 不做网络请求；失败统一转成面向用户的结果，技术细节只留在 diagnostic。
 */
import type { ConvertInput, ConvertedDocument, ConvertWorkerResult } from './blocks.ts'
import { parseCsv } from './csv.ts'
import { parseDocx } from './docx.ts'
import { detectFormat, isTextFormat } from './detect.ts'
import type { ConvertFormat } from './detect.ts'
import { ConvertFailure, diagnosticOf } from './failure.ts'
import { parseHtml } from './html.ts'
import { parseMarkdown } from './markdown.ts'
import { parsePdf } from './pdf.ts'
import { parsePptx } from './pptx.ts'
import { renderBlocks } from './render.ts'
import { decodePlainText, parseText } from './text.ts'
import { parseXlsx } from './xlsx.ts'

export type {
  ConvertBlock,
  ConvertedDocument,
  ConvertFailureCode,
  ConvertInput,
  ConvertWorkerResult,
  SourceLocator,
  SourceMapEntry,
  SourceMapFile,
} from './blocks.ts'
export type { ConvertFormat } from './detect.ts'
export { describeFileType, detectFormat, isTextFormat } from './detect.ts'
export { renderBlocks } from './render.ts'

/** 单份资料正文上限：与 store 的校验保持一致（UTF-8 字节）。 */
const MAX_BODY_BYTES = 2 * 1024 * 1024

/** 每种格式一个解析器；全部返回结构块，渲染统一走 render.ts。 */
const PARSERS: Readonly<Record<ConvertFormat, (bytes: Uint8Array) => Promise<ConvertedDocument> | ConvertedDocument>> = {
  markdown: parseMarkdown,
  text: parseText,
  html: parseHtml,
  csv: parseCsv,
  docx: parseDocx,
  xlsx: parseXlsx,
  pptx: parsePptx,
  pdf: parsePdf,
}

function emptyResult(): ConvertWorkerResult {
  return {
    ok: false,
    code: 'EMPTY',
    problem: '文件里没有可整理的正文内容，可查看原件、重试或手工整理成文档。',
    diagnostic: 'conversion produced no renderable block',
  }
}

/**
 * 把一个文件转换成结构块。
 * @param input - 文件名、可选类型提示与原始字节。
 * @returns 成功时返回结构块与警告；失败时返回用户可读说明与诊断。
 */
export async function convertFile(input: ConvertInput): Promise<ConvertWorkerResult> {
  try {
    const format = await detectFormat(input.fileName, input.fileTypeHint, input.bytes)
    const parsed = await PARSERS[format](input.bytes)
    if (parsed.blocks.length === 0) return emptyResult()
    const rendered = renderBlocks(parsed.blocks)
    if (rendered.text.trim() === '') return emptyResult()
    const bodyBytes = Buffer.byteLength(rendered.text, 'utf8')
    if (bodyBytes > MAX_BODY_BYTES) {
      return {
        ok: false,
        code: 'PARSE_FAILED',
        problem: '文档内容过大，暂时无法自动整理，可查看原件后手工整理。',
        diagnostic: `rendered markdown is ${bodyBytes} bytes, limit ${MAX_BODY_BYTES}`,
      }
    }
    return { ok: true, blocks: parsed.blocks, warnings: parsed.warnings }
  }
  catch (error) {
    if (error instanceof ConvertFailure)
      return { ok: false, code: error.code, problem: error.problem, diagnostic: error.diagnostic }
    return {
      ok: false,
      code: 'PARSE_FAILED',
      problem: '文件内容无法读取，可能已损坏；可以查看原件、重试或手工整理成文档。',
      diagnostic: diagnosticOf(error),
    }
  }
}

/**
 * 为“查看原件”生成可阅读的文本预览；非文本或无法解码时返回 null。
 * @param bytes - 原件字节。
 * @param maxChars - 最多返回的字符数。
 * @returns 文本预览或 null。
 */
export async function textPreview(bytes: Uint8Array, maxChars = 20000): Promise<string | null> {
  try {
    const format = await detectFormat('', undefined, bytes)
    if (!isTextFormat(format)) return null
    return Array.from(decodePlainText(bytes).text).slice(0, maxChars).join('')
  }
  catch {
    return null
  }
}
