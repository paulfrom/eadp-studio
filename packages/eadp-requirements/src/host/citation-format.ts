import type { KnowledgeSnapshotRange, KnowledgeSourceMap } from '@eadp/contracts/knowledge'
import type { RequirementKnowledgeCitation } from '@eadp/contracts/requirements'

/** 需求正文中「需求依据」章节的标题；用于判断正文是否仍保留依据条目。 */
export const BASIS_HEADING = '## 需求依据'
const BASIS_HEADING_PATTERN = /^#{1,6}\s*需求依据\s*$/m
const MAX_LOCATION_LABELS = 3

/** 同一份资料在一次提案中的多个采用范围；写入正文时合并成一条。 */
export interface MergedCitation {
  packId: RequirementKnowledgeCitation['packId']
  documentId: string
  title: string
  sourceLabel: string
  locations: string[]
  notes: string[]
  parts: { snapshotId: string; ranges: KnowledgeSnapshotRange[] }[]
}

/** 正文是否仍包含可读的「需求依据」章节。 */
export const hasBasisHeading = (text: string): boolean => BASIS_HEADING_PATTERN.test(text)

/**
 * 移除正文中的「需求依据」章节：标题行及其到下一个同级或更高级标题之间的内容。
 * 只删除依据章节本身，正文其它内容原样保留；没有该章节时返回原文。
 * @param text - 含旧依据章节的正文。
 * @returns 去掉依据章节后的正文。
 */
