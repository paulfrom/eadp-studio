import { randomBytes } from 'node:crypto'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type {
  KnowledgeCategory,
  KnowledgeEvidenceRange,
  KnowledgeEvidenceResolution,
  KnowledgePackId,
  KnowledgeRange,
  KnowledgeReferenceService,
  KnowledgeResourceRef,
  KnowledgeSourceMap,
  KnowledgeSourceSummary,
} from '@eadp/contracts/knowledge'
import { KnowledgeError, fail, hash } from './store.ts'
import type { KnowledgeEvidenceSource, KnowledgeStore } from './store.ts'
import type { SessionPreferences } from './preferences.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 知识插件提供的只读证据核验与自动参考开关。 */
    eadpKnowledgeReference: KnowledgeReferenceService
  }
}

/** 签发证据时 Host 已从 canonical 正文核验并读取的内容。 */
export interface EvidenceContent {
  sessionId: string
  projectId: string
  packId: KnowledgePackId
  documentId: string
  contentRevisionId: string
  title: string
  category: KnowledgeCategory
  scope: string
  tags: string[]
  source: KnowledgeSourceSummary
  warnings: string[]
  locations: string[]
  /** 完整 Markdown 正文；范围与 hash 都相对于它。 */
  text: string
  ranges: KnowledgeEvidenceRange[]
  resources: KnowledgeResourceRef[]
  sourceMap: KnowledgeSourceMap | null
  /** 原件内容寻址记录；内置整理卡没有原件时为 null。 */
  sourceHash: string | null
}

/** 片段上下文窗口：命中范围向段落边界扩展后的真实正文范围。 */
export interface ExcerptWindow {
  start: number
  end: number
}

interface EvidenceRecord extends EvidenceContent {
  evidenceId: string
  createdAt: number
}

const MAX_ITEMS = 8
const MAX_RANGES = 32
const EVIDENCE_TTL_MS = 12 * 60 * 60 * 1000
/** 片段单侧保留的上下文长度；不足以承担整篇正文。 */
export const EXCERPT_CONTEXT_CHARS = 120
/** 多段片段之间的省略标记，按 Unicode code-point 计。 */
const EXCERPT_SEPARATOR = '\n…\n'

const EXPIRED_EVIDENCE = '该知识内容已失效，请重新读取后再关联。'
const STALE_EVIDENCE = '该知识内容已更新或暂时不可用，请重新读取后再关联。'
const FOREIGN_EVIDENCE = '该知识内容不属于本次会话或项目。'

/** 证据标识不可猜测；绑定本次运行、会话、项目与内容身份。 */
const newEvidenceId = (): string => `kev_${randomBytes(18).toString('hex')}`

/** 合并重叠或相邻范围；非整数、越界与空范围直接丢弃。 */
export function normalizeRanges(ranges: KnowledgeRange[]): KnowledgeRange[] {
  const sorted = ranges
    .filter(range => Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end) && range.end > range.start)
    .sort((left, right) => left.start - right.start || left.end - right.end)
  const merged: KnowledgeRange[] = []
  for (const range of sorted) {
    const last = merged[merged.length - 1]
    if (last !== undefined && range.start <= last.end) last.end = Math.max(last.end, range.end)
    else merged.push({ ...range })
  }
  return merged
}

/**
 * 把候选范围校验到真实正文长度内、合并重叠区间并计算每段正文 hash。
 * @param ranges 索引或工具给出的候选范围。
 * @param characters 完整 canonical 正文（按 Unicode code-point 拆分）。
 * @returns 可直接登记为证据的真实范围。
 */
export function verifyRanges(ranges: KnowledgeRange[], characters: string[]): KnowledgeEvidenceRange[] {
  const bounded = normalizeRanges(ranges.filter(range => range.start >= 0 && range.end <= characters.length))
  return bounded.map(range => ({ ...range, textHash: hash(characters.slice(range.start, range.end).join('')) }))
}

/**
 * 为每段命中范围生成向段落边界扩展的上下文窗口。
 * @param characters 完整 canonical 正文（按 Unicode code-point 拆分）。
 * @param ranges 已核验的命中范围。
 * @param contextChars 单侧扩展的最大字符数。
 * @returns 窗口列表与片段是否截断（未覆盖整篇正文）。
 */
export function excerptWindows(
  characters: string[],
  ranges: KnowledgeRange[],
  contextChars: number = EXCERPT_CONTEXT_CHARS,
): { windows: ExcerptWindow[]; truncated: boolean } {
  const windows: ExcerptWindow[] = []
  let truncated = false
  for (const range of ranges) {
    let start = Math.max(0, range.start - contextChars)
    let end = Math.min(characters.length, range.end + contextChars)
    const before = characters.slice(start, range.start).join('')
    const newline = before.lastIndexOf('\n')
    if (newline >= 0) start += newline + 1
    const after = characters.slice(range.end, end).join('')
    const next = after.indexOf('\n')
    if (next >= 0) end = range.end + next
    if (start > 0 || end < characters.length) truncated = true
    windows.push({ start, end })
  }
  // 相邻命中扩展开来的窗口可能重叠；合并后片段连续，避免同一段正文重复展示。
  const merged: ExcerptWindow[] = []
  for (const window of windows.sort((left, right) => left.start - right.start || left.end - right.end)) {
    const last = merged[merged.length - 1]
    if (last !== undefined && window.start <= last.end) last.end = Math.max(last.end, window.end)
    else merged.push({ ...window })
  }
  return { windows: merged, truncated }
}

