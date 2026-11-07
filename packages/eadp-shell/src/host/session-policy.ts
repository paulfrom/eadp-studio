import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { ActiveDocuments } from './active-document.ts'

/** Supplies the project and active requirement context to native sessions. */
export class SessionPolicies {
  private readonly installed = new WeakSet<Agent>()
  constructor(private readonly ctx: Context, private readonly documents: ActiveDocuments) {}

  async install(agent: Agent): Promise<void> {
    if (this.installed.has(agent)) return
    this.installed.add(agent)
    let projectId: WorkspaceId | undefined
    let root: string | undefined
    const preset = agent.session.header.agentPreset
    this.ctx.effect(() => agent.ctx.systemPrompt.context({
      name: 'eadp:project', order: 100, interpolate: false,
      text: () => {
        if (!projectId || !this.ctx.workspaceRegistry.get(projectId)) return '当前会话未绑定有效本地项目。'
        const active = this.documents.get(projectId)
        return `本地项目目录：${root}。当前需求：${active ?? '未选择；可列出项目需求'}。\n`
          + (preset === 'eadp-prototype'
            ? '先读取原型/AGENT.md及实际依赖的 API 声明。'
            : '需求修改先生成提案，由用户审阅后应用。')
      },
    }))
    const cwd = agent.session.header.cwd
    const workspace = cwd ? await this.ctx.workspaceRegistry.resolveByPath(cwd).catch(() => undefined) : undefined
    projectId = workspace?.id
    root = workspace?.path
  }
}
