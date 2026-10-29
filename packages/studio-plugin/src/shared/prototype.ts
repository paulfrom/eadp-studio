/** A task workspace or an immutable, accepted prototype baseline. */
export type PrototypeFileSource = { kind: 'task'; projectId: string; prototypeTaskId: string } | { kind: 'baseline'; projectId: string; baselineId: string; commitSha: string }
/** A bounded view of one Host-resolved prototype source. */
export type PrototypeFileResult =
  | { kind: 'directory'; source: PrototypeFileSource; observation: string; truncationReason?: string; entries: Array<{ path: string; name: string; kind: 'file' | 'directory'; readOnly: boolean }>; truncated: boolean; nextCursor?: string }
  | { kind: 'search'; source: PrototypeFileSource; observation: string; truncationReason?: string; matches: Array<{ path: string; line: number; column: number; excerpt: string; hash: string }>; truncated: boolean; nextCursor?: string }
  | { kind: 'diff'; source: PrototypeFileSource; observation: string; truncationReason?: string; baseSha: string; files: Array<{ path: string; status: 'added' | 'modified' | 'deleted'; baseHash?: string; currentHash?: string; baseContent?: string; currentContent?: string; binary: boolean; truncated: boolean }>; truncated: boolean; nextCursor?: string }
  | { kind: 'file'; source: PrototypeFileSource; observation: string; path: string; hash?: string; size: number; readOnly: boolean; content?: string; binary: boolean | null; truncated: boolean; truncationReason?: string; lineRange?: { start: number; end: number }; rangeComplete?: boolean; nextLine?: number }
  | { kind: 'saved'; source: Extract<PrototypeFileSource, { kind: 'task' }>; path: string; hash: string }

/** Unsaved editor contents retain the disk hash and text they were based on. */
export interface PrototypeEditBuffer { prototypeTaskId: string; path: string; baseHash: string; baseContent: string; content: string }

/** File paths are relative to the task workspace resolved by the Host. */
export type PrototypeFileCommand =
  | { action: 'listPrototypeDirectory'; source: PrototypeFileSource; directory?: string; cursor?: string; limit?: number }
  | { action: 'searchPrototypeFiles'; source: PrototypeFileSource; query: string; directory?: string; cursor?: string; limit?: number }
  | { action: 'readPrototypeFile'; source: PrototypeFileSource; path: string; lineRange?: { start: number; end: number } }
  | { action: 'readPrototypeDiff'; prototypeTaskId: string; cursor?: string; limit?: number }
  | { action: 'savePrototypeFile'; prototypeTaskId: string; operationId: string; path: string; expectedHash: string; content: string }
  | { action: 'mergePrototypeConflict'; prototypeTaskId: string; path: string; baseHash: string; baseContent: string; diskHash: string; diskContent: string; content: string }
  | { action: 'readPrototypeBuffer'; prototypeTaskId: string; path: string }
  | { action: 'savePrototypeBuffer'; operationId: string; buffer: PrototypeEditBuffer }
  | { action: 'clearPrototypeBuffer'; prototypeTaskId: string; path: string; expectedContent: string }

export type PrototypeRequirementDevelopmentStage = 'queued' | 'claiming' | 'sending' | 'developing' | 'fixing' | 'commit-known' | 'pushing' | 'pushed' | 'synchronizing' | 'awaiting-review' | 'confirming' | 'reviewed' | 'blocked'
export type PrototypeRequirementReviewStatus = 'pending' | 'awaiting-review' | 'correcting' | 'reviewed'

/** Local scheduling is separate from the server's task and claim state. */
export interface PrototypeQueueItem {
  projectId: string; prototypeTaskId: string; title: string; sessionId?: string; pendingCreation?: boolean;
  taskStatus: 'active' | 'cancelled' | 'released' | 'accepted';
  localDispatchState: 'queued' | 'running' | 'awaiting-user' | 'paused' | 'recovery-required';
  nextAction?: string; pauseOperationId?: string; endOperationId?: string; gitRecovery?: 'clear' | 'unknown' | 'reconcile-required'; developmentRequirementIds: string[];
  requirementId?: string; developmentStage?: PrototypeRequirementDevelopmentStage; reviewStatus?: PrototypeRequirementReviewStatus; commitId?: string;
}
export interface PrototypeQueueView { revision: number; selectedTaskId?: string; items: PrototypeQueueItem[] }
export type PrototypePreviewSource = { kind: 'task'; prototypeTaskId: string } | { kind: 'baseline'; baselineId: string; commitSha: string }
export interface PrototypePreviewIdentity { projectId: string; source: PrototypePreviewSource; previewId: string; generation: number; buildHash: string }
/** Recorded engineering steps; a running operation left by a previous process is interrupted. */
export interface PrototypeCheckDiagnostic { stdout: string; stderr: string; truncated: boolean; error?: string }
export interface PrototypeCheckReport {
  operationId: string; projectId: string; prototypeTaskId: string; baselineId?: string; kind: 'checks' | 'preview'; sourceSha: string; startedAt: string; completedAt?: string
  status: 'running' | 'passed' | 'failed' | 'interrupted'; steps: Array<{ name: 'install' | 'typecheck' | 'lint' | 'build' | 'browser'; status: 'running' | 'passed' | 'failed'; exitCode?: number; diagnostic?: PrototypeCheckDiagnostic }>
  inputHash?: string; outputHash?: string; rulesHash?: string; toolsHash?: string; validity?: 'current' | 'stale' | 'unverified'; message?: string
}
export interface PrototypeInstructionAttachment { kind: 'file' | 'image'; name: string; mediaType: string; data: string }
/** Unsent project instruction, stored independently of any collaboration task. */
export interface PrototypeInstructionDraft { projectId: string; prototypeTaskId?: string; title: string; instruction: string; developmentRequirementIds: string[]; attachments?: PrototypeInstructionAttachment[] }
export interface PrototypeConversationAttachment { id: string; kind: 'file' | 'image'; name?: string; bytes: number; width?: number; height?: number }
/** Native log entries retain message sources, attachments and tool outcomes without exposing attachment bytes. */
export interface PrototypeConversationMessage {
  sequence: number; role: 'user' | 'assistant'; text: string; kind?: 'message' | 'tool'; source?: string; operationId?: string; interrupted?: boolean; truncated?: boolean
  attachments?: PrototypeConversationAttachment[]
  tool?: { callId: string; name: string; status: 'running' | 'completed' | 'failed'; arguments?: string; result?: string }
}
/** A successful material tool read records only its source identity and returned line range. */
export interface PrototypeMaterialRead {
  accountId: number; projectId: string; prototypeTaskId: string; sessionId: string; requirementId: string; title: string
  source: 'draft' | 'accepted'; version?: number; hash: string; startLine: number; endLine: number; readAt: string; stale?: boolean
}

