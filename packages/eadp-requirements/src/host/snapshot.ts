import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  KnowledgeEvidenceRange,
  KnowledgeEvidenceResolution,
  KnowledgeSnapshotManifest,
  KnowledgeSnapshotOriginal,
  KnowledgeSnapshotRange,
  KnowledgeSnapshotResource,
  KnowledgeSourceMap,
} from '@eadp/contracts/knowledge'
import type { RequirementFiles } from './files.ts'
import { RequirementKnowledgeError } from './knowledge-error.ts'
import { readJsonFile, stateDirectory } from './state-files.ts'

/** 快照格式版本参与身份计算；格式变化必须产生新的快照而不是覆盖旧内容。 */
const FORMAT_VERSION = 'eadp-knowledge-snapshot@1'
const SNAPSHOT_ID = /^sh_[0-9a-f]{32}$/
const STATE_DIRECTORY = ['.eadp', 'knowledge-sources'] as const
const BODY_FILE = 'body.md'
const MANIFEST_FILE = 'manifest.json'
const SOURCE_MAP_FILE = 'source-map.json'
const RESOURCE_DIRECTORY = 'resources'
const ORIGINAL_DIRECTORY = 'original'

const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')

/** 项目内固定的一份资料当时内容；快照目录以 `snapshotId` 命名。 */
export interface FixedSnapshot {
  snapshotId: string
  manifest: KnowledgeSnapshotManifest
  body: string
}

/** 回读快照得到的全部可展示内容。 */
export interface StoredSnapshot {
  manifest: KnowledgeSnapshotManifest
  body: string
  sourceMap: KnowledgeSourceMap | null
  resources: { path: string; fileName: string; hash: string; dataBase64: string }[]
  original: { fileName: string; size: number; fileType: string; hash: string; dataBase64: string } | null
}

/** 写入前已校验、可落盘的快照内容。 */
interface BuiltSnapshot {
  snapshotId: string
  manifest: KnowledgeSnapshotManifest
  body: string
  resources: { file: string; hash: string; dataBase64: string }[]
  sourceMap: KnowledgeSourceMap | null
  original: { file: string; hash: string; dataBase64: string } | null
}

/** 只比较参与快照身份的字段；`fixedAt` 不参与，重复固定同一份内容视为复用。 */
const sameSnapshot = (left: KnowledgeSnapshotManifest, right: KnowledgeSnapshotManifest): boolean => JSON.stringify({
  snapshotId: left.snapshotId,
  packId: left.packId,
  documentId: left.documentId,
  contentRevisionId: left.contentRevisionId,
  title: left.title,
  category: left.category,
  scope: left.scope,
  tags: left.tags,
  source: left.source,
  warnings: left.warnings,
  locations: left.locations,
  bodyHash: left.bodyHash,
  metadataHash: left.metadataHash,
  assetsHash: left.assetsHash,
  sourceMapHash: left.sourceMapHash,
  ranges: left.ranges,
  resources: left.resources,
  sourceMapFile: left.sourceMapFile,
  original: left.original,
}) === JSON.stringify({
  snapshotId: right.snapshotId,
  packId: right.packId,
  documentId: right.documentId,
  contentRevisionId: right.contentRevisionId,
  title: right.title,
  category: right.category,
  scope: right.scope,
  tags: right.tags,
  source: right.source,
  warnings: right.warnings,
  locations: right.locations,
  bodyHash: right.bodyHash,
  metadataHash: right.metadataHash,
  assetsHash: right.assetsHash,
  sourceMapHash: right.sourceMapHash,
  ranges: right.ranges,
  resources: right.resources,
  sourceMapFile: right.sourceMapFile,
  original: right.original,
})

/** 从文件名取可安全写入的扩展名；未知或过长时按 `bin` 保存。 */
function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  if (dot < 0) return 'bin'
  const extension = fileName.slice(dot + 1).toLowerCase()
  return /^[a-z0-9]{1,10}$/.test(extension) ? extension : 'bin'
}

/** 原件文件名只保留单段安全名称，避免目录穿越。 */
function safeFileName(fileName: string, fallback: string): string {
  const base = path.basename(fileName).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim()
  if (base === '' || base === '.' || base === '..') return fallback
  return base.length > 120 ? base.slice(-120) : base
}

/**
 * 校验并合并采用范围；范围必须落在 canonical 正文内且 hash 与已读取内容一致。
 * 身份与 manifest 都使用同一份规范化结果。
 */
