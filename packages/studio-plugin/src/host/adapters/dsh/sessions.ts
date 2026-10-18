import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle, AgentSetup } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionOutput } from '../../application/ports.ts'
import type { TaskView } from '../../../shared/studio.ts'
import { materialPath } from '../assets/materials.ts'
import { registerStudioExecutionScope } from '../platform/execution-guard.js'
import { loadPrototypeRules, type PrototypeRuleBinding, type PrototypeTaskIdentity } from '../../prototype/generation.js'
import { readTemplateManifest } from '../../prototype/template.js'

export class DshTaskSessions {
  private readonly handles = new Map<string, AgentHandle>()
  private readonly durableSessions = new Set<string>()
  private readonly bindings = new Map<string, PrototypeRuleBinding>()
  constructor(private readonly ctx: Context, readonly manifestPath: string, private readonly onOutput: (sessionId: string, output: SessionOutput) => Promise<void>) {
    ctx.on('session/event', (session, event) => this.enqueueOutput(session.id, event))
    ctx.effect(() => async () => { await this.dispose() }, 'studio: task sessions')
  }
  async open(task: TaskView, rules: string, input: PrototypeTaskIdentity | undefined): Promise<string> {
    if (task.purpose === 'review' && input) throw new Error('评审任务不能取得原型写入权限')
    if (task.purpose === 'split' || task.purpose === 'review' || task.purpose === 'handoff') this.durableSessions.add(task.sessionId)
    if (this.handles.has(task.sessionId)) {
      if (input) await this.bind(task, input)
      if (task.purpose === 'split' || task.purpose === 'review' || task.purpose === 'handoff') {
        const inspection = await this.ctx.sessionController.inspect(task.sessionId as SessionId)
        for (const event of inspection.events) this.enqueueOutput(task.sessionId, event)
      }
      return task.sessionId
    }
    const setup: AgentSetup = async (scope) => {
      await this.ctx.agentPresets.mount(scope, agentPreset)
      scope.systemPrompt.section({ name: 'eadp-task', order: 50, text: rules, interpolate: false })
      if (task.purpose === 'review' && input) throw new Error('评审任务不能取得原型写入权限')
      if (input) {
        const manifest = await readTemplateManifest(this.manifestPath)
        scope.effect(() => registerStudioExecutionScope(task.worktree, {
          readRoot: task.worktree,
            writablePaths: (manifest.contract.writablePrefixes ?? []).filter(p => !p.endsWith('/')).map(p => `原型代码/${p}`),
            writablePrefixes: (manifest.contract.writablePrefixes ?? []).filter(p => p.endsWith('/')).map(p => `原型代码/${p}`),
          protectedPaths: manifest.contract.protectedPaths.map(p => `原型代码/${p}`),
        }), 'studio: prototype file boundary')
        const binding = await loadPrototypeRules(input, { load: async request => {
          scope.systemPrompt.section({ name: 'eadp-template-rules', order: 60, text: request.content, interpolate: false })
          // Registration is synchronous and scope-owned before the Agent is published.
          return { loaded: true, sessionId: task.sessionId, sha256: request.sha256, entrypoint: 'AgentRegistry.setup → systemPrompt.section' }
        } })
        this.bindings.set(task.sessionId, binding)
      } else if (task.purpose === 'review') {
        scope.effect(() => registerStudioExecutionScope(task.worktree, { readRoot: task.worktree, writablePaths: [] }), 'studio: readonly fixed review boundary')
      } else {
        const kind = task.purpose === 'handoff' ? 'handoff' : (await readFile(path.join(task.worktree, '场景', `${task.entityId}.md`)).then(() => 'scenario' as const, () => 'requirement' as const))
        scope.effect(() => registerStudioExecutionScope(task.worktree, { readRoot: task.worktree, writablePaths: task.purpose === 'split' ? [] : [materialPath(kind, task.entityId)] }), 'studio: material file boundary')
      }
    }
    const sessionId = task.sessionId as SessionId
    let handle: AgentHandle
    const inspection = await this.ctx.sessionController.inspect(sessionId).catch(error => {
      if (task.purpose === 'split' && task.split?.status === 'sent' || task.purpose === 'handoff' && task.handoff?.status === 'sent' || task.purpose === 'review' && task.reviewSent) throw new Error('已发送的拆分会话无法读取，请保留现场后重试恢复', { cause: error })
      return undefined
    })
    const selectedPreset = inspection ? this.ctx.sessionProjections.restore({}, inspection.events, 0 as SessionLogOffset, inspection.meta, inspection.inheritedEventCount).snapshot.values.agentPreset ?? undefined : undefined
    const agentPreset = (await this.ctx.agentPresets.resolve(selectedPreset)).id
    if (inspection) handle = await this.ctx.agents.resume({ resumeSessionId: sessionId, setup })
    else handle = await this.ctx.agents.create({ sessionId, meta: { cwd: task.worktree, agentPreset }, setup })
    this.handles.set(task.sessionId, handle)
    if ((task.purpose === 'split' || task.purpose === 'review' || task.purpose === 'handoff') && inspection) {
      // Do not await application delivery: open runs inside its serialized command queue.
      for (const event of inspection.events) this.enqueueOutput(task.sessionId, event)
    }
    return task.sessionId
  }
  private enqueueOutput(sessionId: string, event: SessionEvent): void {
    let output: SessionOutput
    if (event.type === 'turn/end') output = { kind: 'turn-ended', reason: event.data.reason.kind }
    else if (event.type === 'assistant/message' && !event.data.interrupted) output = { kind: 'assistant', content: event.data.message.content.filter(part => part.type === 'text').map(part => part.text).join('\n') }
    else return
    void this.onOutput(sessionId, output).catch(() => { /* Persisted events remain available for the next recovery attempt. */ })
  }

  async bind(task: TaskView, input: PrototypeTaskIdentity): Promise<PrototypeRuleBinding> {
    const handle = this.handles.get(task.sessionId)
    if (!handle) throw new Error('会话尚未加载规则')
    const current = this.bindings.get(task.sessionId)
    if (current?.sourceSha === input.sourceSha) return current
    // A commit changes the fixed task identity, while the registered exact AGENT bytes remain unchanged.
    const binding = await loadPrototypeRules(input, { load: async request => {
      if (!current || current.rulesSha256 !== request.sha256) throw new Error('规则已变化，必须重新建立会话')
      return { loaded: true, sessionId: task.sessionId, sha256: request.sha256, entrypoint: current.entrypoint }
    } })
    this.bindings.set(task.sessionId, binding); return binding
  }
  async prompt(sessionId: string, text: string): Promise<void> {
    const handle = this.handles.get(sessionId)
    if (!handle) throw new Error('任务会话尚未恢复')
    if (this.durableSessions.has(sessionId)) {
      const inspection = await this.ctx.sessionController.inspect(sessionId as SessionId)
      const delivered = inspection.events.some(event => event.type === 'user/message' && event.data.source.kind === 'studio-task'
        && event.data.content.filter(part => part.type === 'text').map(part => part.text).join('\n') === text)
      if (delivered) return
    }
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'studio-task' } }))
  }
  async dispose(): Promise<void> { const handles = [...this.handles.values()]; this.handles.clear(); this.durableSessions.clear(); await Promise.allSettled(handles.map(h => h.dispose())) }
}
declare module '@deepseek-ai/dsh-llm' { interface MessageSourceMap { 'studio-task': { kind: 'studio-task' } } }