export interface PrototypeAdoptionView {
  id: string; source: { projectId: string; baselineId: string }; targetTaskId: string; adjustmentSummary: string
  status: 'accepted' | 'succeeded'; targetBaselineId?: string; succeededAt?: string
}

/** Fixed local author review; a confirmation does not imply backend acceptance. */
export interface PrototypeCandidateSummary {
  operationId: string; projectId: string; prototypeTaskId: string; title: string
  sourceBaseHead: string; sourceSha: string; claimsDigest: string; developmentRequirementIds: string[]
  summaryHash: string; changes: Array<{ path: string; status: 'added' | 'modified' | 'deleted' }>
  status: 'ready' | 'confirmed' | 'no-change' | 'conflict'; confirmedAt?: string; checks?: 'passed'
  conflict?: { expectedHead: string; files: string[] }
  integrationPhase?: 'fixed' | 'source-uploading' | 'source-uploaded' | 'candidate-uploading' | 'uploaded' | 'preparing' | 'prepared' | 'pushing' | 'pushed' | 'completing' | 'aborting' | 'accepted' | 'aborted' | 'unknown'
}
export interface PrototypeCandidateFile {
  path: string; baseContent?: string; sourceContent?: string; binary: boolean; truncated: boolean
}

/** Starting is an explicit user instruction; reading and selection do not dispatch it. */
export type PrototypeCollaborationCommand =
  | { action: 'startPrototypeCollaboration'; projectId: string; operationId: string; title: string; instruction: string; developmentRequirementIds: string[]; referenceRequirementIds: string[]; writeScope: string[]; attachments?: PrototypeInstructionAttachment[] }
  | { action: 'correctPrototypeRequirement'; prototypeTaskId: string; operationId: string; instruction: string }
  | { action: 'confirmPrototypeRequirement'; prototypeTaskId: string; operationId: string }
  | { action: 'readPrototypeQueue' }
  | { action: 'savePrototypeInstructionDraft'; operationId: string; draft: PrototypeInstructionDraft }
  | { action: 'selectPrototypeQueueItem'; prototypeTaskId: string; operationId: string }
  | { action: 'reorderPrototypeQueue'; operationId: string; expectedRevision: number; prototypeTaskIds: string[] }
  | { action: 'pausePrototypeQueueItem'; prototypeTaskId: string; operationId: string }
  | { action: 'resumePrototypeQueueItem'; prototypeTaskId: string; operationId: string }
  | { action: 'endPrototypeTask'; prototypeTaskId: string; operationId: string }
  | { action: 'queryPrototypeMessage'; prototypeTaskId: string }
  | { action: 'readPrototypeConversation'; prototypeTaskId: string }
  | { action: 'checkProjectPrototype'; prototypeTaskId: string; operationId: string }
  | { action: 'startProjectPrototypePreview'; prototypeTaskId: string; operationId: string }
  | { action: 'stopProjectPrototypePreview'; prototypeTaskId: string }
  | { action: 'checkPrototypeBaseline'; source: Extract<PrototypeFileSource, { kind: 'baseline' }>; operationId: string }
  | { action: 'startPrototypeBaselinePreview'; source: Extract<PrototypeFileSource, { kind: 'baseline' }>; operationId: string }
  | { action: 'stopPrototypeBaselinePreview'; baselineId: string }
  | { action: 'selectPrototypePreview'; source?: PrototypePreviewSource }
  | { action: 'adoptPrototypeBaseline'; operationId: string; source: { projectId: string; baselineId: string }; targetTaskId: string; adjustmentSummary: string }
  | { action: 'preparePrototypeConfirmation'; prototypeTaskId: string; operationId: string }
  | { action: 'readPrototypeCandidateFile'; operationId: string; path: string }
  | { action: 'checkPrototypeCandidate'; operationId: string; checkOperationId: string }
  | { action: 'confirmPrototype'; operationId: string; expectedSummaryHash: string }
  | { action: 'submitPrototypeCandidate'; operationId: string; checkOperationId: string }