function normalizeRanges(text: string, ranges: readonly KnowledgeEvidenceRange[]): KnowledgeSnapshotRange[] {
  const characters = Array.from(text)
  const sorted = [...ranges].sort((left, right) => left.start - right.start || left.end - right.end)
  const merged: KnowledgeSnapshotRange[] = []
  for (const range of sorted) {
    if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end <= range.start || range.end > characters.length) {
      throw new RequirementKnowledgeError('采用范围超出本次读取的内容，请重新读取资料后再关联。', 'EVIDENCE_INVALID')
    }
    if (sha256(characters.slice(range.start, range.end).join('')) !== range.textHash) {
      throw new RequirementKnowledgeError('采用范围的内容已变化，请重新读取资料后再关联。', 'EVIDENCE_INVALID')
    }
    const last = merged[merged.length - 1]
    if (last !== undefined && range.start <= last.end) {
      const end = Math.max(last.end, range.end)
      merged[merged.length - 1] = { start: last.start, end, textHash: sha256(characters.slice(last.start, end).join('')) }
      continue
    }
    merged.push({ start: range.start, end: range.end, textHash: range.textHash })
  }
  return merged
}

/**
 * 需求提案的项目固定依据：把 Host 核验过的完整正文、范围、资源、来源映射与原件
 * 写入 `<项目>/.eadp/knowledge-sources/<snapshotId>/`，供应用后长期回读。
 * 同一身份只写一次；已存在但内容不一致时失败而不是覆盖。
 */
export class KnowledgeSnapshots {
  constructor(private readonly files: RequirementFiles, private readonly diagnostic: (message: string) => void) {}

