import { realpathSync } from 'node:fs'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { FsError, type FsTarget } from '@deepseek-ai/dsh-fs'
import { checkPathNames } from '@eadp/contracts'
import type {} from '@deepseek-ai/dsh-working-directory'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { ActiveDocuments } from './active-document.ts'

const CONTROL_TOOLS = new Set(['ask_user_question', 'todo_write'])
const READ_TOOLS = new Set(['read', 'read_image'])
const WRITE_TOOLS = new Set(['write', 'edit'])
const REQUIREMENT_TOOLS = new Set(['eadp_requirements_list', 'eadp_requirement_read', 'eadp_requirement_propose'])
const KNOWLEDGE_TOOLS = new Set(['eadp_knowledge_search', 'eadp_knowledge_read', 'eadp_knowledge_propose'])

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
    this.ctx.effect(() => agent.ctx.tools.guard(execution => this.guard(agent, projectId, root, execution)))
    // Validate the actual resolved mutation target while preserving the native observation-policy intent.
    this.ctx.effect(() => agent.ctx.on('fs/write-intent', async (target, actor, next) => {
      this.resolvedWrite(agent, projectId, root, target, actor)
      return next()
    }, { prepend: true }))
    this.ctx.effect(() => agent.ctx.on('fs/edit-intent', async (target, actor, next) => {
      this.resolvedWrite(agent, projectId, root, target, actor)
      return next()
    }, { prepend: true }))
    this.ctx.effect(() => agent.ctx.systemPrompt.context({
      name: 'eadp:project', order: 100, interpolate: false,
      text: () => {
        if (!projectId || !this.ctx.workspaceRegistry.get(projectId)) return '当前会话未绑定有效本地项目，不能使用项目文件工具；可读取或提议用户知识，提议不写文件。'
        const active = this.documents.get(projectId)
        return `本地项目目录：${root}。当前需求：${active ?? '未选择；可列出项目需求'}。\n`
          + (preset === 'eadp-prototype'
            ? '原型文件读取使用项目根内绝对路径；write/edit 仅使用原型/下相对路径。先读取原型/AGENT.md及实际依赖的 API 声明；安装与运行由用户在工作台操作。不要执行命令或启动子 Agent。'
            : '需求修改必须先生成提案，由用户审阅后应用。原生文件读取使用项目根内绝对路径。')
      },
    }))
    const cwd = agent.session.header.cwd
    const workspace = cwd ? await this.ctx.workspaceRegistry.resolveByPath(cwd).catch(() => undefined) : undefined
    projectId = workspace?.id
    root = workspace?.path
  }

  private guard(agent: Agent, projectId: WorkspaceId | undefined, root: string | undefined, execution: Readonly<ToolExecution>): string | undefined {
    if (execution.agent !== agent) return '工具调用与当前会话身份不一致。'
    if (CONTROL_TOOLS.has(execution.name) || KNOWLEDGE_TOOLS.has(execution.name)) return undefined
    if (!projectId || !root || this.ctx.workspaceRegistry.get(projectId)?.path !== root) return '会话未绑定有效项目，不能操作项目文件。'
    const preset = agent.session.header.agentPreset
    if (REQUIREMENT_TOOLS.has(execution.name)) return preset === 'eadp-requirements' || preset === 'eadp-prototype' ? undefined : '当前会话角色不能使用需求工具。'
    const writing = WRITE_TOOLS.has(execution.name)
    if (!READ_TOOLS.has(execution.name) && !writing) return '当前会话不允许该工具；运行、安装与进程操作请使用工作台。'
    if (writing && preset !== 'eadp-prototype') return '需求与背景修改必须通过提案，由用户审阅后应用。'
    const args = execution.arguments
    if (args === null || typeof args !== 'object' || !('file_path' in args) || typeof args.file_path !== 'string') return '文件工具缺少有效路径。'
    try {
      if (!agent.session.header.cwd || realpathSync.native(agent.session.header.cwd) !== root) return '会话目录与项目登记不一致。'
      const raw = args.file_path
      if (!raw || raw.includes('\0')) return '文件路径无效。'
      if (!writing) {
        // Absolute reads cannot be redirected by a concurrent effective-cwd projection change.
        if (!path.isAbsolute(raw)) return '请使用当前项目内的绝对路径读取文件，避免工作目录变化导致读错项目。'
        const target = realpathSync.native(raw)
        const relative = path.relative(root, target)
        if (!inside(relative) || relative.split(path.sep).some(sensitive)) return '文件路径超出项目，或指向敏感文件。'
      } else {
        if (realpathSync.native(this.ctx.workingDirectory.get(agent.session)) !== root) return '会话当前工作目录已变化，请先通过原生目录操作恢复项目根目录。'
        const checked = checkPathNames(raw.replaceAll('\\', '/'))
        if (!checked.ok || path.win32.isAbsolute(raw) || path.posix.isAbsolute(raw) || checked.names.length < 2 || checked.names[0] !== '原型') return '写入路径必须是原型/下明确的相对文件路径。'
        if (!prototypeTarget(root, resolveFuture(path.resolve(root, raw)))) return '只能修改原型源文件，不能写需求、背景、依赖、敏感文件或保护目录。'
      }
    } catch { return '文件路径不可访问，或其真实目录已变化。' }
    return undefined
  }

  private resolvedWrite(agent: Agent, projectId: WorkspaceId | undefined, root: string | undefined, target: FsTarget, actor: object | undefined): void {
    if ((actor as { agent?: unknown } | undefined)?.agent !== agent) return
    if (!projectId || !root || this.ctx.workspaceRegistry.get(projectId)?.path !== root || agent.session.header.agentPreset !== 'eadp-prototype'
      || !prototypeTarget(root, resolveFuture(this.ctx.fs.processPath(target)))) throw new FsError('实际文件目标不在当前项目可写的原型源文件范围内。', 'FS_SANDBOX_DENIED')
  }
}

function inside(relative: string): boolean { return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) }
function sensitive(name: string): boolean {
  const lower = name.toLowerCase()
  return ['.git', '.npmrc', '.netrc', '.ssh', '.aws', '.azure'].includes(lower) || lower.startsWith('.yarnrc') || (lower.startsWith('.env') && lower !== '.env.example') || /\.(pem|key|pfx|p12)$/i.test(name)
}
function prototypeTarget(root: string, target: string): boolean {
  const relative = path.relative(root, target), parts = relative.split(path.sep)
  return inside(relative) && parts[0] === '原型' && parts.length > 1 && !parts.some(name => {
    const lower = name.toLowerCase()
    return sensitive(name) || lower === 'node_modules' || lower === 'dist' || lower === 'build' || lower === 'coverage' || lower.startsWith('.umi') || lower === '.cache' || lower === '.pnpm-store'
  })
}
/** Resolve missing suffixes through their deepest existing ancestor without inventing a path authority. */
function resolveFuture(target: string): string {
  const suffix: string[] = []
  let current = target
  while (true) {
    try { return path.join(realpathSync.native(current), ...suffix) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = path.dirname(current)
      if (parent === current) throw error
      suffix.unshift(path.basename(current)); current = parent
    }
  }
}
