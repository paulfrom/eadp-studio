import type { ScenarioCommand, ScenarioSource, ScenarioTemplatePreview, ScenarioWorkspace } from './scenarios.ts'
import type { FixedReference, EntityView, MaterialMetadata, NamespaceView, ProjectState, ProjectView, StudioUser } from '@eadp/contracts'
import type { Candidate, SplitTaskBinding } from './requirements.ts'
import type { ConsistencyCommand, ConsistencyTaskView } from './consistency.ts'
import type { ConsistencyComparisonView } from '@eadp/contracts'
import type { RequirementSourceView, RequirementWorkspaceCommand } from './requirement-workspace.ts'
export type { Candidate } from './requirements.ts'

/** One project template catalog; `defaultTemplateId` is absent while a project has published no template. */
export interface TemplateCatalogView { defaultTemplateId?: string; templates: Array<{ id: string; name: string; fixed: FixedReference; body: string }> }
/** Both project template catalogs, read together from one accepted head. */
export interface ProjectTemplateCatalogs { acceptedHead: string; scenarios: TemplateCatalogView; requirements: TemplateCatalogView }

export type ConfirmationChoice = { method: 'direct' } | { method: 'ai-assisted'; reviewId: string; authorDisposition: string }
export interface ReviewView {
  id: string; entityId: string; purpose: 'material' | 'prototype'; inputHash: string;
  status: 'pending' | 'reported' | 'failed'; summary?: string;
  findings?: Array<{ severity: 'info' | 'warning' | 'blocking'; message: string }>; error?: string;
}
/** Steps a project match or initialization passes through while the Host works on the local checkout. */
export type ProjectProgressPhase = 'matching' | 'cloning' | 'initializing' | 'pushing' | 'verifying' | 'binding' | 'failed'
/** One in-flight project operation, rendered as a progress bar; `failed` keeps the bar and the reason. */
export interface ProjectProgress {
  operationId: string; projectName: string; phase: ProjectProgressPhase;
  /** 0–100 of the whole operation; it never moves backwards. */
  percent: number; label: string;
}
export interface ProjectProgressReply { operations: ProjectProgress[] }
export type Stage = 'scenarios' | 'requirements' | 'prototype' | 'baselines' | 'handoffs'
/** Main checkout synchronization after an accepted integration; `blocked` keeps the accepted business state. */
export interface ProjectSync { status: 'pending' | 'blocked' | 'synced'; commit: string; message?: string }
export interface LocalProject { id: string; name: string; directory: string; repositoryUrl: string; sync?: ProjectSync }
/** Per-task settlement: released resources, archived worktree bytes and removed Git registrations. */
export interface TaskCleanup {
  status: 'pending' | 'blocked' | 'done';
  steps: { resources: boolean; archive: boolean; worktree: boolean; branch: boolean; history: boolean };
  archive?: string; head?: string; branch?: string; message?: string;
}
export interface MaterialDraft { entityId: string; metadata: MaterialMetadata; body: string; sha256: string; path: string }
/** A confirmed material's prototype startup, independently recoverable from its confirmation. */
export interface PrototypeStartup {
  id: string; confirmationId: string; fixed: FixedReference;
  status: 'pending' | 'opening' | 'sending' | 'sent' | 'unknown' | 'blocked'; message?: string;
  task?: Pick<TaskView, 'projectId' | 'entityId' | 'sessionId' | 'purpose' | 'inputHash' | 'worktree'>;
}
export interface TaskView { projectId: string; entityId: string; sessionId: string; purpose: 'material' | 'split' | 'prototype' | 'handoff' | 'review'; scenarioRepair?: boolean; reviewId?: string; reviewSent?: boolean; inputHash: string; worktree: string; baseHead?: string; writePaths?: string[]; error?: string; cleanup?: TaskCleanup; handoff?: { baselineId: string; entityId: string; version: number; commitSha: string; status: 'pending' | 'sent' | 'failed' }; split?: SplitTaskBinding; prototypeStart?: PrototypeStartup }
/** A local recovery record the Host could not use, and where its bytes were preserved. */
export interface StudioRecovery { preservedPath: string }
export interface StudioState {
  connected: boolean; account?: StudioUser;
  /** Set once per rebuild, so the surfaces can report where the unusable record was kept. */
  recovery?: StudioRecovery;
  projects: LocalProject[]; selectedProjectId?: string; project?: ProjectView;
  availableProjects: ProjectView[]; namespaces: NamespaceView[];
  projectInitializations: Array<{ id: string; name: string; projectId?: string; phase: string; message?: string }>;
  /** Attachment projections for requirement materials; extracted text remains in the Host. */
  materialSources?: Array<{ entityId: string; readOnly: boolean; sources: ScenarioSource[] }>;
  scenario?: ScenarioWorkspace; templatePreview?: ScenarioTemplatePreview; collaboration?: ProjectState; projectTemplates?: ProjectTemplateCatalogs; reviews: ReviewView[]; drafts: MaterialDraft[];
  requirement?: ScenarioWorkspace;
  consistencyTasks?: ConsistencyTaskView[]; consistencyLatest?: ConsistencyComparisonView[];
  /** Bodies of accepted materials that predate the current contract: displayable, never editable. */
  legacyMaterials?: Array<{ entityId: string; body: string }>; tasks: TaskView[]; candidates: Candidate[];
  preview?: { entityId: string; url: string }; pending: Array<{ id: string; entityId: string; phase: string; message?: string }>;
}
export type StudioCommand = ScenarioCommand | ConsistencyCommand | RequirementWorkspaceCommand
  | { action: 'state' }
  | { action: 'namespaces' }
  | { action: 'login'; username: string; password: string }
  | { action: 'logout' }
  | { action: 'createProject'; name: string; namespaceId: number; path: string }
  | { action: 'openProject'; projectId: string }
  | { action: 'retryProjectInitialization'; operationId: string }
  | { action: 'bindScenarioTemplate'; entityId: string; templateId: string }
  | { action: 'splitRequirements'; scenarioIds: string[] }
  | { action: 'createMaterial'; operationId: string; kind: 'scenario' | 'requirement' | 'handoff'; title: string; scenarioIds?: string[] }
  | { action: 'saveMaterial'; entityId: string; body: string; metadata: MaterialMetadata }
  | { action: 'startSession'; entityId: string; purpose: 'material' | 'prototype' | 'handoff' }
  | { action: 'restoreSession'; sessionId: string }
  | ({ action: 'confirmMaterial'; entityId: string; expectedHash: string } & ConfirmationChoice)
  | ({ action: 'confirmRequirement'; entityId: string; expectedHash: string; operationId: string; body: string; metadata: MaterialMetadata } & ConfirmationChoice)
  | { action: 'requestReview'; entityId: string; purpose: 'material' | 'prototype' }
  | ({ action: 'confirmPrototype'; entityId: string } & ConfirmationChoice)
  | { action: 'selectCandidate'; candidateId: string; expectedInputHash: string }
  | { action: 'claimPrototype' | 'checkPrototype' | 'startPreview' | 'stopPreview' | 'releaseOccupation'; entityId: string }
  | { action: 'setEligibility'; entityId: string; version: number; enabled: boolean; reason: string }
  | { action: 'adopt'; sourceProjectId: string; sourceEntityId: string; version: number; targetEntityId: string; reason: string }
  | { action: 'retryOperation'; operationId: string }
  | { action: 'syncMainCheckout'; projectId: string }
  | { action: 'retryTaskSettlement'; projectId: string; worktree: string }
  | { action: 'generateHandoff'; baselineId: string }
  | { action: 'acknowledgeHandoff'; entityId: string; note: string }
  | { action: 'publish' | 'revokePublication' }
export type StudioReply = { ok: true; state: StudioState; sessionId?: string; comparisons?: ConsistencyComparisonView[]; requirementSource?: RequirementSourceView } | { ok: false; message: string; code: string }
export type { EntityView, MaterialMetadata }

export type * from './scenarios.ts'
