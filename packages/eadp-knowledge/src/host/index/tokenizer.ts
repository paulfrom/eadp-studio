/**
 * 检索词项：NFKC + 小写检索副本、Intl.Segmenter 中文词段、Han bigram 与显式精确词。
 *
 * 索引侧与查询侧共用本模块，保证同一文本得到同一词项。词项只用于查找，不改动
 * canonical 正文；单字查询走独立的精确通道，不靠放大词项噪声解决。
 * 处理签名记录分词实现与运行时 ICU／Unicode 版本，签名变化时整库重建。
 */

/** 分词实现版本；分词规则或精度变化时递增。 */
const TOKENIZER_VERSION = 'tokenizer-v2'
/** 切片实现版本；结构合并规则变化时递增。 */
const CHUNKER_VERSION = 'chunker-v1'

/** 运行时分词能力签名；与 node:sqlite 无关，只记录影响词项的环境。 */
export const TOKENIZER_SIGNATURE = `${TOKENIZER_VERSION}|node=${process.versions.node}|icu=${process.versions.icu ?? 'none'}|unicode=${process.versions.unicode ?? 'none'}`
/** 一次索引结果的完整处理签名：切片与词项任一变化都必须重建。 */
export const PROCESSING_SIGNATURE = `${TOKENIZER_SIGNATURE}|${CHUNKER_VERSION}`

/** 词项长度上限：超长串多为误输入或编码噪声，不进入词项。 */
const MAX_TERM_CHARS = 64
/** 查询侧每类词项上限：避免一次查询构造过长的 MATCH 表达式。 */
const MAX_QUERY_TERMS = 64
/** 索引侧每类词项上限：单个 chunk 的词项数量上界。 */
const MAX_TEXT_TERMS = 4000
/** 精确短语长度上限：更长的查询按词项通道处理。 */
const MAX_EXACT_PHRASE_CHARS = 80

const HAN = /\p{Script=Han}/u
const WORD_CHAR = /[\p{L}\p{M}\p{N}]/u
const ASCII_ALNUM = /[A-Za-z0-9]/
const IDENTIFIER_SEPARATOR = /[-_./]/
const HAS_LETTER_OR_NUMBER = /[\p{L}\p{N}]/u
const SEGMENTER = new Intl.Segmenter('zh', { granularity: 'word' })

/** 索引侧词项：正文片段、章节路径与附加上下文共用。 */
export interface IndexTerms {
  words: string[]
  bigrams: string[]
}

/** 查询侧词项：词项通道与显式精确通道分开给出。 */
export interface QueryTerms {
  words: string[]
  bigrams: string[]
  /** 精确通道词项及权重；权重只用于同通道内排序。 */
  exacts: { term: string; weight: number }[]
}

const charactersOf = (value: string): string[] => Array.from(value)

/** 检索副本：NFKC 归一后小写；只用于查找与索引，不写回正文。 */
export const normalize = (value: string): string => value.normalize('NFKC').toLowerCase().normalize('NFKC')

/** 读取规范化文本中的全部词项；扫描顺序固定，索引与查询复用同一结果。 */
function scan(normalized: string): IndexTerms {
  const characters = charactersOf(normalized)
  const words: string[] = []
  const bigrams: string[] = []
  let index = 0
  while (index < characters.length) {
    const character = characters[index] ?? ''
    if (HAN.test(character)) {
      let end = index + 1
      while (end < characters.length && HAN.test(characters[end] ?? '')) end += 1
      pushHan(characters.slice(index, end).join(''), words, bigrams)
      index = end
      continue
    }
    if (ASCII_ALNUM.test(character)) {
      const run = readIdentifier(characters, index)
      pushIdentifier(run, words)
      index += Math.max(run.length, 1)
      continue
    }
    if (WORD_CHAR.test(character)) {
      let end = index + 1
      while (end < characters.length) {
        const next = characters[end] ?? ''
        if (HAN.test(next) || ASCII_ALNUM.test(next) || !WORD_CHAR.test(next)) break
        end += 1
      }
      for (const segment of segmentWords(characters.slice(index, end).join(''))) pushTerm(segment, words)
      index = end
      continue
    }
    index += 1
  }
  return { words, bigrams }
}

/** 标识符：ASCII 字母数字连续段；`- _ . /` 只作为内部连接符保留。 */
function readIdentifier(characters: readonly string[], start: number): string {
  let end = start
  let run = ''
  while (end < characters.length) {
    const character = characters[end] ?? ''
    if (ASCII_ALNUM.test(character)) {
      run += character
      end += 1
      continue
    }
    const next = characters[end + 1] ?? ''
    if (IDENTIFIER_SEPARATOR.test(character) && ASCII_ALNUM.test(next)) {
      run += character
      end += 1
      continue
    }
    break
  }
  return run
}

