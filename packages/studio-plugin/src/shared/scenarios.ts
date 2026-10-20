import type { EntityOccupancyView, EntityView, FixedReference, MaterialMetadata, RepairTaskView } from '@eadp/contracts'
import type { MaterialDraft, TaskView } from './studio.ts'

export interface ScenarioSuggestionItem { id: string; start: number; end: number; original: string; replacement: string; evidenceIds: string[] }
export interface ScenarioSuggestionGroup { id: string; title: string; items: ScenarioSuggestionItem[] }
export interface ScenarioSuggestionBatch { id: string; entityId: string; baseHash: string; templateRef: FixedReference; groups: ScenarioSuggestionGroup[]; status: 'current' | 'stale' | 'applied' | 'invalid'; error?: string }
export interface ScenarioSource { id: string; name: string; format: string; sha256: string; status: 'reading' | 'read' | 'partial' | 'failed'; ranges: string[]; text: string; error?: string; selected: boolean; formal: boolean }
export interface ScenarioGate { id: 'business' | 'evidence' | 'version' | 'template'; label: string; status: 'passed' | 'blocked' | 'disabled'; messages: string[] }
export interface ScenarioConflict { expectedHash: string; actual: MaterialDraft; localBody: string; localMetadata: MaterialMetadata; savedPath: string }
export interface ScenarioTemplatePreview { operationId: string; expectedHead: string; expectedRevision: number; templates: Array<{ id: string; name: string; body: string }>; defaultTemplateId: string }
export interface ScenarioWorkspace {
  entityId: string; draft: MaterialDraft; readOnly: boolean;
  template: { id: string; name: string; fixed: FixedReference; body: string };
  structureCheck: boolean; gates: ScenarioGate[]; suggestions: ScenarioSuggestionBatch[]; sources: ScenarioSource[];
  sessions: TaskView[]; activeSessionId?: string; conflict?: ScenarioConflict;
  repair?: RepairTaskView & { question?: string; message?: string; sessionId?: string };
  impact?: Array<EntityView | EntityOccupancyView>; git?: { dirty: boolean; branch: string; head: string };
  confirmedBy?: number; confirmedAt?: string; splitOffered?: boolean;
}
/** UI actions are trusted Host commands; Agents only return candidate text. */
export type ScenarioCommand =
  | { action: 'openScenario'; entityId: string }
  | { action: 'scenarioRevisionImpact'; entityId: string }
  | { action: 'startScenarioRevision'; entityId: string; expectedRevision: number; expectedAssociationRevision: number }
  | { action: 'saveScenario'; entityId: string; expectedHash: string; operationId: string; body: string; metadata: MaterialMetadata }
  | { action: 'adoptScenarioSuggestions'; entityId: string; batchId: string; itemIds: string[]; expectedHash: string; operationId: string }
  | { action: 'resolveScenarioConflict'; entityId: string; expectedHash: string; operationId: string; body: string; metadata: MaterialMetadata }
  | { action: 'newScenarioSession'; entityId: string }
  | { action: 'selectScenarioSession'; entityId: string; sessionId: string }
  | { action: 'splitScenario'; entityId: string }
  | { action: 'setScenarioStructureCheck'; enabled: boolean }
  | { action: 'importScenarioSource'; entityId: string; name: string; base64: string; operationId: string }
  | { action: 'retryScenarioSource'; entityId: string; sourceId: string }
  | { action: 'selectScenarioSource'; entityId: string; sourceId: string; selected: boolean; formal: boolean }
  | { action: 'startScenarioRepair'; entityId: string; expectedHash: string; userActionId: string }
  | { action: 'resumeScenarioRepair'; entityId: string; answer: string; expectedHash: string; userActionId: string }
  | { action: 'cancelScenarioRepair'; entityId: string }
  | { action: 'previewScenarioTemplates'; templates: Array<{ id: string; name: string; body: string }>; defaultTemplateId: string }
  | { action: 'publishScenarioTemplates'; operationId: string }
