import type { ConsistencyComparisonView } from '@eadp/contracts'

/** Local execution and sharing are separate from the material's confirmation state. */
export interface ConsistencyTaskView {
  id: string; projectId: string; entityId: string; trigger: 'manual' | 'confirmation'; confirmationId?: string;
  phase: 'running' | 'pending-sync' | 'shared'; createdAt: string;
  freshness: 'current' | 'stale' | 'unknown'; message?: string;
  result?: ConsistencyComparisonView;
  outcome?: Pick<ConsistencyComparisonView, 'result' | 'coverage' | 'failureCode' | 'summary' | 'conflicts' | 'conflictCount'>;
}

/** One controlled read supplies both the model's text and the recorded digest. */
export interface ConsistencyModelInput {
  targetId: string; coverage: 'complete' | 'partial';
  materials: Array<{ entityId: string; kind: 'scenario' | 'requirement'; path: string; sha256: string;
    relation: 'target' | 'formal' | 'potential'; state: 'local-draft' | 'current-file' | 'unverified'; text: string }>;
  limitations: string[];
}

export type ConsistencyCommand =
  | { action: 'listConsistencySummaries' }
  | { action: 'compareConsistency'; entityId: string }
  | { action: 'cancelConsistencyComparison'; comparisonId: string }
  | { action: 'retryConsistencySubmission'; comparisonId: string }
  | { action: 'checkConsistencyFreshness'; comparisonId: string }
  | { action: 'listConsistencyComparisons'; entityId?: string; limit: number; offset: number }
