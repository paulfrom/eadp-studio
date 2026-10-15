import type { EntityView, MaterialMetadata, NamespaceView, ProjectState, ProjectView, StudioUser } from '@eadp/contracts'

export type Stage = 'scenarios' | 'requirements' | 'prototype' | 'baselines' | 'handoffs'
export interface LocalProject { id: string; name: string; directory: string; repositoryUrl: string }
export interface MaterialDraft { entityId: string; metadata: MaterialMetadata; body: string; sha256: string; path: string }
export interface TaskView { projectId: string; entityId: string; sessionId: string; purpose: 'material' | 'split' | 'prototype' | 'handoff'; inputHash: string; worktree: string; error?: string }
export interface Candidate { id: string; scenarioId: string; title: string; summary: string; selectedEntityId?: string }
export interface StudioState {
  connected: boolean; account?: StudioUser;
  projects: LocalProject[]; selectedProjectId?: string; project?: ProjectView;
  availableProjects: ProjectView[]; namespaces: NamespaceView[];
  projectInitializations: Array<{ id: string; name: string; projectId?: string; phase: string; message?: string }>;
  collaboration?: ProjectState; drafts: MaterialDraft[]; tasks: TaskView[]; candidates: Candidate[];
  preview?: { entityId: string; url: string }; pending: Array<{ id: string; entityId: string; phase: string; message?: string }>;
}
export type StudioCommand =
  | { action: 'state' }
  | { action: 'login'; username: string; password: string }
  | { action: 'logout' }
  | { action: 'createProject'; name: string; namespaceId: number; path: string }
  | { action: 'openProject'; projectId: string }
  | { action: 'retryProjectInitialization'; operationId: string }
  | { action: 'selectProject'; projectId: string }
  | { action: 'addCategory'; name: string }
  | { action: 'createMaterial'; kind: 'scenario' | 'requirement' | 'handoff'; title: string; categoryId: string; scenarioId?: string }
  | { action: 'saveMaterial'; entityId: string; body: string; metadata: MaterialMetadata }
  | { action: 'startSession'; entityId: string; purpose: TaskView['purpose'] }
  | { action: 'confirmMaterial'; entityId: string; expectedHash: string; method: 'direct' | 'ai-assisted' }
  | { action: 'selectCandidate'; candidateId: string; categoryId: string }
  | { action: 'claimPrototype' | 'checkPrototype' | 'startPreview' | 'stopPreview' | 'confirmPrototype' | 'releaseOccupation'; entityId: string }
  | { action: 'setEligibility'; entityId: string; version: number; enabled: boolean; reason: string }
  | { action: 'adopt'; sourceProjectId: string; sourceEntityId: string; version: number; targetEntityId: string; reason: string }
  | { action: 'retryOperation'; operationId: string }
  | { action: 'generateHandoff'; baselineId: string }
  | { action: 'acknowledgeHandoff'; entityId: string; note: string }
  | { action: 'publish' | 'revokePublication' }
export type StudioReply = { ok: true; state: StudioState; sessionId?: string } | { ok: false; message: string; code: string }
export type { EntityView, MaterialMetadata }