/** 标识符同时保留整体与各组成部分，便于编号整体匹配和分段匹配。 */
function pushIdentifier(run: string, words: string[]): void {
  const token = trimTerm(run)
  if (token !== '') words.push(token)
  for (const part of run.split(/[-_./]+/)) {
    const component = trimTerm(part)
    if (component !== '' && component !== token) words.push(component)
  }
}

/** 中文词段与 Han bigram 分开保存：词段进 words 列，bigram 进独立 FTS 列。 */
function pushHan(run: string, words: string[], bigrams: string[]): void {
  for (const segment of segmentWords(run)) {
    if (charactersOf(segment).length >= 2) pushTerm(segment, words)
  }
  const characters = charactersOf(run)
  for (let index = 0; index + 1 < characters.length; index += 1) {
    bigrams.push(`${characters[index] ?? ''}${characters[index + 1] ?? ''}`)
  }
}

/** 非中文脚本按分词结果保留；单字符词段只在非 Han 文本中出现。 */
function segmentWords(value: string): string[] {
  const segments: string[] = []
  for (const segment of SEGMENTER.segment(value)) if (segment.isWordLike) segments.push(segment.segment)
  return segments
}

function pushTerm(value: string, terms: string[]): void {
  const term = trimTerm(value)
  if (term !== '') terms.push(term)
}

function trimTerm(value: string): string {
  const trimmed = value.trim()
  if (trimmed === '' || !HAS_LETTER_OR_NUMBER.test(trimmed)) return ''
  return charactersOf(trimmed).slice(0, MAX_TERM_CHARS).join('')
}

/** 去重并保持首次出现顺序。 */
function unique(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    if (seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

/** 索引侧词项：用于单个片段写入 FTS 的预分词文本。 */
export function tokenizeText(value: string): IndexTerms {
  const scanned = scan(normalize(value))
  return {
    words: unique(scanned.words).slice(0, MAX_TEXT_TERMS),
    bigrams: unique(scanned.bigrams).slice(0, MAX_TEXT_TERMS),
  }
}

/** 查询侧词项：词项通道与显式精确通道分开构造。 */
export function queryTerms(value: string): QueryTerms {
  const normalized = normalize(value)
  const scanned = scan(normalized)
  const words = unique(scanned.words)
    .filter(term => !isSingleHan(term))
    .slice(0, MAX_QUERY_TERMS)
  const bigrams = unique(scanned.bigrams).slice(0, MAX_QUERY_TERMS)
  const exacts = new Map<string, number>()
  const addExact = (term: string, weight: number): void => {
    const trimmed = term.trim()
    if (trimmed === '' || !HAS_LETTER_OR_NUMBER.test(trimmed)) return
    if (charactersOf(trimmed).length > MAX_EXACT_PHRASE_CHARS) return
    exacts.set(trimmed, Math.max(exacts.get(trimmed) ?? 0, weight))
  }
  // 连续中文串整体作为精确短语；单字查询只走这条通道。
  for (const run of hanRuns(normalized)) {
    addExact(run, charactersOf(run).length === 1 ? 2.5 : 1.0)
  }
  // 中文词段与标识符保留为精确候选，提升编号与短语的召回。
  for (const term of words) {
    if (ASCII_ALNUM.test(term)) addExact(term, 1.2)
    else if (HAN.test(term[0] ?? '')) addExact(term, 0.8)
  }
  addExact(normalized, 1.5)
  return {
    words,
    bigrams,
    exacts: [...exacts].map(([term, weight]) => ({ term, weight })),
  }
}

/** 连续 Han 串；标点与空白把它们切开。 */
function hanRuns(value: string): string[] {
  const runs: string[] = []
  const characters = charactersOf(value)
  let current = ''
  for (const character of characters) {
    if (HAN.test(character)) {
      current += character
      continue
    }
    if (current !== '') {
      runs.push(current)
      current = ''
    }
  }
  if (current !== '') runs.push(current)
  return runs
}

function isSingleHan(term: string): boolean {
  const characters = charactersOf(term)
  return characters.length === 1 && HAN.test(characters[0] ?? '')
}

/**
 * 构造 FTS5 MATCH 表达式，在标题、标签、词项与 bigram 四列中查找。
 *
 * 标题与标签列写入时同样经过预分词，因此中文短标签与标题能被查询词项命中；
 * 这里不限定列，列权重由 bm25 基线决定。词项整体加引号，查询文本不直接拼进表达式。
 * @param tokens - 本模块生成的词项。
 * @returns MATCH 表达式；没有词项时为 null。
 */
export function matchExpression(tokens: readonly string[]): string | null {
  if (tokens.length === 0) return null
  const quoted = tokens.map(token => `"${token.replace(/"/g, '""')}"`)
  return `(${quoted.join(' OR ')})`
}
