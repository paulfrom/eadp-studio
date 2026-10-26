import { createHash, randomUUID } from 'node:crypto'
import { open, readFile, readdir, realpath, writeFile, lstat, mkdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { isConfirmedMaterialMetadata, isMaterialMetadata, type MaterialMetadata } from '@eadp/contracts'
import { isMaterialPath, materialDirectoryOf, materialPathOf, type MaterialKind } from '@eadp/asset-domain'
import type { MaterialDraft } from '../../../shared/studio.ts'

export const digest = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
/** Bytes read while identifying a material; the metadata block sits at the head of every material. */
const metadataHeadBytes = 16 * 1024
/** Same-title materials are told apart by this suffix, so a project never needs a UUID in a file name. */
const sameNameLimit = 1000
const entityIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/

function assertEntityId(id: string): void { if (!entityIdPattern.test(id)) throw new Error('资产 ID 无效') }
function enoent(message: string): NodeJS.ErrnoException { return Object.assign(new Error(message), { code: 'ENOENT' }) }
function identityBlock(text: string): string | undefined { return /^```eadp-metadata\n([\s\S]*?)\n```/.exec(text)?.[1] }

async function headText(file: string): Promise<string | undefined> {
  const handle = await open(file, 'r').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error })
  if (!handle) return undefined
  try {
    const buffer = Buffer.alloc(metadataHeadBytes)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return buffer.toString('utf8', 0, bytesRead)
  } finally { await handle.close() }
}

/** What one candidate file holds: nothing, a material of this project, or bytes that cannot be identified. */
type MaterialFileState = { state: 'missing' } | { state: 'unknown' } | { state: 'material'; entityId: string; kind: MaterialMetadata['kind'] }

async function materialFileState(file: string): Promise<MaterialFileState> {
  const head = await headText(file)
  if (head === undefined) return { state: 'missing' }
  const block = identityBlock(head) ?? identityBlock(await readFile(file, 'utf8'))
  if (!block) return { state: 'unknown' }
  try {
    const value: unknown = JSON.parse(block)
    // Identity survives an invalid business contract; strict parsing reports the
    // actual file instead of treating an existing author draft as missing.
    if (!value || typeof value !== 'object') return { state: 'unknown' }
    const identity = value as { entityId?: unknown; kind?: unknown }
    return typeof identity.entityId === 'string' && entityIdPattern.test(identity.entityId) &&
      ['scenario', 'requirement', 'baseline', 'handoff'].includes(identity.kind as string)
      ? { state: 'material', entityId: identity.entityId, kind: identity.kind as MaterialMetadata['kind'] }
      : { state: 'unknown' }
  } catch { return { state: 'unknown' } }
}

/**
 * Finds the current path of a material by its stable identity. Files are named
 * after business titles, so the path is discovered rather than derived.
 */
export async function findMaterialFile(root: string, kind: MaterialKind, entityId: string): Promise<string | undefined> {
  assertEntityId(entityId)
  const directory = materialDirectoryOf(kind)
  const names = await readdir(path.join(root, directory)).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return [] as string[]; throw error })
  for (const name of names.sort()) {
    if (!name.endsWith('.md')) continue
    const file = await materialFileState(path.join(root, directory, name))
    if (file.state === 'material' && file.kind === kind && file.entityId === entityId) return `${directory}/${name}`
  }
  return undefined
}

/**
 * Finds an unidentified file at one of the names this title would take. Such a
 * file can never be overwritten: the caller preserves it as an external edit.
 */
export async function unidentifiedMaterialFile(root: string, kind: MaterialKind, title: string): Promise<string | undefined> {
  for (let suffix = 1; suffix <= sameNameLimit; suffix++) {
    const relative = materialPathOf(kind, title, suffix)
    const file = await materialFileState(path.join(root, relative))
    if (file.state === 'missing') return undefined
    if (file.state === 'unknown') return relative
  }
  return undefined
}

/**
 * Picks the relative path this title takes: the title-derived name itself, or
 * the next numbered name while another material already holds it.
 */
export async function materialTargetPath(root: string, kind: MaterialKind, entityId: string, title: string): Promise<string> {
  assertEntityId(entityId)
  for (let suffix = 1; suffix <= sameNameLimit; suffix++) {
    const relative = materialPathOf(kind, title, suffix)
    const file = await materialFileState(path.join(root, relative))
    if (file.state === 'missing' || file.state === 'material' && file.entityId === entityId) return relative
  }
  throw new Error('同名材料过多，请先调整名称再保存')
}

