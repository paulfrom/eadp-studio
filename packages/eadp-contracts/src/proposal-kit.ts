import { diffLines } from 'diff'
import type { ProposalDiffLine } from './requirements.js'

export const PROPOSAL_SUMMARY_MAX = 2000
const DIFF_TIMEOUT_MS = 200
const DIFF_MAX_EDIT_LENGTH = 4000

export function isValidSummary(summary: unknown): summary is string {
  return typeof summary === 'string' && summary.trim().length > 0 && summary.length <= PROPOSAL_SUMMARY_MAX
}

/**
 * Line diff capped at `cap` lines; a diff the engine declined (timeout or too
 * complex) reports as truncated, and the full texts remain in the proposal.
 */
export function diffWithCap(baseText: string, nextText: string, cap = 2000): { diff: ProposalDiffLine[]; truncated: boolean } {
  const changes = diffLines(baseText, nextText, { timeout: DIFF_TIMEOUT_MS, maxEditLength: DIFF_MAX_EDIT_LENGTH })
  const diff: ProposalDiffLine[] = []
  let truncated = changes === undefined
  outer: if (changes) {
    for (const change of changes) {
      const lines = change.value.replace(/\n$/, '').split('\n')
      for (const text of lines) {
        if (diff.length >= cap) {
          truncated = true
          break outer
        }
        diff.push({ kind: change.added ? 'added' : change.removed ? 'removed' : 'context', text })
      }
    }
  }
  return { diff, truncated }
}

/**
 * Per-agent read bookkeeping shared by the proposal flows; a proposal may only
 * target a version the same session previously observed.
 */
export class ReadTracker<K> {
  private readonly reads = new WeakMap<object, Map<K, string | null>>()

  get(owner: object, key: K): string | null | undefined {
    return this.reads.get(owner)?.get(key)
  }

  set(owner: object, key: K, value: string | null): void {
    let bucket = this.reads.get(owner)
    if (!bucket) {
      bucket = new Map()
      this.reads.set(owner, bucket)
    }
    bucket.set(key, value)
  }
}
