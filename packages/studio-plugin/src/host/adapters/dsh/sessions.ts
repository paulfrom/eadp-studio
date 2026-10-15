import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle, AgentSetup } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { TaskView } from '../../../shared/studio.ts'
import { materialPath } from '../assets/materials.ts'
import { registerStudioExecutionScope } from '../platform/execution-guard.js'
import { loadPrototypeRules, type PrototypeRuleBinding, type PrototypeTaskIdentity } from '../../prototype/generation.js'
import { readTemplateManifest } from '../../prototype/template.js'

export class DshTaskSessions {
  private readonly handles = new Map<string, AgentHandle>()
  private readonly bindings = new Map<string, PrototypeRuleBinding>()
  constructor(private readonly ctx: Context, readonly manifestPath: string, private readonly onCandidates: (sessionId: string, content: string) => Promise<void>) {
    ctx.on('session/event', (session, event) => this.enqueueCandidates(session.id, event))
    ctx.effect(() => async () => { await this.dispose() }, 'studio: task sessions')
  }
  async open(task: TaskView, rules: string, input: PrototypeTaskIdentity | undefined): Promise<string> {
    if (this.handles.has(task.sessionId)) {
      if (input) await this.bind(task, input)
      if (task.purpose === 'split' && task.split?.status === 'sent') {
        const inspection = await this.ctx.sessionController.inspect(task.sessionId as SessionId)
        for (const event of inspection.events) this.enqueueCandidates(task.sessionId, event)
      }
      return task.sessionId
    }
    const setup: AgentSetup = async (scope) => {
      scope.systemPrompt.section({ name: 'eadp-task', order: 50, text: rules, interpolate: false })
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
      } else {
        const kind = task.purpose === 'handoff' ? 'handoff' : (await readFile(path.join(task.worktree, '场景', `${task.entityId}.md`)).then(() => 'scenario' as const, () => 'requirement' as const))
        scope.effect(() => registerStudioExecutionScope(task.worktree, { readRoot: task.worktree, writablePaths: task.purpose === 'split' ? [] : [materialPath(kind, task.entityId)] }), 'studio: material file boundary')
      }
    }
    const sessionId = task.sessionId as SessionId
    let handle: AgentHandle
    const inspection = await this.ctx.sessionController.inspect(sessionId).catch(error => {
      if (task.purpose === 'split' && task.split?.status === 'sent') throw new Error('已发送的拆分会话无法读取，请保留现场后重试恢复', { cause: error })
      return undefined
    })
    if (inspection) handle = await this.ctx.agents.resume({ resumeSessionId: sessionId, setup })
    else handle = await this.ctx.agents.create({ sessionId, meta: { cwd: task.worktree }, setup })
    this.handles.set(task.sessionId, handle)
    if (task.purpose === 'split' && task.split?.status === 'sent' && inspection) {
      // Do not await application delivery: open runs inside its serialized command queue.
      for (const event of inspection.events) this.enqueueCandidates(task.sessionId, event)
    }
    return task.sessionId
  }
  private enqueueCandidates(sessionId: string, event: SessionEvent): void {
    if (event.type !== 'assistant/message' || event.data.interrupted) return
    const content = event.data.message.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
    void this.onCandidates(sessionId, content).catch(() => { /* Persisted events remain available for the next recovery attempt. */ })
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
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'studio-task' } }))
  }
  async dispose(): Promise<void> { const handles = [...this.handles.values()]; this.handles.clear(); await Promise.allSettled(handles.map(h => h.dispose())) }
}
declare module '@deepseek-ai/dsh-llm' { interface MessageSourceMap { 'studio-task': { kind: 'studio-task' } } }
