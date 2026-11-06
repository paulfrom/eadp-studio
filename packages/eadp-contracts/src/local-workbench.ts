/** Project identity is owned by the native DSH Workspace registry. */
export type ProjectId = string
export type SessionRole = 'requirements' | 'prototype'
export const EADP_SLOTS = { requirements: 'eadp.requirements.view', prototype: 'eadp.prototype.view', knowledge: 'eadp.knowledge.view' } as const
export interface EadpRequirementsSlotProps { projectId: ProjectId; active: boolean }
export interface EadpPrototypeSlotProps { projectId: ProjectId; active: boolean }
export interface EadpKnowledgeSlotProps { active: boolean }
/** Coordinates unsaved editor input before navigation within the workbench. */
export interface EadpRequirementsClient {
  flushActive(): Promise<{ ok: boolean; message?: string }>
  hasUnsaved(): boolean
}
export const EADP_ERRORS = { projectNotFound: 'PROJECT_NOT_FOUND', invalidPath: 'INVALID_PATH', outsideProject: 'OUTSIDE_PROJECT', staleVersion: 'STALE_VERSION', unavailable: 'UNAVAILABLE' } as const

/** Updates only the document hint used by native session context. */
export interface EadpShellClient {
  setActiveDocument(projectId: ProjectId, relativePath: string | null): Promise<void>
}
