import type { FixedReference, MaterialMetadata } from '@eadp/contracts'

/** Accepted source text pinned by the requirement's formal scenario relationship. */
export interface RequirementSourceView {
  entityId: string; title: string; version: number; confirmationId: string;
  fixed: FixedReference; builtin: boolean; body: string;
}

/** Explicit user actions for the requirement document and its design conversation. */
export type RequirementWorkspaceCommand =
  | { action: 'readRequirementSource'; entityId: string; sourceEntityId: string; expectedVersion: number }
  | { action: 'openRequirement'; entityId: string }
  | { action: 'startRequirementRevision'; entityId: string; expectedRevision: number }
  | { action: 'saveRequirement'; entityId: string; expectedHash: string; operationId: string; body: string; metadata: MaterialMetadata }
  | { action: 'resolveRequirementConflict'; entityId: string; expectedHash: string; operationId: string; body: string; metadata: MaterialMetadata }
  | { action: 'resolveRequirementWriteProposal'; entityId: string; proposalId: string; decision: 'write' | 'reject'; expectedHash: string }
  | { action: 'undoRequirementWrite'; entityId: string; operationId: string; expectedHash: string }
  | { action: 'newRequirementSession'; entityId: string }
  | { action: 'selectRequirementSession'; entityId: string; sessionId: string }
  | { action: 'bindRequirementTemplate'; entityId: string; templateId: string; expectedHash: string; operationId: string }
