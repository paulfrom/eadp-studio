import type { IWorkspaces, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { EadpRequirementsClient, SessionRole } from '@eadp/contracts'

/** Narrow capabilities used by the panel; no Renderer filesystem access. */
export interface ShellFace {
  workspaces: IWorkspaces
  pickDirectory(): Promise<string | null>
  createDirectory(parent: string, name: string): Promise<string>
  checkDirectory(path: string): Promise<void>
  validateRelocation(path: string): Promise<void>
  assertRemovable(projectId: string): Promise<void>
  requirements: EadpRequirementsClient
  createSession(projectId: string, role: SessionRole): Promise<string>
  restoreSession(projectId: string, sessionId: string): Promise<string>
  retainSession(sessionId: string): SessionReference
}
export type { WorkspaceView }
