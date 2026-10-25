import type { ScenarioWriteChange } from '../../shared/scenarios.ts'
import { digest } from '../adapters/assets/materials.ts'

interface Chapter { key: string; title: string; text: string }

/** Keeps exact file bytes per chapter, including repeated headings and fenced examples. */
function chapters(body: string): Chapter[] {
  const result: Chapter[] = [], occurrences = new Map<string, number>()
  let fence: string | undefined, start = 0, offset = 0, title = '正文开头', key = 'intro'
  for (const line of body.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (marker) {
      if (!fence) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length && /^\s{0,3}(?:`+|~+)[ \t]*\r?\n?$/.test(line)) fence = undefined
    } else if (!fence) {
      const heading = /^ {0,3}##[ \t]+(.+?)[ \t]*#*[ \t]*\r?\n?$/.exec(line)?.[1]?.trim()
      if (heading) {
        if (offset > start) result.push({ key, title, text: body.slice(start, offset) })
        const occurrence = (occurrences.get(heading) ?? 0) + 1
        occurrences.set(heading, occurrence)
        title = heading; key = `${heading}\u0000${occurrence}`; start = offset
      }
    }
    offset += line.length
  }
  if (offset > start) result.push({ key, title, text: body.slice(start) })
  return result
}

/** Counts inserted and removed lines with Myers' shortest edit path, excluding equal lines. */
function lineCounts(before: string, after: string): { addedLines: number; removedLines: number } {
  const left = before ? before.replace(/\n$/, '').split('\n') : []
  const right = after ? after.replace(/\n$/, '').split('\n') : []
  let start = 0, endLeft = left.length, endRight = right.length
  while (start < endLeft && start < endRight && left[start] === right[start]) start++
  while (endLeft > start && endRight > start && left[endLeft - 1] === right[endRight - 1]) { endLeft--; endRight-- }
  const removed = endLeft - start, added = endRight - start
  if (!removed || !added) return { addedLines: added, removedLines: removed }
  const previousLines = new Set(left.slice(start, endLeft))
  if (!right.slice(start, endRight).some(line => previousLines.has(line))) return { addedLines: added, removedLines: removed }
  const maximum = removed + added, offset = maximum + 1
  const frontier = new Int32Array(2 * maximum + 3).fill(-1)
  frontier[offset + 1] = 0
  for (let distance = 0; distance <= maximum; distance++) {
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const index = offset + diagonal
      let x = diagonal === -distance || diagonal !== distance && frontier[index - 1]! < frontier[index + 1]!
        ? frontier[index + 1]! : frontier[index - 1]! + 1
      let y = x - diagonal
      while (x < removed && y < added && left[start + x] === right[start + y]) { x++; y++ }
      frontier[index] = x
      if (x >= removed && y >= added) return { addedLines: (distance + added - removed) / 2, removedLines: (distance + removed - added) / 2 }
    }
  }
  throw new Error('无法计算文档行差异')
}

function change(key: string, title: string, before: string, after: string): ScenarioWriteChange {
  return { id: digest(key).slice(0, 24), title, before, after, kind: !before ? 'added' : !after ? 'removed' : 'changed', ...lineCounts(before, after) }
}

/** Chapter moves are reviewed together so a partial write never silently reorders untouched text. */
function reordered(previous: Chapter[], next: Chapter[]): boolean {
  const previousKeys = new Set(previous.map(item => item.key)), nextKeys = new Set(next.map(item => item.key))
  return previous.filter(item => nextKeys.has(item.key)).map(item => item.key).join('\u0001') !== next.filter(item => previousKeys.has(item.key)).map(item => item.key).join('\u0001')
}

/** Produces stable, Host-owned review IDs from the exact source and proposed document. */
export function describeWriteChanges(before: string, after: string): ScenarioWriteChange[] {
  if (before === after) return []
  const previous = chapters(before), next = chapters(after)
  if (reordered(previous, next)) return [change('document', '全文（含章节顺序调整）', before, after)]
  const left = new Map(previous.map(item => [item.key, item])), right = new Map(next.map(item => [item.key, item]))
  const keys = [...new Set([...next.map(item => item.key), ...previous.map(item => item.key)])]
  return keys.filter(key => left.get(key)?.text !== right.get(key)?.text).map(key => change(key, right.get(key)?.title ?? left.get(key)!.title, left.get(key)?.text ?? '', right.get(key)?.text ?? ''))
}

/** Applies only reviewed chapters; omitted modifications and removals retain their original bytes. */
export function applyWriteChanges(before: string, after: string, selectedIds: readonly string[] | undefined): string {
  const changes = describeWriteChanges(before, after)
  if (!Array.isArray(selectedIds) || selectedIds.length === 0) throw new Error('请至少选择一处变更后写入')
  const selected = new Set(selectedIds), available = new Set(changes.map(item => item.id))
  if (selected.size !== selectedIds.length || selectedIds.some(id => !available.has(id))) throw new Error('所选变更与当前写入提议不一致，请重新审阅')
  if (selected.size === changes.length) return after
  const previous = chapters(before), next = chapters(after)
  const old = new Map(previous.map(item => [item.key, item]))
  const output: string[] = []
  let cursor = 0
  for (const chapter of next) {
    const oldChapter = old.get(chapter.key), id = digest(chapter.key).slice(0, 24)
    if (oldChapter) {
      while (cursor < previous.length && previous[cursor]!.key !== chapter.key) {
        const removed = previous[cursor++]!
        if (!selected.has(digest(removed.key).slice(0, 24))) output.push(removed.text)
      }
      cursor++
      output.push(selected.has(id) ? chapter.text : oldChapter.text)
    } else if (selected.has(id)) output.push(chapter.text)
  }
  while (cursor < previous.length) {
    const removed = previous[cursor++]!
    if (!selected.has(digest(removed.key).slice(0, 24))) output.push(removed.text)
  }
  return output.reduce((body, chunk) => body && !body.endsWith('\n') && /^ {0,3}##[ \t]/.test(chunk) ? `${body}\n\n${chunk}` : body + chunk, '')
}
