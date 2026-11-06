import { realpathSync } from 'node:fs'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { ActiveDocuments } from './active-document.ts'

const CONTROL_TOOLS = new Set(['ask_user_question', 'todo_write'])
const READ_TOOLS = new Set(['read', 'read_image'])

/** Installs scoped policy before native creation/resume listeners release queued work. */
export class SessionPolicies {
  private readonly installed = new WeakSet<Agent>()

  constructor(private readonly ctx: Context, private readonly documents: ActiveDocuments) {}

  async install(agent: Agent): Promise<void> {
    if (this.installed.has(agent)) return
    this.installed.add(agent)
    let projectId: WorkspaceId | undefined
    let root: string | undefined
    const preset = agent.session.header.agentPreset
    // Install denial before the first await, including when this plugin joins live Agents.
    this.ctx.effect(() => agent.ctx.tools.guard(execution => this.guard(agent, projectId, root, execution)))
    this.ctx.effect(() => agent.ctx.systemPrompt.context({
      name: 'eadp:project', order: 100, interpolate: false,
      text: () => {
        if (!projectId || !this.ctx.workspaceRegistry.get(projectId)) return '当前会话未绑定有效本地项目，不能使用文件工具。'
        const active = this.documents.get(projectId)
        return `本地项目：${projectId}。当前需求：${active ?? '未选择；可列出项目需求'}。\n`
          + (preset === 'eadp-prototype' ? '原型代码位于原型/。安装与运行由用户在工作台操作。' : '需求修改必须先生成提案，由用户审阅后应用。')
      },
    }))
    const cwd = agent.session.header.cwd
    const workspace = cwd ? await this.ctx.workspaceRegistry.resolveByPath(cwd).catch(() => undefined) : undefined
    projectId = workspace?.id
    root = workspace?.path
  }

  private guard(agent: Agent, projectId: WorkspaceId | undefined, root: string | undefined, execution: Readonly<ToolExecution>): string | undefined {
    if (execution.agent !== agent) return '工具调用与当前会话身份不一致。'
    if (CONTROL_TOOLS.has(execution.name)) return undefined
    if (!projectId || !root || this.ctx.workspaceRegistry.get(projectId)?.path !== root) return '会话未绑定有效项目，不能操作文件。'
    if (!READ_TOOLS.has(execution.name)) return '当前会话不允许该工具；文件修改与运行请使用工作台对应操作。'
    const args = execution.arguments
    if (args === null || typeof args !== 'object' || !('file_path' in args) || typeof args.file_path !== 'string') return '文件工具缺少有效路径。'
    try {
      const cwd = agent.session.header.cwd
      if (!cwd || realpathSync.native(cwd) !== root) return '会话目录与项目登记不一致。'
      const raw = args.file_path
      if (!raw || raw.includes('\0')) return '文件路径无效。'
      const target = realpathSync.native(path.resolve(root, raw))
      const relative = path.relative(root, target)
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return '文件路径超出当前项目。'
      const parts = relative.split(path.sep)
      if (parts.some(sensitive)) return '不能读取敏感文件或受保护目录。'
    } catch { return '文件路径不可访问，或其真实目录已变化。' }
    return undefined
  }
}

function sensitive(name: string): boolean {
  const lower = name.toLowerCase()
  return lower === '.git' || lower === 'node_modules' || lower === 'dist' || lower.startsWith('.umi')
    || (lower.startsWith('.env') && lower !== '.env.example') || /\.(pem|key|pfx|p12)$/i.test(name)
}
