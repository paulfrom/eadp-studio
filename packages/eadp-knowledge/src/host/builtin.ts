/**
 * 内置知识包的只读加载。
 *
 * 内置包随产品安装，清单固定 schemaVersion 1，卡片正文是随包的 Markdown 文件。
 * 本模块只负责定位包目录、解析清单和按清单路径读取正文；内容校验与内容身份由 store 计算。
 * 任何一步失败都只影响内置包，不影响用户资料。
 */
import { existsSync } from 'node:fs'
import { constants } from 'node:fs'
import { lstat, open, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { KnowledgeCategory } from '@eadp/contracts/knowledge'
import { isKnowledgeCategory } from '@eadp/contracts/knowledge'

/** 内置清单里的一张资料卡；正文位置相对内置包根目录。 */
export interface BuiltinCard {
  id: string
  title: string
  /** 真实外部出处的说明文字，随包维护，不在用户界面伪造页码。 */
  citation: string
  scope: string
  tags: string[]
  category: KnowledgeCategory
  path: string
  sha256: string
}

/** 一次读取到的内置包清单；正文尚未读取。 */
export interface BuiltinPack {
  version: string
  updatedAt: string
  cards: BuiltinCard[]
}

/** 内置包缺失或损坏；调用方把它降级为一条问题说明，不阻断用户资料。 */
export class BuiltinPackError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BuiltinPackError'
  }
}

const reject = (message: string): never => {
  throw new BuiltinPackError(message)
}

const MANIFEST_MAX_BYTES = 2 * 1024 * 1024
const CARD_MAX_BYTES = 4 * 1024 * 1024
const MAX_CARDS = 500
const HASH = /^[0-9a-f]{64}$/
const CARD_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const CARD_PATH = /^cards\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}\.md$/
const VERSION = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const exactKeys = (value: Record<string, unknown>, allowed: readonly string[]): boolean =>
  Object.keys(value).every(key => allowed.includes(key))

const isText = (value: unknown, max: number, allowEmpty = false): value is string =>
  typeof value === 'string'
  && value.length <= max
  && !value.includes('\0')
  && (allowEmpty || value.trim().length > 0)

/**
 * 解析内置资料所在目录，兼容源码运行与构建产物两种位置。
 * 构建产物 `lib/index.js` 与资源目录 `resources/builtin` 同属包根，源码文件位于 `src/host`。
 * @returns 含 manifest.json 的目录；未随产品提供时返回 null。
 */
export async function resolveBuiltinRoot(): Promise<string | null> {
  for (const relative of ['../resources/builtin/', '../../resources/builtin/']) {
    const candidate = fileURLToPath(new URL(relative, import.meta.url))
    if (existsSync(join(candidate, 'manifest.json'))) return candidate
  }
  return null
}

/**
 * 读取并校验内置包清单，同时记录清单文件的更新时间。
 * @param root - {@link resolveBuiltinRoot} 返回的包目录。
 * @returns 包版本与卡片元数据；正文需另行读取。
 * @throws {BuiltinPackError} 清单缺失、格式不符或字段不完整时。
 */
export async function loadBuiltinPack(root: string): Promise<BuiltinPack> {
  const bytes = await readWithin(root, 'manifest.json', MANIFEST_MAX_BYTES)
  const updatedAt = await updatedAtOf(join(root, 'manifest.json'))
  let parsed: unknown
  try {
    parsed = JSON.parse(decode(bytes))
  } catch {
    return reject('内置资料清单无法识别。')
  }
  if (!isRecord(parsed) || !exactKeys(parsed, ['schemaVersion', 'packId', 'version', 'documents'])) return reject('内置资料清单格式不正确。')
  if (parsed.schemaVersion !== 1 || parsed.packId !== 'builtin') return reject('内置资料清单格式不正确。')
  if (!isText(parsed.version, 64) || !VERSION.test(parsed.version)) return reject('内置资料版本无效。')
  if (!Array.isArray(parsed.documents) || parsed.documents.length > MAX_CARDS) return reject('内置资料清单格式不正确。')
  const cards: BuiltinCard[] = []
  const ids = new Set<string>()
  const paths = new Set<string>()
  for (const value of parsed.documents) {
    const card = parseCard(value)
    if (ids.has(card.id) || paths.has(card.path)) return reject('内置资料清单包含重复条目。')
    ids.add(card.id)
    paths.add(card.path)
    cards.push(card)
  }
  return { version: parsed.version, updatedAt, cards }
}

/**
 * 读取一张内置卡片的正文；符号链接与异常大小都会被拒绝。
 * @param root - 内置包根目录。
 * @param card - {@link loadBuiltinPack} 返回的卡片。
 * @returns 卡片正文原始字节，由调用方校验 hash。
 * @throws {BuiltinPackError} 正文缺失、越界或不是普通文件时。
 */
export async function readBuiltinCardBody(root: string, card: BuiltinCard): Promise<Uint8Array> {
  if (!CARD_PATH.test(card.path)) return reject('内置资料正文位置无效。')
  return readWithin(root, card.path, CARD_MAX_BYTES)
}

const parseCard = (value: unknown): BuiltinCard => {
  if (!isRecord(value) || !exactKeys(value, ['id', 'title', 'source', 'scope', 'tags', 'category', 'path', 'sha256'])) return reject('内置资料卡格式不正确。')
  const id = value.id
  const title = value.title
  const citation = value.source
  const scope = value.scope
  const category = value.category
  const path = value.path
  const sha256 = value.sha256
  if (!isText(id, 64) || !CARD_ID.test(id)) return reject('内置资料卡编号无效。')
  if (!isText(title, 200)) return reject('内置资料标题无效。')
  if (!isText(citation, 2000)) return reject('内置资料来源说明无效。')
  if (!isText(scope, 1000, true)) return reject('内置资料适用范围无效。')
  const tags = parseTags(value.tags)
  if (tags === null) return reject('内置资料标签无效。')
  if (!isKnowledgeCategory(category)) return reject('内置资料分类无效。')
  if (!isText(path, 200) || !CARD_PATH.test(path)) return reject('内置资料正文位置无效。')
  if (!isText(sha256, 64) || !HASH.test(sha256)) return reject('内置资料正文校验值无效。')
  return { id, title, citation, scope, tags, category, path, sha256 }
}

const parseTags = (value: unknown): string[] | null => {
  if (!Array.isArray(value) || value.length > 30) return null
  const tags: string[] = []
  for (const tag of value) {
    if (!isText(tag, 100)) return null
    tags.push(tag)
  }
  return tags
}

/** 读取包目录内的普通文件；路径逐段校验，安装目录自身不在校验范围内。 */
const readWithin = async (root: string, relative: string, maxBytes: number): Promise<Uint8Array> => {
  let cursor = root
  for (const part of relative.split('/')) {
    cursor = join(cursor, part)
    let info
    try {
      info = await lstat(cursor)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return reject('内置资料文件缺失。')
      throw error
    }
    if (info.isSymbolicLink()) return reject('内置资料文件不能是链接。')
  }
  const file = await open(cursor, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > maxBytes) return reject('内置资料文件大小异常。')
    return new Uint8Array(await file.readFile())
  } finally {
    await file.close()
  }
}

const updatedAtOf = async (path: string): Promise<string> => {
  try {
    return new Date((await stat(path)).mtimeMs).toISOString()
  } catch {
    return new Date(0).toISOString()
  }
}

const decode = (bytes: Uint8Array): string => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return reject('内置资料文字格式无法识别。')
  }
}
