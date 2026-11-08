/**
 * 纯文本解码与分段。
 *
 * 所有文本类格式（Markdown / HTML / CSV / 纯文本）共用这里的解码规则：
 * 先按 UTF-8 严格解码，再尝试 UTF-16 BOM，最后按 GB18030 回退，
 * 保证中文文档不会因为编码不同被误判成损坏。
 */
import type { ConvertBlock, ConvertedDocument } from './blocks.ts'
import { emptyDocument, parseFailed } from './failure.ts'
import { escapeInlineText } from './render.ts'

/** 解码结果；`warnings` 记录编码回退这类需要持续展示的提示。 */
export interface DecodedText {
  text: string
  warnings: string[]
}

const UTF8_BOM = [0xef, 0xbb, 0xbf]
const UTF16_LE_BOM = [0xff, 0xfe]
const UTF16_BE_BOM = [0xfe, 0xff]

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false
  return prefix.every((value, index) => bytes[index] === value)
}

/** 统一换行符并去掉会让存储层拒绝的控制字符。 */
function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/\uFEFF/g, '')
}

function decodeStrict(label: string, bytes: Uint8Array): string {
  return new TextDecoder(label, { fatal: true }).decode(bytes)
}

/**
 * 把字节解码成文本。
 * @param bytes - 文件原始字节。
 * @returns 文本（换行已规范化）与编码相关警告。
 * @throws {ConvertFailure} 文件为空或无法按已知编码读取。
 */
export function decodePlainText(bytes: Uint8Array): DecodedText {
  if (bytes.length === 0) emptyDocument('文件是空的，没有可整理的内容。', 'empty byte sequence')
  if (startsWith(bytes, UTF8_BOM))
    return { text: normalizeText(decodeStrict('utf-8', bytes.subarray(UTF8_BOM.length))), warnings: [] }
  if (startsWith(bytes, UTF16_LE_BOM) || startsWith(bytes, UTF16_BE_BOM)) {
    const encoding = startsWith(bytes, UTF16_LE_BOM) ? 'utf-16le' : 'utf-16be'
    return { text: normalizeText(decodeStrict(encoding, bytes.subarray(2))), warnings: [] }
  }
  try {
    return { text: normalizeText(decodeStrict('utf-8', bytes)), warnings: [] }
  }
  catch {
    // 不是合法 UTF-8，继续尝试常见中文编码；失败原因由最后一个分支统一给出。
  }
  try {
    const text = normalizeText(decodeStrict('gb18030', bytes))
    return { text, warnings: ['文件文字按常见中文编码读取，个别字符可能显示不一致。'] }
  }
  catch (error) {
    parseFailed(
      '无法读取文件里的文字，文件可能已损坏；可以查看原件、重试或手工整理成文档。',
      `unsupported text encoding: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/** 按空行分段；段内单行换行保留为软换行，避免合并中文行时插入多余空格。 */
export function splitParagraphs(text: string): string[] {
  return text
    .split(/\n[ \t]*\n/)
    .map(block => block.replace(/[ \t]+$/gm, '').trim())
    .filter(block => block !== '')
}

/** 解析纯文本文件：每段一个段落块，不做结构猜测。 */
export function parseText(bytes: Uint8Array): ConvertedDocument {
  const decoded = decodePlainText(bytes)
  const blocks: ConvertBlock[] = splitParagraphs(decoded.text).map(paragraph => ({
    kind: 'paragraph',
    text: escapeInlineText(paragraph),
  }))
  if (blocks.length === 0)
    emptyDocument('文件里没有可整理的正文内容，可查看原件、重试或手工整理成文档。', 'text file contains no non-empty paragraph')
  return { blocks, warnings: decoded.warnings }
}
