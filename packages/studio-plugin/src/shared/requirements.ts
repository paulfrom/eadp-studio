import type { FixedReference, MaterialMetadata } from '@eadp/contracts'

/** An accepted ordinary scenario selected as immutable input for one split. */
export interface SplitSource {
  projectId: string; entityId: string; title: string; version: number;
  confirmationId: string; fixed: FixedReference;
}
/** The requirement template context fixed when the split was requested. */
export interface CandidateTemplate { id: string; fixed: FixedReference; body: string }
/** Lines refer to the supplied scenario Markdown body, excluding its technical metadata. */
export interface CandidateExcerpt { startLine: number; endLine: number; text: string }
export interface CandidateSource extends SplitSource { excerpts: CandidateExcerpt[] }
/** A durable split keeps its selected inputs; later scenario revisions never replace them. */
export interface SplitTaskBinding {
  id: string; sources: SplitSource[]; template: CandidateTemplate;
  existingRequirements: Array<{ id: string; title: string; summary?: string }>;
  status: 'pending' | 'sent' | 'failed' | 'completed';
}
/** A proposed independent business capability, adopted only by a trusted user command. */
export interface Candidate {
  id: string; projectId: string; sessionId: string; splitId: string; inputHash: string;
  title: string; summary: string; goal: string; scope: string;
  rules: string[]; acceptanceCriteria: string[]; body: string;
  sources: CandidateSource[]; template: CandidateTemplate;
  quality: Pick<MaterialMetadata, 'coreRulesPresent' | 'acceptanceCriteriaPresent' | 'openQuestions'>;
  /** Reserved identity survives a failed first body write; retries finish that same material. */
  reservedEntityId?: string; selectedEntityId?: string;
}
