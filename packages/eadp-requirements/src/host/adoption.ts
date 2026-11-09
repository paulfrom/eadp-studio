import type { KnowledgeSnapshotManifest } from '@eadp/contracts/knowledge'
import type { RequirementKnowledgeAdoption, RequirementKnowledgeCitation } from '@eadp/contracts/requirements'
import { RequirementKnowledgeError } from './knowledge-error.ts'

/** 一次提案最多关联的资料数、单份范围数与采用说明长度上限。 */
const MAX_ADOPTIONS = 8
const MAX_RANGES = 32
const MAX_NOTE_CHARACTERS = 500
const MAX_EVIDENCE_ID = 200

/**
 * 校验模型申报的采用项：标识来自本会话读取、范围是该次读取内的真实范围、采用说明必填。
 * @param value - 工具参数中的 `citations`；缺省表示不关联依据。
 * @returns 已规范化的采用项，保持模型给出的顺序。
 */
export function parseKnowledgeAdoptions(value: unknown): RequirementKnowledgeAdoption[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new RequirementKnowledgeError('需求依据参数格式无效。', 'EVIDENCE_INVALID')
  if (value.length > MAX_ADOPTIONS) throw new RequirementKnowledgeError('一次关联的资料过多，请分批提出。', 'EVIDENCE_INVALID')
  return value.map(parseAdoption)
}

function parseAdoption(value: unknown): RequirementKnowledgeAdoption {
  if (typeof value !== 'object' || value === null) throw new RequirementKnowledgeError('需求依据参数格式无效。', 'EVIDENCE_INVALID')
  const record = value as Record<string, unknown>
  const evidenceId = record['evidenceId']
  if (typeof evidenceId !== 'string' || evidenceId.trim() === '' || evidenceId.length > MAX_EVIDENCE_ID) {
    throw new RequirementKnowledgeError('用于关联的知识内容无效，请先读取资料后再关联。', 'EVIDENCE_INVALID')
  }
  const note = record['note']
  if (typeof note !== 'string') throw new RequirementKnowledgeError('关联知识时必须说明采用理由。', 'EVIDENCE_INVALID')
  const trimmed = note.trim()
  if (trimmed === '' || Array.from(trimmed).length > MAX_NOTE_CHARACTERS) {
    throw new RequirementKnowledgeError('采用说明不能为空且不能超过 500 字。', 'EVIDENCE_INVALID')
  }
  const ranges = record['ranges']
  if (!Array.isArray(ranges) || ranges.length === 0 || ranges.length > MAX_RANGES) {
    throw new RequirementKnowledgeError('采用的资料范围无效，请按本次读取到的范围重新关联。', 'EVIDENCE_INVALID')
  }
  return {
    evidenceId,
    note: trimmed,
    ranges: ranges.map(parseRange),
  }
}

function parseRange(value: unknown): { start: number; end: number } {
  if (typeof value !== 'object' || value === null) throw new RequirementKnowledgeError('采用的资料范围无效。', 'EVIDENCE_INVALID')
  const record = value as Record<string, unknown>
  const start = record['start']
  const end = record['end']
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || (start as number) < 0 || (end as number) <= (start as number)) {
    throw new RequirementKnowledgeError('采用的资料范围无效。', 'EVIDENCE_INVALID')
  }
  return { start: start as number, end: end as number }
}

/** 由已固定的 manifest 生成提案内的引用条目；采用说明不参与快照身份。 */
export function citationFromSnapshot(manifest: KnowledgeSnapshotManifest, note: string): RequirementKnowledgeCitation {
  return {
    snapshotId: manifest.snapshotId,
    packId: manifest.packId,
    documentId: manifest.documentId,
    contentRevisionId: manifest.contentRevisionId,
    title: manifest.title,
    sourceLabel: manifest.source.label,
    locations: [...manifest.locations],
    warnings: [...manifest.warnings],
    ranges: manifest.ranges,
    note,
  }
}
