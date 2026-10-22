import type { FixedReference } from '@eadp/contracts'
import type { MaterialDraft } from '../../shared/studio.ts'
import type { ScenarioSuggestionBatch, ScenarioSuggestionGroup, ScenarioSuggestionItem } from '../../shared/scenarios.ts'

const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/
const hashPattern = /^[a-f0-9]{64}$/
/** Longest original-text echo the model may send to prove which text its range targets. */
const anchorLimit = 40
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !(key in value))) throw new Error('场景建议字段无效')
  return value as Record<string, unknown>
}
function id(value: unknown): asserts value is string { if (typeof value !== 'string' || !idPattern.test(value)) throw new Error('场景建议 ID 无效') }
function text(value: unknown, maximum = 1_000_000): asserts value is string { if (typeof value !== 'string' || value.length > maximum) throw new Error('场景建议文本无效或过大') }
function unique(values: string[]): void { if (new Set(values).size !== values.length) throw new Error('场景建议包含重复 ID') }
export function sameTemplate(a: FixedReference, b: FixedReference): boolean { return a.commitSha === b.commitSha && a.path === b.path && a.sha256 === b.sha256 }

/**
 * Parses the single propose-only result block. The model sends only the body
 * range plus a short anchor instead of the text it replaces, so an answer never
 * repeats the document; the original text is derived from the draft the batch's
 * `baseHash` names.
 */
export function parseSuggestionBatch(response: string, draft: MaterialDraft): ScenarioSuggestionBatch {
  if (response.length > 2_000_000) throw new Error('场景建议过大')
  if ([...response.matchAll(/^```eadp-suggestions(?:\s|$)/gm)].length !== 1) throw new Error('需要且仅允许一个 eadp-suggestions JSON 块')
  const blocks = [...response.matchAll(/^```eadp-suggestions\n([^]*?)\n```\s*$/gm)]
  if (blocks.length !== 1) throw new Error('需要且仅允许一个 eadp-suggestions JSON 块')
  const batch = object(JSON.parse(blocks[0]![1]!), ['id', 'entityId', 'baseHash', 'groups'])
  id(batch.id); id(batch.entityId)
  if (typeof batch.baseHash !== 'string' || !hashPattern.test(batch.baseHash)) throw new Error('场景建议版本 hash 无效')
  // A batch describing another version still arrives as history. Only the
  // current body can prove a range, so an older batch keeps empty originals and
  // the workspace marks it stale.
  const current = batch.baseHash === draft.sha256
  if (!Array.isArray(batch.groups) || !batch.groups.length || batch.groups.length > 100) throw new Error('场景建议分组无效')
  const groupIds: string[] = [], itemIds: string[] = [], groups: ScenarioSuggestionGroup[] = []
  for (const value of batch.groups) {
    const group = object(value, ['id', 'title', 'items']); id(group.id); text(group.title, 500)
    if (!group.title.trim() || !Array.isArray(group.items) || !group.items.length || group.items.length > 1000) throw new Error('场景建议分组内容无效')
    groupIds.push(group.id)
    const items: ScenarioSuggestionItem[] = []
    for (const itemValue of group.items) {
      const item = object(itemValue, ['id', 'start', 'end', 'anchor', 'replacement', 'evidenceIds']); id(item.id)
      if (!Number.isSafeInteger(item.start) || !Number.isSafeInteger(item.end) || (item.start as number) < 0 || (item.end as number) < (item.start as number)) throw new Error('场景建议字符范围无效')
      text(item.anchor); text(item.replacement)
      if (item.anchor.length > anchorLimit) throw new Error(`场景建议原文锚点不能超过 ${anchorLimit} 字`)
      if (!Array.isArray(item.evidenceIds) || item.evidenceIds.length > 100) throw new Error('场景建议依据无效')
      for (const evidenceId of item.evidenceIds) id(evidenceId)
      unique(item.evidenceIds as string[])
      const start = item.start as number, end = item.end as number, original = current ? draft.body.slice(start, end) : ''
      if (current) {
        if (end > draft.body.length) throw new Error('场景建议字符范围超出当前正文')
        if (!original.startsWith(item.anchor) || (item.anchor === '') !== (original === '')) throw new Error('场景建议原文锚点与范围不一致')
        if (original === item.replacement) throw new Error('场景建议替换内容没有变化')
      }
      items.push({ id: item.id, start, end, original, replacement: item.replacement, evidenceIds: item.evidenceIds as string[] })
      itemIds.push(item.id)
    }
    groups.push({ id: group.id, title: group.title, items })
  }
  unique(groupIds); unique(itemIds)
  if (itemIds.length > 1000) throw new Error('场景建议条目过多')
  return { id: batch.id, entityId: batch.entityId, baseHash: batch.baseHash, groups, status: 'current' }
}

function overlaps(a: ScenarioSuggestionItem, b: ScenarioSuggestionItem): boolean {
  // Two insertions at the same point have no defined order; an insertion on a replacement boundary is also ambiguous.
  if (a.start === a.end || b.start === b.end) return a.start <= b.end && b.start <= a.end
  return a.start < b.end && b.start < a.end
}
/** Applies selected ranges to one immutable body snapshot, never to intermediate results. */
export function suggestionBody(draft: MaterialDraft, batch: ScenarioSuggestionBatch, selectedItemIds: readonly string[], readEvidenceIds: readonly string[]): string {
  if (draft.metadata.kind !== 'scenario' || batch.status !== 'current' || batch.entityId !== draft.entityId || batch.baseHash !== draft.sha256) throw new Error('场景建议已过期，请基于当前正文和模板重新生成')
  if (!selectedItemIds.length || selectedItemIds.length > 1000 || new Set(selectedItemIds).size !== selectedItemIds.length) throw new Error('请先选择有效且不重复的建议')
  const all = new Map(batch.groups.flatMap(group => group.items).map(item => [item.id, item]))
  const selected = selectedItemIds.map(itemId => { const item = all.get(itemId); if (!item) throw new Error('所选建议不存在'); return item }).sort((a, b) => a.start - b.start || a.end - b.end)
  const evidence = new Set(readEvidenceIds)
  for (const [index, item] of selected.entries()) {
    if (item.end > draft.body.length) throw new Error('场景建议范围超出当前正文，请重新生成')
    if (item.evidenceIds.some(evidenceId => !evidence.has(evidenceId))) throw new Error('场景建议引用了未实际读取的资料')
    if (index && overlaps(selected[index - 1]!, item)) throw new Error('所选建议范围重叠，请重新选择')
  }
  let result = draft.body
  for (const item of selected.reverse()) result = result.slice(0, item.start) + item.replacement + result.slice(item.end)
  if (result.length > 1_000_000) throw new Error('采纳后的场景正文过大')
  return result
}
