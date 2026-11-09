/**
 * 由 canonical 正文生成索引片段：结构切片 + 词项检索副本。
 *
 * 只在 worker 内运行；发布前的内容身份核验由 Host 完成。切片与词项共用
 * tokenizer／chunk 的定义，保证与查询侧一致。
 */
import type { IndexedDocument } from '../store.ts'
import type { ChunkRange } from './chunk.ts'
import { chunkMarkdown } from './chunk.ts'
import { chunkKeyOf, sha256 } from './identity.ts'
import { normalize, tokenizeText } from './tokenizer.ts'

/** 已构建的片段：包含发布所需的全部列。 */
export interface BuiltChunk {
  chunkKey: string
  ordinal: number
  start: number
  end: number
  contextRanges: ChunkRange[]
  headingPath: string[]
  content: string
  contentHash: string
  /** 词项列：预分词后以空格分隔，写入 FTS5。 */
  wordsText: string
  bigramsText: string
  /** 精确通道检索副本：NFKC + 小写后的章节路径与正文。 */
  exactText: string
}

/**
 * 生成一份资料的全部片段。
 * @param document - Host 已核对的内容输入。
 * @returns 按正文顺序排列的片段；正文无结构时按整篇一个片段兜底，不静默丢内容。
 */
export function buildChunks(document: IndexedDocument): BuiltChunk[] {
  const structural = chunkMarkdown(document.text)
  if (structural.length === 0) {
    const content = document.text
    const length = Array.from(content).length
    return [buildChunk(document.bodyHash, 0, { start: 0, end: length }, [], [], '', content)]
  }
  return structural.map((chunk, ordinal) =>
    buildChunk(document.bodyHash, ordinal, chunk, chunk.headingPath, chunk.contextRanges, chunk.contextText, chunk.content))
}

/** 单个片段：词项来自章节路径、附加上下文与正文，正文范围保持真实。 */
function buildChunk(
  bodyHash: string,
  ordinal: number,
  range: ChunkRange,
  headingPath: string[],
  contextRanges: ChunkRange[],
  contextText: string,
  content: string,
): BuiltChunk {
  const contentHash = sha256(content)
  const searchText = [headingPath.join('\n'), contextText, content].filter(part => part.trim() !== '').join('\n')
  const terms = tokenizeText(searchText)
  return {
    chunkKey: chunkKeyOf(bodyHash, range.start, range.end, contentHash),
    ordinal,
    start: range.start,
    end: range.end,
    contextRanges: contextRanges.map(context => ({ ...context })),
    headingPath: [...headingPath],
    content,
    contentHash,
    wordsText: terms.words.join(' '),
    bigramsText: terms.bigrams.join(' '),
    exactText: normalize(searchText),
  }
}
