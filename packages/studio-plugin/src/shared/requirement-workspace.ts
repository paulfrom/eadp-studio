import type { FixedReference, MaterialMetadata } from '@eadp/contracts'

/** Accepted source text pinned by the requirement's formal scenario relationship. */
export interface RequirementSourceView {
  entityId: string; title: string; version: number; confirmationId: string;
  fixed: FixedReference; builtin: boolean; body: string;
}

/** Progress and recovery choices for one exact requirement save. */
export interface RequirementSaveView {
  operationId: string; phase: 'relations' | 'document' | 'directory'; status: 'pending' | 'recovery';
  message: string; documentSaved: boolean; reason: 'network' | 'occupation' | 'relations' | 'invalid';
  /** Unwritten input is separate from the actual file and its acknowledged hash. */
  input?: { body: string; metadata: MaterialMetadata };
}

/** Explicit user actions for the requirement document and its design conversation. */
export type RequirementWorkspaceCommand =
  | { action: 'readRequirementSource'; entityId: string; sourceEntityId: string; expectedVersion: number }
  | { action: 'openRequirement'; entityId: string }
  | { action: 'startRequirementRevision'; entityId: string; expectedRevision: number }
  | { action: 'saveRequirement'; entityId: string; operationId: string; body: string; metadata: MaterialMetadata }
  | { action: 'retryRequirementSave'; entityId: string; operationId: string }
  | { action: 'resolveRequirementWriteProposal'; entityId: string; proposalId: string; decision: 'write' | 'reject'; expectedHash: string; selectedChangeIds?: string[] }
  | { action: 'undoRequirementWrite'; entityId: string; operationId: string; expectedHash: string }
  | { action: 'newRequirementSession'; entityId: string }
  | { action: 'selectRequirementSession'; entityId: string; sessionId: string }