export function stripBasisSection(text: string): string {
  const heading = BASIS_HEADING_PATTERN.exec(text)
  if (heading === null) return text
  const level = heading[0].match(/^#+/)?.[0].length ?? 1
  const tailStart = heading.index + heading[0].length
  const next = new RegExp(`^#{1,${level}}\\s`, 'm').exec(text.slice(tailStart))
  const end = next === null ? text.length : tailStart + next.index
  const before = text.slice(0, heading.index).replace(/[\s\uFEFF]+$/u, '')
  const after = text.slice(end).replace(/^[\s\uFEFF]+/u, '')
  if (before === '') return after
  return after === '' ? before : `${before}\n\n${after}`
}

/**
 * 向已有依据章节追加采用项：资料已在章节中时并入其采用范围与说明，避免同一资料重复一条；
 * 没有依据章节或找不到该资料的条目时按新条目追加。
 * 用于界面采用：正文已有的依据来自此前已应用的提案，不能因此拒绝同一资料的新范围。
 * @param text - 当前正文（可能已有依据章节）。
 * @param citations - 本次新增的依据。
 * @param snapshots - 新增依据的快照正文与来源映射。
 * @returns 合并后的正文；没有实际变化时原样返回。
 */
export function appendBasisEntries(
  text: string,
  citations: readonly RequirementKnowledgeCitation[],
  snapshots: ReadonlyMap<string, { body: string; sourceMap: KnowledgeSourceMap | null }>,
): string {
  if (citations.length === 0) return text
  const heading = BASIS_HEADING_PATTERN.exec(text)
  if (heading === null) return renderBasisSection(text, citations, snapshots)
  const entries = mergedEntries(mergeCitationGroups(citations), snapshots)
  const level = heading[0].match(/^#+/)?.[0].length ?? 2
  const tailStart = heading.index + heading[0].length
  const next = new RegExp(`^#{1,${level}}\\s`, 'm').exec(text.slice(tailStart))
  const sectionEnd = next === null ? text.length : tailStart + next.index
  let section = text.slice(tailStart, sectionEnd)
  let changed = false
  for (const entry of entries) {
    const merged = mergeEntryIntoSection(section, entry)
    if (merged !== null) {
      if (merged !== section) changed = true
      section = merged
    }
  }
  const extra = entries.filter(entry => !section.includes(entry.title))
  const tail = extra.map(entry => entry.lines.join('\n')).join('\n')
  if (changed || tail !== '') {
    const suffix = `${section.replace(/[\s\uFEFF]+$/u, '')}\n${tail === '' ? '' : `\n${tail}\n`}`
    return `${text.slice(0, tailStart)}${suffix}${text.slice(sectionEnd)}`
  }
  return text
}

/**
 * 在章节文本中找到某资料的条目并并入新的采用范围/说明。
 * @returns 合并后的章节；找不到该条目时为空。
 */
function mergeEntryIntoSection(section: string, entry: RenderedEntry): string | null {
  const lines = section.split('\n')
  const start = lines.findIndex(line => line.includes(entry.title))
  if (start < 0) return null
  let end = start + 1
  while (end < lines.length && !lines[end]?.trimStart().startsWith('- 《')) end += 1
  const block = lines.slice(start, end)
  const incomingNotes = entry.lines.filter(line => line.includes('采用说明：')).map(line => line.slice(line.indexOf('采用说明：') + '采用说明：'.length).trim())
  const incomingPositions = entry.lines.filter(line => line.includes('采用范围：')).map(line => line.slice(line.indexOf('采用范围：') + '采用范围：'.length).trim())
  let noteLine = block.findIndex(line => line.includes('采用说明：'))
  if (noteLine < 0) { block.splice(1, 0, '  采用说明：'); noteLine = 1 }
  const notes = block[noteLine]!.slice(block[noteLine]!.indexOf('采用说明：') + '采用说明：'.length).split('；').map(value => value.trim()).filter(value => value !== '')
  for (const note of incomingNotes) if (!notes.includes(note)) notes.push(note)
  block[noteLine] = `  采用说明：${notes.join('；')}`
  let positionLine = block.findIndex(line => line.includes('采用范围：'))
  const positions = positionLine < 0 ? [] : block[positionLine]!.slice(block[positionLine]!.indexOf('采用范围：') + '采用范围：'.length).split('、').map(value => value.trim()).filter(value => value !== '')
  for (const position of incomingPositions) for (const part of position.split('、')) if (!positions.includes(part) && part !== '') positions.push(part)
  if (positions.length > 0) {
    if (positionLine < 0) { block.push(`  采用范围：${positions.join('、')}`); positionLine = block.length - 1 }
    else block[positionLine] = `  采用范围：${positions.join('、')}`
  }
  return [...lines.slice(0, start), ...block, ...lines.slice(end)].join('\n')
}

/**
 * 先移除旧的依据章节，再按全部依据重新渲染；合并采用项时使用。
 * 正文改动保留在依据章节之前，不能因重渲染被覆盖。
 * @param text - 仍需保留的正文（含旧的依据章节）。
 * @param citations - 合并后的全部依据。
 * @param snapshots - 全部依据对应的快照正文与来源映射。
 * @returns 只含全部依据一份章节的正文。
 */
export function rerenderBasisSection(
  text: string,
  citations: readonly RequirementKnowledgeCitation[],
  snapshots: ReadonlyMap<string, { body: string; sourceMap: KnowledgeSourceMap | null }>,
): string {
  return renderBasisSection(stripBasisSection(text), citations, snapshots)
}

/** 按资料合并采用项，保留各自范围；采用说明去重并保持顺序。 */
export function mergeCitationGroups(citations: readonly RequirementKnowledgeCitation[]): MergedCitation[] {
  const groups = new Map<string, MergedCitation>()
  for (const citation of citations) {
    const key = `${citation.packId}:${citation.documentId}:${citation.contentRevisionId}`
    const existing = groups.get(key)
    if (existing === undefined) {
      groups.set(key, {
        packId: citation.packId,
        documentId: citation.documentId,
        title: citation.title,
        sourceLabel: citation.sourceLabel,
        locations: [...citation.locations],
        notes: [citation.note],
        parts: [{ snapshotId: citation.snapshotId, ranges: citation.ranges }],
      })
      continue
    }
    for (const location of citation.locations) if (!existing.locations.includes(location)) existing.locations.push(location)
    if (!existing.notes.includes(citation.note)) existing.notes.push(citation.note)
    existing.parts.push({ snapshotId: citation.snapshotId, ranges: citation.ranges })
  }
  return [...groups.values()]
}

/**
 * 把已固定依据渲染成需求正文末尾可读的「需求依据」章节。
 * 采用说明与目标路径不参与快照身份，这里只使用业务语言；当时内容通过需求依据界面查看。
 * @param text - 模型提出的正文。
 * @param citations - 本次提案已固定的依据。
 * @param snapshots - 快照正文与来源映射，用于把范围转成可读定位。
 * @returns 含依据章节的正文；没有依据或已存在章节时原样返回。
 */
export function renderBasisSection(
  text: string,
  citations: readonly RequirementKnowledgeCitation[],
  snapshots: ReadonlyMap<string, { body: string; sourceMap: KnowledgeSourceMap | null }>,
): string {
  if (citations.length === 0) return text
  const merged = mergeCitationGroups(citations)
  if (merged.length === 0) return text
  const entries = mergedEntries(merged, snapshots)
  const heading = BASIS_HEADING_PATTERN.exec(text)
  if (heading === null) {
    const lines = entries.flatMap(entry => entry.lines).join('\n')
    return `${text.replace(/[\s\uFEFF]+$/u, '')}\n\n${BASIS_HEADING}\n\n${lines}\n`
  }
  /* 模型已自己写了依据章节：只补它没有列出的资料，不重复整段。 */
  const missing = entries.filter(entry => !text.includes(entry.title))
  if (missing.length === 0) return text
  const insertAt = heading.index + heading[0].length
  return `${text.slice(0, insertAt)}\n\n${missing.map(entry => entry.lines.join('\n')).join('\n')}${text.slice(insertAt)}`
}

/** 一条合并后的依据在正文中的固定写法；首行标题用于判断正文是否仍保留该条目。 */
interface RenderedEntry {
  title: string
  lines: string[]
}

function mergedEntries(
  merged: readonly MergedCitation[],
  snapshots: ReadonlyMap<string, { body: string; sourceMap: KnowledgeSourceMap | null }>,
): RenderedEntry[] {
  return merged.map(citation => {
    const positions = mergedPositions(citation.parts, snapshots)
    const location = citation.locations.length > 0 ? citation.locations.join('、') : positions.join('、')
    const lines = [
      `- 《${citation.title}》｜来源：${citation.sourceLabel}｜资料位置：${location === '' ? '按采用范围' : location}`,
      `  采用说明：${citation.notes.join('；')}`,
    ]
    if (positions.length > 0) lines.push(`  采用范围：${positions.join('、')}`)
    lines.push('  当时采用内容已随本需求保存，可在需求依据中查看。')
    return { title: `《${citation.title}》`, lines }
  })
}

/** 所有采用范围的可读定位；同一范围内多个来源标签去重。 */
function mergedPositions(
  parts: readonly { snapshotId: string; ranges: KnowledgeSnapshotRange[] }[],
  snapshots: ReadonlyMap<string, { body: string; sourceMap: KnowledgeSourceMap | null }>,
): string[] {
  const labels: string[] = []
  for (const part of parts) {
    const snapshot = snapshots.get(part.snapshotId)
    if (snapshot === undefined) continue
    for (const range of part.ranges) {
      const label = rangeLabel(snapshot.body, snapshot.sourceMap, range)
      if (!labels.includes(label)) labels.push(label)
    }
  }
  return labels
}

/** 优先使用资料真实来源位置，其次按 canonical 正文段落序号表达。 */
function rangeLabel(body: string, sourceMap: KnowledgeSourceMap | null, range: KnowledgeSnapshotRange): string {
  if (sourceMap !== null) {
    const observed: string[] = []
    for (const entry of sourceMap.entries) {
      if (entry.end <= range.start || entry.start >= range.end) continue
      if (entry.label && !observed.includes(entry.label)) observed.push(entry.label)
    }
    if (observed.length > 0) return observed.length > MAX_LOCATION_LABELS ? `${observed.slice(0, MAX_LOCATION_LABELS).join('、')}等` : observed.join('、')
  }
  return paragraphLabel(body, range.start)
}

/** 计算范围内起点所在段落序号（从 1 开始），不伪造页码。 */
function paragraphLabel(body: string, start: number): string {
  const characters = Array.from(body)
  const before = characters.slice(0, Math.max(0, Math.min(start, characters.length))).join('')
  const paragraphs = before.split(/\n\s*\n/).filter(segment => segment.trim() !== '')
  return `第 ${paragraphs.length + 1} 段`
}
