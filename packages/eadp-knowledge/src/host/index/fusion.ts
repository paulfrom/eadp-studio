/**
 * 基础查询组与扩展查询组的候选融合、去重与最终候选约束。
 *
 * 融合顺序与 README §8.4 一致：worker 已在每个查询内融合词项／精确通道；这里先把同一组
 * 内的查询按 RRF 合并（每个查询一票），再按两个组的稳定排名做组间 RRF，最后施加基础组
 * 保留名额、稳定排序、去重与单资料占用上限。
 *
 * 常量与理由：
 * - `RRF_K = 60`：与 worker 内词项／精确通道的 RRF 常数一致，组内与组间使用同一尺度。
 * - 基础组优先占 `ceil(limit / 2)` 个名额：原问题与上下文始终优先于模型生成的近义查询，
 *   避免扩展因恰好命中更多查询而挤掉原查询结果。
 * - `MAX_PER_DOCUMENT = 2`：同一资料的多个片段在自动注入中会合并阅读，限制占用可让
 *   候选覆盖更多资料；同时保留少量同资料片段供手工查找。
 * - `MAX_FUSED = 80`：融合池上限，覆盖两组各查询的候选深度即可，避免异常大的集合放大
 *   排序与内存成本。
 */
import type { SearchGroup } from './protocol.ts'
import type { KnowledgeCandidate } from './search.ts'

/** 组内与组间融合共用的 RRF 常数。 */
const RRF_K = 60
/** 进入最终约束的融合候选上限。 */
const MAX_FUSED = 80
/** 单份资料在最终候选中的占用上限。 */
const MAX_PER_DOCUMENT = 2

type Channel = KnowledgeCandidate['channels'][number]

/** 组内排名条目：候选、组内 RRF 分数与合并后的命中原因。 */
export interface GroupRankEntry {
  candidate: KnowledgeCandidate
  score: number
  channels: Set<Channel>
}

/** 融合中的候选累计：组间分数与命中原因合并后形成最终排名。 */
interface FusedEntry {
  candidate: KnowledgeCandidate
  score: number
  channels: Set<Channel>
}

/** 已选入最终结果的候选；命中原因在去重合并时继续累加。 */
interface Selected {
  candidate: KnowledgeCandidate
  channels: Set<Channel>
}

/**
 * 计算一个查询组的稳定排名：组内每个查询一票，按组内排名做 RRF。
 * @param group - 基础组或扩展组；组内查询顺序不影响结果。
 * @returns 按分数降序、同分按 `chunkKey` 升序排列的组内排名。
 */
export function rankSearchGroup(group: SearchGroup): GroupRankEntry[] {
  const entries = new Map<string, GroupRankEntry>()
  for (const ranking of group.queries) {
    ranking.candidates.forEach((candidate, index) => {
      const entry = entries.get(candidate.chunkKey)
      const score = 1 / (RRF_K + index + 1)
      if (entry === undefined) {
        entries.set(candidate.chunkKey, {
          candidate,
          score,
          channels: new Set(candidate.channels),
        })
        return
      }
      entry.score += score
      for (const channel of candidate.channels) entry.channels.add(channel)
    })
  }
  return [...entries.values()].sort(compareRank)
}

/**
 * 按两个组的稳定排名做组间 RRF，再施加基础组保留名额与最终候选约束。
 * @param groups - 本次查找实际参与的组；缺失的组不参与投票。
 * @param limit - 最终候选上限；基础组优先名额取其一半（向上取整）。
 * @returns 已去重、稳定排序并限制单资料占用的候选。
 */
export function fuseSearchGroups(groups: readonly SearchGroup[], limit: number): KnowledgeCandidate[] {
  if (limit <= 0) return []
  const rankings = groups.map(group => ({ key: group.key, entries: rankSearchGroup(group) }))
  const fused = new Map<string, FusedEntry>()
  for (const ranking of rankings) {
    ranking.entries.forEach((entry, rank) => {
      const target = fused.get(entry.candidate.chunkKey)
      const score = 1 / (RRF_K + rank + 1)
      if (target === undefined) {
        fused.set(entry.candidate.chunkKey, {
          candidate: entry.candidate,
          score,
          channels: new Set(entry.channels),
        })
        return
      }
      target.score += score
      for (const channel of entry.channels) target.channels.add(channel)
    })
  }
  const ranked = [...fused.values()].sort(compareRank).slice(0, MAX_FUSED)
  const base = rankings.find(ranking => ranking.key === 'base')
  const reserved = base === undefined ? [] : base.entries.slice(0, Math.ceil(limit / 2))

  const selected: Selected[] = []
  const seenChunks = new Set<string>()
  const seenRanges = new Map<string, Selected>()
  const perDocument = new Map<string, number>()
  const add = (chunkKey: string): void => {
    if (selected.length >= limit || seenChunks.has(chunkKey)) return
    const entry = fused.get(chunkKey)
    if (entry === undefined) return
    const rangeKey = rangeKeyOf(entry.candidate)
    const duplicate = seenRanges.get(rangeKey)
    if (duplicate !== undefined) {
      // 同一资料同一真实范围：合并命中原因后只返回一次。
      for (const channel of entry.channels) duplicate.channels.add(channel)
      seenChunks.add(chunkKey)
      return
    }
    const documentKey = `${entry.candidate.packId}:${entry.candidate.documentId}`
    const used = perDocument.get(documentKey) ?? 0
    if (used >= MAX_PER_DOCUMENT) return
    perDocument.set(documentKey, used + 1)
    const item: Selected = { candidate: entry.candidate, channels: new Set(entry.channels) }
    selected.push(item)
    seenChunks.add(chunkKey)
    seenRanges.set(rangeKey, item)
  }
  // 基础组靠前候选先占名额；其余按组间融合顺序补齐。
  for (const entry of reserved) add(entry.candidate.chunkKey)
  for (const entry of ranked) add(entry.candidate.chunkKey)
  return selected.map(item => ({ ...item.candidate, channels: orderedChannels(item.channels) }))
}

/** 稳定排序：分数降序，同分按 `chunkKey` 升序。 */
function compareRank(left: { candidate: KnowledgeCandidate; score: number }, right: { candidate: KnowledgeCandidate; score: number }): number {
  return right.score - left.score || left.candidate.chunkKey.localeCompare(right.candidate.chunkKey, 'en')
}

/** 命中原因按固定顺序输出，便于诊断与注入消息稳定展示。 */
function orderedChannels(channels: ReadonlySet<Channel>): Channel[] {
  const ordered: Channel[] = []
  if (channels.has('词项')) ordered.push('词项')
  if (channels.has('精确')) ordered.push('精确')
  return ordered
}

/** 资料与真实范围的去重键；同一 chunk 的多个命中原因合并为一条候选。 */
function rangeKeyOf(candidate: KnowledgeCandidate): string {
  const ranges = candidate.ranges.map(range => `${range.start}-${range.end}`).join(',')
  return `${candidate.packId}\u0000${candidate.documentId}\u0000${ranges}`
}
