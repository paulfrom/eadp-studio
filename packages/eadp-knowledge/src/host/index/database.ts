/**
 * 索引库读写：表结构、代次发布事务、查询短读事务与任务记录。
 *
 * 单连接串行读写：发布与删除在 BEGIN IMMEDIATE 内完成，查询在短读事务内完成；
 * 旧代次在发布同一事务内删除，因此查询只会看到当前代次。行值只在 worker 内使用，
 * 写入与读取都由本模块自己的 schema 决定。
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { KnowledgePackId } from '@eadp/contracts/knowledge'
import type { IndexedDocument } from '../store.ts'
import type { BuiltChunk } from './build.ts'
import { buildChunks } from './build.ts'
import { documentKey, tagsHashOf } from './identity.ts'
import type { DocumentState, JobIdentity, JobState, OpenResult, SearchQuery, SearchResult } from './protocol.ts'
import type { KnowledgeCandidate } from './search.ts'
import { matchExpression, normalize, queryTerms, tokenizeText } from './tokenizer.ts'

/** 索引库结构版本；列或约束不兼容时整库重建。 */
const SCHEMA_VERSION = '1'
/** 词项通道：RRF 常数、每通道候选深度与单通道取数上限（冻结基线值）。 */
const RRF_K = 60
const CHANNEL_DEPTH = 24
const CHANNEL_FETCH = CHANNEL_DEPTH * 5
/** 精确通道每个词项的取数上限。 */
const EXACT_FETCH = 120
/** 暂存的构建结果保留数量；主线程按顺序发布，保留少量便于失败恢复。 */
const MAX_STAGED = 4

type SqlParameter = string | number | bigint | null
type SqlRow = Record<string, SqlParameter>
type Statement = ReturnType<DatabaseSync['prepare']>

const textOf = (value: SqlParameter | undefined): string => (typeof value === 'string' ? value : '')
const number = (value: SqlParameter | undefined): number =>
  typeof value === 'number' ? value : typeof value === 'bigint' ? Number(value) : 0

/** FTS 的标题与标签列写入预分词词项：中文标题与短标签才能被查询词项命中。 */
const ftsColumnText = (value: string): string => {
  const terms = tokenizeText(value)
  return [...terms.words, ...terms.bigrams].join(' ')
}

