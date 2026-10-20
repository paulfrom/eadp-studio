import { readFile } from 'node:fs/promises'
import type { MaterialMetadata } from '@eadp/contracts'
import type { ScenarioSource } from '../../shared/scenarios.ts'
import { atomicWriteFile, containedFile, digest } from '../adapters/assets/materials.ts'

export interface ScenarioEvidenceRecord { source: ScenarioSource; original: Uint8Array }
const extensions: Readonly<Record<string, string>> = { text: 'txt', txt: 'txt', markdown: 'md', md: 'md', pdf: 'pdf', doc: 'doc', docx: 'docx', xls: 'xls', xlsx: 'xlsx', csv: 'csv', tsv: 'tsv', ppt: 'ppt', pptx: 'pptx', png: 'png', jpeg: 'jpg', jpg: 'jpg', webp: 'webp', gif: 'gif' }

async function archiveBytes(root: string, relative: string, bytes: Uint8Array): Promise<{ path: string; sha256: string }> {
  const target = await containedFile(root, relative, true), hash = digest(bytes)
  const existing = await readFile(target).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error })
  if (existing && digest(existing) !== hash) throw new Error('已归档依据内容与其固定路径不一致')
  if (!existing) await atomicWriteFile(target, bytes)
  return { path: relative, sha256: hash }
}

/** Archives only the explicit formal selection and only content the source reader actually returned. */
export async function archiveSelectedEvidence(root: string, records: readonly ScenarioEvidenceRecord[], selectedIds: readonly string[]): Promise<MaterialMetadata['businessEvidence']> {
  if (selectedIds.length > 100 || new Set(selectedIds).size !== selectedIds.length || new Set(records.map(record => record.source.id)).size !== records.length) throw new Error('正式依据选择无效或重复')
  const selected = selectedIds.map(id => { const record = records.find(item => item.source.id === id); if (!record) throw new Error('选定依据不存在'); return record })
  // Validate the complete selection before writing any archive member.
  for (const { source, original } of selected) {
    if (!source.formal || !['read', 'partial'].includes(source.status) || !source.text.trim() || !source.ranges.length || source.ranges.some(range => !range.trim())) throw new Error('正式依据必须由用户选定且包含实际读取内容及范围')
    if (!source.name.trim() || source.name.length > 500 || !extensions[source.format.toLowerCase()] || original.byteLength > 50_000_000 || source.text.length > 10_000_000) throw new Error('正式依据格式、名称或大小无效')
    if (digest(original) !== source.sha256) throw new Error('来源已变化，请重新读取并选择新版本')
  }
  const result: MaterialMetadata['businessEvidence'] = []
  for (const { source, original } of selected) {
    const prefix = `.eadp/evidence/${source.sha256}`
    const extracted = new TextEncoder().encode(source.text.replace(/\r\n?/g, '\n'))
    const originalFile = await archiveBytes(root, `${prefix}/original.${extensions[source.format.toLowerCase()]}`, original)
    const textFile = await archiveBytes(root, `${prefix}/extracted-${digest(extracted)}.txt`, extracted)
    const scope = new TextEncoder().encode(JSON.stringify({ sourceId: source.id, name: source.name, format: source.format, originalHash: source.sha256, status: source.status, ranges: source.ranges, error: source.error }, null, 2))
    const scopeFile = await archiveBytes(root, `${prefix}/reading-${digest(scope)}.json`, scope)
    result.push({ label: source.name, reference: `source:${source.id}`, files: [originalFile, textFile, scopeFile], ranges: [{ path: textFile.path, startLine: 1, endLine: new TextDecoder().decode(extracted).split('\n').length }] })
  }
  return result
}
