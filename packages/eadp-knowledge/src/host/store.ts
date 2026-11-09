/**
 * 用户知识资料的本地持久化。
 *
 * 磁盘事实源是 manifest.json 与不可变内容文件：清单记录目录与资料元数据，
 * 正文、图片、来源映射和原件按内容 hash 写入独立文件。
 * 每次保存先写内容文件，最后原子替换清单；清单改名是唯一可见提交点，
 * 提交前重新读取清单并核对内容身份，外部改动不会被静默覆盖。
 */
import { createHash, randomUUID } from 'node:crypto'
import { constants, lstatSync } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname, join, parse, relative as pathRelative, sep } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type {
  KnowledgeCatalog,
  KnowledgeCategory,
  KnowledgeCategoryCount,
  KnowledgeDocument,
  KnowledgeDocumentSummary,
  KnowledgeDraft,
  KnowledgeDraftResource,
  KnowledgeErrorCode,
  KnowledgeIssue,
  KnowledgeOrganizeState,
  KnowledgePack,
  KnowledgePackId,
  KnowledgeRead,
  KnowledgeResourceRef,
  KnowledgeSourceMap,
  KnowledgeSourceSummary,
} from '@eadp/contracts/knowledge'
import { KNOWLEDGE_CATEGORIES, isKnowledgeCategory } from '@eadp/contracts/knowledge'
import { BuiltinPackError, loadBuiltinPack, readBuiltinCardBody, resolveBuiltinRoot } from './builtin.ts'

/** 知识操作失败；`code` 供界面区分可恢复情况。 */
export class KnowledgeError extends Error {
  constructor(readonly code: KnowledgeErrorCode, message: string) {
    super(message)
    this.name = 'KnowledgeError'
  }
}

/** 抛出带错误码的知识失败。 */
export const fail = (code: KnowledgeErrorCode, message: string): never => {
  throw new KnowledgeError(code, message)
}

/** 内容 hash：sha256 十六进制小写；字符串按 UTF-8 计。 */
export const hash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')

/** 空内容的 hash；没有图片或来源映射时用作内容身份的一部分。 */
const EMPTY_HASH = hash(new Uint8Array())

/** 来源映射中的一条定位；偏移按正文 Unicode code-point 计。 */
export interface SourceMapEntry {
  start: number
  end: number
  label: string
  page?: number
  sheet?: string
  cell?: string
  slide?: number
  section?: string
}

/** 正文范围到原文件的来源映射，由导入流程生成、按原样保存。 */
export interface SourceMapFile {
  schemaVersion: 1
  entries: SourceMapEntry[]
}

/** 资料的出处信息；原件字段只指向已保存的不可变字节。 */
export interface StoredSource {
  kind: 'imported' | 'authored' | 'builtin-copy'
  label: string
  fileName?: string
  size?: number
  fileType?: string
  importId?: string
  sourceHash?: string
  /** 可展示的来源补充说明；内置副本用它保留真实外部出处。 */
  detail?: string
}

/** 新建资料时由导入流程给出的完整来源信息。 */
export interface NewDocumentInput {
  draft: KnowledgeDraft
  source: StoredSource
  sourceMap: SourceMapFile | null
  warnings: string[]
  resources: KnowledgeDraftResource[]
}

/** 索引输入：一份资料的正文与内容身份。 */
export interface IndexedDocument {
  packId: KnowledgePackId
  documentId: string
  contentRevisionId: string
  bodyHash: string
  metadataHash: string
  assetsHash: string
  sourceMapHash: string
  title: string
  category: KnowledgeCategory
  scope: string
  tags: string[]
  autoReference: boolean
  sourceLabel: string
  locations: string[]
  warnings: string[]
  text: string
}

/** 证据核验来源：完整 canonical 正文与项目可固定的来源资产。 */
export interface KnowledgeEvidenceSource {
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
  text: string
  resources: KnowledgeResourceRef[]
  sourceMap: KnowledgeSourceMap | null
  sourceHash: string | null
}

interface ManifestDocument {
  documentId: string
  title: string
  category: KnowledgeCategory
  scope: string
  tags: string[]
  autoReference: boolean
  organize: KnowledgeOrganizeState
  warnings: string[]
  contentRevisionId: string
  bodyHash: string
  metadataHash: string
  assetsHash: string
  sourceMapHash: string
  bodyPath: string
  sourceMapPath: string | null
  resources: KnowledgeResourceRef[]
  source: StoredSource
  createdAt: string
  updatedAt: string
}

/** 内置资料的检索偏好；内置包只读，偏好只能保存在用户清单里。 */
interface ManifestPreference {
  packId: 'builtin'
  documentId: string
  autoReference: boolean
}

interface UserManifest {
  schemaVersion: 2
  packId: 'user'
  version: string
  documents: ManifestDocument[]
  preferences: ManifestPreference[]
}

interface LoadedUserPack {
  raw: string | null
  manifest: UserManifest
  exists: boolean
}

interface BuiltinDocument {
  id: string
  title: string
  scope: string
  tags: string[]
  category: KnowledgeCategory
  /** 清单里的真实外部出处引文，随内置资料展示。 */
  detail: string
  text: string
  bodyHash: string
  metadataHash: string
  contentRevisionId: string
  updatedAt: string
}

interface BuiltinLoad {
  exists: boolean
  version: string
  updatedAt: string
  documents: BuiltinDocument[]
  problem: string | null
}

interface ContentWrite {
  path: string
  bytes: Uint8Array
  hash: string
}

interface PreparedContent {
  text: string
  resources: KnowledgeResourceRef[]
  writes: ContentWrite[]
}

interface PlannedResource {
  placeholder: string
  fileName: string
  hash: string
  extension: DetectedImage
  bytes: Uint8Array
}

interface NormalizedDraft {
  title: string
  category: KnowledgeCategory
  scope: string
  text: string
  autoReference: boolean
}

type DetectedImage = 'png' | 'jpg' | 'gif' | 'webp' | 'bmp' | 'svg'

const MANIFEST_SCHEMA_VERSION = 2
const MANIFEST_MAX_BYTES = 8 * 1024 * 1024
const MAX_DOCUMENTS = 10_000
const MAX_PREFERENCES = 10_000
const MAX_BODY_BYTES = 2 * 1024 * 1024
const MAX_DOCUMENT_BYTES = 200 * 1024 * 1024
const MAX_ASSET_BYTES = 20 * 1024 * 1024
const MAX_SOURCE_BYTES = 100 * 1024 * 1024
const MAX_SOURCE_MAP_BYTES = 32 * 1024 * 1024
const MAX_SOURCE_MAP_ENTRIES = 200_000
const MAX_METADATA_BYTES = 64 * 1024
const MAX_RESOURCES = 200
const MAX_TITLE_CHARS = 200
const MAX_SCOPE_CHARS = 1000
const MAX_TAGS = 30
const MAX_TAG_CHARS = 50
const MAX_WARNINGS = 32
const MAX_WARNING_CHARS = 300
const MAX_SOURCE_LABEL_CHARS = 300
const MAX_SOURCE_DETAIL_CHARS = 2000
const MAX_FILE_NAME_CHARS = 255
const MAX_FILE_TYPE_CHARS = 100
const MAX_LOCATIONS = 12
const EXCERPT_CHARS = 160
const MAX_PAGE_CHARS = 16_000
const MAX_ASSET_BASE64_CHARS = Math.ceil(MAX_ASSET_BYTES / 3) * 4 + 4
const MANUAL_REVISION_WARNING = '正文已人工修订，不再显示原文件位置'
const BUILTIN_LABEL = '产品内置整理内容'
const COPIED_LABEL = '复制自产品内置内容'
const DEFAULT_AUTHORED_SOURCE: StoredSource = { kind: 'authored', label: '用户直接撰写' }
const WRITE_FAILURE = '本机知识文件暂时无法写入，请检查磁盘空间后再试。'
const READ_FAILURE = '本机知识文件暂时无法读取，请稍后重试。'
const HASH = /^[0-9a-f]{64}$/
const DOCUMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const BUILTIN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const MANIFEST_VERSION = /^(0|[1-9]\d{0,14})$/
const ASSET_PATH = /^assets\/([0-9a-f]{64})\.(png|jpg|jpeg|gif|webp|bmp|svg)$/
const ASSET_REFERENCE = /(?<![0-9A-Za-z_./-])assets\/[0-9a-f]{64}\.(?:png|jpg|jpeg|gif|webp|bmp|svg)/g
const PLACEHOLDER = /^eadp-asset:[0-9]{1,9}$/
const TEMPORARY_NAME = /\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/
const DOCUMENT_KEYS = [
  'documentId', 'title', 'category', 'scope', 'tags', 'autoReference', 'organize', 'warnings',
  'contentRevisionId', 'bodyHash', 'metadataHash', 'assetsHash', 'sourceMapHash',
  'bodyPath', 'sourceMapPath', 'resources', 'source', 'createdAt', 'updatedAt',
] as const

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const exactKeys = (value: object, allowed: readonly string[]): boolean =>
  Object.keys(value).every(key => allowed.includes(key))

const isText = (value: unknown, max: number, allowEmpty = false): value is string =>
  typeof value === 'string'
  && value.length <= max
  && !value.includes('\0')
  && (allowEmpty || value.trim().length > 0)

const isHash = (value: unknown): value is string => typeof value === 'string' && HASH.test(value)

const isDocumentId = (value: unknown): value is string => typeof value === 'string' && DOCUMENT_ID.test(value)

const isOrganizeState = (value: unknown): value is KnowledgeOrganizeState =>
  value === 'pending' || value === 'ready' || value === 'failed'

const isIsoTime = (value: unknown): value is string => {
  if (typeof value !== 'string') return false
  const time = Date.parse(value)
  return Number.isFinite(time) && new Date(time).toISOString() === value
}

/** 元数据身份只包含标题、分类与适用范围；检索偏好、标签与提示只影响后续使用，不改变内容身份。 */
const metadataHashOf = (metadata: { title: string; category: KnowledgeCategory; scope: string }): string =>
  hash(JSON.stringify(metadata))

const COPY_SUFFIX = '（我的副本）'

/** 复制内置资料时标出副本；标题超长时截断原题再拼后缀。 */
const copyTitle = (title: string): string => {
  const suffixLength = Array.from(COPY_SUFFIX).length
  const characters = Array.from(title)
  const base = characters.length + suffixLength <= MAX_TITLE_CHARS
    ? characters.join('')
    : characters.slice(0, MAX_TITLE_CHARS - suffixLength).join('')
  return `${base}${COPY_SUFFIX}`
}

/** 资源身份使用正文引用路径与文件内容 hash 的排序清单。 */
const assetsHashOf = (resources: readonly KnowledgeResourceRef[]): string => {
  if (resources.length === 0) return hash('')
  const entries = resources
    .map(resource => [resource.path, assetHashOf(resource.path)] as const)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return hash(JSON.stringify(entries))
}

const assetHashOf = (path: string): string => ASSET_PATH.exec(path)?.[1] ?? fail('RESOURCE_INVALID', '图片位置无效。')

const contentRevisionOf = (metadataHash: string, bodyHash: string, assetsHash: string, sourceMapHash: string): string =>
  hash([metadataHash, bodyHash, assetsHash, sourceMapHash].join('\n'))

const locationsOf = (sourceMap: SourceMapFile | null): string[] => {
  if (sourceMap === null) return []
  const labels: string[] = []
  for (const entry of sourceMap.entries) {
    const label = entry.label.trim()
    if (label !== '' && !labels.includes(label)) labels.push(label)
    if (labels.length >= MAX_LOCATIONS) break
  }
  return labels
}