/** 表结构：代次、资料指针、片段、FTS 与任务。 */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS index_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS index_generations (
    generation_id TEXT PRIMARY KEY,
    pack_id TEXT NOT NULL,
    document_id TEXT NOT NULL,
    content_revision_id TEXT NOT NULL,
    body_hash TEXT NOT NULL,
    metadata_hash TEXT NOT NULL,
    tags_hash TEXT NOT NULL,
    assets_hash TEXT NOT NULL,
    source_map_hash TEXT NOT NULL,
    processing_signature TEXT NOT NULL,
    chunk_count INTEGER NOT NULL,
    created_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS index_generations_document ON index_generations(pack_id, document_id)',
  `CREATE TABLE IF NOT EXISTS documents (
    pack_id TEXT NOT NULL,
    document_id TEXT NOT NULL,
    current_generation_id TEXT NOT NULL,
    content_revision_id TEXT NOT NULL,
    body_hash TEXT NOT NULL,
    metadata_hash TEXT NOT NULL,
    tags_hash TEXT NOT NULL,
    processing_signature TEXT NOT NULL,
    chunk_count INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (pack_id, document_id)
  )`,
  `CREATE TABLE IF NOT EXISTS chunks (
    chunk_id INTEGER PRIMARY KEY,
    generation_id TEXT NOT NULL REFERENCES index_generations(generation_id) ON DELETE CASCADE,
    chunk_key TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    start_cp INTEGER NOT NULL,
    end_cp INTEGER NOT NULL,
    context_ranges TEXT NOT NULL,
    heading_path TEXT NOT NULL,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    words_text TEXT NOT NULL,
    bigrams_text TEXT NOT NULL,
    exact_text TEXT NOT NULL,
    UNIQUE (generation_id, chunk_key)
  )`,
  'CREATE INDEX IF NOT EXISTS chunks_generation ON chunks(generation_id)',
  `CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    chunk_id UNINDEXED,
    title,
    tags,
    words,
    han_bigrams,
    tokenize = 'unicode61'
  )`,
  `CREATE TABLE IF NOT EXISTS jobs (
    job_id TEXT PRIMARY KEY,
    pack_id TEXT NOT NULL,
    document_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    content_revision_id TEXT NOT NULL,
    status TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS jobs_document ON jobs(pack_id, document_id)',
]

const DROP_ALL = [
  'DROP TABLE IF EXISTS chunks_fts',
  'DROP TABLE IF EXISTS chunks',
  'DROP TABLE IF EXISTS documents',
  'DROP TABLE IF EXISTS index_generations',
  'DROP TABLE IF EXISTS jobs',
  'DROP TABLE IF EXISTS index_meta',
]

const CLEAR_DERIVED = [
  'DELETE FROM chunks_fts',
  'DELETE FROM chunks',
  'DELETE FROM documents',
  'DELETE FROM index_generations',
  'DELETE FROM jobs',
]

const INSERT_GENERATION = `INSERT INTO index_generations (
  generation_id, pack_id, document_id, content_revision_id, body_hash, metadata_hash, tags_hash,
  assets_hash, source_map_hash, processing_signature, chunk_count, created_at
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`

const INSERT_CHUNK = `INSERT INTO chunks (
  generation_id, chunk_key, ordinal, start_cp, end_cp, context_ranges, heading_path,
  content, content_hash, words_text, bigrams_text, exact_text
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`

const UPSERT_DOCUMENT = `INSERT INTO documents (
  pack_id, document_id, current_generation_id, content_revision_id, body_hash, metadata_hash,
  tags_hash, processing_signature, chunk_count, updated_at
) VALUES (?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(pack_id, document_id) DO UPDATE SET
  current_generation_id = excluded.current_generation_id,
  content_revision_id = excluded.content_revision_id,
  body_hash = excluded.body_hash,
  metadata_hash = excluded.metadata_hash,
  tags_hash = excluded.tags_hash,
  processing_signature = excluded.processing_signature,
  chunk_count = excluded.chunk_count,
  updated_at = excluded.updated_at`

const JOB_UPSERT = `INSERT INTO jobs (
  job_id, pack_id, document_id, kind, content_revision_id, status, attempt, error, created_at, updated_at
) VALUES (?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(job_id) DO UPDATE SET
  status = excluded.status,
  attempt = excluded.attempt,
  error = excluded.error,
  updated_at = excluded.updated_at`

/** 词项与精确通道查询用的共享选择列。 */
const CHUNK_COLUMNS = `c.chunk_id AS chunk_id, c.chunk_key AS chunk_key, c.start_cp AS start_cp,
  c.end_cp AS end_cp, c.context_ranges AS context_ranges, c.heading_path AS heading_path,
  d.pack_id AS pack_id, d.document_id AS document_id, d.content_revision_id AS content_revision_id`

const FTS_QUERY = `SELECT ${CHUNK_COLUMNS}, bm25(chunks_fts, 0.0, 2.5, 1.2, 1.0, 0.6) AS rank
FROM chunks_fts
JOIN chunks c ON c.chunk_id = chunks_fts.chunk_id
JOIN documents d ON d.current_generation_id = c.generation_id
WHERE chunks_fts MATCH ?`

const EXACT_QUERY = `SELECT ${CHUNK_COLUMNS}
FROM chunks c
JOIN documents d ON d.current_generation_id = c.generation_id
WHERE instr(c.exact_text, ?) > 0`

/** 构建暂存；发布前只存在于 worker 内存，不进入数据库。 */
interface StagedBuild {
  document: IndexedDocument
  chunks: BuiltChunk[]
}

/** 精确通道聚合：同一片段命中多个精确词项时加权累加。 */
interface ExactEntry {
  score: number
  order: number
  row: SqlRow
}

/** 索引库：worker 内唯一连接。 */
export class IndexDatabase {
  private readonly db: DatabaseSync
  private readonly statements = new Map<string, Statement>()
  private readonly staged = new Map<string, StagedBuild>()

  constructor(path: string, private readonly processingSignature: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    try {
      this.db.exec('PRAGMA busy_timeout = 5000')
      this.db.exec('PRAGMA foreign_keys = ON')
      this.migrate()
    } catch (error) {
      try {
        this.db.close()
      } catch {
        // 关闭已损坏的连接可能再次失败；保留原始打开错误，由调用方决定是否重建。
      }
      throw error
    }
  }

  /** 关闭连接；未发布的构建随进程结束丢弃。 */
  close(): void {
    this.staged.clear()
    this.statements.clear()
    this.db.close()
  }

  /** 打开结果：已发布资料状态与未完成任务，供 Host 启动核对。 */
  openResult(): OpenResult {
    return { documents: this.documentStates(), jobs: this.unfinishedJobs() }
  }

  /** 单份资料的已发布状态；不存在时为 null。 */
  documentState(packId: KnowledgePackId, documentId: string): DocumentState | null {
    const row = this.row(
      `SELECT pack_id, document_id, content_revision_id, body_hash, metadata_hash, tags_hash,
        current_generation_id, processing_signature, chunk_count
       FROM documents WHERE pack_id = ? AND document_id = ?`,
      packId,
      documentId,
    )
    return row === undefined ? null : stateOf(row)
  }

  /**
   * 暂存一次构建：正文身份不变时复用已发布片段，否则重新切片与分词。
   * 暂存阶段不写数据库，发布由 Host 核验正文身份后触发。
   */
  stage(job: JobIdentity, document: IndexedDocument, reuseGenerationId: string | null): { buildId: string; chunkCount: number } {
    this.recordJob(job, document.packId, document.documentId, 'running', null)
    const reused = reuseGenerationId === null ? null : this.reusableChunks(reuseGenerationId, document.bodyHash)
    const chunks = reused ?? buildChunks(document)
    const buildId = randomUUID()
    this.staged.set(buildId, { document, chunks })
    while (this.staged.size > MAX_STAGED) {
      const oldest = this.staged.keys().next()
      if (oldest.done === true) break
      this.staged.delete(oldest.value)
    }
    return { buildId, chunkCount: chunks.length }
  }

  /** 丢弃尚未发布的构建。 */
  discard(buildId: string): void {
    this.staged.delete(buildId)
  }

  /**
   * 发布一个构建：单个 BEGIN IMMEDIATE 写入代次、片段、FTS 与资料指针，并删除旧代次。
   * Host 已核验正文身份；这里只追加"暂存后资料指针未被其他代次改写"的写入一致性。
   */
  publish(job: JobIdentity, buildId: string): void {
    const staged = this.staged.get(buildId)
    if (staged === undefined) throw new Error('索引构建已失效，需要重新登记。')
    this.staged.delete(buildId)
    const { document, chunks } = staged
    const now = new Date().toISOString()
    const tagsHash = tagsHashOf(document.tags)
    this.transaction(() => {
      const existing = this.documentState(document.packId, document.documentId)
      const generationId = randomUUID()
      this.statement(INSERT_GENERATION).run(
        generationId,
        document.packId,
        document.documentId,
        document.contentRevisionId,
        document.bodyHash,
        document.metadataHash,
        tagsHash,
        document.assetsHash,
        document.sourceMapHash,
        this.processingSignature,
        chunks.length,
        now,
      )
      const insertChunk = this.statement(INSERT_CHUNK)
      const insertFts = this.statement(
        'INSERT INTO chunks_fts (chunk_id, title, tags, words, han_bigrams) VALUES (?,?,?,?,?)',
      )
      const title = ftsColumnText(document.title)
      const tags = ftsColumnText(document.tags.join(' '))
      for (const chunk of chunks) {
        const result = insertChunk.run(
          generationId,
          chunk.chunkKey,
          chunk.ordinal,
          chunk.start,
          chunk.end,
          JSON.stringify(chunk.contextRanges),
          JSON.stringify(chunk.headingPath),
          chunk.content,
          chunk.contentHash,
          chunk.wordsText,
          chunk.bigramsText,
          chunk.exactText,
        )
        insertFts.run(number(result.lastInsertRowid), title, tags, chunk.wordsText, chunk.bigramsText)
      }
      this.statement(UPSERT_DOCUMENT).run(
        document.packId,
        document.documentId,
        generationId,
        document.contentRevisionId,
        document.bodyHash,
        document.metadataHash,
        tagsHash,
        this.processingSignature,
        chunks.length,
        now,
      )
      if (existing !== null) this.deleteGeneration(existing.generationId)
      this.recordJob(job, document.packId, document.documentId, 'done', null)
    })
  }

  /**
   * 仅元数据变化：正文块与词项复用，只更新标题、标签与元数据身份。
   * 内容身份不一致说明资料已经变化，抛错由 Host 重新走构建流程。
   */
  refresh(job: JobIdentity, document: IndexedDocument): void {
    const state = this.documentState(document.packId, document.documentId)
    if (state === null) throw new Error('索引资料不存在，需要重新构建。')
    if (state.contentRevisionId !== document.contentRevisionId) throw new Error('资料内容已更新，索引需要重新构建。')
    const tagsHash = tagsHashOf(document.tags)
    const now = new Date().toISOString()
    this.transaction(() => {
      this.statement(
        'UPDATE index_generations SET metadata_hash = ?, tags_hash = ? WHERE generation_id = ?',
      ).run(document.metadataHash, tagsHash, state.generationId)
      this.statement(
        'UPDATE documents SET metadata_hash = ?, tags_hash = ?, updated_at = ? WHERE pack_id = ? AND document_id = ?',
      ).run(document.metadataHash, tagsHash, now, document.packId, document.documentId)
      this.statement(
        'UPDATE chunks_fts SET title = ?, tags = ? WHERE chunk_id IN (SELECT chunk_id FROM chunks WHERE generation_id = ?)',
      ).run(ftsColumnText(document.title), ftsColumnText(document.tags.join(' ')), state.generationId)
      this.recordJob(job, document.packId, document.documentId, 'done', null)
    })
  }

  /** 资料删除：清理代次、片段、FTS 与任务；资料指针先移除，避免查询看到残留。 */
  drop(packId: KnowledgePackId, documentId: string): void {
    this.transaction(() => {
      for (const generation of this.rows(
        'SELECT generation_id FROM index_generations WHERE pack_id = ? AND document_id = ?',
        packId,
        documentId,
      )) {
        this.deleteFtsForGeneration(textOf(generation['generation_id']))
      }
      this.statement('DELETE FROM documents WHERE pack_id = ? AND document_id = ?').run(packId, documentId)
      this.statement('DELETE FROM index_generations WHERE pack_id = ? AND document_id = ?').run(packId, documentId)
      this.statement('DELETE FROM jobs WHERE pack_id = ? AND document_id = ?').run(packId, documentId)
    })
    for (const [buildId, staged] of this.staged) {
      if (staged.document.packId === packId && staged.document.documentId === documentId) this.staged.delete(buildId)
    }
  }

  /** 记录失败任务；错误只保留文本，便于下次启动核对。 */
  failJob(job: JobIdentity, packId: KnowledgePackId, documentId: string, error: string): void {
    this.recordJob(job, packId, documentId, 'failed', error.slice(0, 500))
  }

  /**
   * 查询：词项（words／Han bigram 两个 FTS 列表）与精确通道分别取候选，按 RRF 融合。
   * 全部在短读事务内完成；返回的候选都来自已发布的当前代次。
   */
  search(query: SearchQuery): SearchResult {
    const admitted = new Set(query.admittedKeys)
    if (admitted.size === 0) return { candidates: [] }
    const scores = new Map<number, { score: number; channels: Set<'词项' | '精确'>; row: SqlRow }>()
    this.read(() => {
      for (const value of query.queries) {
        const terms = queryTerms(value)
        const lists: { channel: '词项' | '精确'; rows: SqlRow[] }[] = []
        const wordExpression = matchExpression(terms.words)
        if (wordExpression !== null) lists.push({ channel: '词项', rows: this.ftsRows(wordExpression, query, admitted) })
        const bigramExpression = matchExpression(terms.bigrams)
        if (bigramExpression !== null) lists.push({ channel: '词项', rows: this.ftsRows(bigramExpression, query, admitted) })
        if (terms.exacts.length > 0) lists.push({ channel: '精确', rows: this.exactRows(terms.exacts, query, admitted) })
        for (const list of lists) {
          list.rows.forEach((row, index) => {
            const chunkId = number(row['chunk_id'])
            const entry = scores.get(chunkId) ?? { score: 0, channels: new Set<'词项' | '精确'>(), row }
            entry.score += 1 / (RRF_K + index + 1)
            entry.channels.add(list.channel)
            scores.set(chunkId, entry)
          })
        }
      }
    })
    const ranked = [...scores.values()].sort(
      (left, right) => right.score - left.score || textOf(left.row['chunk_key']).localeCompare(textOf(right.row['chunk_key']), 'en'),
    )
    const candidates: KnowledgeCandidate[] = []
    for (const entry of ranked.slice(0, query.limit)) candidates.push(candidateOf(entry.row, entry.channels))
    return { candidates }
  }

  /** 词项通道：FTS BM25 排序，按准入集合与资料范围过滤。 */
  private ftsRows(expression: string, query: SearchQuery, admitted: Set<string>): SqlRow[] {
    const parameters: SqlParameter[] = [expression]
    let sql = FTS_QUERY
    if (query.packId !== null) {
      sql += ' AND d.pack_id = ?'
      parameters.push(query.packId)
    }
    sql += ' ORDER BY rank LIMIT ?'
    parameters.push(CHANNEL_FETCH)
    return this.rows(sql, ...parameters)
      .filter(row => admitted.has(documentKey(textOf(row['pack_id']), textOf(row['document_id']))))
      .slice(0, CHANNEL_DEPTH)
  }

  /** 精确通道：每个精确词项做规范化子串匹配，按命中词项数加权后排序。 */
  private exactRows(exacts: readonly { term: string; weight: number }[], query: SearchQuery, admitted: Set<string>): SqlRow[] {
    const entries = new Map<number, ExactEntry>()
    for (const exact of exacts) {
      this.exactTermRows(exact.term, query, admitted).forEach((row, order) => {
        const chunkId = number(row['chunk_id'])
        const entry = entries.get(chunkId)
        if (entry === undefined) entries.set(chunkId, { score: exact.weight, order, row })
        else entry.score += exact.weight
      })
    }
    return [...entries.values()]
      .sort((left, right) => right.score - left.score || left.order - right.order)
      .slice(0, CHANNEL_DEPTH)
      .map(entry => entry.row)
  }

  private exactTermRows(term: string, query: SearchQuery, admitted: Set<string>): SqlRow[] {
    const parameters: SqlParameter[] = [normalize(term)]
    let sql = EXACT_QUERY
    if (query.packId !== null) {
      sql += ' AND d.pack_id = ?'
      parameters.push(query.packId)
    }
    sql += ' LIMIT ?'
    parameters.push(EXACT_FETCH)
    return this.rows(sql, ...parameters)
      .filter(row => admitted.has(documentKey(textOf(row['pack_id']), textOf(row['document_id']))))
      .slice(0, EXACT_FETCH)
  }

  /** 复用已发布片段：只有正文身份一致时才复用，元数据变化也走这里。 */
  private reusableChunks(generationId: string, bodyHash: string): BuiltChunk[] | null {
    const generation = this.row('SELECT body_hash FROM index_generations WHERE generation_id = ?', generationId)
    if (generation === undefined || textOf(generation['body_hash']) !== bodyHash) return null
    const rows = this.rows(
      `SELECT chunk_key, ordinal, start_cp, end_cp, context_ranges, heading_path, content, content_hash,
        words_text, bigrams_text, exact_text
       FROM chunks WHERE generation_id = ? ORDER BY ordinal`,
      generationId,
    )
    if (rows.length === 0) return null
    return rows.map(row => ({
      chunkKey: textOf(row['chunk_key']),
      ordinal: number(row['ordinal']),
      start: number(row['start_cp']),
      end: number(row['end_cp']),
      contextRanges: parseRanges(textOf(row['context_ranges'])),
      headingPath: parseHeadingPath(textOf(row['heading_path'])),
      content: textOf(row['content']),
      contentHash: textOf(row['content_hash']),
      wordsText: textOf(row['words_text']),
      bigramsText: textOf(row['bigrams_text']),
      exactText: textOf(row['exact_text']),
    }))
  }

  private documentStates(): DocumentState[] {
    const rows = this.rows(
      `SELECT pack_id, document_id, content_revision_id, body_hash, metadata_hash, tags_hash,
        current_generation_id, processing_signature, chunk_count
       FROM documents ORDER BY pack_id, document_id`,
    )
    return rows.map(stateOf)
  }

  private unfinishedJobs(): JobState[] {
    const rows = this.rows(
      `SELECT job_id, pack_id, document_id, kind, content_revision_id, status, attempt, error
       FROM jobs WHERE status <> 'done' ORDER BY updated_at`,
    )
    return rows.map(row => ({
      jobId: textOf(row['job_id']),
      packId: textOf(row['pack_id']) === 'builtin' ? 'builtin' : 'user',
      documentId: textOf(row['document_id']),
      kind: textOf(row['kind']) === 'remove' ? 'remove' : 'index',
      contentRevisionId: textOf(row['content_revision_id']),
      status: jobStatusOf(textOf(row['status'])),
      attempt: number(row['attempt']),
      error: typeof row['error'] === 'string' ? row['error'] : null,
    }))
  }

  /** 记录任务阶段；running 每次累加尝试次数。 */
  private recordJob(job: JobIdentity, packId: KnowledgePackId, documentId: string, status: JobState['status'], error: string | null): void {
    const existing = this.row('SELECT attempt FROM jobs WHERE job_id = ?', job.jobId)
    const attempt = (existing === undefined ? 0 : number(existing['attempt'])) + (status === 'running' ? 1 : 0)
    const now = new Date().toISOString()
    this.statement(JOB_UPSERT).run(
      job.jobId,
      packId,
      documentId,
      job.kind,
      job.contentRevisionId,
      status,
      attempt,
      error,
      now,
      now,
    )
    this.statement(
      `DELETE FROM jobs WHERE status = 'done' AND job_id NOT IN (
        SELECT job_id FROM jobs ORDER BY updated_at DESC LIMIT 200
      )`,
    ).run()
  }

  /** 删除一个代次的 FTS 与片段；片段随代次外键级联删除。 */
  private deleteGeneration(generationId: string): void {
    this.deleteFtsForGeneration(generationId)
    this.statement('DELETE FROM index_generations WHERE generation_id = ?').run(generationId)
  }

  private deleteFtsForGeneration(generationId: string): void {
    this.statement(
      'DELETE FROM chunks_fts WHERE chunk_id IN (SELECT chunk_id FROM chunks WHERE generation_id = ?)',
    ).run(generationId)
  }

  private migrate(): void {
    const existing = this.tableExists('index_meta') ? this.meta('schema_version') : null
    if (existing !== SCHEMA_VERSION) {
      for (const sql of DROP_ALL) this.db.exec(sql)
      for (const sql of SCHEMA) this.db.exec(sql)
      this.setMeta('schema_version', SCHEMA_VERSION)
    }
    if (this.meta('processing_signature') !== this.processingSignature) {
      for (const sql of CLEAR_DERIVED) this.db.exec(sql)
      this.setMeta('processing_signature', this.processingSignature)
    }
  }

  private tableExists(name: string): boolean {
    return this.row(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, name) !== undefined
  }

  private meta(key: string): string | null {
    const row = this.row('SELECT value FROM index_meta WHERE key = ?', key)
    return row === undefined ? null : textOf(row['value'])
  }

  private setMeta(key: string, value: string): void {
    this.statement(
      'INSERT INTO index_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, value)
  }

  private transaction(action: () => void): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      action()
      this.db.exec('COMMIT')
    } catch (error) {
      this.rollback()
      throw error
    }
  }

  private read(action: () => void): void {
    this.db.exec('BEGIN')
    try {
      action()
      this.db.exec('COMMIT')
    } catch (error) {
      this.rollback()
      throw error
    }
  }

  private rollback(): void {
    try {
      this.db.exec('ROLLBACK')
    } catch {
      // 没有活动事务或已被 SQLite 自动回滚；保留原始错误。
    }
  }

  private statement(sql: string): Statement {
    const cached = this.statements.get(sql)
    if (cached !== undefined) return cached
    const statement = this.db.prepare(sql)
    this.statements.set(sql, statement)
    return statement
  }

  private rows(sql: string, ...parameters: SqlParameter[]): SqlRow[] {
    return this.statement(sql).all(...parameters) as SqlRow[]
  }

  private row(sql: string, ...parameters: SqlParameter[]): SqlRow | undefined {
    return this.statement(sql).get(...parameters) as SqlRow | undefined
  }
}

function stateOf(row: SqlRow): DocumentState {
  return {
    packId: textOf(row['pack_id']) === 'builtin' ? 'builtin' : 'user',
    documentId: textOf(row['document_id']),
    contentRevisionId: textOf(row['content_revision_id']),
    bodyHash: textOf(row['body_hash']),
    metadataHash: textOf(row['metadata_hash']),
    tagsHash: textOf(row['tags_hash']),
    generationId: textOf(row['current_generation_id']),
    processingSignature: textOf(row['processing_signature']),
    chunkCount: number(row['chunk_count']),
  }
}

function jobStatusOf(value: string): JobState['status'] {
  if (value === 'running' || value === 'failed' || value === 'done') return value
  return 'pending'
}

function candidateOf(row: SqlRow, channels: Set<'词项' | '精确'>): KnowledgeCandidate {
  const ranges = parseRanges(textOf(row['context_ranges']))
  const main = { start: number(row['start_cp']), end: number(row['end_cp']) }
  if (main.end > main.start) ranges.unshift(main)
  return {
    packId: textOf(row['pack_id']) === 'builtin' ? 'builtin' : 'user',
    documentId: textOf(row['document_id']),
    contentRevisionId: textOf(row['content_revision_id']),
    ranges,
    headingPath: parseHeadingPath(textOf(row['heading_path'])),
    channels: channels.has('精确') ? (channels.has('词项') ? ['词项', '精确'] : ['精确']) : ['词项'],
    chunkKey: textOf(row['chunk_key']),
  }
}

function parseRanges(value: string): { start: number; end: number }[] {
  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed)) throw new Error('索引片段范围已损坏，需要重建索引。')
  const ranges: { start: number; end: number }[] = []
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) throw new Error('索引片段范围已损坏，需要重建索引。')
    const start = 'start' in item ? item.start : undefined
    const end = 'end' in item ? item.end : undefined
    if (typeof start !== 'number' || typeof end !== 'number' || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) continue
    ranges.push({ start, end })
  }
  return ranges
}

function parseHeadingPath(value: string): string[] {
  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed)) throw new Error('索引片段章节已损坏，需要重建索引。')
  return parsed.filter((item): item is string => typeof item === 'string')
}
