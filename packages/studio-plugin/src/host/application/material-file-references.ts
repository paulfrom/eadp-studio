import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { MaterialMetadata } from '@eadp/contracts'
import { containedFile, digest, materialText } from '../adapters/assets/materials.ts'
import type { MaterialDraft } from '../../shared/studio.ts'
import type { ScenarioDocumentService } from './scenario-documents.ts'
import { syncProjectContext } from './scenario-package.ts'

import { archiveEvidenceBytes } from './scenario-evidence.ts'

type Evidence = MaterialMetadata['businessEvidence'][number]

/** Accepts checkout newline conversion without treating changed source content as an old reading. */
export function verifiedEvidenceBytes(bytes: Buffer, hash: string): Buffer {
  if (digest(bytes) === hash) return bytes
  const normalized = Buffer.from(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r\n/g, '\n'))
  if (digest(normalized) !== hash) throw new Error('资料实际内容已变化，需要重新读取')
  return normalized
}

/** Preserves the exact read ranges and verifies their source before rebuilding content-addressed members. */
async function refreshEvidence(root: string, evidence: Evidence): Promise<Evidence> {
  const content = new Map(await Promise.all(evidence.files.map(async file => [file.path, await readFile(await containedFile(root, file.path))] as const)))
  const original = evidence.files.find(file => path.basename(file.path).startsWith('original.'))
  const scopes = evidence.files.filter(file => /^reading-[a-f0-9]{64}\.json$/.test(path.basename(file.path)))
  if (original || scopes.length) {
    if (scopes.length !== 1 || !original) throw new Error('依据缺少唯一读取记录或原件')
    const scope = scopes[0]!, scopeBytes = verifiedEvidenceBytes(content.get(scope.path)!, scope.sha256)
    const reading = JSON.parse(scopeBytes.toString('utf8')) as Record<string, unknown>
    if (reading.name !== evidence.label || evidence.reference !== `source:${reading.sourceId}` || reading.originalHash !== original.sha256 || !['read', 'partial'].includes(String(reading.status)) || !Array.isArray(reading.ranges) || !reading.ranges.length || reading.ranges.some(value => typeof value !== 'string' || !value.trim())) throw new Error('依据读取记录与原件不符')
    verifiedEvidenceBytes(content.get(original.path)!, original.sha256)
  }
  for (const range of evidence.ranges) {
    const file = evidence.files.find(value => value.path === range.path)
    if (!file) throw new Error('引用文件未归档')
    const bytes = verifiedEvidenceBytes(content.get(range.path)!, file.sha256)
    const lines = new TextDecoder('utf-8', { fatal: true }).decode(bytes).split('\n')
    if (lines.at(-1) === '') lines.pop()
    if (range.startLine < 1 || range.endLine < range.startLine || range.endLine > lines.length || !lines.slice(range.startLine - 1, range.endLine).join('\n').trim()) throw new Error('引用范围已无法成立')
  }
  const files: Evidence['files'] = [], replacements = new Map<string, string>()
  for (const file of evidence.files) {
    const current = content.get(file.path)!, verified = verifiedEvidenceBytes(current, file.sha256)
    if (digest(current) === file.sha256) { files.push(file); continue }
    const prefix = path.posix.dirname(file.path), basename = path.basename(file.path)
    const relative = /^extracted-/.test(basename) ? `${prefix}/extracted-${digest(verified)}.txt`
      : /^reading-/.test(basename) ? `${prefix}/reading-${digest(verified)}.json` : file.path
    files.push(await archiveEvidenceBytes(root, relative, verified)); replacements.set(file.path, relative)
  }
  // Archive members retain their exact bytes in Git, including source-file newlines.
  for (const directory of new Set(files.map(file => path.posix.dirname(file.path)))) {
    const attributes = await archiveEvidenceBytes(root, `${directory}/.gitattributes`, Buffer.from('* -text\n'))
    const existing = files.findIndex(file => file.path === attributes.path)
    if (existing < 0) files.push(attributes)
    else files[existing] = attributes
  }
  return { ...evidence, files, ranges: evidence.ranges.map(range => ({ ...range, path: replacements.get(range.path) ?? range.path })) }
}

/** Derives the next confirmation's file hashes and preserves only verifiable formal readings. */
export async function refreshMaterialReferences(root: string, metadata: MaterialMetadata, readVersionedFile: (relative: string) => Promise<Buffer>): Promise<{ metadata: MaterialMetadata; notices: string[] }> {
  const notices: string[] = []
  const files = metadata.files && await Promise.all(metadata.files.map(async file => ({ ...file, sha256: digest(await readVersionedFile(file.path)) })))
  const businessEvidence: MaterialMetadata['businessEvidence'] = []
  for (const evidence of metadata.businessEvidence) {
    try { businessEvidence.push(await refreshEvidence(root, evidence)) }
    catch (error) {
      if (metadata.kind !== 'scenario') throw error
      notices.push(`正式引用“${evidence.label}”已失效，本次确认不包含该引用，原始文件已保留`)
    }
  }
  return { metadata: { ...metadata, ...(files ? { files } : {}), businessEvidence }, notices }
}

/** Normalizes the next material snapshot locally before review or confirmation binds its Git bytes. */
export async function refreshMaterialDraft(root: string, draft: MaterialDraft, documents: ScenarioDocumentService,
  readVersionedFile: (relative: string) => Promise<Buffer>): Promise<{ draft: MaterialDraft; notices: string[] }> {
  if (draft.metadata.kind !== 'scenario' && draft.metadata.kind !== 'requirement') return { draft, notices: [] }
  const refreshed = await refreshMaterialReferences(root, await syncProjectContext(root, draft.metadata), readVersionedFile)
  if (digest(materialText(refreshed.metadata, draft.body)) === draft.sha256) return { draft, notices: refreshed.notices }
  const saved = await documents.save({ root, metadata: refreshed.metadata, body: draft.body, operationId: `references-${randomUUID()}` })
  return { draft: saved, notices: refreshed.notices }
}