/**
 * 按窗口取正文；多段之间用省略标记连接。
 * 不做逐段裁剪，保证片段字符数与窗口长度一一对应（截断时据此换算证据范围）。
 * @param characters 完整 canonical 正文（按 Unicode code-point 拆分）。
 * @param windows 已计算好的上下文窗口。
 * @returns 可直接展示的片段文本。
 */
export function excerptText(characters: string[], windows: ExcerptWindow[]): string {
  return windows.map(window => characters.slice(window.start, window.end).join('')).join(EXCERPT_SEPARATOR)
}

/**
 * 把实际展示的片段窗口换算为证据范围；截断时只保留展示出来的部分并重算 hash。
 * @param characters 完整 canonical 正文（按 Unicode code-point 拆分）。
 * @param windows 本次片段实际使用的上下文窗口。
 * @param visibleChars 拼接后的片段文本中实际展示的字符数。
 * @returns 可登记的原文范围；没有任何内容可见时为空。
 */
export function excerptRanges(characters: string[], windows: ExcerptWindow[], visibleChars: number): KnowledgeEvidenceRange[] {
  const separatorLength = Array.from(EXCERPT_SEPARATOR).length
  const ranges: KnowledgeEvidenceRange[] = []
  let consumed = 0
  for (const window of windows) {
    const windowLength = window.end - window.start
    const shown = Math.max(0, Math.min(windowLength, visibleChars - consumed))
    const end = window.start + shown
    if (end > window.start) ranges.push({ start: window.start, end, textHash: hash(characters.slice(window.start, end).join('')) })
    consumed += windowLength + separatorLength
  }
  return ranges
}

/**
 * 用 Host 已核验的 canonical 来源组装一次证据登记内容。
 * @param source Host 从正文文件重读并核验过的资料。
 * @param sessionId 签发证据所属会话。
 * @param projectId 签发证据所属项目。
 * @param ranges 本次实际取得并已核验的真实范围。
 * @returns 可直接交给 {@link KnowledgeReference.issue} 的登记内容。
 */
export function evidenceContent(
  source: KnowledgeEvidenceSource,
  sessionId: string,
  projectId: string,
  ranges: KnowledgeEvidenceRange[],
): EvidenceContent {
  return {
    sessionId,
    projectId,
    packId: source.packId,
    documentId: source.documentId,
    contentRevisionId: source.contentRevisionId,
    title: source.title,
    category: source.category,
    scope: source.scope,
    tags: source.tags,
    source: source.source,
    warnings: source.warnings,
    locations: source.locations,
    text: source.text,
    ranges,
    resources: source.resources,
    sourceMap: source.sourceMap,
    sourceHash: source.sourceHash,
  }
}

/**
 * 证据登记器：自动注入与显式读取共用。
 * 记录只存在于本次运行；解析时重新校验内容身份，资料更新或删除后旧标识失效。
 */
export class KnowledgeReference extends Service implements KnowledgeReferenceService {
  private readonly records = new Map<string, EvidenceRecord>()

  constructor(ctx: Context, private readonly store: KnowledgeStore, private readonly preferences: SessionPreferences) {
    super(ctx, 'eadpKnowledgeReference')
  }

  /** 登记一次 Host 已核验的读取；返回会话／项目绑定的标识。 */
  issue(content: EvidenceContent): string {
    const evidenceId = newEvidenceId()
    this.records.set(evidenceId, { ...content, evidenceId, createdAt: Date.now() })
    this.prune()
    return evidenceId
  }

  autoReferenceFor(sessionId: string): Promise<boolean> {
    return this.preferences.autoReference(sessionId)
  }

  setAutoReferenceFor(sessionId: string, enabled: boolean): Promise<void> {
    return this.preferences.setAutoReference(sessionId, enabled)
  }

  /** 当前 canonical 内容身份；资料不存在、已删除或暂时不可读时为空，不向调用方抛错。 */
  async currentContentRevision(packId: KnowledgePackId, documentId: string): Promise<string | null> {
    if (packId !== 'builtin' && packId !== 'user') return null
    if (typeof documentId !== 'string' || documentId === '' || documentId.includes('\0')) return null
    try {
      const catalog = await this.store.catalog()
      const pack = catalog.packs.find(value => value.packId === packId)
      return pack?.documents.find(value => value.documentId === documentId)?.contentRevisionId ?? null
    } catch (error) {
      this.ctx.logger.warn(`知识内容身份读取失败：${String(error)}`)
      return null
    }
  }

