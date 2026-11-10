import type { IWorkspaces, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionReference, ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { EadpRequirementsClient, SessionRole } from '@eadp/contracts'

/**
 * The requirement path each project is currently editing. The Shell writes it only
 * after the Host accepted the native active-document hint, and renders it into the
 * knowledge slot so that view can act on the document the user is editing.
 */
export interface ActiveDocuments {
  /** Path last accepted for `projectId`; `null` when the project has no open requirement. */
  get(projectId: string): string | null
  /** Observer for any project's path; returns the unsubscribe callback. */
  subscribe(listener: () => void): () => void
  /** Drop `projectId` when the view leaves it or the project is removed. */
  forget(projectId: string): void
}

/** Narrow capabilities used by the panel; no Renderer filesystem access. */
export interface ShellFace {
  sessions: ISessions
  workspaces: IWorkspaces
  pickDirectory(): Promise<string | null>
  createDirectory(parent: string, name: string): Promise<string>
  checkDirectory(path: string): Promise<void>
  validateRelocation(path: string): Promise<void>
  assertRemovable(projectId: string): Promise<void>
  stopProject(projectId: string): Promise<void>
  requirements: EadpRequirementsClient
  activeDocuments: ActiveDocuments
  createSession(projectId: string, role: SessionRole): Promise<string>
  restoreSession(projectId: string, sessionId: string): Promise<string>
  retainSession(sessionId: string): SessionReference
}
export type { WorkspaceView }
