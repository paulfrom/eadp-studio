import type { CheckEvidence, FixedReference, MaterialMetadata, PrototypeEngineeringEvidence, StudioIdentity, StudioUser } from '@eadp/contracts'
import type { TaskView } from '../../shared/studio.ts'
import type { ConsistencyModelInput } from '../../shared/consistency.ts'
import type { WorkspaceGit } from '../adapters/workspace/git.ts'
import type { PrototypeCheckReport, PrototypeInstructionAttachment, PrototypePreviewIdentity } from '../../shared/prototype.ts'
import type { RequirementIdentity } from '../adapters/dsh/prototype-requirements.ts'

export type SessionOutput = ({ kind: 'assistant'; content: string } | { kind: 'turn-ended'; reason: string }
  | { kind: 'source-read'; path: string; ranges: string[]; attachmentId: string }) & { seq?: number }
export interface ScenarioSourceRead { status: 'read' | 'partial' | 'failed'; ranges: string[]; text: string; error?: string }

export interface MergeConflictInput { path: string; base?: string; ours?: string; theirs?: string }
export interface MergeConflictResult { content?: string; delete?: true }

export interface HostPorts {
  workspaceRoot: string
  prototypeManifestPath?: string
  git: WorkspaceGit
  gitLocal(args: readonly string[], cwd: string): Promise<string>
  login(username: string, password: string): Promise<StudioIdentity>
  logout(): Promise<void>
  account(): Promise<StudioUser | undefined>
  installTemplate(destination: string): Promise<void>
  session(task: TaskView, rules: string, requireExisting?: boolean): Promise<string>
  prompt(sessionId: string, text: string, operationId?: string, attachments?: PrototypeInstructionAttachment[]): Promise<void>
  inspectPrompt(sessionId: string, operationId: string): Promise<'delivered' | 'admitted' | 'absent' | 'unknown'>
  /** Last durable native turn is an observation, never a request to resume model work. */
  lastPrototypeTurn?(sessionId: string): Promise<Extract<SessionOutput, { kind: 'turn-ended' }> | undefined>
  readPrototypeConversation(sessionId: string): Promise<import('../../shared/prototype.ts').PrototypeConversationMessage[]>
  /** Read-only one-shot identification; its result is checked against the original instruction and project directory. */
  identifyPrototypeRequirements?(input: { instruction: string; requirements: RequirementIdentity[]; existingIds: string[]; explicitIds: string[] }, signal: AbortSignal): Promise<string>
  /** One-shot DSH inference with no Agent tools, Session persistence, or Git access. */
  compareConsistency?(input: ConsistencyModelInput, signal: AbortSignal): Promise<string>
  /** One-shot short-text inference with no Agent tools, Session persistence, or Git access. */
  summarize?(input: { subject: string; facts: string }, signal: AbortSignal): Promise<string>
  /** One-shot merging of text that a remote accepted change and this task both modified. */
  mergeConflict?(input: MergeConflictInput, signal: AbortSignal): Promise<MergeConflictResult>
  cancelSession?(sessionId: string): Promise<void>
  /** Observe whole-agent quiescence and flush the native session before releasing the local execution slot. */
  settlePrototypeSession(sessionId: string, cancel: boolean): Promise<boolean>
  /** Release the Agent handles owned by one task worktree; other tasks stay live. */
  releaseTask?(worktree: string): Promise<void>
  readScenarioSource?(source: { path: string; name: string }): Promise<ScenarioSourceRead>
  checks(task: TaskView, sourceSha: string, operationId?: string): Promise<CheckEvidence>
  candidateChecks(task: TaskView, sourceSha: string, operationId: string): Promise<PrototypeEngineeringEvidence>
  prototypeCheckReports?(tasks: Array<{ projectId: string; prototypeTaskId: string }>): Promise<PrototypeCheckReport[]>
  preview(task: TaskView, operationId: string): Promise<{ url: string; identity: PrototypePreviewIdentity }>
  selectPreview(identity?: PrototypePreviewIdentity): Promise<void>
  stopPreview(sessionId?: string): Promise<void>
  publication(action: 'publish' | 'revokePublication'): Promise<void>
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
