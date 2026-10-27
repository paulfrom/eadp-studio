/** A bounded view of files belonging to one locally registered prototype task. */
export type PrototypeFileResult =
  | { kind: 'directory'; projectId: string; prototypeTaskId: string; observation: string; entries: Array<{ path: string; name: string; kind: 'file' | 'directory'; readOnly: boolean }>; truncated: boolean; nextCursor?: string }
  | { kind: 'search'; projectId: string; prototypeTaskId: string; observation: string; matches: Array<{ path: string; line: number; column: number; excerpt: string; hash: string }>; truncated: boolean; nextCursor?: string }
  | { kind: 'diff'; projectId: string; prototypeTaskId: string; observation: string; baseSha: string; files: Array<{ path: string; status: 'added' | 'modified' | 'deleted'; baseHash?: string; currentHash?: string; baseContent?: string; currentContent?: string; binary: boolean; truncated: boolean }>; truncated: boolean; nextCursor?: string }
  | { kind: 'file'; projectId: string; prototypeTaskId: string; observation: string; path: string; hash: string; size: number; readOnly: boolean; content?: string; binary: boolean; truncated: boolean }
  | { kind: 'saved'; projectId: string; prototypeTaskId: string; path: string; hash: string }

/** Unsaved editor contents retain the disk hash and text they were based on. */
export interface PrototypeEditBuffer { prototypeTaskId: string; path: string; baseHash: string; baseContent: string; content: string }

/** File paths are relative to the task workspace resolved by the Host. */
export type PrototypeFileCommand =
  | { action: 'listPrototypeDirectory'; prototypeTaskId: string; directory?: string; cursor?: string; limit?: number }
  | { action: 'searchPrototypeFiles'; prototypeTaskId: string; query: string; directory?: string; cursor?: string; limit?: number }
  | { action: 'readPrototypeFile'; prototypeTaskId: string; path: string }
  | { action: 'readPrototypeDiff'; prototypeTaskId: string; cursor?: string; limit?: number }
  | { action: 'savePrototypeFile'; prototypeTaskId: string; operationId: string; path: string; expectedHash: string; content: string }
  | { action: 'readPrototypeBuffer'; prototypeTaskId: string; path: string }
  | { action: 'savePrototypeBuffer'; operationId: string; buffer: PrototypeEditBuffer }
  | { action: 'clearPrototypeBuffer'; prototypeTaskId: string; path: string; expectedContent: string }

/** Local scheduling is separate from the server's task and claim state. */
export interface PrototypeQueueItem {
  projectId: string; prototypeTaskId: string; title: string; sessionId?: string;
  localDispatchState: 'queued' | 'running' | 'awaiting-user' | 'paused' | 'recovery-required';
  nextAction?: string; developmentRequirementIds: string[];
}
export interface PrototypeQueueView { revision: number; selectedTaskId?: string; items: PrototypeQueueItem[] }
/** Unsent project instruction, stored independently of any collaboration task. */
export interface PrototypeInstructionDraft { projectId: string; prototypeTaskId?: string; title: string; instruction: string; developmentRequirementIds: string[] }
/** Text returned by the native session log; no messages are inferred from task state. */
export interface PrototypeConversationMessage { sequence: number; role: 'user' | 'assistant'; text: string; interrupted?: boolean }

/** Starting is an explicit user instruction; reading and selection do not dispatch it. */
export type PrototypeCollaborationCommand =
  | { action: 'startPrototypeCollaboration'; projectId: string; operationId: string; title: string; instruction: string; developmentRequirementIds: string[]; referenceRequirementIds: string[]; writeScope: string[] }
  | { action: 'continuePrototypeCollaboration'; prototypeTaskId: string; operationId: string; instruction: string }
  | { action: 'extendPrototypeDevelopment'; prototypeTaskId: string; operationId: string; instruction: string; developmentRequirementIds: string[]; writeScope: string[] }
  | { action: 'readPrototypeQueue' }
  | { action: 'savePrototypeInstructionDraft'; operationId: string; draft: PrototypeInstructionDraft }
  | { action: 'selectPrototypeQueueItem'; prototypeTaskId: string; operationId: string }
  | { action: 'resumePrototypeQueueItem'; prototypeTaskId: string; operationId: string }
  | { action: 'queryPrototypeMessage'; prototypeTaskId: string }
  | { action: 'readPrototypeConversation'; prototypeTaskId: string }
  | { action: 'checkProjectPrototype'; prototypeTaskId: string; operationId: string }
  | { action: 'startProjectPrototypePreview'; prototypeTaskId: string; operationId: string }
  | { action: 'stopProjectPrototypePreview'; prototypeTaskId: string }
