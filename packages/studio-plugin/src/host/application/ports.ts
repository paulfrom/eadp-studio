import type { CheckEvidence, MaterialMetadata, StudioIdentity, StudioUser } from '@eadp/contracts'
import type { TaskView } from '../../shared/studio.ts'
import type { WorkspaceGit } from '../adapters/workspace/git.js'

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
  checks(task: TaskView, sourceSha: string): Promise<CheckEvidence>
  preview(task: TaskView): Promise<{ url: string }>
  stopPreview(): Promise<void>
  publication(action: 'publish' | 'revokePublication', baseline?: { id: string; commitSha: string }): Promise<void>
}
export function initialMetadata(entity: { id: string; kind: MaterialMetadata['kind']; title: string; categoryId: string }, scenarioId?: string): MaterialMetadata {
  return { entityId: entity.id, kind: entity.kind, title: entity.title, categoryId: entity.categoryId,
    scenarioIds: scenarioId ? [scenarioId] : [], prerequisites: [], sources: [], businessEvidence: [],
    coreRulesPresent: false, acceptanceCriteriaPresent: false, openQuestions: [], referencedAssets: [] }
}
