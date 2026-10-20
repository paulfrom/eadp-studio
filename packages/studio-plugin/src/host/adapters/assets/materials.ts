import { createHash, randomUUID } from 'node:crypto'
import { readFile, realpath, writeFile, lstat, mkdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { isConfirmedMaterialMetadata, isMaterialMetadata, type MaterialMetadata } from '@eadp/contracts'
import type { MaterialDraft } from '../../../shared/studio.ts'

export const digest = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
export function materialPath(kind: MaterialMetadata['kind'], id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(id)) throw new Error('资产 ID 无效')
  if (kind === 'scenario') return `场景/${id}.md`
  if (kind === 'requirement') return `需求/${id}.md`
  if (kind === 'handoff') return `handoff.${id}.md`
  throw new Error('此资产不使用材料编辑器')
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
export function parseMaterial(bytes: Buffer, relative: string): MaterialDraft {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (bytes[0] === 0xef || text.includes('\r')) throw new Error('材料必须为 UTF-8 无 BOM、LF 换行')
  const match = /^```eadp-metadata\n([\s\S]*?)\n```\n?/.exec(text)
  if (!match) throw new Error('材料缺少 eadp 元数据')
  const metadata: unknown = JSON.parse(match[1]!)
  if (!isMaterialMetadata(metadata)) throw new Error('材料元数据无效')
  if (materialPath(metadata.kind, metadata.entityId) !== relative) throw new Error('材料身份与路径不一致')
  const remainder = text.slice(match[0].length)
  return { entityId: metadata.entityId, metadata, body: remainder.startsWith('\n') ? remainder.slice(1) : remainder, sha256: digest(bytes), path: relative }
}
export async function readMaterial(root: string, kind: MaterialMetadata['kind'], id: string): Promise<MaterialDraft> {
  const relative = materialPath(kind, id)
  return parseMaterial(await readFile(await containedFile(root, relative)), relative)
}
export function materialText(metadata: MaterialMetadata, body: string): string {
  if (!isMaterialMetadata(metadata) || body.length > 1_000_000) throw new Error('材料内容无效或过大')
  return `\`\`\`eadp-metadata\n${JSON.stringify(metadata, null, 2)}\n\`\`\`\n\n${body.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '')}`
}
/** Writes in the target directory so readers never observe a partially written material. */
export async function atomicWriteFile(target: string, bytes: string | Uint8Array): Promise<void> {
  const temporary = `${target}.${randomUUID()}.tmp`
  try { await writeFile(temporary, bytes, { flag: 'wx' }); await rename(temporary, target) }
  finally { await rm(temporary, { force: true }) }
}
export async function saveMaterial(root: string, metadata: MaterialMetadata, body: string): Promise<MaterialDraft> {
  const relative = materialPath(metadata.kind, metadata.entityId)
  await atomicWriteFile(await containedFile(root, relative, true), materialText(metadata, body))
  return readMaterial(root, metadata.kind, metadata.entityId)
}
export function checkMaterial(draft: MaterialDraft): void {
  const m = draft.metadata
  if (!isConfirmedMaterialMetadata(m)) throw new Error('请补充明确的业务依据后再确认材料')
  if (!m.coreRulesPresent || !m.acceptanceCriteriaPresent || m.openQuestions.some(q => q.blocking)) throw new Error('核心规则、验收条件或阻断待澄清项尚未解决')
}
