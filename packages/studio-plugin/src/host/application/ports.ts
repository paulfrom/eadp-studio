import type { CheckEvidence, FixedReference, MaterialMetadata, StudioIdentity, StudioUser } from '@eadp/contracts'
import type { TaskView } from '../../shared/studio.ts'
import type { ConsistencyModelInput } from '../../shared/consistency.ts'
import type { WorkspaceGit } from '../adapters/workspace/git.js'

export type SessionOutput = ({ kind: 'assistant'; content: string } | { kind: 'turn-ended'; reason: string }
  | { kind: 'source-read'; path: string; ranges: string[]; attachmentId: string }) & { seq?: number }
export interface ScenarioSourceRead { status: 'read' | 'partial' | 'failed'; ranges: string[]; text: string; error?: string }

export interface MergeConflictInput { path: string; base?: string; ours?: string; theirs?: string }
export interface MergeConflictResult { content?: string; delete?: true }

export interface HostPorts {
  workspaceRoot: string
  git: WorkspaceGit
  gitLocal(args: readonly string[], cwd: string): Promise<string>
  login(username: string, password: string): Promise<StudioIdentity>
  logout(): Promise<void>
  account(): Promise<StudioUser | undefined>
  installTemplate(destination: string): Promise<void>
  session(task: TaskView, rules: string): Promise<string>
  prompt(sessionId: string, text: string): Promise<void>
  /** One-shot DSH inference with no Agent tools, Session persistence, or Git access. */
  compareConsistency?(input: ConsistencyModelInput, signal: AbortSignal): Promise<string>
  /** One-shot short-text inference with no Agent tools, Session persistence, or Git access. */
  summarize?(input: { subject: string; facts: string }, signal: AbortSignal): Promise<string>
  /** One-shot merging of text that a remote accepted change and this task both modified. */
  mergeConflict?(input: MergeConflictInput, signal: AbortSignal): Promise<MergeConflictResult>
  cancelSession?(sessionId: string): Promise<void>
  /** Release the Agent handles owned by one task worktree; other tasks stay live. */
  releaseTask?(worktree: string): Promise<void>
  readScenarioSource?(source: { path: string; name: string }): Promise<ScenarioSourceRead>
  checks(task: TaskView, sourceSha: string): Promise<CheckEvidence>
  preview(task: TaskView): Promise<{ url: string }>
  stopPreview(): Promise<void>
  publication(action: 'publish' | 'revokePublication', baseline?: { id: string; commitSha: string }): Promise<void>
}
export function initialMetadata(entity: { id: string; kind: MaterialMetadata['kind']; title: string; templateId?: string; templateRef?: FixedReference }, scenarioIds: string[] = [], sources: Array<{ projectId: string; entityId: string; version: number }> = []): MaterialMetadata {
  const shared = { entityId: entity.id, kind: entity.kind, title: entity.title,
    scenarioIds: entity.kind === 'requirement' ? scenarioIds : [], prerequisites: [], sources: [], businessEvidence: [],
    openQuestions: [], referencedAssets: [] }
  if (entity.kind === 'scenario' || entity.kind === 'requirement') {
    if (!entity.templateId || !entity.templateRef) throw new Error(entity.kind === 'scenario' ? '场景缺少后台分配的固定模板' : '需求缺少后台分配的固定模板')
    if (entity.kind === 'scenario') return { ...shared, kind: 'scenario', templateId: entity.templateId, templateRef: entity.templateRef, flowComplete: false }
    return { ...shared, kind: 'requirement', templateId: entity.templateId, templateRef: entity.templateRef, sources, coreRulesPresent: false, acceptanceCriteriaPresent: false }
  }
  return { ...shared, kind: entity.kind, sources, coreRulesPresent: false, acceptanceCriteriaPresent: false }
}