/** 把正文压成单行纯文本，供摘要与命中片段展示；不用于保存正文。 */
const plainText = (markdown: string): string => {
  let value = markdown
  value = value.replace(/```[\s\S]*?```/g, ' ')
  value = value.replace(/~~~[\s\S]*?~~~/g, ' ')
  value = value.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
  value = value.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  value = value.replace(/<[^>]*>/g, ' ')
  value = value.replace(/`([^`]*)`/g, '$1')
  value = value.replace(/^\s{0,3}#{1,6}\s+/gm, '')
  value = value.replace(/^\s{0,3}>\s?/gm, '')
  value = value.replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, '')
  value = value.replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, ' ')
  value = value.replace(/[|*_~]/g, ' ')
  value = value.replace(/\s+/g, ' ')
  return value.trim()
}

const excerptOf = (text: string): string => Array.from(plainText(text)).slice(0, EXCERPT_CHARS).join('')

const decodeText = (bytes: Uint8Array): string => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    // 解码失败说明文件不是可读文字，按内容损坏处理。
    return fail('RESOURCE_INVALID', '知识文件内容无法识别。')
  }
}

const startsWith = (bytes: Uint8Array, signature: readonly number[]): boolean =>
  signature.every((value, index) => bytes[index] === value)

const headText = (bytes: Uint8Array, limit: number): string =>
  new TextDecoder('utf-8').decode(bytes.subarray(0, Math.min(bytes.length, limit)))

const detectImage = (bytes: Uint8Array): DetectedImage | null => {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png'
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpg'
  const gif = headText(bytes.subarray(0, 6), 6)
  if (gif === 'GIF87a' || gif === 'GIF89a') return 'gif'
  const riff = headText(bytes.subarray(0, 12), 12)
  if (riff.startsWith('RIFF') && riff.endsWith('WEBP')) return 'webp'
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'bmp'
  const head = headText(bytes, 4096).toLowerCase()
  if (head.includes('<svg')) return 'svg'
  return null
}

const canonicalExtension = (extension: string): DetectedImage | null => {
  if (extension === 'png') return 'png'
  if (extension === 'jpg' || extension === 'jpeg') return 'jpg'
  if (extension === 'gif') return 'gif'
  if (extension === 'webp') return 'webp'
  if (extension === 'bmp') return 'bmp'
  if (extension === 'svg') return 'svg'
  return null
}

const extensionOf = (fileName: string): string | null => {
  const index = fileName.lastIndexOf('.')
  return index <= 0 || index === fileName.length - 1 ? null : fileName.slice(index + 1).toLowerCase()
}

const decodeBase64 = (value: unknown): Uint8Array => {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ASSET_BASE64_CHARS) return fail('RESOURCE_INVALID', '图片内容无效。')
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return fail('RESOURCE_INVALID', '图片内容无效。')
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length === 0 || bytes.toString('base64') !== value) return fail('RESOURCE_INVALID', '图片内容无效。')
  return new Uint8Array(bytes)
}

/** 用户知识包的读写；写操作由 {@link KnowledgeStore.mutate} 串行化。 */
export class KnowledgeStore {
  constructor(private readonly diagnostic: (message: string) => void) {
  }

  private tail: Promise<unknown> = Promise.resolve()

  /** 串行化本进程内的写操作；只是队列，不替代提交前的条件校验。 */
  mutate<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(operation)
    this.tail = next.catch(() => {
    })
    return next
  }

  /** 用户资料根目录的绝对路径；导入项等外置文件必须与本存储使用同一根。 */
  get userRoot(): string {
    return join(resolveDshHome(), 'knowledge')
  }

  /** 汇总内置包与用户包的目录；一个包损坏不影响另一个包。 */
  async catalog(): Promise<KnowledgeCatalog> {
    const packs: KnowledgePack[] = []
    const issues: KnowledgeIssue[] = []
    const builtin = await this.loadBuiltin()
    if (builtin.problem !== null) this.diagnostic(`内置资料读取失败：${builtin.problem}`)
    let user: { loaded: LoadedUserPack | null; error: unknown | null }
    try {
      user = { loaded: await this.loadUserPack(), error: null }
    } catch (error) {
      user = { loaded: null, error }
    }
    const preferences = user.loaded === null ? new Map<string, boolean>() : this.preferenceMap(user.loaded.manifest)
    packs.push({
      packId: 'builtin',
      packVersion: builtin.version,
      readOnly: true,
      exists: builtin.exists,
      categories: this.categoryCounts(builtin.documents.map(document => document.category)),
      documents: builtin.documents.map(document => this.builtinSummary(document, preferences.get(document.id) ?? true)),
    })
    if (builtin.problem !== null) {
      issues.push({
        packId: 'builtin',
        code: builtin.exists ? 'RESOURCE_INVALID' : 'UNAVAILABLE',
        message: '内置资料暂时无法读取。',
      })
    }
    if (user.loaded !== null) {
      const loaded = user.loaded
      const documents: KnowledgeDocumentSummary[] = []
      for (const document of loaded.manifest.documents) {
        try {
          const text = await this.readBody(document)
          const locations = await this.readSourceMapLabels(document)
          documents.push(this.toSummary('user', document, text, locations))
        } catch (error) {
          this.diagnostic(`资料目录读取失败：${document.documentId}：${this.errorText(error)}`)
          issues.push({
            packId: 'user',
            code: 'RESOURCE_INVALID',
            message: '部分资料内容不完整，暂不能显示。',
            documentId: document.documentId,
          })
        }
      }
      packs.push({
        packId: 'user',
        packVersion: loaded.manifest.version,
        readOnly: false,
        exists: loaded.exists,
        categories: this.categoryCounts(loaded.manifest.documents.map(document => document.category)),
        documents,
      })
    } else {
      this.diagnostic(`用户资料清单读取失败：${this.errorText(user.error)}`)
      packs.push({
        packId: 'user',
        packVersion: '0',
        readOnly: false,
        exists: false,
        categories: this.categoryCounts([]),
        documents: [],
      })
      issues.push({
        packId: 'user',
        code: user.error instanceof KnowledgeError ? user.error.code : 'UNAVAILABLE',
        message: '我的知识暂时无法读取。',
      })
    }
    return { packs, issues }
  }

  /** 读取整份资料；`expectedRevisionId` 非空时必须仍是当前内容身份。 */
  async readDocument(packId: KnowledgePackId, documentId: string, expectedRevisionId: string | null): Promise<KnowledgeDocument> {
    if (packId !== 'builtin' && packId !== 'user') return fail('INVALID_ARGUMENT', '资料范围无效。')
    if (packId === 'builtin') {
      if (typeof documentId !== 'string' || !BUILTIN_ID.test(documentId)) return fail('INVALID_ARGUMENT', '资料编号无效。')
      const document = this.requireBuiltinDocument(await this.loadBuiltin(), documentId)
      this.assertRevision(document.contentRevisionId, expectedRevisionId)
      const preferences = await this.readBuiltinPreferences()
      return this.builtinDocument(document, preferences.get(document.id) ?? true)
    }
    if (!isDocumentId(documentId)) return fail('INVALID_ARGUMENT', '资料编号无效。')
    const document = this.requireDocument((await this.loadUserPack()).manifest, documentId)
    this.assertRevision(document.contentRevisionId, expectedRevisionId)
    const text = await this.readBody(document)
    const locations = await this.readSourceMapLabels(document)
    return this.toDocument(document, text, locations)
  }

  /** 读取资料引用的图片；路径必须在该资料的图片清单内。 */
  async readResource(packId: KnowledgePackId, documentId: string, expectedRevisionId: string | null, path: string): Promise<Uint8Array> {
    if (packId !== 'builtin' && packId !== 'user') return fail('INVALID_ARGUMENT', '资料范围无效。')
    if (typeof path !== 'string' || !ASSET_PATH.test(path)) return fail('RESOURCE_INVALID', '图片位置无效。')
    if (packId === 'builtin') {
      if (typeof documentId !== 'string' || !BUILTIN_ID.test(documentId)) return fail('INVALID_ARGUMENT', '资料编号无效。')
      const document = this.requireBuiltinDocument(await this.loadBuiltin(), documentId)
      this.assertRevision(document.contentRevisionId, expectedRevisionId)
      return fail('NOT_FOUND', '该资料没有图片。')
    }
    if (!isDocumentId(documentId)) return fail('INVALID_ARGUMENT', '资料编号无效。')
    const document = this.requireDocument((await this.loadUserPack()).manifest, documentId)
    this.assertRevision(document.contentRevisionId, expectedRevisionId)
    if (!document.resources.some(resource => resource.path === path)) return fail('NOT_FOUND', '资料中不存在该图片。')
    try {
      const bytes = await this.readUserFile(path, MAX_ASSET_BYTES)
      if (hash(bytes) !== assetHashOf(path)) return fail('RESOURCE_INVALID', '图片内容与记录不符。')
      return bytes
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fail('NOT_FOUND', '图片文件已丢失。')
      throw error
    }
  }

  /** 分页读取正文；从权威正文文件重读，偏移按 Unicode code-point 计。 */
  async readPage(packId: KnowledgePackId, documentId: string, expectedRevisionId: string | null, offset: number, length: number): Promise<KnowledgeRead> {
    if (packId !== 'builtin' && packId !== 'user') return fail('INVALID_ARGUMENT', '资料范围无效。')
    if (packId === 'builtin') {
      if (typeof documentId !== 'string' || !BUILTIN_ID.test(documentId)) return fail('INVALID_ARGUMENT', '资料编号无效。')
      const document = this.requireBuiltinDocument(await this.loadBuiltin(), documentId)
      this.assertRevision(document.contentRevisionId, expectedRevisionId)
      const page = this.paginate(document.text, offset, length)
      return {
        reference: { packId: 'builtin', documentId: document.id, contentRevisionId: document.contentRevisionId },
        title: document.title,
        category: document.category,
        tags: [...document.tags],
        ...page,
        offset,
        range: { start: offset, end: offset + page.length },
        source: BUILTIN_LABEL,
        locations: [],
        warnings: [],
        evidenceId: null,
      }
    }
    if (!isDocumentId(documentId)) return fail('INVALID_ARGUMENT', '资料编号无效。')
    const document = this.requireDocument((await this.loadUserPack()).manifest, documentId)
    this.assertRevision(document.contentRevisionId, expectedRevisionId)
    const text = await this.readBody(document)
    const page = this.paginate(text, offset, length)
    return {
      reference: { packId: 'user', documentId: document.documentId, contentRevisionId: document.contentRevisionId },
      title: document.title,
      category: document.category,
      tags: [...document.tags],
      ...page,
      offset,
      range: { start: offset, end: offset + page.length },
      source: document.source.label,
      locations: await this.readSourceMapLabels(document),
      warnings: [...document.warnings],
      evidenceId: null,
    }
  }

  /**
   * 索引输入：全部可参与查找的资料正文与内容身份；供后台索引与查询核验使用。
   * 读取失败的资料通过 `issues` 如实报告，不静默当作不存在。
   */
  async indexInputs(): Promise<{ documents: IndexedDocument[]; issues: KnowledgeIssue[] }> {
    const documents: IndexedDocument[] = []
    const issues: KnowledgeIssue[] = []
    const builtin = await this.loadBuiltin()
    if (builtin.problem !== null) {
      this.diagnostic(`内置资料读取失败：${builtin.problem}`)
      issues.push({ packId: 'builtin', code: 'UNAVAILABLE', message: '内置资料暂时无法读取。' })
    }
    const builtinPreferences = await this.readBuiltinPreferences()
    for (const document of builtin.documents)
      documents.push(this.indexInputOfBuiltin(document, builtinPreferences.get(document.id) ?? true))
    try {
      const loaded = await this.loadUserPack()
      for (const document of loaded.manifest.documents) {
        try {
          documents.push(await this.indexInputOfUser(document))
        } catch (error) {
          this.diagnostic(`索引前读取资料失败：${document.documentId}：${this.errorText(error)}`)
          issues.push({ packId: 'user', code: 'RESOURCE_INVALID', message: '部分资料内容不完整，暂不能参与查找。', documentId: document.documentId })
        }
      }
    } catch (error) {
      this.diagnostic(`我的知识清单读取失败：${this.errorText(error)}`)
      issues.push({ packId: 'user', code: error instanceof KnowledgeError ? error.code : 'UNAVAILABLE', message: '我的知识暂时无法读取。' })
    }
    return { documents, issues }
  }

  /**
   * 单份资料的索引输入；资料不存在或正文不可读时返回 null。
   * 索引任务在发布前用它重新核验内容身份，避免迟到版本被发布。
   */
  async indexDocument(packId: KnowledgePackId, documentId: string): Promise<IndexedDocument | null> {
    if (packId === 'builtin') {
      if (typeof documentId !== 'string' || !BUILTIN_ID.test(documentId)) return null
      const builtin = await this.loadBuiltin()
      if (builtin.problem !== null) {
        this.diagnostic(`索引前读取内置资料失败：${builtin.problem}`)
        return null
      }
      const document = builtin.documents.find(candidate => candidate.id === documentId)
      if (document === undefined) return null
      const preferences = await this.readBuiltinPreferences()
      return this.indexInputOfBuiltin(document, preferences.get(documentId) ?? true)
    }
    if (packId !== 'user' || !isDocumentId(documentId)) return null
    let loaded: LoadedUserPack
    try {
      loaded = await this.loadUserPack()
    } catch (error) {
      this.diagnostic(`索引前读取资料清单失败：${this.errorText(error)}`)
      return null
    }
    const document = loaded.manifest.documents.find(candidate => candidate.documentId === documentId)
    if (document === undefined) return null
    try {
      return await this.indexInputOfUser(document)
    } catch (error) {
      this.diagnostic(`索引前读取资料失败：${documentId}：${this.errorText(error)}`)
      return null
    }
  }

  /** 只读清单的当前内容身份；资料不存在或清单不可读时返回 null。 */
  async currentRevision(packId: KnowledgePackId, documentId: string): Promise<string | null> {
    try {
      if (packId === 'builtin') {
        if (typeof documentId !== 'string' || !BUILTIN_ID.test(documentId)) return null
        const builtin = await this.loadBuiltin()
        if (builtin.problem !== null) return null
        return builtin.documents.find(candidate => candidate.id === documentId)?.contentRevisionId ?? null
      }
      if (packId !== 'user' || !isDocumentId(documentId)) return null
      const loaded = await this.loadUserPack()
      return loaded.manifest.documents.find(candidate => candidate.documentId === documentId)?.contentRevisionId ?? null
    } catch (error) {
      this.diagnostic(`读取资料版本失败：${documentId}：${this.errorText(error)}`)
      return null
    }
  }

  private indexInputOfBuiltin(document: BuiltinDocument, autoReference: boolean): IndexedDocument {
    return {
      packId: 'builtin',
      documentId: document.id,
      contentRevisionId: document.contentRevisionId,
      bodyHash: document.bodyHash,
      metadataHash: document.metadataHash,
      assetsHash: EMPTY_HASH,
      sourceMapHash: EMPTY_HASH,
      title: document.title,
      category: document.category,
      scope: document.scope,
      tags: [...document.tags],
      autoReference,
      sourceLabel: BUILTIN_LABEL,
      locations: [],
      warnings: [],
      text: document.text,
    }
  }

  private async indexInputOfUser(document: ManifestDocument): Promise<IndexedDocument> {
    const text = await this.readBody(document)
    return {
      packId: 'user',
      documentId: document.documentId,
      contentRevisionId: document.contentRevisionId,
      bodyHash: document.bodyHash,
      metadataHash: document.metadataHash,
      assetsHash: document.assetsHash,
      sourceMapHash: document.sourceMapHash,
      title: document.title,
      category: document.category,
      scope: document.scope,
      tags: [...document.tags],
      autoReference: document.autoReference,
      sourceLabel: this.sourceSummary(document.source).label,
      locations: await this.readSourceMapLabels(document),
      warnings: [...document.warnings],
      text,
    }
  }

  /** 按 manifest 计算查找准入集合；`${packId}:${documentId}`。 */
  async admittedDocumentKeys(admission: 'auto-reference' | 'all'): Promise<Set<string>> {
    const keys = new Set<string>()
    const builtin = await this.loadBuiltin()
    const builtinPreferences = await this.readBuiltinPreferences()
    for (const document of builtin.documents) {
      if (admission === 'auto-reference' && !(builtinPreferences.get(document.id) ?? true)) continue
      keys.add(`builtin:${document.id}`)
    }
    try {
      const loaded = await this.loadUserPack()
      for (const document of loaded.manifest.documents) {
        if (admission === 'auto-reference' && !document.autoReference) continue
        keys.add(`user:${document.documentId}`)
      }
    } catch (error) {
      this.diagnostic(`查找准入计算失败：${this.errorText(error)}`)
    }
    return keys
  }

  /**
   * 证据核验来源：完整 canonical 正文与可固定到项目的来源资产。
   * 只读取，不签发证据；证据由知识插件按会话登记。
   */
  async evidenceSource(packId: KnowledgePackId, documentId: string, expectedRevisionId: string): Promise<KnowledgeEvidenceSource> {
    if (packId !== 'builtin' && packId !== 'user') return fail('INVALID_ARGUMENT', '资料范围无效。')
    if (packId === 'builtin') {
      if (typeof documentId !== 'string' || !BUILTIN_ID.test(documentId)) return fail('INVALID_ARGUMENT', '资料编号无效。')
      const document = this.requireBuiltinDocument(await this.loadBuiltin(), documentId)
      this.assertRevision(document.contentRevisionId, expectedRevisionId)
      return {
        packId: 'builtin',
        documentId: document.id,
        contentRevisionId: document.contentRevisionId,
        title: document.title,
        category: document.category,
        scope: document.scope,
        tags: [...document.tags],
        source: { kind: 'builtin', label: BUILTIN_LABEL, detail: document.detail, hasOriginal: false },
        warnings: [],
        locations: [],
        text: document.text,
        resources: [],
        sourceMap: null,
        sourceHash: null,
      }
    }
    if (!isDocumentId(documentId)) return fail('INVALID_ARGUMENT', '资料编号无效。')
    const document = this.requireDocument((await this.loadUserPack()).manifest, documentId)
    this.assertRevision(document.contentRevisionId, expectedRevisionId)
    const text = await this.readBody(document)
    return {
      packId: 'user',
      documentId: document.documentId,
      contentRevisionId: document.contentRevisionId,
      title: document.title,
      category: document.category,
      scope: document.scope,
      tags: [...document.tags],
      source: this.sourceSummary(document.source),
      warnings: [...document.warnings],
      locations: await this.readSourceMapLabels(document),
      text,
      resources: document.resources.map(resource => ({ path: resource.path, fileName: resource.fileName })),
      sourceMap: await this.readSourceMap(document),
      sourceHash: document.source.kind === 'imported' && document.source.sourceHash !== undefined && this.hasSource(document.source.sourceHash) ? document.source.sourceHash : null,
    }
  }

  /** 新建或修改资料；正文、资源与来源映射先落盘，清单最后提交。 */
  async saveDocument(
    documentId: string | null,
    expectedRevisionId: string | null,
    draft: KnowledgeDraft,
    resources: KnowledgeDraftResource[],
    origin?: { source: StoredSource; sourceMap: SourceMapFile | null; warnings: string[] },
  ): Promise<KnowledgeDocument> {
    const normalized = this.validateDraft(draft)
    const validatedOrigin = origin === undefined ? undefined : this.validateOrigin(origin)
    if (documentId === null) {
      if (expectedRevisionId !== null) return fail('INVALID_ARGUMENT', '新建资料不应带有版本信息。')
    } else {
      if (!isDocumentId(documentId)) return fail('INVALID_ARGUMENT', '资料编号无效。')
      if (expectedRevisionId === null) return fail('INVALID_ARGUMENT', '修改资料需要当前版本。')
      if (!isHash(expectedRevisionId)) return fail('INVALID_ARGUMENT', '资料版本无效。')
    }
    const loaded = await this.loadUserPack()
    const previous = documentId === null ? null : this.requireDocument(loaded.manifest, documentId)
    if (previous !== null && previous.contentRevisionId !== expectedRevisionId) return fail('VERSION_MISMATCH', '资料已更新，请重新打开后再试。')
    const targetDocumentId = previous === null ? randomUUID() : previous.documentId
    const source = validatedOrigin?.source ?? previous?.source ?? { ...DEFAULT_AUTHORED_SOURCE }
    let sourceMap = validatedOrigin?.sourceMap ?? null
    const warnings = validatedOrigin !== undefined ? [...validatedOrigin.warnings] : previous === null ? [] : [...previous.warnings]
    if (validatedOrigin === undefined && previous !== null && previous.sourceMapPath !== null) {
      sourceMap = null
      if (!warnings.includes(MANUAL_REVISION_WARNING)) warnings.push(MANUAL_REVISION_WARNING)
    }
    const content = await this.prepareContent(normalized.text, resources, previous)
    const bodyBytes = Buffer.from(content.text, 'utf8')
    const bodyHash = hash(bodyBytes)
    const metadataHash = metadataHashOf({
      title: normalized.title,
      category: normalized.category,
      scope: normalized.scope,
    })
    const assetsHash = assetsHashOf(content.resources)
    const sourceMapBytes = sourceMap === null ? null : Buffer.from(`${JSON.stringify(sourceMap, null, 2)}\n`, 'utf8')
    const sourceMapHash = sourceMapBytes === null ? hash('') : hash(sourceMapBytes)
    const contentRevisionId = contentRevisionOf(metadataHash, bodyHash, assetsHash, sourceMapHash)
    const bodyPath = `cards/${targetDocumentId}/${bodyHash}.md`
    const sourceMapPath = sourceMapBytes === null ? null : `source-maps/${targetDocumentId}/${contentRevisionId}.json`
    const now = new Date().toISOString()
    const document: ManifestDocument = {
      documentId: targetDocumentId,
      title: normalized.title,
      category: normalized.category,
      scope: normalized.scope,
      tags: previous === null ? [] : [...previous.tags],
      autoReference: normalized.autoReference,
      organize: 'pending',
      warnings: this.truncateWarnings(warnings),
      contentRevisionId,
      bodyHash,
      metadataHash,
      assetsHash,
      sourceMapHash,
      bodyPath,
      sourceMapPath,
      resources: content.resources,
      source,
      createdAt: previous === null ? now : previous.createdAt,
      updatedAt: now,
    }
    const manifest = this.replaceDocument(loaded.manifest, document)
    const created: ContentWrite[] = []
    try {
      for (const write of content.writes) await this.writeContentFile(write.path, write.bytes, write.hash, created)
      await this.writeContentFile(bodyPath, bodyBytes, bodyHash, created)
      if (sourceMapPath !== null && sourceMapBytes !== null) await this.writeContentFile(sourceMapPath, sourceMapBytes, sourceMapHash, created)
      await this.commit(loaded, manifest, previous === null ? null : targetDocumentId, previous === null ? null : expectedRevisionId)
    } catch (error) {
      await this.rollbackCreated(created)
      throw error
    }
    if (previous !== null) await this.cleanupRevision(previous, manifest.documents)
    return this.toDocument(document, content.text, locationsOf(sourceMap))
  }

  /**
   * 设置“参与需求沟通”偏好。用户偏好写在资料自身字段；内置包只读，
   * 内置偏好按 packId + documentId 记在用户清单里。两者都不改变内容身份。
   */
  async setAutoReference(packId: KnowledgePackId, documentId: string, expectedRevisionId: string, autoReference: boolean): Promise<void> {
    if (packId !== 'builtin' && packId !== 'user') return fail('INVALID_ARGUMENT', '资料范围无效。')
    if (!isHash(expectedRevisionId)) return fail('INVALID_ARGUMENT', '资料版本无效。')
    if (typeof autoReference !== 'boolean') return fail('INVALID_ARGUMENT', '自动参考设置无效。')
    if (packId === 'builtin') {
      await this.setBuiltinAutoReference(documentId, expectedRevisionId, autoReference)
      return
    }
    if (!isDocumentId(documentId)) return fail('INVALID_ARGUMENT', '资料编号无效。')
    const loaded = await this.loadUserPack()
    const previous = this.requireDocument(loaded.manifest, documentId)
    this.assertRevision(previous.contentRevisionId, expectedRevisionId)
    if (previous.autoReference === autoReference) return
    const document: ManifestDocument = {
      ...previous,
      autoReference,
      updatedAt: new Date().toISOString(),
    }
    await this.commit(loaded, this.replaceDocument(loaded.manifest, document), documentId, expectedRevisionId)
  }

  /** 内置资料的内容身份用于确认操作基于当前包版本；偏好本身只改用户清单。 */
  private async setBuiltinAutoReference(documentId: string, expectedRevisionId: string, autoReference: boolean): Promise<void> {
    if (typeof documentId !== 'string' || !BUILTIN_ID.test(documentId)) return fail('INVALID_ARGUMENT', '资料编号无效。')
    const document = this.requireBuiltinDocument(await this.loadBuiltin(), documentId)
    this.assertRevision(document.contentRevisionId, expectedRevisionId)
    const loaded = await this.loadUserPack()
    const current = loaded.manifest.preferences.find(preference => preference.documentId === documentId)
    if ((current?.autoReference ?? true) === autoReference) return
    // 缺省即为参与，因此打开偏好时删除记录，关闭时新增记录。
    const preferences = loaded.manifest.preferences.filter(preference => preference.documentId !== documentId)
    if (!autoReference) preferences.push({ packId: 'builtin', documentId, autoReference: false })
    await this.commit(loaded, this.nextManifest(loaded.manifest, loaded.manifest.documents, preferences), null, null)
  }

  /** 删除资料；清单提交后清理不再被引用的内容文件。 */
  async removeDocument(documentId: string, expectedRevisionId: string): Promise<void> {
    if (!isDocumentId(documentId)) return fail('INVALID_ARGUMENT', '资料编号无效。')
    if (!isHash(expectedRevisionId)) return fail('INVALID_ARGUMENT', '资料版本无效。')
    const loaded = await this.loadUserPack()
    const previous = this.requireDocument(loaded.manifest, documentId)
    this.assertRevision(previous.contentRevisionId, expectedRevisionId)
    const manifest = this.nextManifest(
      loaded.manifest,
      loaded.manifest.documents.filter(document => document.documentId !== documentId),
    )
    await this.commit(loaded, manifest, documentId, expectedRevisionId)
    await this.cleanupRevision(previous, manifest.documents)
    await this.removeEmptyDocumentDirectories(documentId)
  }

  /** 把内置资料复制为用户资料；标题标出副本，来源保留原出处，原内置包不变。 */
  async copyBuiltin(documentId: string, expectedRevisionId: string): Promise<KnowledgeDocument> {
    if (typeof documentId !== 'string' || !BUILTIN_ID.test(documentId)) return fail('INVALID_ARGUMENT', '资料编号无效。')
    if (!isHash(expectedRevisionId)) return fail('INVALID_ARGUMENT', '资料版本无效。')
    const source = this.requireBuiltinDocument(await this.loadBuiltin(), documentId)
    this.assertRevision(source.contentRevisionId, expectedRevisionId)
    const loaded = await this.loadUserPack()
    const now = new Date().toISOString()
    const title = copyTitle(source.title)
    const bodyBytes = Buffer.from(source.text, 'utf8')
    const bodyHash = hash(bodyBytes)
    const metadataHash = metadataHashOf({
      title,
      category: source.category,
      scope: source.scope,
    })
    const assetsHash = assetsHashOf([])
    const sourceMapHash = hash('')
    const contentRevisionId = contentRevisionOf(metadataHash, bodyHash, assetsHash, sourceMapHash)
    const targetDocumentId = randomUUID()
    const document: ManifestDocument = {
      documentId: targetDocumentId,
      title,
      category: source.category,
      scope: source.scope,
      tags: [...source.tags],
      autoReference: true,
      organize: 'ready',
      warnings: [],
      contentRevisionId,
      bodyHash,
      metadataHash,
      assetsHash,
      sourceMapHash,
      bodyPath: `cards/${targetDocumentId}/${bodyHash}.md`,
      sourceMapPath: null,
      resources: [],
      source: { kind: 'builtin-copy', label: COPIED_LABEL, detail: source.detail },
      createdAt: now,
      updatedAt: now,
    }
    const manifest = this.replaceDocument(loaded.manifest, document)
    const created: ContentWrite[] = []
    try {
      await this.writeContentFile(document.bodyPath, bodyBytes, bodyHash, created)
      await this.commit(loaded, manifest, null, null)
    } catch (error) {
      await this.rollbackCreated(created)
      throw error
    }
    return this.toDocument(document, source.text, [])
  }

  /** 按内容 hash 保存原件；已存在同内容原件时直接复用。 */
  async saveSource(bytes: Uint8Array, fileName: string, fileType: string | undefined): Promise<{ sourceHash: string; size: number; fileType?: string }> {
    if (!(bytes instanceof Uint8Array) || bytes.length === 0) return fail('INVALID_ARGUMENT', '文件内容为空，无法保存。')
    if (bytes.length > MAX_SOURCE_BYTES) return fail('LIMIT_EXCEEDED', '单个文件不能超过 100 MB。')
    const name = this.requireFileName(fileName)
    const type = fileType === undefined ? undefined : this.requireFileType(fileType)
    const sourceHash = hash(bytes)
    const existing = await this.existingSourceMetadata(sourceHash)
    if (existing !== null) return this.sourceReceipt(sourceHash, existing)
    await this.storeSourceDirectory(sourceHash, bytes, name, type)
    return this.sourceReceipt(sourceHash, await this.readSourceMetadataRecord(sourceHash))
  }

  /** 读取原件字节并核对内容 hash。 */
  async readSource(sourceHash: string): Promise<Uint8Array> {
    if (!isHash(sourceHash)) return fail('INVALID_ARGUMENT', '原件编号无效。')
    try {
      const bytes = await this.readUserFile(`sources/${sourceHash}/payload`, MAX_SOURCE_BYTES)
      if (hash(bytes) !== sourceHash) return fail('RESOURCE_INVALID', '原件内容与记录不符。')
      return bytes
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fail('NOT_FOUND', '原件不存在。')
      throw error
    }
  }

  /** 读取原件元数据；用于来源与原件视图。 */
  async readSourceMetadata(sourceHash: string): Promise<{ fileName: string; size: number; fileType?: string; importedAt: string }> {
    if (!isHash(sourceHash)) return fail('INVALID_ARGUMENT', '原件编号无效。')
    try {
      return await this.readSourceMetadataRecord(sourceHash)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fail('NOT_FOUND', '原件信息不存在。')
      throw error
    }
  }

  /** 同步判断原件是否可用；界面渲染来源信息时不能等待文件系统。 */
  hasSource(sourceHash: string): boolean {
    if (!isHash(sourceHash)) return false
    return this.isRegularFileSync(this.userPath(`sources/${sourceHash}/payload`))
  }

  /** 后台整理回写标签；内容身份已变化时放弃，不覆盖用户的新版本。 */
  async updateTags(documentId: string, baseRevisionId: string, tags: string[], organize: 'ready' | 'failed'): Promise<KnowledgeDocumentSummary | null> {
    if (!isDocumentId(documentId)) return fail('INVALID_ARGUMENT', '资料编号无效。')
    if (!isHash(baseRevisionId)) return fail('INVALID_ARGUMENT', '资料版本无效。')
    if (organize !== 'ready' && organize !== 'failed') return fail('INVALID_ARGUMENT', '整理状态无效。')
    const nextTags = this.parseTags(tags, 'INVALID_ARGUMENT')
    const loaded = await this.loadUserPack()
    const previous = this.requireDocument(loaded.manifest, documentId)
    if (previous.contentRevisionId !== baseRevisionId) return null
    if (previous.organize === organize && sameTextList(previous.tags, nextTags)) return this.summaryOf(previous)
    const document: ManifestDocument = {
      ...previous,
      tags: nextTags,
      organize,
      updatedAt: new Date().toISOString(),
    }
    await this.commit(loaded, this.replaceDocument(loaded.manifest, document), documentId, baseRevisionId)
    return this.summaryOf(document)
  }

  /** 只改整理状态；不改变内容身份。 */
  async setOrganize(documentId: string, expectedRevisionId: string, organize: KnowledgeOrganizeState): Promise<KnowledgeDocumentSummary> {
    if (!isDocumentId(documentId)) return fail('INVALID_ARGUMENT', '资料编号无效。')
    if (!isHash(expectedRevisionId)) return fail('INVALID_ARGUMENT', '资料版本无效。')
    if (!isOrganizeState(organize)) return fail('INVALID_ARGUMENT', '整理状态无效。')
    const loaded = await this.loadUserPack()
    const previous = this.requireDocument(loaded.manifest, documentId)
    this.assertRevision(previous.contentRevisionId, expectedRevisionId)
    if (previous.organize === organize) return this.summaryOf(previous)
    const document: ManifestDocument = {
      ...previous,
      organize,
      updatedAt: new Date().toISOString(),
    }
    await this.commit(loaded, this.replaceDocument(loaded.manifest, document), documentId, expectedRevisionId)
    return this.summaryOf(document)
  }

  /** 启动核对：报告被引用文件的缺失或变化，清理可判定的孤儿与临时文件。 */
  async reconcile(): Promise<void> {
    let loaded: LoadedUserPack
    try {
      loaded = await this.loadUserPack()
    } catch (error) {
      this.diagnostic(`知识库核对已跳过：${this.errorText(error)}`)
      return
    }
    if (!loaded.exists) return
    await this.reconcilePreferences(loaded)
    const documents = loaded.manifest.documents
    const bodies = new Set(documents.map(document => document.bodyPath))
    const maps = new Set(documents.flatMap(document => document.sourceMapPath === null ? [] : [document.sourceMapPath]))
    const assets = new Set(documents.flatMap(document => document.resources.map(resource => resource.path)))
    await this.reportContent()
    await this.reconcileDocumentDirectory('cards', bodies)
    await this.reconcileDocumentDirectory('source-maps', maps)
    await this.reconcileAssetDirectory(assets)
    await this.reconcileTemporaryFiles()
  }

  // ---------- 读取与清单 ----------

  /** 清理指向已不存在内置资料的内置偏好；内置包不可用时跳过，避免误删。 */
  private async reconcilePreferences(loaded: LoadedUserPack): Promise<void> {
    if (loaded.manifest.preferences.length === 0) return
    const builtin = await this.loadBuiltin()
    if (!builtin.exists || builtin.problem !== null) {
      this.diagnostic('内置资料不可用，已跳过内置偏好核对。')
      return
    }
    const known = new Set(builtin.documents.map(document => document.id))
    const preferences = loaded.manifest.preferences.filter(preference => {
      if (known.has(preference.documentId)) return true
      this.diagnostic(`清理已不存在的内置资料偏好：${preference.documentId}`)
      return false
    })
    if (preferences.length === loaded.manifest.preferences.length) return
    try {
      await this.commit(loaded, this.nextManifest(loaded.manifest, loaded.manifest.documents, preferences), null, null)
    } catch (error) {
      this.diagnostic(`内置偏好核对提交失败：${this.errorText(error)}`)
    }
  }

  private async loadUserPack(): Promise<LoadedUserPack> {
    let raw: string
    try {
      raw = decodeText(await this.readUserFile('manifest.json', MANIFEST_MAX_BYTES))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { raw: null, manifest: this.emptyManifest(), exists: false }
      throw error
    }
    return { raw, manifest: this.parseManifest(raw), exists: true }
  }

  private emptyManifest(): UserManifest {
    return { schemaVersion: MANIFEST_SCHEMA_VERSION, packId: 'user', version: '0', documents: [], preferences: [] }
  }

  private parseManifest(raw: string): UserManifest {
    const damaged = (): never => fail('RESOURCE_INVALID', '资料清单无法识别，暂时不能打开知识库。')
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      // 清单不是合法 JSON 时不能猜测修复，只能报告损坏。
      return damaged()
    }
    if (!isRecord(parsed) || !exactKeys(parsed, ['schemaVersion', 'packId', 'version', 'documents', 'preferences'])) return damaged()
    if (parsed.schemaVersion !== MANIFEST_SCHEMA_VERSION || parsed.packId !== 'user') return damaged()
    const version = parsed.version
    if (typeof version !== 'string' || !MANIFEST_VERSION.test(version)) return damaged()
    const rawDocuments = parsed.documents
    if (!Array.isArray(rawDocuments) || rawDocuments.length > MAX_DOCUMENTS) return damaged()
    const documents: ManifestDocument[] = []
    const ids = new Set<string>()
    for (const item of rawDocuments) {
      const document = this.parseManifestDocument(item)
      if (ids.has(document.documentId)) return damaged()
      ids.add(document.documentId)
      documents.push(document)
    }
    const preferences = parsed.preferences === undefined ? [] : this.parsePreferences(parsed.preferences)
    return { schemaVersion: MANIFEST_SCHEMA_VERSION, packId: 'user', version, documents, preferences }
  }

  /** 内置偏好列表；旧清单没有该字段时按空列表处理。 */
  private parsePreferences(value: unknown): ManifestPreference[] {
    const damaged = (): never => fail('RESOURCE_INVALID', '资料清单格式无法识别，暂时不能打开知识库。')
    if (!Array.isArray(value) || value.length > MAX_PREFERENCES) return damaged()
    const preferences: ManifestPreference[] = []
    const ids = new Set<string>()
    for (const item of value) {
      if (!isRecord(item) || !exactKeys(item, ['packId', 'documentId', 'autoReference'])) return damaged()
      const packId = item.packId
      const documentId = item.documentId
      const autoReference = item.autoReference
      if (packId !== 'builtin') return damaged()
      if (typeof documentId !== 'string' || !BUILTIN_ID.test(documentId) || ids.has(documentId)) return damaged()
      if (typeof autoReference !== 'boolean') return damaged()
      ids.add(documentId)
      preferences.push({ packId: 'builtin', documentId, autoReference })
    }
    return preferences
  }

  private parseManifestDocument(value: unknown): ManifestDocument {
    const damaged = (): never => fail('RESOURCE_INVALID', '资料清单格式无法识别，暂时不能打开知识库。')
    if (!isRecord(value) || !exactKeys(value, DOCUMENT_KEYS)) return damaged()
    const documentId = value.documentId
    const title = value.title
    const category = value.category
    const scope = value.scope
    const autoReference = value.autoReference
    const organize = value.organize
    const contentRevisionId = value.contentRevisionId
    const bodyHash = value.bodyHash
    const metadataHash = value.metadataHash
    const assetsHash = value.assetsHash
    const sourceMapHash = value.sourceMapHash
    const bodyPath = value.bodyPath
    const sourceMapPath = value.sourceMapPath
    const createdAt = value.createdAt
    const updatedAt = value.updatedAt
    if (!isDocumentId(documentId)) return damaged()
    if (!isText(title, MAX_TITLE_CHARS) || !isKnowledgeCategory(category) || !isText(scope, MAX_SCOPE_CHARS, true)) return damaged()
    if (typeof autoReference !== 'boolean' || !isOrganizeState(organize)) return damaged()
    if (!isHash(contentRevisionId) || !isHash(bodyHash) || !isHash(metadataHash) || !isHash(assetsHash) || !isHash(sourceMapHash)) return damaged()
    if (!isIsoTime(createdAt) || !isIsoTime(updatedAt)) return damaged()
    const tags = this.parseTags(value.tags, 'RESOURCE_INVALID')
    const warnings = this.parseWarnings(value.warnings, 'RESOURCE_INVALID')
    const resources = this.parseResources(value.resources, 'RESOURCE_INVALID')
    const source = this.validateStoredSource(value.source, 'RESOURCE_INVALID')
    if (bodyPath !== `cards/${documentId}/${bodyHash}.md`) return damaged()
    if (sourceMapPath !== null && sourceMapPath !== `source-maps/${documentId}/${contentRevisionId}.json`) return damaged()
    if (metadataHashOf({ title, category, scope }) !== metadataHash) return damaged()
    if (assetsHashOf(resources) !== assetsHash) return damaged()
    if (contentRevisionOf(metadataHash, bodyHash, assetsHash, sourceMapHash) !== contentRevisionId) return damaged()
    return {
      documentId,
      title,
      category,
      scope,
      tags,
      autoReference,
      organize,
      warnings,
      contentRevisionId,
      bodyHash,
      metadataHash,
      assetsHash,
      sourceMapHash,
      bodyPath,
      sourceMapPath,
      resources,
      source,
      createdAt,
      updatedAt,
    }
  }

  private parseTags(value: unknown, code: KnowledgeErrorCode): string[] {
    return this.parseTextList(value, code, MAX_TAGS, MAX_TAG_CHARS)
  }

  private parseWarnings(value: unknown, code: KnowledgeErrorCode): string[] {
    return this.parseTextList(value, code, MAX_WARNINGS, MAX_WARNING_CHARS)
  }

  private parseTextList(value: unknown, code: KnowledgeErrorCode, maxCount: number, maxChars: number): string[] {
    if (!Array.isArray(value) || value.length > maxCount) return fail(code, '资料附加信息无效。')
    const items: string[] = []
    for (const item of value) {
      if (!isText(item, maxChars)) return fail(code, '资料附加信息无效。')
      const text = item.trim()
      if (!items.includes(text)) items.push(text)
    }
    return items
  }

  private parseResources(value: unknown, code: KnowledgeErrorCode): KnowledgeResourceRef[] {
    if (!Array.isArray(value) || value.length > MAX_RESOURCES) return fail(code, '资料图片清单无效。')
    const resources: KnowledgeResourceRef[] = []
    const paths = new Set<string>()
    for (const item of value) {
      if (!isRecord(item) || !exactKeys(item, ['path', 'fileName'])) return fail(code, '资料图片清单无效。')
      const path = item.path
      const fileName = item.fileName
      if (!isText(path, 200) || !ASSET_PATH.test(path) || paths.has(path)) return fail(code, '资料图片清单无效。')
      if (!this.isSafeFileName(fileName)) return fail(code, '资料图片清单无效。')
      paths.add(path)
      resources.push({ path, fileName })
    }
    return resources
  }

  private validateStoredSource(value: unknown, code: KnowledgeErrorCode): StoredSource {
    if (!isRecord(value) || !exactKeys(value, ['kind', 'label', 'fileName', 'size', 'fileType', 'importId', 'sourceHash', 'detail']))
      return fail(code, '资料来源信息无效。')
    const kind = value.kind
    const label = value.label
    if (kind !== 'imported' && kind !== 'authored' && kind !== 'builtin-copy') return fail(code, '资料来源信息无效。')
    if (!isText(label, MAX_SOURCE_LABEL_CHARS)) return fail(code, '资料来源说明无效。')
    const source: StoredSource = { kind, label: label.trim() }
    const fileName = value.fileName
    if (fileName !== undefined) {
      if (!this.isSafeFileName(fileName)) return fail(code, '资料来源信息无效。')
      source.fileName = fileName
    }
    const size = value.size
    if (size !== undefined) {
      if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) return fail(code, '资料来源信息无效。')
      source.size = size
    }
    const fileType = value.fileType
    if (fileType !== undefined) {
      if (!isText(fileType, MAX_FILE_TYPE_CHARS)) return fail(code, '资料来源信息无效。')
      source.fileType = fileType.trim()
    }
    const importId = value.importId
    if (importId !== undefined) {
      if (typeof importId !== 'string' || importId.length === 0 || importId.length > 100 || importId.includes('\0'))
        return fail(code, '资料来源信息无效。')
      source.importId = importId
    }
    const sourceHash = value.sourceHash
    if (sourceHash !== undefined) {
      if (!isHash(sourceHash)) return fail(code, '资料来源信息无效。')
      source.sourceHash = sourceHash
    }
    const detail = value.detail
    if (detail !== undefined) {
      if (!isText(detail, MAX_SOURCE_DETAIL_CHARS)) return fail(code, '资料来源信息无效。')
      source.detail = detail.trim()
    }
    return source
  }

  private validateSourceMap(value: unknown): SourceMapFile {
    if (!isRecord(value) || !exactKeys(value, ['schemaVersion', 'entries']) || value.schemaVersion !== 1)
      return fail('INVALID_ARGUMENT', '来源位置信息无效。')
    const rawEntries = value.entries
    if (!Array.isArray(rawEntries) || rawEntries.length > MAX_SOURCE_MAP_ENTRIES) return fail('INVALID_ARGUMENT', '来源位置信息无效。')
    const entries: SourceMapEntry[] = []
    for (const item of rawEntries) {
      if (!isRecord(item) || !exactKeys(item, ['start', 'end', 'label', 'page', 'sheet', 'cell', 'slide', 'section']))
        return fail('INVALID_ARGUMENT', '来源位置信息无效。')
      const start = item.start
      const end = item.end
      const label = item.label
      if (typeof start !== 'number' || !Number.isSafeInteger(start) || start < 0) return fail('INVALID_ARGUMENT', '来源位置信息无效。')
      if (typeof end !== 'number' || !Number.isSafeInteger(end) || end < start) return fail('INVALID_ARGUMENT', '来源位置信息无效。')
      if (!isText(label, 200)) return fail('INVALID_ARGUMENT', '来源位置信息无效。')
      const entry: SourceMapEntry = { start, end, label: label.trim() }
      const page = item.page
      if (page !== undefined) {
        if (typeof page !== 'number' || !Number.isSafeInteger(page) || page < 0) return fail('INVALID_ARGUMENT', '来源位置信息无效。')
        entry.page = page
      }
      const slide = item.slide
      if (slide !== undefined) {
        if (typeof slide !== 'number' || !Number.isSafeInteger(slide) || slide < 0) return fail('INVALID_ARGUMENT', '来源位置信息无效。')
        entry.slide = slide
      }
      const sheet = item.sheet
      if (sheet !== undefined) {
        if (!isText(sheet, 200)) return fail('INVALID_ARGUMENT', '来源位置信息无效。')
        entry.sheet = sheet
      }
      const cell = item.cell
      if (cell !== undefined) {
        if (!isText(cell, 200)) return fail('INVALID_ARGUMENT', '来源位置信息无效。')
        entry.cell = cell
      }
      const section = item.section
      if (section !== undefined) {
        if (!isText(section, 200)) return fail('INVALID_ARGUMENT', '来源位置信息无效。')
        entry.section = section
      }
      entries.push(entry)
    }
    return { schemaVersion: 1, entries }
  }

  private validateDraft(draft: KnowledgeDraft): NormalizedDraft {
    if (!isRecord(draft) || !exactKeys(draft, ['title', 'category', 'scope', 'text', 'autoReference']))
      return fail('INVALID_ARGUMENT', '资料内容不完整，请检查后重试。')
    const title = typeof draft.title === 'string' ? draft.title.trim() : ''
    const scope = typeof draft.scope === 'string' ? draft.scope.trim() : ''
    const text = draft.text
    const autoReference = draft.autoReference
    const category = draft.category
    if (!isText(title, MAX_TITLE_CHARS)) return fail('INVALID_ARGUMENT', '请填写资料标题，最多 200 字。')
    if (!isKnowledgeCategory(category)) return fail('INVALID_ARGUMENT', '请选择知识分类。')
    if (!isText(scope, MAX_SCOPE_CHARS, true)) return fail('INVALID_ARGUMENT', '适用范围最多 1000 字。')
    if (typeof autoReference !== 'boolean') return fail('INVALID_ARGUMENT', '自动参考设置无效。')
    if (typeof text !== 'string' || text.trim().length === 0 || text.includes('\0')) return fail('INVALID_ARGUMENT', '正文不能为空。')
    const encoded = Buffer.from(text, 'utf8')
    if (encoded.toString('utf8') !== text) return fail('INVALID_ARGUMENT', '正文包含无法保存的字符。')
    if (encoded.length > MAX_BODY_BYTES) return fail('RESOURCE_INVALID', '正文超过 2 MiB 上限。')
    return { title, category, scope, text, autoReference }
  }

  private validateOrigin(origin: { source: StoredSource; sourceMap: SourceMapFile | null; warnings: string[] }): {
    source: StoredSource
    sourceMap: SourceMapFile | null
    warnings: string[]
  } {
    if (!isRecord(origin)) return fail('INVALID_ARGUMENT', '资料来源信息无效。')
    const source = this.validateStoredSource(origin.source, 'INVALID_ARGUMENT')
    const warnings = this.truncateWarnings(origin.warnings)
    const sourceMap = origin.sourceMap === null ? null : this.validateSourceMap(origin.sourceMap)
    return { source, sourceMap, warnings }
  }

  private truncateWarnings(value: unknown): string[] {
    if (!Array.isArray(value)) return []
    const warnings: string[] = []
    for (const item of value) {
      if (!isText(item, MAX_WARNING_CHARS)) continue
      const warning = item.trim()
      if (!warnings.includes(warning)) warnings.push(warning)
      if (warnings.length >= MAX_WARNINGS) break
    }
    return warnings
  }

  private requireDocument(manifest: UserManifest, documentId: string): ManifestDocument {
    const document = manifest.documents.find(candidate => candidate.documentId === documentId)
    if (document === undefined) return fail('NOT_FOUND', '资料不存在或已被删除。')
    return document
  }

  private assertRevision(current: string, expected: string | null): void {
    if (expected === null) return
    if (!isHash(expected)) fail('INVALID_ARGUMENT', '资料版本无效。')
    if (expected !== current) fail('VERSION_MISMATCH', '资料已更新，请重新打开后再试。')
  }

  private async readBody(document: ManifestDocument): Promise<string> {
    const bytes = await this.readUserFile(document.bodyPath, MAX_BODY_BYTES)
    if (hash(bytes) !== document.bodyHash) return fail('RESOURCE_INVALID', '资料正文已在外部修改，请重新打开后再试。')
    return decodeText(bytes)
  }

  private async readSourceMapLabels(document: ManifestDocument): Promise<string[]> {
    const map = await this.readSourceMap(document)
    return map === null ? [] : locationsOf(map)
  }

  private async readSourceMap(document: ManifestDocument): Promise<SourceMapFile | null> {
    if (document.sourceMapPath === null) return null
    try {
      const bytes = await this.readUserFile(document.sourceMapPath, MAX_SOURCE_MAP_BYTES)
      if (hash(bytes) !== document.sourceMapHash) {
        this.diagnostic(`来源位置文件与记录不符：${document.documentId}`)
        return null
      }
      return this.validateSourceMap(JSON.parse(decodeText(bytes)))
    } catch (error) {
      this.diagnostic(`读取来源位置失败：${document.documentId}：${this.errorText(error)}`)
      return null
    }
  }

  private async summaryOf(document: ManifestDocument): Promise<KnowledgeDocumentSummary> {
    const text = await this.readBody(document)
    const locations = await this.readSourceMapLabels(document)
    return this.toSummary('user', document, text, locations)
  }

  private toSummary(packId: KnowledgePackId, document: ManifestDocument, text: string, locations: string[]): KnowledgeDocumentSummary {
    return {
      packId,
      documentId: document.documentId,
      contentRevisionId: document.contentRevisionId,
      title: document.title,
      category: document.category,
      scope: document.scope,
      tags: [...document.tags],
      excerpt: excerptOf(text),
      bodyLength: Array.from(text).length,
      readOnly: false,
      autoReference: document.autoReference,
      organize: document.organize,
      locations,
      warnings: [...document.warnings],
      source: this.sourceSummary(document.source),
      updatedAt: document.updatedAt,
    }
  }

  private toDocument(document: ManifestDocument, text: string, locations: string[]): KnowledgeDocument {
    return {
      ...this.toSummary('user', document, text, locations),
      text,
      resources: document.resources.map(resource => ({ path: resource.path, fileName: resource.fileName })),
    }
  }

  private sourceSummary(source: StoredSource): KnowledgeSourceSummary {
    const hasOriginal = source.kind === 'imported' && source.sourceHash !== undefined && this.hasSource(source.sourceHash)
    return {
      kind: source.kind === 'builtin-copy' ? 'copy' : source.kind,
      label: source.label,
      hasOriginal,
      ...(source.fileName !== undefined ? { fileName: source.fileName } : {}),
      ...(source.size !== undefined ? { size: source.size } : {}),
      ...(source.fileType !== undefined ? { fileType: source.fileType } : {}),
      ...(source.importId !== undefined ? { importId: source.importId } : {}),
      ...(source.detail !== undefined ? { detail: source.detail } : {}),
    }
  }

  private categoryCounts(categories: readonly KnowledgeCategory[]): KnowledgeCategoryCount[] {
    return KNOWLEDGE_CATEGORIES.map(category => ({
      category,
      count: categories.filter(value => value === category).length,
    }))
  }

  private paginate(text: string, offset: number, length: number): { text: string; length: number; truncated: boolean; nextOffset: number | null } {
    if (!Number.isSafeInteger(offset) || offset < 0) return fail('INVALID_ARGUMENT', '读取位置无效。')
    if (!Number.isSafeInteger(length) || length < 1 || length > MAX_PAGE_CHARS) return fail('INVALID_ARGUMENT', '读取长度无效。')
    const characters = Array.from(text)
    if (offset > characters.length) return fail('INVALID_ARGUMENT', '读取位置超出正文范围。')
    const end = Math.min(offset + length, characters.length)
    return {
      text: characters.slice(offset, end).join(''),
      length: end - offset,
      truncated: end < characters.length,
      nextOffset: end < characters.length ? end : null,
    }
  }

  // ---------- 内置包 ----------

  private async loadBuiltin(): Promise<BuiltinLoad> {
    const missing: BuiltinLoad = {
      exists: false,
      version: '0',
      updatedAt: new Date(0).toISOString(),
      documents: [],
      problem: null,
    }
    let root: string | null
    try {
      root = await resolveBuiltinRoot()
    } catch (error) {
      return { ...missing, problem: this.errorText(error) }
    }
    if (root === null) return missing
    try {
      const pack = await loadBuiltinPack(root)
      const documents: BuiltinDocument[] = []
      for (const card of pack.cards) {
        const bytes = await readBuiltinCardBody(root, card)
        const bodyHash = hash(bytes)
        if (bodyHash !== card.sha256) throw new BuiltinPackError('内置资料正文与清单不一致。')
        const metadataHash = metadataHashOf({
          title: card.title,
          category: card.category,
          scope: card.scope,
        })
        documents.push({
          id: card.id,
          title: card.title,
          scope: card.scope,
          tags: [...card.tags],
          category: card.category,
          detail: card.citation,
          text: decodeText(bytes),
          bodyHash,
          metadataHash,
          contentRevisionId: hash(['builtin', pack.version, bodyHash, metadataHash].join('\n')),
          updatedAt: pack.updatedAt,
        })
      }
      return { exists: true, version: pack.version, updatedAt: pack.updatedAt, documents, problem: null }
    } catch (error) {
      return { ...missing, exists: true, problem: this.errorText(error) }
    }
  }

  /** 读取内置资料的检索偏好；用户清单缺失或损坏时按默认值处理，不阻断阅读。 */
  private async readBuiltinPreferences(): Promise<Map<string, boolean>> {
    try {
      const loaded = await this.loadUserPack()
      return this.preferenceMap(loaded.manifest)
    } catch (error) {
      this.diagnostic(`读取内置资料偏好失败：${this.errorText(error)}`)
      return new Map()
    }
  }

  private preferenceMap(manifest: UserManifest): Map<string, boolean> {
    return new Map(manifest.preferences.map(preference => [preference.documentId, preference.autoReference]))
  }

  private requireBuiltinDocument(loaded: BuiltinLoad, documentId: string): BuiltinDocument {
    if (!loaded.exists || loaded.problem !== null) {
      if (loaded.problem !== null) this.diagnostic(`内置资料读取失败：${loaded.problem}`)
      return fail(loaded.problem === null ? 'NOT_FOUND' : 'UNAVAILABLE', loaded.problem === null ? '内置资料不存在。' : '内置资料暂时无法读取。')
    }
    const document = loaded.documents.find(candidate => candidate.id === documentId)
    if (document === undefined) return fail('NOT_FOUND', '内置资料不存在。')
    return document
  }

  private builtinSummary(document: BuiltinDocument, autoReference: boolean): KnowledgeDocumentSummary {
    return {
      packId: 'builtin',
      documentId: document.id,
      contentRevisionId: document.contentRevisionId,
      title: document.title,
      category: document.category,
      scope: document.scope,
      tags: [...document.tags],
      excerpt: excerptOf(document.text),
      bodyLength: Array.from(document.text).length,
      readOnly: true,
      autoReference,
      organize: 'ready',
      locations: [],
      warnings: [],
      source: { kind: 'builtin', label: BUILTIN_LABEL, detail: document.detail, hasOriginal: false },
      updatedAt: document.updatedAt,
    }
  }

  private builtinDocument(document: BuiltinDocument, autoReference: boolean): KnowledgeDocument {
    return {
      ...this.builtinSummary(document, autoReference),
      text: document.text,
      resources: [],
    }
  }

  // ---------- 写入 ----------

  private async prepareContent(text: string, drafts: KnowledgeDraftResource[], previous: ManifestDocument | null): Promise<PreparedContent> {
    const planned = this.planDraftResources(drafts)
    let replaced = text
    for (const resource of planned) replaced = replaced.split(resource.placeholder).join(`assets/${resource.hash}.${resource.extension}`)
    if (replaced.includes('eadp-asset:')) return fail('INVALID_ARGUMENT', '正文中有尚未插入完成的图片，请重新插入后再保存。')
    const order: string[] = []
    for (const match of replaced.matchAll(ASSET_REFERENCE)) if (!order.includes(match[0])) order.push(match[0])
    const resources: KnowledgeResourceRef[] = []
    const writes: ContentWrite[] = []
    let totalBytes = Buffer.byteLength(replaced, 'utf8')
    for (const path of order) {
      const plannedResource = planned.find(resource => `assets/${resource.hash}.${resource.extension}` === path)
      if (plannedResource !== undefined) {
        resources.push({ path, fileName: plannedResource.fileName })
        writes.push({ path, bytes: plannedResource.bytes, hash: plannedResource.hash })
        totalBytes += plannedResource.bytes.length
        continue
      }
      const previousResource = previous?.resources.find(resource => resource.path === path)
      if (previousResource === undefined) return fail('RESOURCE_INVALID', '正文引用的图片已缺失，请重新插入后再保存。')
      await this.assertAssetAvailable(path)
      resources.push({ path, fileName: previousResource.fileName })
    }
    if (totalBytes > MAX_DOCUMENT_BYTES) return fail('LIMIT_EXCEEDED', '资料内容超过 200 MB，暂时不能保存。')
    return { text: replaced, resources, writes }
  }

  private planDraftResources(drafts: unknown): PlannedResource[] {
    if (!Array.isArray(drafts) || drafts.length > MAX_RESOURCES) return fail('INVALID_ARGUMENT', '图片数量超过上限，请减少后重试。')
    const planned: PlannedResource[] = []
    const placeholders = new Set<string>()
    let totalBytes = 0
    for (const value of drafts) {
      if (!isRecord(value) || !exactKeys(value, ['placeholder', 'fileName', 'dataBase64'])) return fail('INVALID_ARGUMENT', '图片信息不完整。')
      const placeholder = value.placeholder
      const fileName = value.fileName
      const dataBase64 = value.dataBase64
      if (typeof placeholder !== 'string' || !PLACEHOLDER.test(placeholder) || placeholders.has(placeholder))
        return fail('INVALID_ARGUMENT', '图片标记无效。')
      if (!this.isSafeFileName(fileName)) return fail('INVALID_ARGUMENT', '图片文件名无效。')
      const bytes = decodeBase64(dataBase64)
      if (bytes.length > MAX_ASSET_BYTES) return fail('LIMIT_EXCEEDED', '单张图片不能超过 20 MB。')
      const declared = extensionOf(fileName)
      const detected = detectImage(bytes)
      if (declared === null || detected === null || canonicalExtension(declared) !== detected)
        return fail('RESOURCE_INVALID', '图片格式无法识别，或与文件名不一致。')
      totalBytes += bytes.length
      if (totalBytes > MAX_DOCUMENT_BYTES) return fail('LIMIT_EXCEEDED', '图片总大小超过 200 MB，暂时不能保存。')
      placeholders.add(placeholder)
      planned.push({
        placeholder,
        fileName: fileName.trim(),
        hash: hash(bytes),
        extension: detected,
        bytes,
      })
    }
    return planned
  }

  private async assertAssetAvailable(relative: string): Promise<void> {
    try {
      const info = await lstat(this.userPath(relative))
      if (!info.isFile() || info.isSymbolicLink()) return fail('RESOURCE_INVALID', '资料引用的图片不可用，请重新插入。')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fail('RESOURCE_INVALID', '资料引用的图片已缺失，请重新插入后再保存。')
      if (error instanceof KnowledgeError) throw error
      this.diagnostic(`检查图片失败：${relative}：${String(error)}`)
      return fail('UNAVAILABLE', READ_FAILURE)
    }
  }

  private nextVersion(version: string): string {
    const next = (BigInt(version) + 1n).toString()
    if (next.length > 15) return fail('LIMIT_EXCEEDED', '资料版本已达上限。')
    return next
  }

  /** 生成递增版本的新清单；内置偏好不带入文档，只随清单整体保留。 */
  private nextManifest(manifest: UserManifest, documents: ManifestDocument[], preferences: readonly ManifestPreference[] = manifest.preferences): UserManifest {
    return {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      packId: 'user',
      version: this.nextVersion(manifest.version),
      documents,
      preferences: preferences.map(preference => ({ ...preference })),
    }
  }

  private replaceDocument(manifest: UserManifest, document: ManifestDocument): UserManifest {
    const documents = manifest.documents.map(candidate => candidate.documentId === document.documentId ? document : candidate)
    if (!manifest.documents.some(candidate => candidate.documentId === document.documentId)) documents.push(document)
    return this.nextManifest(manifest, documents)
  }

  private encodeManifest(manifest: UserManifest): string {
    const encoded = `${JSON.stringify(manifest, null, 2)}\n`
    if (Buffer.byteLength(encoded, 'utf8') > MANIFEST_MAX_BYTES) return fail('LIMIT_EXCEEDED', '资料清单过大，暂时不能保存。')
    return encoded
  }

  /** 原子提交清单：先把内容写到同目录临时文件，核对读取后未被外部改写，再改名成为唯一可见点。 */
  private async commit(loaded: LoadedUserPack, manifest: UserManifest, documentId: string | null, expectedRevisionId: string | null): Promise<void> {
    const target = this.userPath('manifest.json')
    await this.ensureDirectory(this.userRoot)
    const temporary = `${target}.${randomUUID()}.tmp`
    try {
      await this.writeFileAt(temporary, Buffer.from(this.encodeManifest(manifest), 'utf8'))
      const current = await this.loadUserPack()
      if (current.raw !== loaded.raw) return fail('VERSION_MISMATCH', '知识库已在别处修改，请重新打开后再试。')
      if (documentId !== null && expectedRevisionId !== null) {
        const currentDocument = current.manifest.documents.find(document => document.documentId === documentId)
        if (currentDocument === undefined || currentDocument.contentRevisionId !== expectedRevisionId)
          return fail('VERSION_MISMATCH', '资料已更新，请重新打开后再试。')
      }
      await this.renameAt(temporary, target)
    } finally {
      await this.removeFileQuietly(temporary)
    }
  }

  // ---------- 内容文件 ----------

  private async writeContentFile(relative: string, bytes: Uint8Array, contentHash: string, created: ContentWrite[]): Promise<void> {
    if (await this.contentFileMatches(relative, contentHash)) return
    await this.atomicWrite(this.userPath(relative), bytes)
    created.push({ path: relative, bytes, hash: contentHash })
  }

  private async contentFileMatches(relative: string, contentHash: string): Promise<boolean> {
    try {
      await this.assertNoSymlinkPath(this.userPath(relative))
      await lstat(this.userPath(relative))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      if (error instanceof KnowledgeError) throw error
      this.diagnostic(`检查知识文件失败：${relative}：${String(error)}`)
      return fail('UNAVAILABLE', READ_FAILURE)
    }
    const existing = await this.readUserFile(relative, MAX_DOCUMENT_BYTES)
    if (hash(existing) !== contentHash) return fail('RESOURCE_INVALID', '知识目录中的文件与内容不符，请检查后重试。')
    return true
  }

  private async atomicWrite(target: string, bytes: Uint8Array): Promise<void> {
    await this.ensureDirectory(dirname(target))
    const temporary = `${target}.${randomUUID()}.tmp`
    try {
      await this.writeFileAt(temporary, bytes)
      await this.renameAt(temporary, target)
    } finally {
      await this.removeFileQuietly(temporary)
    }
  }

  private async rollbackCreated(created: readonly ContentWrite[]): Promise<void> {
    for (const write of [...created].reverse()) {
      try {
        const bytes = await this.readUserFile(write.path, MAX_DOCUMENT_BYTES)
        if (hash(bytes) !== write.hash) {
          this.diagnostic(`保存失败后保留内容不符的文件：${write.path}`)
          continue
        }
        await unlink(this.userPath(write.path))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.diagnostic(`保存失败后清理文件失败：${write.path}：${String(error)}`)
      }
    }
  }

  private async cleanupRevision(previous: ManifestDocument, documents: readonly ManifestDocument[]): Promise<void> {
    const bodyPaths = new Set(documents.map(document => document.bodyPath))
    const mapPaths = new Set(documents.flatMap(document => document.sourceMapPath === null ? [] : [document.sourceMapPath]))
    const assetPaths = new Set(documents.flatMap(document => document.resources.map(resource => resource.path)))
    if (!bodyPaths.has(previous.bodyPath)) await this.removeContentFile(previous.bodyPath, previous.bodyHash)
    if (previous.sourceMapPath !== null && !mapPaths.has(previous.sourceMapPath))
      await this.removeContentFile(previous.sourceMapPath, previous.sourceMapHash)
    for (const resource of previous.resources) if (!assetPaths.has(resource.path)) await this.removeContentFile(resource.path, assetHashOf(resource.path))
  }

  private async removeContentFile(relative: string, expectedHash: string): Promise<void> {
    try {
      const bytes = await this.readUserFile(relative, MAX_DOCUMENT_BYTES)
      if (hash(bytes) !== expectedHash) {
        this.diagnostic(`知识文件内容与记录不符，已保留：${relative}`)
        return
      }
      await unlink(this.userPath(relative))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      this.diagnostic(`清理知识文件失败：${relative}：${String(error)}`)
    }
  }

  private async removeEmptyDocumentDirectories(documentId: string): Promise<void> {
    await this.removeEmptyDirectory(`cards/${documentId}`)
    await this.removeEmptyDirectory(`source-maps/${documentId}`)
  }

  private async removeEmptyDirectory(relative: string): Promise<void> {
    try {
      await rmdir(this.userPath(relative))
    } catch {
      // 目录非空或已不存在都属于正常情况，不据此删除任何其他文件。
    }
  }

  // ---------- 原件 ----------

  private async existingSourceMetadata(sourceHash: string): Promise<{ fileName: string; size: number; fileType?: string; importedAt: string } | null> {
    try {
      return await this.readSourceMetadataRecord(sourceHash)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      try {
        await lstat(this.userPath(`sources/${sourceHash}`))
      } catch {
        // 目录不存在，说明原件尚未保存。
        return null
      }
      return fail('RESOURCE_INVALID', '原件信息不完整。')
    }
  }

  private async readSourceMetadataRecord(sourceHash: string): Promise<{ fileName: string; size: number; fileType?: string; importedAt: string }> {
    const bytes = await this.readUserFile(`sources/${sourceHash}/metadata.json`, MAX_METADATA_BYTES)
    let parsed: unknown
    try {
      parsed = JSON.parse(decodeText(bytes))
    } catch {
      // 元数据不是合法 JSON 时按损坏处理。
      return fail('RESOURCE_INVALID', '原件信息无法识别。')
    }
    if (!isRecord(parsed) || !exactKeys(parsed, ['schemaVersion', 'fileName', 'size', 'fileType', 'importedAt']) || parsed.schemaVersion !== 1)
      return fail('RESOURCE_INVALID', '原件信息无法识别。')
    const fileName = parsed.fileName
    const size = parsed.size
    const fileType = parsed.fileType
    const importedAt = parsed.importedAt
    if (!this.isSafeFileName(fileName)) return fail('RESOURCE_INVALID', '原件信息无法识别。')
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) return fail('RESOURCE_INVALID', '原件信息无法识别。')
    if (fileType !== undefined && !isText(fileType, MAX_FILE_TYPE_CHARS)) return fail('RESOURCE_INVALID', '原件信息无法识别。')
    if (!isIsoTime(importedAt)) return fail('RESOURCE_INVALID', '原件信息无法识别。')
    const payloadSize = await this.sourcePayloadSize(sourceHash)
    if (payloadSize !== size) return fail('RESOURCE_INVALID', '原件大小与记录不符。')
    return {
      fileName,
      size,
      importedAt,
      ...(fileType !== undefined ? { fileType: fileType.trim() } : {}),
    }
  }

  private async sourcePayloadSize(sourceHash: string): Promise<number> {
    const relative = `sources/${sourceHash}/payload`
    try {
      const info = await lstat(this.userPath(relative))
      if (!info.isFile() || info.isSymbolicLink()) return fail('RESOURCE_INVALID', '原件内容不可用。')
      return info.size
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fail('RESOURCE_INVALID', '原件内容缺失。')
      if (error instanceof KnowledgeError) throw error
      this.diagnostic(`读取原件信息失败：${relative}：${String(error)}`)
      return fail('UNAVAILABLE', READ_FAILURE)
    }
  }

  private async storeSourceDirectory(sourceHash: string, bytes: Uint8Array, fileName: string, fileType: string | undefined): Promise<void> {
    const sourcesRoot = this.userPath('sources')
    await this.ensureDirectory(sourcesRoot)
    const temporary = join(sourcesRoot, `.${sourceHash}.${randomUUID()}.tmp`)
    const metadata = {
      schemaVersion: 1,
      fileName,
      size: bytes.length,
      ...(fileType !== undefined ? { fileType } : {}),
      importedAt: new Date().toISOString(),
    }
    try {
      await this.mkdirAt(temporary)
      await this.atomicWrite(join(temporary, 'payload'), bytes)
      await this.atomicWrite(join(temporary, 'metadata.json'), Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`, 'utf8'))
      await this.io(async () => {
        try {
          await rename(temporary, this.userPath(`sources/${sourceHash}`))
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          // 目标目录已由另一路写操作建立时复用；内容 hash 相同，由后续元数据读取确认。
          if (code !== 'EEXIST' && code !== 'ENOTEMPTY' && code !== 'EPERM' && code !== 'EACCES') throw error
        }
      }, WRITE_FAILURE)
    } finally {
      await this.removeDirectoryQuietly(temporary)
    }
  }

  private sourceReceipt(sourceHash: string, metadata: { size: number; fileType?: string }): { sourceHash: string; size: number; fileType?: string } {
    return {
      sourceHash,
      size: metadata.size,
      ...(metadata.fileType !== undefined ? { fileType: metadata.fileType } : {}),
    }
  }

  // ---------- 文件与路径 ----------

  private userPath(relative: string): string {
    return join(this.userRoot, ...relative.split('/'))
  }

  private isSafeFileName(value: unknown): value is string {
    if (!isText(value, MAX_FILE_NAME_CHARS)) return false
    return !value.includes('/') && !value.includes('\\')
  }

  private requireFileName(value: unknown): string {
    if (!this.isSafeFileName(value)) return fail('INVALID_ARGUMENT', '文件名无效。')
    return value.trim()
  }

  private requireFileType(value: unknown): string {
    if (!isText(value, MAX_FILE_TYPE_CHARS)) return fail('INVALID_ARGUMENT', '文件类型说明无效。')
    return value.trim()
  }

  private async readUserFile(relative: string, maxBytes: number): Promise<Uint8Array> {
    const absolute = this.userPath(relative)
    let file: FileHandle | undefined
    try {
      await this.assertNoSymlinkPath(absolute)
      file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
      const info = await file.stat()
      if (!info.isFile() || info.size > maxBytes) return fail('RESOURCE_INVALID', '知识文件大小或类型异常。')
      return new Uint8Array(await file.readFile())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error
      if (error instanceof KnowledgeError) throw error
      this.diagnostic(`读取知识文件失败：${relative}：${String(error)}`)
      return fail('UNAVAILABLE', READ_FAILURE)
    } finally {
      await file?.close()
    }
  }

  /** 逐段拒绝符号链接；缺失的尾部路径留给调用方处理。 */
  private async assertNoSymlinkPath(absolute: string): Promise<void> {
    const anchor = parse(absolute).root
    const parts = pathRelative(anchor, absolute).split(sep).filter(part => part.length > 0)
    let cursor = anchor
    for (const part of parts) {
      cursor = join(cursor, part)
      let info
      try {
        info = await lstat(cursor)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      if (info.isSymbolicLink()) fail('RESOURCE_INVALID', '知识文件位置包含链接，已停止操作。')
    }
  }

  /** 同步版路径检查；用于渲染来源信息时判断原件是否可用。 */
  private isRegularFileSync(absolute: string): boolean {
    const anchor = parse(absolute).root
    const parts = pathRelative(anchor, absolute).split(sep).filter(part => part.length > 0)
    let cursor = anchor
    let isFile = false
    for (const part of parts) {
      cursor = join(cursor, part)
      let info
      try {
        info = lstatSync(cursor)
      } catch {
        // 路径中任一段不存在时原件不可用。
        return false
      }
      if (info.isSymbolicLink()) return false
      isFile = info.isFile()
    }
    return isFile
  }

  private async ensureDirectory(directory: string): Promise<void> {
    await this.io(async () => {
      await this.assertNoSymlinkPath(directory)
      await mkdir(directory, { recursive: true })
      await this.assertNoSymlinkPath(directory)
    }, WRITE_FAILURE)
  }

  private async writeFileAt(target: string, bytes: Uint8Array): Promise<void> {
    await this.io(() => writeFile(target, bytes, { flag: 'wx' }), WRITE_FAILURE)
  }

  private async renameAt(from: string, to: string): Promise<void> {
    await this.io(() => rename(from, to), WRITE_FAILURE)
  }

  private async mkdirAt(target: string): Promise<void> {
    await this.io(() => mkdir(target), WRITE_FAILURE)
  }

  private async io<T>(action: () => Promise<T>, message: string): Promise<T> {
    try {
      return await action()
    } catch (error) {
      if (error instanceof KnowledgeError) throw error
      this.diagnostic(`${message}：${String(error)}`)
      return fail('UNAVAILABLE', message)
    }
  }

  private async removeFileQuietly(absolute: string): Promise<void> {
    try {
      await unlink(absolute)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.diagnostic(`临时知识文件清理失败：${absolute}：${String(error)}`)
    }
  }

  private async removeDirectoryQuietly(directory: string): Promise<void> {
    try {
      await rm(directory, { recursive: true, force: true })
    } catch (error) {
      this.diagnostic(`临时知识目录清理失败：${directory}：${String(error)}`)
    }
  }

  private errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  // ---------- 核对 ----------

  private async reportContent(): Promise<void> {
    let loaded: LoadedUserPack
    try {
      loaded = await this.loadUserPack()
    } catch {
      // 清单本身损坏时由目录汇总报告问题，核对阶段不重复猜测修复。
      return
    }
    for (const document of loaded.manifest.documents) {
      try {
        await this.readBody(document)
      } catch (error) {
        this.diagnostic(`资料正文核对失败：${document.documentId}：${this.errorText(error)}`)
      }
      if (document.sourceMapPath !== null) {
        try {
          const bytes = await this.readUserFile(document.sourceMapPath, MAX_SOURCE_MAP_BYTES)
          if (hash(bytes) !== document.sourceMapHash) this.diagnostic(`来源位置文件与记录不符：${document.documentId}`)
        } catch (error) {
          this.diagnostic(`来源位置文件缺失或不可读：${document.documentId}：${this.errorText(error)}`)
        }
      }
      for (const resource of document.resources) {
        const expected = assetHashOf(resource.path)
        try {
          const bytes = await this.readUserFile(resource.path, MAX_ASSET_BYTES)
          if (hash(bytes) !== expected) this.diagnostic(`图片内容与记录不符：${resource.path}`)
        } catch (error) {
          this.diagnostic(`图片缺失或不可读：${resource.path}：${this.errorText(error)}`)
        }
      }
      if (document.source.kind === 'imported' && document.source.sourceHash !== undefined && !this.hasSource(document.source.sourceHash))
        this.diagnostic(`原件缺失：${document.documentId}`)
    }
  }

  private async reconcileDocumentDirectory(directory: 'cards' | 'source-maps', referenced: ReadonlySet<string>): Promise<void> {
    const root = this.userPath(directory)
    let entries
    try {
      await this.assertNoSymlinkPath(root)
      entries = await readdir(root, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      this.diagnostic(`核对知识目录失败：${directory}：${this.errorText(error)}`)
      return
    }
    const pattern = directory === 'cards' ? /^[0-9a-f]{64}\.md$/ : /^[0-9a-f]{64}\.json$/
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        this.diagnostic(`知识目录中含有链接，已跳过：${directory}/${entry.name}`)
        continue
      }
      if (!entry.isDirectory()) continue
      if (!DOCUMENT_ID.test(entry.name)) continue
      const relativeDirectory = `${directory}/${entry.name}`
      let files
      try {
        files = await readdir(this.userPath(relativeDirectory), { withFileTypes: true })
      } catch (error) {
        this.diagnostic(`核对资料目录失败：${relativeDirectory}：${this.errorText(error)}`)
        continue
      }
      for (const file of files) {
        if (!file.isFile() || !pattern.test(file.name)) continue
        const relative = `${relativeDirectory}/${file.name}`
        if (referenced.has(relative)) continue
        if (directory === 'cards' && !await this.contentMatchesName(relative, file.name.slice(0, 64))) continue
        await this.removeDeterministicFile(relative)
      }
      await this.removeEmptyDirectory(relativeDirectory)
    }
  }

  private async reconcileAssetDirectory(referenced: ReadonlySet<string>): Promise<void> {
    const root = this.userPath('assets')
    let entries
    try {
      await this.assertNoSymlinkPath(root)
      entries = await readdir(root, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      this.diagnostic(`核对图片目录失败：${this.errorText(error)}`)
      return
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        this.diagnostic(`图片目录中含有链接，已跳过：${entry.name}`)
        continue
      }
      if (!entry.isFile()) continue
      const relative = `assets/${entry.name}`
      if (!ASSET_PATH.test(relative) || referenced.has(relative)) continue
      if (!await this.contentMatchesName(relative, entry.name.slice(0, 64))) continue
      await this.removeDeterministicFile(relative)
    }
  }

  private async contentMatchesName(relative: string, expectedHash: string): Promise<boolean> {
    try {
      const bytes = await this.readUserFile(relative, MAX_DOCUMENT_BYTES)
      return hash(bytes) === expectedHash
    } catch (error) {
      this.diagnostic(`核对知识文件失败：${relative}：${this.errorText(error)}`)
      return false
    }
  }

  private async removeDeterministicFile(relative: string): Promise<void> {
    try {
      await this.io(() => unlink(this.userPath(relative)), '本机知识文件暂时无法清理，请稍后重试。')
    } catch (error) {
      this.diagnostic(`清理知识文件失败：${relative}：${this.errorText(error)}`)
    }
  }

  private async reconcileTemporaryFiles(): Promise<void> {
    const directories = [this.userRoot, this.userPath('assets'), this.userPath('sources')]
    for (const parent of ['cards', 'source-maps'] as const) {
      const absolute = this.userPath(parent)
      try {
        const entries = await readdir(absolute, { withFileTypes: true })
        for (const entry of entries) if (entry.isDirectory()) directories.push(join(absolute, entry.name))
      } catch {
        // 目录尚不存在时无需清理临时文件；其他读取问题留给目录核对报告。
      }
    }
    for (const directory of directories) await this.removeTemporaryEntries(directory)
  }

  private async removeTemporaryEntries(directory: string): Promise<void> {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      // 目录不存在或不可读时不清理，避免在未知状态下删除内容。
      return
    }
    for (const entry of entries) {
      if (!TEMPORARY_NAME.test(entry.name)) continue
      const target = join(directory, entry.name)
      try {
        if (entry.isDirectory()) await rm(target, { recursive: true, force: true })
        else await unlink(target)
      } catch (error) {
        this.diagnostic(`清理临时知识文件失败：${entry.name}：${String(error)}`)
      }
    }
  }
}

const sameTextList = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index])
