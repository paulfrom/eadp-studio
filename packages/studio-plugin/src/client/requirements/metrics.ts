import type { ConsistencyComparisonView, MaterialMetadata } from '@eadp/contracts'
import { listItemCount, splitSections } from '../scenarios/document.ts'

/** Requirement card metrics from one readable material; never keyword or confidence guesses. */
export interface RequirementMetrics { rules: number | null; openQuestions: number; blocking: number }
/** Latest comparison conclusion for one material; failed, cancelled or unread means unknown. */
export type LatestComparison =
  | { status: 'unknown' }
  | { status: 'known'; conflictCount: number; coverage: 'complete' | 'partial'; createdAt: string }

/**
 * Count business rules and open questions with the same parsing for drafts and
 * confirmed materials: rules are the top-level list entries of the 业务规则
 * section, questions come from the material metadata.
 */
export function requirementMetrics(body: string, metadata: MaterialMetadata): RequirementMetrics {
  const sections = splitSections(body).filter(section => section.title === '业务规则')
  const rules = sections.length ? sections.reduce((count, section) => count + listItemCount(section.body), 0) : null
  return { rules, openQuestions: metadata.openQuestions.length, blocking: metadata.openQuestions.filter(question => question.blocking).length }
}

/**
 * Derive the per-material reminder from its most recent comparison only.
 * Running or pending-sync tasks are not conclusions, and a failed or cancelled
 * comparison can never stand in for a consistent result.
 */
export function latestComparison(entityId: string, history: ConsistencyComparisonView[]): LatestComparison {
  const latest = history.filter(item => item.entityId === entityId).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0]
  if (!latest || latest.result !== 'completed') return { status: 'unknown' }
  return { status: 'known', conflictCount: latest.conflictCount, coverage: latest.coverage, createdAt: latest.createdAt }
}
