import type { Context } from '@deepseek-ai/cordis'
import path from 'node:path'
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
import type { PrototypeConversationMessage } from '../../../shared/prototype.ts'
import { findMaterialFile } from '../assets/materials.ts'
import { inheritStudioExecutionScope, registerStudioExecutionScope, updateStudioWriteScope } from '../platform/execution-guard.js'
import { loadPrototypeRules, type PrototypeRuleBinding, type PrototypeTaskIdentity } from '../../prototype/generation.js'
import { readTemplateManifest } from '../../prototype/template.js'

const configuredAgents = new WeakSet<object>()
export type ScenarioContextReader = (task: TaskView, signal: AbortSignal) => Promise<{ text: string; readPaths: string[] }>

export class DshTaskSessions {
  private readonly handles = new Map<string, AgentHandle>()
  private readonly worktrees = new Map<string, string>()
  private readonly durableSessions = new Set<string>()
  private readonly bindings = new Map<string, PrototypeRuleBinding>()
  private readonly imageCalls = new Map<string, string>()
  private readonly releaseOutput: () => void
  private readonly releaseInheritance: () => void
  constructor(private readonly ctx: Context, readonly manifestPath: string, private readonly onOutput: (sessionId: string, output: SessionOutput) => Promise<void>, private readonly scenarioContext?: ScenarioContextReader, private readonly skillsDirectory?: string) {
    this.releaseOutput = ctx.on('session/event', (session, event) => this.enqueueOutput(session.id, event))
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
  /** Mount the shipped skill snapshot on this Agent only; default project and user roots stay disabled. */
  private async mountBundledSkills(scope: Context): Promise<void> {
    const specifier = '@deepseek-ai/dsh-skill-filesystem'
    const { apply } = await import(specifier) as { apply: (ctx: Context, config: Record<string, unknown>) => void }
    scope.plugin({ apply }, { providerName: 'eadp-bundled', includeDefaultRoots: false, customSkillDirs: [this.skillsDirectory!], watch: false })
  }
  async open(task: TaskView, rules: string, input: PrototypeTaskIdentity | undefined): Promise<string> {
    if (task.purpose === 'review' && input) throw new Error('评审任务不能取得原型写入权限')
    // Materials are named after their titles, so the session resolves their current paths instead of deriving them.
    const scenarioFile = task.purpose === 'material' ? await findMaterialFile(task.worktree, 'scenario', task.entityId) : undefined
    const requirementFile = task.purpose === 'material' && !scenarioFile ? await findMaterialFile(task.worktree, 'requirement', task.entityId) : undefined
    // Requirements and scenarios share the same read-only design orchestration and bundled skills.
    const scenarioTask = task.scenarioRepair === true || scenarioFile !== undefined || requirementFile !== undefined
    if (scenarioTask && input) throw new Error('场景会话不能取得原型写入权限')
    const replay = task.purpose === 'material' || task.purpose === 'split' || task.purpose === 'review' || task.purpose === 'handoff'
    if (task.purpose === 'split' || task.purpose === 'review' || task.purpose === 'handoff') this.durableSessions.add(task.sessionId)
    if (this.handles.has(task.sessionId)) {
      if (input) {
        const handle = this.handles.get(task.sessionId)!
        updateStudioWriteScope(handle.agent, (task.writePaths ?? []).filter(p => !p.endsWith('/')).map(p => `原型代码/${p}`), (task.writePaths ?? []).filter(p => p.endsWith('/')).map(p => `原型代码/${p}`))
      }
      if (input) await this.bind(task, input)
      if (this.durableSessions.has(task.sessionId)) {
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
    const agentPreset = (await this.ctx.agentPresets.resolve(requirementFile !== undefined || task.purpose === 'split' ? 'eadp-requirement' : scenarioTask ? 'eadp-scenario' : selectedPreset)).id
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
      if (scenarioTask && this.skillsDirectory) await this.mountBundledSkills(scope)
      scope.systemPrompt.section({ name: 'eadp-task', order: 50, text: rules, interpolate: false })
      let readPaths: string[] = []
      if (scenarioTask && this.scenarioContext) {
        let latest = ''
        // Required runtime context is refreshed after native request preparation
        // and persisted by the loop for composer sends, repairs, and retries.
        scope.systemPrompt.context({ name: 'eadp-scenario', order: 80, required: true, interpolate: false, text: () => latest })
        scope.on('agent/request', async ({ signal }, next) => {
          const current = await this.scenarioContext!(task, signal)
          signal.throwIfAborted()
          latest = current.text
          readPaths = current.readPaths
          return next()
        })
      }
      if (task.purpose === 'review' && input) throw new Error('评审任务不能取得原型写入权限')
      if (input) {
        const manifest = await readTemplateManifest(this.manifestPath)
        scope.effect(() => registerStudioExecutionScope(task.worktree, {
          readRoot: task.worktree,
          writablePaths: (task.writePaths ?? []).filter(p => !p.endsWith('/')).map(p => `原型代码/${p}`),
          writablePrefixes: (task.writePaths ?? []).filter(p => p.endsWith('/')).map(p => `原型代码/${p}`),
          protectedPaths: manifest.contract.protectedPaths.map(p => `原型代码/${p}`),
        }, agent), 'studio: prototype file boundary')
        const binding = await loadPrototypeRules(input, { load: async request => {
          scope.systemPrompt.section({ name: 'eadp-template-rules', order: 60, text: request.content, interpolate: false })
          return { loaded: true, sessionId: task.sessionId, sha256: request.sha256, entrypoint: 'AgentRegistry.setup → systemPrompt.section' }
        } })
        this.bindings.set(task.sessionId, binding)
      } else if (task.purpose === 'review') {
        scope.effect(() => registerStudioExecutionScope(task.worktree, { readRoot: task.worktree, readPaths: () => readPaths, writablePaths: [] }, agent), 'studio: readonly fixed review boundary')
      } else {
        const kind = task.purpose === 'handoff' ? 'handoff' : scenarioFile !== undefined ? 'scenario' : 'requirement'
        const writable = task.purpose === 'split' || scenarioTask ? undefined : await findMaterialFile(task.worktree, kind, task.entityId)
        const writablePaths = [...writable ? [writable] : [], ...task.writePaths ?? []]
        scope.effect(() => registerStudioExecutionScope(task.worktree, { readRoot: task.worktree, readPaths: () => readPaths, writablePaths }, agent), 'studio: material file boundary')
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
    this.worktrees.set(task.sessionId, path.resolve(task.worktree))
    if (replay && inspection) {
      // Do not await application delivery: open runs inside its serialized command queue.
      for (const event of inspection.events) this.enqueueOutput(task.sessionId, event)
    }
    return task.sessionId
  }
  private enqueueOutput(sessionId: string, event: SessionEvent): void {
    let output: SessionOutput
    const callKey = (id: string) => `${sessionId}:${id}`
    if (event.type === 'tool/call') {
      if (event.data.name === 'read_image') {
        try {
          const args: unknown = JSON.parse(event.data.arguments)
          if (args && typeof args === 'object' && 'file_path' in args && typeof args.file_path === 'string') this.imageCalls.set(callKey(event.data.callId), args.file_path)
        } catch { /* Invalid tool arguments never establish reading evidence. */ }
      }
      return
    }
    if (event.type === 'tool/result') {
      const requestedPath = this.imageCalls.get(callKey(event.data.message.toolCallId))
      this.imageCalls.delete(callKey(event.data.message.toolCallId))
      const image = event.data.message.content.find(part => part.type === 'image')
      if (!requestedPath || event.data.message.isError || image?.type !== 'image') return
      output = { kind: 'source-read', path: requestedPath, attachmentId: image.attachment.attachmentId,
        ranges: [`image:1 (${image.attachment.width}×${image.attachment.height}); attachment:${image.attachment.attachmentId}`] }
    }
    else if (event.type === 'turn/end') output = { kind: 'turn-ended', reason: event.data.reason.kind }
    else if (event.type === 'assistant/message' && !event.data.interrupted) output = { kind: 'assistant', content: event.data.message.content.filter(part => part.type === 'text').map(part => part.text).join('\n') }
    else return
    if (Number.isSafeInteger(event.seq)) output.seq = event.seq
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
  async prompt(sessionId: string, text: string, operationId?: string): Promise<void> {
    const handle = this.handles.get(sessionId)
    if (!handle) throw new Error('任务会话尚未恢复')
    if (operationId || this.durableSessions.has(sessionId)) {
      const inspection = operationId ? await this.ctx.sessionController.inspect(sessionId as SessionId).catch(() => undefined) : await this.ctx.sessionController.inspect(sessionId as SessionId)
      const delivered = inspection?.events.some(event => event.type === 'user/message' && event.data.source.kind === 'studio-task'
        && (operationId ? event.data.source.operationId === operationId : event.data.content.filter(part => part.type === 'text').map(part => part.text).join('\n') === text))
      if (delivered) return
    }
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'studio-task', ...(operationId ? { operationId } : {}) } }))
  }
  /** A missing log entry does not prove that an in-flight request was not delivered. */
  async inspectPrompt(sessionId: string, operationId: string): Promise<'delivered' | 'unknown'> {
    const inspection = await this.ctx.sessionController.inspect(sessionId as SessionId).catch(() => undefined)
    return inspection?.events.some(event => event.type === 'user/message' && event.data.source.kind === 'studio-task' && event.data.source.operationId === operationId) ? 'delivered' : 'unknown'
  }
  async readPrototypeConversation(sessionId: string): Promise<PrototypeConversationMessage[]> {
    const inspection = await this.ctx.sessionController.inspect(sessionId as SessionId)
    const messages: PrototypeConversationMessage[] = []
    for (const event of inspection.events) {
      if (event.type === 'user/message') {
        if (event.data.source.kind !== 'studio-task' && event.data.source.kind !== 'user') continue
        const text = event.data.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
        if (text) messages.push({ sequence: event.seq, role: 'user', text })
      } else if (event.type === 'assistant/message') {
        const text = event.data.message.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
        if (text) messages.push({ sequence: event.seq, role: 'assistant', text, ...(event.data.interrupted ? { interrupted: true } : {}) })
      }
    }
    return messages
  }
  /** Use the same cancellation command as DSH's native conversation surface. */
  async cancel(sessionId: string): Promise<void> {
    if (this.ctx.agents.get(sessionId as SessionId)) this.ctx.sessionController.cancel({ sessionId: sessionId as SessionId })
  }
  /** Release only the Agent handles owned by one task worktree; other tasks keep running. */
  async releaseWorktree(worktree: string): Promise<void> {
    const target = path.resolve(worktree), released: AgentHandle[] = []
    for (const [sessionId, directory] of [...this.worktrees]) {
      if (directory !== target) continue
      const handle = this.handles.get(sessionId)
      this.worktrees.delete(sessionId); this.handles.delete(sessionId); this.durableSessions.delete(sessionId); this.bindings.delete(sessionId)
      for (const key of [...this.imageCalls.keys()]) if (key.startsWith(`${sessionId}:`)) this.imageCalls.delete(key)
      if (handle) released.push(handle)
    }
    await Promise.allSettled(released.map(handle => handle.dispose()))
  }
  async dispose(): Promise<void> { this.releaseOutput(); this.releaseInheritance(); const handles = [...this.handles.values()]; this.handles.clear(); this.worktrees.clear(); this.durableSessions.clear(); this.imageCalls.clear(); this.bindings.clear(); await Promise.allSettled(handles.map(h => h.dispose())) }
}
declare module '@deepseek-ai/dsh-llm' { interface MessageSourceMap { 'studio-task': { kind: 'studio-task'; operationId?: string } } }
