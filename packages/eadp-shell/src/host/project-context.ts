import { realpath } from 'node:fs/promises'
import path from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-workspace'
import type { ProjectContext, ProjectContextService } from '@eadp/contracts'
import type { ActiveDocuments } from './active-document.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Shell 提供的只读项目上下文：当前会话对应的项目与正在编辑的需求。 */
    eadpProjectContext: ProjectContextService
  }
}

/** 需求文件标题取文件名；项目背景文件固定显示为“项目背景”。 */
const titleOf = (relativePath: string): string =>
  relativePath === 'CONTEXT.md' ? '项目背景' : path.posix.basename(relativePath, '.md')

/**
 * 把当前会话解析为项目与当前需求，供知识插件在自动参考时使用。
 * 只读取 Workspace 登记与 Shell 自己的活动文档提示，不暴露写入或文件接口。
 */
export class ProjectContexts extends Service implements ProjectContextService {
  static inject = ['workspaceRegistry', 'sessionController']

  constructor(ctx: Context, private readonly documents: ActiveDocuments) {
    super(ctx, 'eadpProjectContext')
  }

  async forSession(sessionId: string): Promise<ProjectContext | null> {
    const inspected = await this.ctx.sessionController.inspect(SessionId(sessionId))
    const cwd = inspected.meta.cwd
    if (cwd === undefined) return null
    const workspace = await this.ctx.workspaceRegistry.resolveByPath(cwd)
    if (!workspace || await realpath(cwd) !== workspace.path) return null
    const requirementPath = this.documents.get(workspace.id) ?? null
    return {
      projectId: workspace.id,
      projectRoot: workspace.path,
      requirementPath,
      requirementTitle: requirementPath === null ? null : titleOf(requirementPath),
    }
  }
}
