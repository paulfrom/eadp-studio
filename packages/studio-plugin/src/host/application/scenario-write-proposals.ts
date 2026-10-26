import type { FixedReference } from '@eadp/contracts'
import type { MaterialDraft } from '../../shared/studio.ts'
import type { ScenarioWriteSummary } from '../../shared/scenarios.ts'
import { digest, normalizeMaterialBody } from '../adapters/assets/materials.ts'
import { describeWriteChanges } from './material-write-changes.ts'

export interface ParsedWriteProposal { conclusions: Array<{ id: string; text: string }>; evidenceIds: string[]; body: string; target?: 'context' }
export interface ProposalState { baseHash: string; templateRef: FixedReference; contextHash: string; evidenceIds: readonly string[]; target?: 'context' }
export interface ProposalCurrent { draftHash: string; templateRef: FixedReference; contextHash: string; evidenceIds: readonly string[] }

const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/
const evidenceLimit = 100
const conclusionLimit = 50
const fenceOpen = '```eadp-write-proposal'
const fenceClose = '```'

/**
 * Reads the single proposal block. The protocol asks for a fenced
 * `eadp-write-proposal` block; models also close the same JSON with a matching
 * tag, so tag lines become fence lines and one parser validates both spellings.
 * Text after the block stays part of the answer and never voids the proposal.
 */
function proposalBlockSource(response: string): string {
  return response.replace(/\r\n/g, '\n')
    .replace(/^<eadp-write-proposal>[ \t]*$/gm, fenceOpen)
    .replace(/^<\/eadp-write-proposal>[ \t]*$/gm, fenceClose)
}

/** True when the answer carried a proposal; an unusable one must be reported instead of ignored. */
export function hasWriteProposal(response: string): boolean {
  return /^```[^\n]*eadp-write-proposal/m.test(proposalBlockSource(response)) || response.includes('<eadp-write-proposal')
}

function object(value: unknown, keys: string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !optional.includes(key) && !(key in value))) throw new Error('写入提议字段无效')
  return value as Record<string, unknown>
}
function id(value: unknown): asserts value is string { if (typeof value !== 'string' || !idPattern.test(value)) throw new Error('写入提议 ID 无效') }
function text(value: unknown, maximum: number): asserts value is string { if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new Error('写入提议文本无效或过大') }
/** Model-authored JSON reaches the user as a failure message, never as a parser trace. */
function json(source: string): unknown {
  try { return JSON.parse(source) } catch { throw new Error('写入提议代码块不是合法 JSON，请让 AI 重新给出这段代码块') }
}

/**
 * Parses the model's propose-only block. The model supplies conclusions, the
 * evidence it actually read and the complete new body; proposal identity,
 * base/template/context hashes and authorization are Host-owned and any extra
 * field is rejected rather than ignored.
 */
export function parseWriteProposal(response: string, draft: MaterialDraft, readEvidenceIds: readonly string[]): ParsedWriteProposal {
  if (response.length > 2_000_000) throw new Error('写入提议过大')
  const block = proposalBlockSource(response)
  if ([...block.matchAll(/^```eadp-write-proposal[ \t]*$/gm)].length !== 1) throw new Error('需要且仅允许一个 eadp-write-proposal JSON 块')
  const payload = /^```eadp-write-proposal[ \t]*\n([^]*?)^```[ \t]*$/m.exec(block)
  if (!payload) throw new Error('需要且仅允许一个 eadp-write-proposal JSON 块')
  const value = object(json(payload[1]!), ['entityId', 'conclusions', 'evidenceIds', 'body', 'target'], ['target'])
  id(value.entityId)
  if (value.entityId !== draft.entityId) throw new Error('写入提议材料身份不一致')
  if (value.target !== undefined && value.target !== 'context') throw new Error('写入提议目标无效')
  if (!Array.isArray(value.conclusions) || !value.conclusions.length || value.conclusions.length > conclusionLimit) throw new Error('写入提议结论无效')
  const conclusions: Array<{ id: string; text: string }> = [], conclusionIds = new Set<string>()
  for (const itemValue of value.conclusions) {
    const item = object(itemValue, ['id', 'text']); id(item.id); text(item.text, 2_000)
    if (conclusionIds.has(item.id)) throw new Error('写入提议包含重复结论 ID')
    conclusionIds.add(item.id); conclusions.push({ id: item.id, text: item.text.trim() })
  }
  if (!Array.isArray(value.evidenceIds) || value.evidenceIds.length > evidenceLimit) throw new Error('写入提议依据无效')
  const evidenceIds: string[] = [], available = new Set(readEvidenceIds)
  for (const evidenceId of value.evidenceIds) {
    id(evidenceId)
    if (!available.has(evidenceId)) throw new Error('写入提议引用了未实际读取的资料')
    if (evidenceIds.includes(evidenceId)) throw new Error('写入提议包含重复依据 ID')
    evidenceIds.push(evidenceId)
  }
  text(value.body, 1_000_000)
  // Models often echo the Host-owned identity block at the head of the whole
  // body; identity is never business content, so the Host removes it here.
  const body = normalizeMaterialBody(value.body)
  // A context proposal replaces another file; its identity is checked against CONTEXT.md by the Host.
  if (value.target !== 'context' && body === draft.body) throw new Error('写入提议正文与当前正文相同')
  return { conclusions, evidenceIds, body, ...(value.target === 'context' ? { target: 'context' as const } : {}) }
}

/** Stable key for a conclusion text; a rejected conclusion cannot return under another model-chosen ID. */
export const conclusionKey = (conclusion: { text: string }): string => digest(conclusion.text.trim())

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = [...new Set(a)].sort(), right = [...new Set(b)].sort()
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/** Every bound input must still match; any change voids the proposal and requires a fresh question. */
export function proposalInvalidReason(proposal: ProposalState, current: ProposalCurrent): string | undefined {
  // A context proposal is bound to CONTEXT.md alone; the scenario body and template are not its target.
  if (proposal.target === 'context') {
    if (proposal.contextHash !== current.contextHash) return 'CONTEXT.md 已变化，写入提议已作废，请重新提问'
    if (!sameSet(proposal.evidenceIds, current.evidenceIds)) return '依据集合已变化，写入提议已作废，请重新提问'
    return undefined
  }
  if (proposal.baseHash !== current.draftHash) return '正文已变化，写入提议已作废，请重新提问'
  if (proposal.templateRef.commitSha !== current.templateRef.commitSha || proposal.templateRef.path !== current.templateRef.path || proposal.templateRef.sha256 !== current.templateRef.sha256) return '模板已变化，写入提议已作废，请重新提问'
  if (proposal.contextHash !== current.contextHash) return 'CONTEXT.md 已变化，写入提议已作废，请重新提问'
  if (!sameSet(proposal.evidenceIds, current.evidenceIds)) return '依据集合已变化，写入提议已作废，请重新提问'
  return undefined
}

/**
 * Describes what one whole-body write changed, which read evidence it used and
 * which blocking business answers remain. Evidence and questions come from Host
 * state, never from the model's prose.
 */
export function summarizeWrite(before: string, after: string, evidence: readonly string[], unanswered: readonly string[]): ScenarioWriteSummary {
  const changes = describeWriteChanges(before, after)
  return {
    added: changes.filter(change => change.kind === 'added').map(change => change.title),
    removed: changes.filter(change => change.kind === 'removed').map(change => change.title),
    changed: changes.filter(change => change.kind === 'changed').map(change => change.title),
    evidence: [...evidence], unanswered: [...unanswered],
  }
}

