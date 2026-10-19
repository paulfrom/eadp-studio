import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type AgentHandle, type AgentSetup } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionOutput } from '../../application/ports.ts'
import type { TaskView } from '../../../shared/studio.ts'
import { materialPath } from '../assets/materials.ts'
import { inheritStudioExecutionScope, registerStudioExecutionScope } from '../platform/execution-guard.js'
import { loadPrototypeRules, type PrototypeRuleBinding, type PrototypeTaskIdentity } from '../../prototype/generation.js'
import { readTemplateManifest } from '../../prototype/template.js'

const configuredAgents = new WeakSet<object>()

export class DshTaskSessions {
  private readonly handles = new Map<string, AgentHandle>()
  private readonly durableSessions = new Set<string>()
  private readonly bindings = new Map<string, PrototypeRuleBinding>()
  private readonly releaseInheritance: () => void
  constructor(private readonly ctx: Context, readonly manifestPath: string, private readonly onOutput: (sessionId: string, output: SessionOutput) => Promise<void>) {
    ctx.on('session/event', (session, event) => this.enqueueOutput(session.id, event))
    this.releaseInheritance = ctx.on('agent/created', ({ agent }) => {
      const parentId = agent.session.header.parentSession
      const parent = parentId === undefined ? undefined : ctx.agents.get(parentId)
      // Durable lineage alone is not authority: the registry must attest that
      // this exact live Agent was created by this exact live parent.
      if (parent && ctx.agents.get(agent.id) === agent && ctx.agents.isOwnedBy(agent.id, parent)) {
        agent.ctx.effect(() => inheritStudioExecutionScope(parent, agent) ?? (() => {}), 'studio: inherited task file boundary')
      }
    })
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
    const projections = this.ctx.sessionProjections, defaultModel = this.ctx.agentDefaultModel
    const sessionId = task.sessionId as SessionId
    let handle: AgentHandle
    const inspection = await this.ctx.sessionController.inspect(sessionId).catch(error => {
      if (task.purpose === 'split' && task.split?.status === 'sent' || task.purpose === 'handoff' && task.handoff?.status === 'sent' || task.purpose === 'review' && task.reviewSent) throw new Error('已发送的拆分会话无法读取，请保留现场后重试恢复', { cause: error })
      return undefined
    })
    const restored = inspection ? this.ctx.sessionProjections.restore({}, inspection.events, 0 as SessionLogOffset, inspection.meta, inspection.inheritedEventCount).snapshot.values : undefined
    const selectedPreset = restored?.agentPreset ?? undefined
    const restoredSelection = restored?.modelSelection?.next ?? restored?.modelSelection?.lastUsed ?? undefined
    const agentPreset = (await this.ctx.agentPresets.resolve(selectedPreset)).id
    const agentOptions = restoredSelection ? { provider: restoredSelection.provider, model: restoredSelection.model } : this.ctx.agentDefaultModel.currentSelection()
    const configure = async (scope: Context, agent: AgentHandle['agent'], installModel: boolean): Promise<void> => {
      if (configuredAgents.has(agent)) return
      // The conversation surface may already hold the live write handle. Reuse
      // that exact Agent and attach Studio's task boundary instead of opening a
      // second handle, which the session store rejects.
      if (installModel) installModelSelection(scope, {
        get current() {
          const state = projections.stateOf(agent.session, 'modelSelection')
          if (state === undefined) throw new Error('任务会话缺少 modelSelection 投影')
          if (state.pending !== null) return { provider: state.pending.provider, model: state.pending.model, ...(state.pending.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(state.pending.reasoningEffort) }) }
          const header = agent.session.requestHeader()
          if (header === undefined) return defaultModel.currentSelection()
          const { provider, model, reasoningEffort } = header.config
          return { provider, model, ...(reasoningEffort === undefined || header.adapterDefaults?.reasoningEffort === true ? {} : { reasoningEffort }) }
        },
        assembled: undefined,
      })
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
        }, agent), 'studio: prototype file boundary')
        const binding = await loadPrototypeRules(input, { load: async request => {
          scope.systemPrompt.section({ name: 'eadp-template-rules', order: 60, text: request.content, interpolate: false })
          return { loaded: true, sessionId: task.sessionId, sha256: request.sha256, entrypoint: 'AgentRegistry.setup → systemPrompt.section' }
        } })
        this.bindings.set(task.sessionId, binding)
      } else if (task.purpose === 'review') {
        scope.effect(() => registerStudioExecutionScope(task.worktree, { readRoot: task.worktree, writablePaths: [] }, agent), 'studio: readonly fixed review boundary')
      } else {
        const kind = task.purpose === 'handoff' ? 'handoff' : (await readFile(path.join(task.worktree, '场景', `${task.entityId}.md`)).then(() => 'scenario' as const, () => 'requirement' as const))
        scope.effect(() => registerStudioExecutionScope(task.worktree, { readRoot: task.worktree, writablePaths: task.purpose === 'split' ? [] : [materialPath(kind, task.entityId)] }, agent), 'studio: material file boundary')
      }
      configuredAgents.add(agent)
    }
    const setup: AgentSetup = async (scope, agent) => { await configure(scope, agent, true) }
    const live = this.ctx.agents.get(sessionId)
    if (live) {
      await configure(live.ctx, live, false)
      handle = { agent: live, dispose: async () => {} }
    } else if (inspection) handle = await this.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions, setup })
    else handle = await this.ctx.agents.create({ sessionId, meta: { cwd: task.worktree, agentPreset }, agentOptions, setup })
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
  async dispose(): Promise<void> { this.releaseInheritance(); const handles = [...this.handles.values()]; this.handles.clear(); this.durableSessions.clear(); await Promise.allSettled(handles.map(h => h.dispose())) }
}
declare module '@deepseek-ai/dsh-llm' { interface MessageSourceMap { 'studio-task': { kind: 'studio-task' } } }
