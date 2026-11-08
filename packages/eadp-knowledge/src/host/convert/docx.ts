/**
 * Word（.docx）解析：mammoth 转 HTML，再走 HTML → Markdown → 结构块。
 *
 * 图片不提取（避免把二进制资源写进正文），只统计数量并提示查看原件。
 */
import mammoth from 'mammoth'
import type { ConvertedDocument } from './blocks.ts'
import { diagnosticOf, emptyDocument, parseFailed } from './failure.ts'
import { htmlToBlocks } from './html.ts'

/** 解析 Word 文档；失败时抛出可直接展示给用户的转换失败。 */
export async function parseDocx(bytes: Uint8Array): Promise<ConvertedDocument> {
  let images = 0
  let html: string
  try {
    const result = await mammoth.convertToHtml(
      { buffer: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) },
      {
        ignoreEmptyParagraphs: true,
        // 图片不落正文：返回空 src，turndown 会丢掉该节点，数量用于警告。
        convertImage: mammoth.images.imgElement(() => {
          images += 1
          return Promise.resolve({ src: '' })
        }),
      },
    )
    html = result.value
  }
  catch (error) {
    parseFailed(
      '无法读取 Word 文档，文件可能已损坏或受保护；可以查看原件、重试或手工整理成文档。',
      `mammoth convertToHtml failed: ${diagnosticOf(error)}`,
    )
  }
  const parsed = htmlToBlocks(html)
  const warnings = [...parsed.warnings]
  if (images > 0) warnings.push(`文中有 ${images} 张图片未一并导入，可查看原件。`)
  if (parsed.blocks.length === 0)
    emptyDocument('文件里没有可整理的正文内容，可查看原件、重试或手工整理成文档。', 'docx converted to an empty document')
  return { blocks: parsed.blocks, warnings }
}