  /** 固定一份已核验内容；已存在同一身份时复用。 */
  async ensure(projectId: string, resolution: KnowledgeEvidenceResolution): Promise<FixedSnapshot> {
    const built = this.build(resolution)
    const parent = await stateDirectory(this.files, projectId, STATE_DIRECTORY, true)
    if (parent === null) throw new RequirementKnowledgeError('当时内容无法保存到项目。', 'SNAPSHOT_FAILED')
    const directory = path.join(parent, built.snapshotId)
    const existing = await this.readManifest(directory)
    if (existing !== null) {
      if (!sameSnapshot(existing, built.manifest)) {
        throw new RequirementKnowledgeError('同一关联范围已存在不同的当时内容，未覆盖已有内容；请重新读取资料后重试。', 'SNAPSHOT_FAILED')
      }
      return { snapshotId: built.snapshotId, manifest: existing, body: built.body }
    }
    const occupied = await readdir(parent).then(entries => entries.includes(built.snapshotId), () => false)
    if (occupied) {
      throw new RequirementKnowledgeError('当时内容的保存位置已被占用，无法安全写入；请稍后重试。', 'SNAPSHOT_FAILED')
    }
    const temporary = path.join(parent, `.tmp-${randomUUID()}`)
    try {
      await mkdir(temporary)
      await this.writeBuilt(temporary, built)
      try {
        await rename(temporary, directory)
      } catch (error) {
        const placed = await this.readManifest(directory)
        if (placed !== null && sameSnapshot(placed, built.manifest)) return { snapshotId: built.snapshotId, manifest: placed, body: built.body }
        throw error
      }
      return { snapshotId: built.snapshotId, manifest: built.manifest, body: built.body }
    } catch (error) {
      this.diagnostic(`需求依据当时内容保存失败：${String(error)}`)
      if (error instanceof RequirementKnowledgeError) throw error
      throw new RequirementKnowledgeError('当时内容未能保存到项目，请稍后重试。', 'SNAPSHOT_FAILED')
    } finally {
      await rm(temporary, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  /** 回读一份固定内容；文件缺失或校验不一致时按不可读失败。 */
  async read(projectId: string, snapshotId: string): Promise<StoredSnapshot> {
    const directory = await this.directory(projectId, snapshotId)
    if (directory === null) throw new RequirementKnowledgeError('该需求依据的当时内容暂时无法读取。', 'SNAPSHOT_FAILED')
    const manifest = await this.readManifestStrict(directory)
    if (manifest === null || manifest.snapshotId !== snapshotId) {
      throw new RequirementKnowledgeError('该需求依据的当时内容不完整，暂时无法读取。', 'SNAPSHOT_FAILED')
    }
    const body = await readFile(path.join(directory, BODY_FILE), 'utf8').catch(() => null)
    if (body === null || sha256(body) !== manifest.bodyHash) {
      throw new RequirementKnowledgeError('该需求依据的当时内容与记录不一致，暂时无法读取。', 'SNAPSHOT_FAILED')
    }
    const resources: StoredSnapshot['resources'] = []
    for (const resource of manifest.resources) {
      const bytes = await readFile(path.join(directory, resource.file)).catch(() => null)
      if (bytes === null || sha256(bytes) !== resource.hash) {
        throw new RequirementKnowledgeError('该需求依据附带的图片或文件暂时无法读取。', 'SNAPSHOT_FAILED')
      }
      resources.push({ path: resource.path, fileName: resource.fileName, hash: resource.hash, dataBase64: bytes.toString('base64') })
    }
    const sourceMap = await this.readSourceMap(directory, manifest)
    const original = await this.readOriginal(directory, manifest)
    return { manifest, body, sourceMap, resources, original }
  }

  /** 清理没有任何提案引用的快照目录；只处理 `sh_` 目录，未知项写诊断后保留。 */
  async cleanup(projectId: string, referenced: ReadonlySet<string>): Promise<void> {
    const parent = await stateDirectory(this.files, projectId, STATE_DIRECTORY, false)
    if (parent === null) return
    const entries = await readdir(parent, { withFileTypes: true })
    for (const entry of entries) {
      /* 临时目录与未知项都不是可清理的快照；只写诊断保留现场。 */
      if (entry.name.startsWith('.')) {
        this.diagnostic(`需求依据保存目录中的临时项未处理：${entry.name}`)
        continue
      }
      if (!entry.isDirectory() || !SNAPSHOT_ID.test(entry.name)) {
        this.diagnostic(`需求依据保存目录中的未识别项未处理：${entry.name}`)
        continue
      }
      if (referenced.has(entry.name)) continue
      try {
        await rm(path.join(parent, entry.name), { recursive: true, force: true })
      } catch (error) {
        this.diagnostic(`未被引用的需求依据当时内容清理失败：${entry.name} ${String(error)}`)
      }
    }
  }

  /** 把快照目录解析为绝对路径；目录不存在时返回 null。 */
  private async directory(projectId: string, snapshotId: string): Promise<string | null> {
    if (!SNAPSHOT_ID.test(snapshotId)) throw new RequirementKnowledgeError('需求依据标识无效。', 'INVALID_PATH')
    const parent = await stateDirectory(this.files, projectId, STATE_DIRECTORY, false)
    return parent === null ? null : path.join(parent, snapshotId)
  }

  /** 根据已核验内容计算稳定身份与 manifest。 */
  private build(resolution: KnowledgeEvidenceResolution): BuiltSnapshot {
    const body = resolution.text
    const ranges = normalizeRanges(body, resolution.ranges)
    const bodyHash = sha256(body)
    const metadataHash = sha256(JSON.stringify({
      formatVersion: FORMAT_VERSION,
      packId: resolution.packId,
      documentId: resolution.documentId,
      contentRevisionId: resolution.contentRevisionId,
      title: resolution.title,
      category: resolution.category,
      scope: resolution.scope,
      tags: resolution.tags,
      source: resolution.source,
    }))
    const sortedResources = [...resolution.resources].sort((left, right) => left.path.localeCompare(right.path))
    const assetsHash = sha256(JSON.stringify(sortedResources.map(resource => ({
      path: resource.path,
      fileName: resource.fileName,
      hash: resource.hash,
    }))))
    const sourceMapHash = sha256(resolution.sourceMap === null ? '' : JSON.stringify(resolution.sourceMap))
    const originalHash = resolution.original?.hash ?? ''
    const identity = [
      FORMAT_VERSION,
      resolution.packId,
      resolution.documentId,
      resolution.contentRevisionId,
      bodyHash,
      metadataHash,
      assetsHash,
      sourceMapHash,
      originalHash,
      ranges.map(range => `${range.start}:${range.end}:${range.textHash}`).join(','),
    ].join('\n')
    const snapshotId = `sh_${sha256(identity).slice(0, 32)}`
    const resources: KnowledgeSnapshotResource[] = sortedResources.map(resource => ({
      path: resource.path,
      fileName: resource.fileName,
      hash: resource.hash,
      file: `${RESOURCE_DIRECTORY}/${resource.hash}.${extensionOf(resource.fileName)}`,
    }))
    const original: KnowledgeSnapshotOriginal | null = resolution.original === null ? null : {
      fileName: resolution.original.fileName,
      size: resolution.original.size,
      fileType: resolution.original.fileType,
      hash: resolution.original.hash,
      file: `${ORIGINAL_DIRECTORY}/${safeFileName(resolution.original.fileName, 'original')}`,
    }
    const manifest: KnowledgeSnapshotManifest = {
      schemaVersion: 1,
      formatVersion: FORMAT_VERSION,
      snapshotId,
      packId: resolution.packId,
      documentId: resolution.documentId,
      contentRevisionId: resolution.contentRevisionId,
      title: resolution.title,
      category: resolution.category,
      scope: resolution.scope,
      tags: [...resolution.tags],
      source: { ...resolution.source },
      warnings: [...resolution.warnings],
      locations: [...resolution.locations],
      bodyHash,
      metadataHash,
      assetsHash,
      sourceMapHash,
      ranges,
      resources,
      sourceMapFile: resolution.sourceMap === null ? null : SOURCE_MAP_FILE,
      original,
      fixedAt: new Date().toISOString(),
    }
    return {
      snapshotId,
      manifest,
      body,
      resources: sortedResources.map((resource, index) => ({ file: resources[index]!.file, hash: resource.hash, dataBase64: resource.dataBase64 })),
      sourceMap: resolution.sourceMap === null ? null : structuredClone(resolution.sourceMap),
      original: resolution.original === null || original === null ? null : { file: original.file, hash: resolution.original.hash, dataBase64: resolution.original.dataBase64 },
    }
  }

  /** 写入一份新快照；目录必须尚不存在。 */
  private async writeBuilt(directory: string, built: BuiltSnapshot): Promise<void> {
    await writeFile(path.join(directory, BODY_FILE), built.body, 'utf8')
    if (built.resources.length > 0) {
      await mkdir(path.join(directory, RESOURCE_DIRECTORY))
      for (const resource of built.resources) {
        const target = path.join(directory, resource.file)
        await mkdir(path.dirname(target), { recursive: true })
        await writeFile(target, Buffer.from(resource.dataBase64, 'base64'))
      }
    }
    if (built.sourceMap !== null) {
      await writeFile(path.join(directory, SOURCE_MAP_FILE), JSON.stringify(built.sourceMap, null, 2) + '\n', 'utf8')
    }
    if (built.original !== null) {
      const target = path.join(directory, built.original.file)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, Buffer.from(built.original.dataBase64, 'base64'))
    }
    await writeFile(path.join(directory, MANIFEST_FILE), JSON.stringify(built.manifest, null, 2) + '\n', 'utf8')
  }

  /** 读取 manifest；不存在或内容无效时返回 null（由调用方判断是复用、占用还是不可读）。 */
  private async readManifest(directory: string): Promise<KnowledgeSnapshotManifest | null> {
    try {
      const value = await readJsonFile(path.join(directory, MANIFEST_FILE))
      return isManifest(value) ? value : null
    } catch (error) {
      this.diagnostic(`需求依据 manifest 读取失败：${String(error)}`)
      return null
    }
  }

  /** 回读路径上的 manifest：不存在返回 null，存在但无效按不完整失败。 */
  private async readManifestStrict(directory: string): Promise<KnowledgeSnapshotManifest | null> {
    let value: unknown
    try {
      value = await readJsonFile(path.join(directory, MANIFEST_FILE))
    } catch {
      throw new RequirementKnowledgeError('该需求依据的当时内容无法读取。', 'SNAPSHOT_FAILED')
    }
    if (value === null) return null
    if (!isManifest(value)) throw new RequirementKnowledgeError('该需求依据的当时内容记录不完整。', 'SNAPSHOT_FAILED')
    return value
  }

  private async readSourceMap(directory: string, manifest: KnowledgeSnapshotManifest): Promise<KnowledgeSourceMap | null> {
    if (manifest.sourceMapFile === null) return null
    const value = await readJsonFile(path.join(directory, manifest.sourceMapFile)).catch(() => null)
    if (!isSourceMap(value)) throw new RequirementKnowledgeError('该需求依据的来源位置信息暂时无法读取。', 'SNAPSHOT_FAILED')
    return value
  }

  private async readOriginal(directory: string, manifest: KnowledgeSnapshotManifest): Promise<StoredSnapshot['original']> {
    if (manifest.original === null) return null
    const bytes = await readFile(path.join(directory, manifest.original.file)).catch(() => null)
    if (bytes === null || sha256(bytes) !== manifest.original.hash) {
      throw new RequirementKnowledgeError('该需求依据附带的原件暂时无法读取。', 'SNAPSHOT_FAILED')
    }
    return {
      fileName: manifest.original.fileName,
      size: manifest.original.size,
      fileType: manifest.original.fileType,
      hash: manifest.original.hash,
      dataBase64: bytes.toString('base64'),
    }
  }
}

/** 只做回读所需的最小结构校验，避免把损坏记录当成有效依据。 */
function isManifest(value: unknown): value is KnowledgeSnapshotManifest {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return record['schemaVersion'] === 1
    && record['formatVersion'] === FORMAT_VERSION
    && typeof record['snapshotId'] === 'string'
    && typeof record['packId'] === 'string'
    && typeof record['documentId'] === 'string'
    && typeof record['contentRevisionId'] === 'string'
    && typeof record['bodyHash'] === 'string'
    && typeof record['metadataHash'] === 'string'
    && typeof record['assetsHash'] === 'string'
    && typeof record['sourceMapHash'] === 'string'
    && Array.isArray(record['ranges'])
    && Array.isArray(record['resources'])
    && (record['sourceMapFile'] === null || typeof record['sourceMapFile'] === 'string')
    && (record['original'] === null || typeof record['original'] === 'object')
}

function isSourceMap(value: unknown): value is KnowledgeSourceMap {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return record['schemaVersion'] === 1 && Array.isArray(record['entries'])
}
