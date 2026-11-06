import { stat } from 'node:fs/promises'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { ActiveDocuments } from './active-document.ts'
import { SessionPolicies } from './session-policy.ts'

export const name = 'eadp-shell'
export const inject = ['typert', 'workspaceRegistry', 'sessionController', 'agents', 'tools', 'systemPrompt']

/** UI-only project session operations; no method here is an Agent tool. */
export class ShellService extends TypertRemoteService {
  private readonly documents = new ActiveDocuments()
  private readonly policies: SessionPolicies

  constructor(ctx: Context) {
    super(ctx, 'eadpShell', { namespace: 'eadpShell' })
    this.policies = new SessionPolicies(ctx, this.documents)
    ctx.on('agent/created', async ({ agent }) => { await this.policies.install(agent) })
    for (const agent of ctx.agents.list()) {
      void this.policies.install(agent).catch(error => ctx.logger.error(`项目会话策略安装失败：${String(error)}`))
    }
  }

  @Remote
  async createSession(projectId: string, role: 'requirements' | 'prototype'): Promise<string> {
    if (role !== 'requirements' && role !== 'prototype') throw new Error('会话角色无效。')
    this.project(projectId)
    const created = await this.ctx.sessionController.create({ workspaceId: WorkspaceId(projectId), agentPreset: `eadp-${role}` })
    return created.sessionId
  }

  @Remote
  async restoreSession(projectId: string, sessionId: string): Promise<string> {
    const workspace = this.project(projectId)
    if (!workspace.sessionIds.includes(SessionId(sessionId))) throw new Error('会话不属于当前项目。')
    const inspected = await this.ctx.sessionController.inspect(SessionId(sessionId))
    if (!inspected.meta.cwd) throw new Error('会话没有项目目录，不能恢复到当前项目。')
    const owner = await this.ctx.workspaceRegistry.resolveByPath(inspected.meta.cwd)
    if (owner?.id !== workspace.id) throw new Error('会话目录与当前项目不一致。')
    const resolved = await this.ctx.sessionController.resolveAgent(SessionId(sessionId))
    if ('error' in resolved) throw resolved.error
    await this.policies.install(resolved.agent)
    return resolved.agent.id
  }

  @Remote
  async setActiveDocument(projectId: string, relativePath: string | null): Promise<void> {
    this.project(projectId)
    this.documents.set(projectId, relativePath)
  }

  /** Verify a user-picked replacement has recognizable project content without modifying it. */
  @Remote
  async validateRelocation(directory: string): Promise<void> {
    if (!path.isAbsolute(directory)) throw new Error('项目目录必须是绝对路径。')
    const root = await stat(directory)
    if (!root.isDirectory()) throw new Error('所选路径不是目录。')
    for (const [name, isDirectory] of [['需求', true], ['原型', true], ['CONTEXT.md', false]] as const) {
      try {
        const entry = await stat(path.join(directory, name))
        if (isDirectory ? entry.isDirectory() : entry.isFile()) return
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    throw new Error('所选目录没有需求、原型或 CONTEXT.md，请核对项目位置。')
  }

  /** Refuse removal while the official Session activity providers report unfinished work. */
  @Remote
  async assertRemovable(projectId: string): Promise<void> {
    const workspace = this.project(projectId)
    for (const sessionId of workspace.sessionIds) {
      const activity = await this.ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]))
      if (activity.length > 0) throw new Error('项目仍有活动会话，请先停止或等待当前轮次结束。')
    }
  }

  private project(projectId: string) {
    const workspace = this.ctx.workspaceRegistry.get(WorkspaceId(projectId))
    if (!workspace) throw new Error('项目登记不存在，请重新打开项目。')
    return workspace
  }
}

export function apply(ctx: Context): void { ctx.plugin(ShellService) }
