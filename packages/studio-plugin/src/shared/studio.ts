import type { ScenarioCommand, ScenarioTemplatePreview, ScenarioWorkspace } from './scenarios.ts'
import type { FixedReference, EntityView, MaterialMetadata, NamespaceView, ProjectState, ProjectView, StudioUser } from '@eadp/contracts'

/** A project template catalog; `defaultTemplateId` is absent while a project has published no template. */
export interface ScenarioTemplateCatalog { acceptedHead: string; defaultTemplateId?: string; templates: Array<{ id: string; name: string; fixed: FixedReference; body: string }> }

export type ConfirmationChoice = { method: 'direct' } | { method: 'ai-assisted'; reviewId: string; authorDisposition: string }
export interface ReviewView {
  id: string; entityId: string; purpose: 'material' | 'prototype'; candidateSha: string; inputHash: string;
  status: 'pending' | 'reported' | 'failed'; summary?: string;
  findings?: Array<{ severity: 'info' | 'warning' | 'blocking'; message: string }>; error?: string;
}
export type Stage = 'scenarios' | 'requirements' | 'prototype' | 'baselines' | 'handoffs'
export interface LocalProject { id: string; name: string; directory: string; repositoryUrl: string }
export interface MaterialDraft { entityId: string; metadata: MaterialMetadata; body: string; sha256: string; path: string }
export interface TaskView { projectId: string; entityId: string; sessionId: string; purpose: 'material' | 'split' | 'prototype' | 'handoff' | 'review'; scenarioRepair?: boolean; reviewId?: string; reviewSent?: boolean; inputHash: string; worktree: string; error?: string; handoff?: { baselineId: string; entityId: string; version: number; commitSha: string; status: 'pending' | 'sent' | 'failed' }; split?: { integrationId: string; confirmationId: string; version: number; fixed: FixedReference; status: 'pending' | 'sent' | 'failed' | 'completed' } }
export interface Candidate { id: string; projectId: string; scenarioId: string; sessionId: string; integrationId: string; confirmationId: string; version: number; inputHash: string; title: string; summary: string; selectedEntityId?: string }
/** A local recovery record the Host could not use, and where its bytes were preserved. */
export interface StudioRecovery { preservedPath: string }
export interface StudioState {
  connected: boolean; account?: StudioUser;
  /** Set once per rebuild, so the surfaces can report where the unusable record was kept. */
  recovery?: StudioRecovery;
  projects: LocalProject[]; selectedProjectId?: string; project?: ProjectView;
  availableProjects: ProjectView[]; namespaces: NamespaceView[];
  projectInitializations: Array<{ id: string; name: string; projectId?: string; phase: string; message?: string }>;
  scenario?: ScenarioWorkspace; templatePreview?: ScenarioTemplatePreview; collaboration?: ProjectState; scenarioTemplates?: ScenarioTemplateCatalog; reviews: ReviewView[]; drafts: MaterialDraft[];
  /** Bodies of accepted materials that predate the current contract: displayable, never editable. */
  legacyMaterials?: Array<{ entityId: string; body: string }>; tasks: TaskView[]; candidates: Candidate[];
  preview?: { entityId: string; url: string }; pending: Array<{ id: string; entityId: string; phase: string; message?: string }>;
}
export type StudioCommand = ScenarioCommand
  | { action: 'state' }
  | { action: 'namespaces' }
  | { action: 'login'; username: string; password: string }
  | { action: 'logout' }
  | { action: 'createProject'; name: string; namespaceId: number; path: string }
  | { action: 'openProject'; projectId: string }
  | { action: 'retryProjectInitialization'; operationId: string }
  | { action: 'selectProject'; projectId: string }
  | { action: 'addCategory'; name: string }
  | { action: 'bindScenarioTemplate'; entityId: string; templateId: string }
  | { action: 'createMaterial'; operationId: string; kind: 'scenario' | 'requirement' | 'handoff'; title: string; categoryId?: string; scenarioIds?: string[] }
  | { action: 'saveMaterial'; entityId: string; body: string; metadata: MaterialMetadata }
  | { action: 'startSession'; entityId: string; purpose: 'material' | 'prototype' | 'handoff' }
  | { action: 'restoreSession'; sessionId: string }
  | ({ action: 'confirmMaterial'; entityId: string; expectedHash: string } & ConfirmationChoice)
  | { action: 'requestReview'; entityId: string; purpose: 'material' | 'prototype' }
  | ({ action: 'confirmPrototype'; entityId: string } & ConfirmationChoice)
  | { action: 'selectCandidate'; candidateId: string; categoryId: string }
  | { action: 'claimPrototype' | 'checkPrototype' | 'startPreview' | 'stopPreview' | 'releaseOccupation'; entityId: string }
  | { action: 'setEligibility'; entityId: string; version: number; enabled: boolean; reason: string }
  | { action: 'adopt'; sourceProjectId: string; sourceEntityId: string; version: number; targetEntityId: string; reason: string }
  | { action: 'retryOperation'; operationId: string }
  | { action: 'generateHandoff'; baselineId: string }
  | { action: 'acknowledgeHandoff'; entityId: string; note: string }
  | { action: 'publish' | 'revokePublication' }
export type StudioReply = { ok: true; state: StudioState; sessionId?: string } | { ok: false; message: string; code: string }
export type { EntityView, MaterialMetadata }

export type * from './scenarios.ts'
