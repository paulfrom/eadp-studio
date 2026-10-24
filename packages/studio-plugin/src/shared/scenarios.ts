import type { EntityOccupancyView, EntityView, FixedReference, MaterialMetadata, RepairTaskView } from '@eadp/contracts'
import type { MaterialDraft, TaskView } from './studio.ts'
import type { RequirementSaveView } from './requirement-workspace.ts'

export interface ScenarioSource { id: string; name: string; format: string; sha256: string; status: 'reading' | 'read' | 'partial' | 'failed'; ranges: string[]; text: string; error?: string; selected: boolean; formal: boolean }
export interface ScenarioGate { id: 'business' | 'evidence' | 'version' | 'template'; label: string; status: 'passed' | 'blocked' | 'disabled'; messages: string[] }
export interface ScenarioConflict { expectedHash: string; actual: MaterialDraft; localBody: string; localMetadata: MaterialMetadata; savedPath: string }
/** Host-created proposal; the model may only supply conclusions, evidence IDs and the full body. */
export interface ScenarioWriteProposal {
  id: string; entityId: string; baseHash: string; templateRef: FixedReference; contextHash: string;
  evidenceIds: string[]; conclusions: Array<{ id: string; text: string }>; body: string; createdAt: string;
  /** Absent targets the scenario body; `context` targets only the project-root CONTEXT.md. */
  target?: 'context';
  status: 'pending' | 'consumed' | 'rejected'; operationId?: string; error?: string;
}
/** What the chat card needs: no body, no hashes, no authorization fields. */
export interface ScenarioWriteProposalView { id: string; baseHash: string; createdAt: string; conclusions: string[]; evidenceCount: number; target?: 'context'; status: ScenarioWriteProposal['status']; error?: string }
/** Chapters, evidence and remaining business answers reported after one whole-body write. */
export interface ScenarioWriteSummary { added: string[]; removed: string[]; changed: string[]; evidence: string[]; unanswered: string[] }
/** The latest whole-body write, kept locally so undo can restore its exact previous body. */
export interface ScenarioWriteReceipt {
  operationId: string; createdAt: string; beforeBody: string; beforeHash: string; afterHash: string; summary: ScenarioWriteSummary;
  undone?: boolean;
}
export interface ScenarioWriteReceiptView { operationId: string; createdAt: string; afterHash: string; summary: ScenarioWriteSummary; canUndo: boolean; undone?: boolean }
/** User-facing settlement stage for the current local or accepted scenario. */
export interface ScenarioSettlementView {
  status: 'draft' | 'sync-pending' | 'cleanup-pending' | 'settled';
  sync?: { status: 'pending' | 'blocked' | 'synced'; message?: string };
  cleanup?: TaskView['cleanup'];
}
/** The material catalog one explicit project-template publication changes. */
export type MaterialTemplateKind = 'scenario' | 'requirement'
export interface ScenarioTemplatePreview { kind: MaterialTemplateKind; operationId: string; expectedHead: string; expectedRevision: number; templates: Array<{ id: string; name: string; body: string }>; defaultTemplateId: string }
export interface ScenarioWorkspace {
  entityId: string; draft: MaterialDraft; readOnly: boolean;
  template: { id: string; name: string; fixed: FixedReference; body: string };
  structureCheck: boolean; gates: ScenarioGate[]; sources: ScenarioSource[];
  writeProposal?: ScenarioWriteProposalView;
  writeReceipt?: ScenarioWriteReceiptView;
  requirementSave?: RequirementSaveView;
  /** A confirmation keeps its user intent while the author resolves an exception. */
  confirmationRecovery?: { operationId: string; message: string; expectedHash?: string };
  settlement: ScenarioSettlementView;
  sessions: TaskView[]; activeSessionId?: string; conflict?: ScenarioConflict;
  repair?: RepairTaskView & { question?: string; message?: string; sessionId?: string };
  impact?: Array<EntityView | EntityOccupancyView>; git?: { dirty: boolean; branch: string; head: string };
  confirmedBy?: number; confirmedAt?: string; splitOffered?: boolean;
}
/** UI actions are trusted Host commands; Agents only return candidate text. */
export type ScenarioCommand =
  | { action: 'openScenario'; entityId: string }
  | { action: 'scenarioRevisionImpact'; entityId: string }
  | { action: 'startScenarioRevision'; entityId: string; expectedRevision: number }
  | { action: 'saveScenario'; entityId: string; expectedHash: string; operationId: string; body: string; metadata: MaterialMetadata }
  | { action: 'resolveScenarioWriteProposal'; entityId: string; proposalId: string; decision: 'write' | 'reject'; expectedHash: string }
  | { action: 'undoScenarioWrite'; entityId: string; operationId: string; expectedHash: string }
  | { action: 'resolveScenarioConflict'; entityId: string; expectedHash: string; operationId: string; body: string; metadata: MaterialMetadata }
  | { action: 'newScenarioSession'; entityId: string }
  | { action: 'selectScenarioSession'; entityId: string; sessionId: string }
  | { action: 'splitScenario'; entityId: string }
  | { action: 'setScenarioStructureCheck'; enabled: boolean }
  /** Attachment actions serve scenario and requirement materials through one Host service. */
  | { action: 'importScenarioSource'; entityId: string; name: string; base64: string; operationId: string }
  | { action: 'retryScenarioSource'; entityId: string; sourceId: string }
  | { action: 'selectScenarioSource'; entityId: string; sourceId: string; selected: boolean; formal: boolean }
  | { action: 'startScenarioRepair'; entityId: string; expectedHash: string; userActionId: string }
  | { action: 'resumeScenarioRepair'; entityId: string; answer: string; expectedHash: string; userActionId: string }
  | { action: 'cancelScenarioRepair'; entityId: string }
  | { action: 'previewMaterialTemplates'; kind: MaterialTemplateKind; templates: Array<{ id: string; name: string; body: string }>; defaultTemplateId: string }
  | { action: 'publishMaterialTemplates'; operationId: string }
