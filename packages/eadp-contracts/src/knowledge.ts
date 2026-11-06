import type { ProposalDiffLine } from './requirements.js'
export type KnowledgePackId = 'builtin' | 'user'
export type KnowledgeErrorCode = 'INVALID_ARGUMENT' | 'NOT_FOUND' | 'VERSION_MISMATCH' | 'RESOURCE_INVALID' | 'UNAVAILABLE'
export interface KnowledgeReference { packId: KnowledgePackId; packVersion: string; documentId: string; sha256: string }
export interface KnowledgeCard extends KnowledgeReference { title: string; source: string; scope: string; tags: string[]; version: string; readOnly: boolean }
export interface KnowledgePack { packId: KnowledgePackId; packVersion: string; readOnly: boolean; exists: boolean; cards: KnowledgeCard[] }
export interface KnowledgeIssue { packId: KnowledgePackId; code: KnowledgeErrorCode; message: string; documentId?: string }
export interface KnowledgeCatalog { packs: KnowledgePack[]; issues: KnowledgeIssue[] }
export interface KnowledgeDraft { title: string; source: string; scope: string; tags: string[]; text: string }
export interface KnowledgeHit { reference: KnowledgeReference; title: string; excerpt: string; source: string; scope: string }
export interface KnowledgeSearchResult { hits: KnowledgeHit[]; issues: KnowledgeIssue[] }
export interface KnowledgeRead { reference: KnowledgeReference; title: string; source: string; scope: string; tags: string[]; text: string; offset: number; length: number; truncated: boolean; nextOffset: number | null }
/** User knowledge changes are suggestions until a trusted UI applies them. */
export interface KnowledgeProposal {
  proposalId: string
  action: 'create' | 'update'
  target: 'user'
  documentId: string
  baseVersion: string
  draft: KnowledgeDraft
  baseText: string
  summary: string
  diff: ProposalDiffLine[]
  diffTruncated: boolean
  createdAt: string
  sessionId: string
}
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap { 'eadp/knowledge': { code: KnowledgeErrorCode; packId?: KnowledgePackId; documentId?: string } }
}
