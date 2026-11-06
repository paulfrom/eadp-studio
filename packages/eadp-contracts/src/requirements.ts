import type { FileVersion } from './files.js'
/** A bounded line comparison; the candidate and original remain available for complete review. */
export interface ProposalDiffLine { kind: 'context' | 'added' | 'removed'; text: string }
/** An unapplied in-memory suggestion, never a second authority for the project file. */
export interface RequirementProposal {
  proposalId: string
  projectId: string
  relativePath: string
  target: 'requirement' | 'context'
  baseVersion: FileVersion | null
  text: string
  baseText: string
  summary: string
  diff: ProposalDiffLine[]
  diffTruncated: boolean
  createdAt: string
  sessionId: string
}
