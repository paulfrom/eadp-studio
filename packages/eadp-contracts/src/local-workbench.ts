/** Project identity is owned by the native DSH Workspace registry. */
export type ProjectId = string
export type SessionRole = 'requirements' | 'prototype'
export const EADP_SLOTS = { requirements: 'eadp.requirements.view', prototype: 'eadp.prototype.view', knowledge: 'eadp.knowledge.view' } as const
export interface EadpRequirementsSlotProps { projectId: ProjectId; active: boolean; /** 当前需求会话；没有会话时为 null。 */ sessionId: string | null }
export interface EadpPrototypeSlotProps { projectId: ProjectId; active: boolean }
export interface EadpKnowledgeSlotProps { active: boolean }
/** Coordinates unsaved editor input of one project before navigation leaves it. */
export interface EadpRequirementsClient {
  /** Save pending input of `projectId`; another project's draft never blocks this navigation. */
  flushActive(projectId: ProjectId): Promise<{ ok: boolean; message?: string }>
  /** Whether `projectId` still holds input or a conflict that navigation must not drop. */
  hasUnsaved(projectId: ProjectId): boolean
}
export const EADP_ERRORS = { projectNotFound: 'PROJECT_NOT_FOUND', invalidPath: 'INVALID_PATH', outsideProject: 'OUTSIDE_PROJECT', staleVersion: 'STALE_VERSION', unavailable: 'UNAVAILABLE' } as const

/** Updates only the document hint used by native session context. */
export interface EadpShellClient {
  setActiveDocument(projectId: ProjectId, relativePath: string | null): Promise<void>
}

/** 需求会话可用的只读项目上下文；由 Shell 提供，知识插件在自动参考时消费。 */
export interface ProjectContext {
  projectId: ProjectId
  projectRoot: string
  /** 当前正在编辑的需求 Markdown 相对路径；未在需求文件上时为 null。 */
  requirementPath: string | null
  /** 当前需求标题；未在需求文件上时为 null。 */
  requirementTitle: string | null
}

/** Shell 暴露的只读项目上下文服务，不提供任何写入或文件接口。 */
export interface ProjectContextService {
  /** 按原生会话返回项目与当前需求；会话不属于受管项目或目录不可用时为 null。 */
  forSession(sessionId: string): Promise<ProjectContext | null>
}