export async function containedFile(root: string, relative: string, create = false): Promise<string> {
  if (path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some(x => !x || x === '.' || x === '..' || x.includes(':'))) throw new Error('文件路径无效')
  const base = await realpath(root)
  const target = path.resolve(base, relative)
  const parent = path.dirname(target)
  if (create) await mkdir(parent, { recursive: true })
  const actualParent = await realpath(parent)
  const rel = path.relative(base, actualParent)
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error('文件超出项目范围')
  const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error })
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error('资产必须是项目内的普通文件')
  return target
}
/** Every identity block a Markdown document carries; the accepted contract allows exactly one. */
export function identityBlockCount(text: string): number {
  return [...text.replace(/\r\n?/g, '\n').matchAll(/^```eadp-metadata[ \t]*$/gm)].length
}
/**
 * Removes the Host-owned identity block a model may echo at the head of a
 * whole-body proposal. Material identity is never part of the business body;
 * any further identity block is refused instead of guessed away.
 */
export function normalizeMaterialBody(body: string): string {
  const normalized = body.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '')
  const stripped = normalized.replace(/^```eadp-metadata\n[^]*?\n```\n*/, '')
  if (/^```eadp-metadata[ \t]*$/m.test(stripped)) throw new Error('正文不能包含材料身份块，材料身份由 Host 维护')
  return stripped
}
/** Fails before a candidate is fixed when the exact file would carry more than one identity. */
export async function assertSingleIdentityBlock(root: string, relative: string): Promise<void> {
  const text = await readFile(await containedFile(root, relative), 'utf8')
  if (identityBlockCount(text) !== 1) throw new Error('材料包含重复的身份块，请保存材料以移除重复内容后再确认')
}
export function parseMaterial(bytes: Buffer, relative: string): MaterialDraft {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (bytes[0] === 0xef || text.includes('\r')) throw new Error('材料必须为 UTF-8 无 BOM、LF 换行')
  const match = /^```eadp-metadata\n([\s\S]*?)\n```\n?/.exec(text)
  if (!match) throw new Error('材料缺少 eadp 元数据')
  let metadata: unknown
  try { metadata = JSON.parse(match[1]!) }
  catch (cause) { throw Object.assign(new Error(`材料元数据 JSON 无效：${relative}`, { cause }), { code: 'INVALID_MATERIAL' }) }
  if (!isMaterialMetadata(metadata)) throw Object.assign(new Error(`材料元数据无效：${relative}`), { code: 'INVALID_MATERIAL' })
  if (!isMaterialFile(metadata, relative)) throw new Error('材料身份与路径不一致')
  const remainder = text.slice(match[0].length)
  return { entityId: metadata.entityId, metadata, body: remainder.startsWith('\n') ? remainder.slice(1) : remainder, sha256: digest(bytes), path: relative }
}
function isMaterialFile(metadata: MaterialMetadata, relative: string): boolean {
  return metadata.kind === 'baseline' ? relative === `baseline.${metadata.entityId}.json` : isMaterialPath(metadata.kind, relative)
}
export async function readMaterial(root: string, kind: MaterialMetadata['kind'], id: string): Promise<MaterialDraft> {
  if (kind === 'baseline') throw new Error('此资产不使用材料编辑器')
  const relative = await findMaterialFile(root, kind, id)
  if (!relative) throw enoent(`材料文件不存在：${materialDirectoryOf(kind)}/${id}`)
  return parseMaterial(await readFile(await containedFile(root, relative)), relative)
}
export function materialText(metadata: MaterialMetadata, body: string): string {
  if (!isMaterialMetadata(metadata) || body.length > 1_000_000) throw new Error('材料内容无效或过大')
  return `\`\`\`eadp-metadata\n${JSON.stringify(metadata, null, 2)}\n\`\`\`\n\n${normalizeMaterialBody(body)}`
}
/** Writes in the target directory so readers never observe a partially written material. */
export async function atomicWriteFile(target: string, bytes: string | Uint8Array): Promise<void> {
  const temporary = `${target}.${randomUUID()}.tmp`
  try { await writeFile(temporary, bytes, { flag: 'wx' }); await rename(temporary, target) }
  finally { await rm(temporary, { force: true }) }
}
/**
 * Moves a material to the path its current title requires, without rewriting
 * its bytes. A material renamed by an edit therefore keeps one readable name.
 */
export async function normalizeMaterialPath(root: string, draft: MaterialDraft): Promise<string> {
  if (draft.metadata.kind === 'baseline') throw new Error('此资产不使用材料编辑器')
  const relative = await materialTargetPath(root, draft.metadata.kind, draft.entityId, draft.metadata.title)
  if (relative === draft.path) return relative
  await rename(await containedFile(root, draft.path), await containedFile(root, relative, true))
  return relative
}
export async function saveMaterial(root: string, metadata: MaterialMetadata, body: string): Promise<MaterialDraft> {
  if (metadata.kind === 'baseline') throw new Error('此资产不使用材料编辑器')
  const previous = await findMaterialFile(root, metadata.kind, metadata.entityId)
  const relative = await materialTargetPath(root, metadata.kind, metadata.entityId, metadata.title)
  const text = materialText(metadata, body)
  await atomicWriteFile(await containedFile(root, relative, true), text)
  // A title edit renames the material in place; the old path must not linger as a second document.
  if (previous && previous !== relative) await rm(await containedFile(root, previous), { force: true })
  return parseMaterial(Buffer.from(text), relative)
}
export function checkMaterial(draft: MaterialDraft): void {
  const m = draft.metadata, kind = m.kind
  if (!isConfirmedMaterialMetadata(m)) throw new Error(kind === 'scenario' ? '场景材料格式无效，请核对流程声明与固定引用' : '请补充明确的业务依据后再确认材料')
  if (m.kind === 'scenario') {
    if (!m.flowComplete || m.openQuestions.some(q => q.blocking)) throw new Error('业务流程尚未完整，或存在使流程无法确定的待澄清项')
  } else if (!m.coreRulesPresent || !m.acceptanceCriteriaPresent || m.openQuestions.some(q => q.blocking)) throw new Error('核心规则、验收条件或阻断待澄清项尚未解决')
}