  /** 解析并重新核验证据；范围越界、内容变化或跨会话使用一律拒绝。 */
  async resolveEvidence(input: { sessionId: string; projectId: string; items: { evidenceId: string; ranges: { start: number; end: number }[] }[] }): Promise<KnowledgeEvidenceResolution[]> {
    if (!Array.isArray(input.items) || input.items.length === 0) return fail('INVALID_ARGUMENT', '请先读取要作为依据的知识内容。')
    if (input.items.length > MAX_ITEMS) return fail('LIMIT_EXCEEDED', '一次关联的知识内容过多。')
    const resolutions: KnowledgeEvidenceResolution[] = []
    for (const item of input.items) {
      const record = this.requireRecord(item.evidenceId, input.sessionId, input.projectId)
      const ranges = this.selectRanges(record, item.ranges)
      try {
        resolutions.push(await this.resolveRecord(record, ranges))
      } catch (error) {
        // 登记后的资料更新、删除或正文不可读都不能再作为依据。
        if (!(error instanceof KnowledgeError)) throw error
        this.records.delete(record.evidenceId)
        return fail('EVIDENCE_INVALID', STALE_EVIDENCE)
      }
    }
    return resolutions
  }

  /** 找到本次会话与项目内仍未过期的登记记录。 */
  private requireRecord(evidenceId: string, sessionId: string, projectId: string): EvidenceRecord {
    const record = typeof evidenceId === 'string' ? this.records.get(evidenceId) : undefined
    if (record === undefined) return fail('EVIDENCE_INVALID', EXPIRED_EVIDENCE)
    if (record.sessionId !== sessionId || record.projectId !== projectId) return fail('EVIDENCE_INVALID', FOREIGN_EVIDENCE)
    if (Date.now() - record.createdAt > EVIDENCE_TTL_MS) {
      this.records.delete(record.evidenceId)
      return fail('EVIDENCE_INVALID', EXPIRED_EVIDENCE)
    }
    return record
  }

  /** 请求范围必须落在本次已读取范围内，且 hash 与登记一致。 */
  private selectRanges(record: EvidenceRecord, requested: { start: number; end: number }[]): KnowledgeEvidenceRange[] {
    if (!Array.isArray(requested) || requested.length === 0 || requested.length > MAX_RANGES) return fail('INVALID_ARGUMENT', '采用范围无效。')
    const characters = Array.from(record.text)
    const selected: KnowledgeEvidenceRange[] = []
    for (const range of requested) {
      if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end <= range.start || range.end > characters.length) return fail('INVALID_ARGUMENT', '采用范围无效。')
      const issued = record.ranges.find(value => range.start >= value.start && range.end <= value.end)
      if (!issued) return fail('EVIDENCE_INVALID', '采用范围超出本次实际读取的内容。')
      const textHash = hash(characters.slice(range.start, range.end).join(''))
      selected.push({ start: range.start, end: range.end, textHash })
    }
    return selected
  }

  /** 重新读取 canonical 内容，用当前来源元数据与资产生成核验结果。 */
  private async resolveRecord(record: EvidenceRecord, ranges: KnowledgeEvidenceRange[]): Promise<KnowledgeEvidenceResolution> {
    const source = await this.store.evidenceSource(record.packId, record.documentId, record.contentRevisionId)
    return {
      packId: source.packId,
      documentId: source.documentId,
      contentRevisionId: source.contentRevisionId,
      title: source.title,
      category: source.category,
      scope: source.scope,
      tags: [...source.tags],
      source: { ...source.source },
      warnings: [...source.warnings],
      locations: [...source.locations],
      text: source.text,
      ranges,
      resources: await this.resources(record, source.resources),
      sourceMap: source.sourceMap === null ? null : structuredClone(source.sourceMap),
      original: await this.original(source),
    }
  }

  /** 读取 canonical 版本的图片内容；字节与登记版本必须一致。 */
  private async resources(record: EvidenceRecord, resources: KnowledgeResourceRef[]): Promise<{ path: string; fileName: string; hash: string; dataBase64: string }[]> {
    const values: { path: string; fileName: string; hash: string; dataBase64: string }[] = []
    for (const resource of resources) {
      const bytes = await this.store.readResource(record.packId, record.documentId, record.contentRevisionId, resource.path)
      values.push({ path: resource.path, fileName: resource.fileName, hash: hash(bytes), dataBase64: Buffer.from(bytes).toString('base64') })
    }
    return values
  }

  /** 读取原件内容寻址副本；没有随包原件时为空。 */
  private async original(source: KnowledgeEvidenceSource): Promise<KnowledgeEvidenceResolution['original']> {
    if (source.sourceHash === null) return null
    const bytes = await this.store.readSource(source.sourceHash)
    return {
      fileName: source.source.fileName ?? '原始文件',
      size: bytes.byteLength,
      fileType: source.source.fileType ?? '文件',
      hash: hash(bytes),
      dataBase64: Buffer.from(bytes).toString('base64'),
    }
  }

  /** 只保留近期记录，避免长会话无限增长；过期标识按失效处理。 */
  private prune(): void {
    const cutoff = Date.now() - EVIDENCE_TTL_MS
    for (const [id, record] of this.records) if (record.createdAt < cutoff) this.records.delete(id)
  }
}
