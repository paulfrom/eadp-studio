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
import type { AttachmentAdmissionPart, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { SessionOutput } from '../../application/ports.ts'
import type { TaskView } from '../../../shared/studio.ts'
import type { PrototypeConversationAttachment, PrototypeConversationMessage, PrototypeInstructionAttachment } from '../../../shared/prototype.ts'
import { findMaterialFile } from '../assets/materials.ts'
import { inheritStudioExecutionScope, registerStudioExecutionScope, updateStudioWriteScope } from '../platform/execution-guard.js'
import { loadPrototypeRules, type PrototypeRuleBinding, type PrototypeTaskIdentity } from '../../prototype/generation.js'
import { readTemplateManifest } from '../../prototype/template.js'
import type { PrototypeMaterialContext } from '../../application/prototype-material-context.ts'
import { registerPrototypeMaterialTools } from './prototype-material-tools.ts'
import type { PrototypeBrowserTools } from './prototype-browser-tools.ts'

const configuredAgents = new WeakSet<object>()
const conversationText = (value: string): { text: string; truncated?: true } => ({ text: value.slice(0, 100_000), ...(value.length > 100_000 ? { truncated: true as const } : {}) })
const conversationAttachments = (content: ReadonlyArray<{ type: string; attachment?: { attachmentId: string; name?: string; bytes: number; width?: number; height?: number } }>): PrototypeConversationAttachment[] => content.flatMap(part => part.attachment ? [{ id: part.attachment.attachmentId, kind: part.type === 'image' ? 'image' as const : 'file' as const, ...(part.attachment.name ? { name: part.attachment.name } : {}), bytes: part.attachment.bytes, ...(part.attachment.width !== undefined ? { width: part.attachment.width } : {}), ...(part.attachment.height !== undefined ? { height: part.attachment.height } : {}) }] : [])
export type ScenarioContextReader = (task: TaskView, signal: AbortSignal) => Promise<{ text: string; readPaths: string[] }>

export class DshTaskSessions {
  private readonly handles = new Map<string, AgentHandle>()
  private readonly worktrees = new Map<string, string>()
  private readonly durableSessions = new Set<string>()
  private readonly bindings = new Map<string, PrototypeRuleBinding>()
  private readonly imageCalls = new Map<string, string>()
  private readonly releaseOutput: () => void
  private readonly releaseInheritance: () => void
  constructor(private readonly ctx: Context, readonly manifestPath: string, private readonly onOutput: (sessionId: string, output: SessionOutput) => Promise<void>, private readonly scenarioContext?: ScenarioContextReader, private readonly skillsDirectory?: string, private readonly prototypeWriteAuthorization?: (task: TaskView) => Promise<() => Promise<void>>, private readonly prototypeMaterials?: () => PrototypeMaterialContext, private readonly prototypeBrowser?: PrototypeBrowserTools) {
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
  async open(task: TaskView, rules: string, input: PrototypeTaskIdentity | undefined, requireExisting = false): Promise<string> {
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
        if (!this.prototypeWriteAuthorization) throw new Error('原型事项缺少后台授权核对')
        const authorizeWrite = await this.prototypeWriteAuthorization(task)
        updateStudioWriteScope(handle.agent, (task.writePaths ?? []).filter(p => !p.endsWith('/')).map(p => `原型代码/${p}`), (task.writePaths ?? []).filter(p => p.endsWith('/')).map(p => `原型代码/${p}`), authorizeWrite)
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
        scope.on('agent/pre-step', async (_payload, next) => {
          const decision = await next()
          if (decision.kind === 'enter' && decision.messages.some(message => message.source.kind !== 'studio-task')) return { kind: 'reject' }
          return decision
        })
        if (!this.prototypeWriteAuthorization) throw new Error('原型事项缺少后台授权核对')
        const authorizeWrite = await this.prototypeWriteAuthorization(task)
        scope.effect(() => registerStudioExecutionScope(task.worktree, {
          readRoot: task.worktree,
          writablePaths: (task.writePaths ?? []).filter(p => !p.endsWith('/')).map(p => `原型代码/${p}`),
          writablePrefixes: (task.writePaths ?? []).filter(p => p.endsWith('/')).map(p => `原型代码/${p}`),
          protectedPaths: manifest.contract.protectedPaths.map(p => `原型代码/${p}`),
          coordinateWrites: true,
          authorizeWrite,
          prototypeMaterials: !!this.prototypeMaterials,
        }, agent), 'studio: prototype file boundary')
        if (this.prototypeMaterials) registerPrototypeMaterialTools(scope, agent, task, this.prototypeMaterials())
        this.prototypeBrowser?.register(scope, agent, task)
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
    else if (requireExisting) throw new Error('原生会话记录无法读取，原事项和现场已保留')
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
  async prompt(sessionId: string, text: string, operationId?: string, attachments: PrototypeInstructionAttachment[] = []): Promise<void> {
    const handle = this.handles.get(sessionId)
    if (!handle) throw new Error('任务会话尚未恢复')
    if (operationId || this.durableSessions.has(sessionId)) {
      const inspection = operationId ? await this.ctx.sessionController.inspect(sessionId as SessionId).catch(() => undefined) : await this.ctx.sessionController.inspect(sessionId as SessionId)
      const delivered = inspection?.events.some(event => event.type === 'user/message' && event.data.source.kind === 'studio-task'
        && (operationId ? event.data.source.operationId === operationId : event.data.content.filter(part => part.type === 'text').map(part => part.text).join('\n') === text))
      const admitted = operationId && inspection?.events.some(event => event.type === 'agent/inbox/spliced' && event.data.inserted.some(message => message.source.kind === 'studio-task' && message.source.operationId === operationId))
      if (delivered || admitted) return
    }
    if (attachments.length > 8) throw new Error('每条原型指令最多附带 8 个文件')
    const parts: AttachmentAdmissionPart[] = []
    let totalBytes = 0
    for (const attachment of attachments) {
      if (!attachment.name || attachment.name.length > 255 || attachment.name.includes('\0') || !attachment.mediaType) throw new Error('附件名称或类型无效')
      const bytes = Buffer.from(attachment.data, 'base64')
      if (!bytes.length || bytes.length > 8 * 1024 * 1024 || bytes.toString('base64') !== attachment.data) throw new Error(`附件 ${attachment.name} 的编码或大小无效`)
      totalBytes += bytes.length
      if (totalBytes > 16 * 1024 * 1024) throw new Error('每条原型指令的附件总大小不能超过 16 MiB')
      if (attachment.kind === 'file') parts.push({ type: 'file', attachment: await this.ctx.attachments.admitEncodedFile({ data: attachment.data, name: attachment.name }) })
      else if (attachment.kind === 'image') parts.push({ type: 'image', data: attachment.data, mediaType: attachment.mediaType as ImageMediaType, name: attachment.name })
      else throw new Error('附件类型不受支持')
    }
    const content = await this.ctx.attachments.admitPromptContent([{ type: 'text', text }, ...parts])
    handle.agent.followup(createUserMessage({ content, source: { kind: 'studio-task', ...(operationId ? { operationId } : {}) } }))
    if (operationId) {
      if (!await this.ctx.sessions.flush(handle.agent.session)) throw new Error('原生消息持久化结果未知')
      if (await this.inspectPrompt(sessionId, operationId) === 'unknown') throw new Error('原生消息记录尚不可核对')
    }
  }
  /** A missing log entry does not prove that an in-flight request was not delivered. */
  async inspectPrompt(sessionId: string, operationId: string): Promise<'delivered' | 'admitted' | 'unknown'> {
    const handle = this.handles.get(sessionId)
    if (handle && !await this.ctx.sessions.flush(handle.agent.session).catch(() => false)) return 'unknown'
    const inspection = await this.ctx.sessionController.inspect(sessionId as SessionId).catch(() => undefined)
    if (inspection?.events.some(event => event.type === 'user/message' && event.data.source.kind === 'studio-task' && event.data.source.operationId === operationId)) return 'delivered'
    if (inspection?.events.some(event => event.type === 'agent/inbox/spliced' && event.data.inserted.some(message => message.source.kind === 'studio-task' && message.source.operationId === operationId))) return 'admitted'
    return 'unknown'
  }
  async readPrototypeConversation(sessionId: string): Promise<PrototypeConversationMessage[]> {
    const inspection = await this.ctx.sessionController.inspect(sessionId as SessionId)
    const messages: PrototypeConversationMessage[] = [], toolNames = new Map<string, string>()
    for (const event of inspection.events) {
      if (event.type === 'user/message') {
        if (!['studio-task', 'user', 'user-rpc'].includes(event.data.source.kind)) continue
        const text = event.data.content.filter(part => part.type === 'text').map(part => part.text).join('\n'), attachments = conversationAttachments(event.data.content)
        if (text || attachments.length) messages.push({ sequence: event.seq, role: 'user', ...conversationText(text), source: event.data.source.kind,
          ...(event.data.source.kind === 'studio-task' && event.data.source.operationId ? { operationId: event.data.source.operationId } : {}), ...(attachments.length ? { attachments } : {}) })
      } else if (event.type === 'assistant/message') {
        const text = event.data.message.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
        if (text) messages.push({ sequence: event.seq, role: 'assistant', ...conversationText(text), ...(event.data.interrupted ? { interrupted: true } : {}) })
      } else if (event.type === 'tool/call') {
        toolNames.set(event.data.callId, event.data.name)
        messages.push({ sequence: event.seq, role: 'assistant', kind: 'tool', ...conversationText(event.data.arguments), tool: { callId: event.data.callId, name: event.data.name, status: 'running', arguments: event.data.arguments.slice(0, 100_000) } })
      } else if (event.type === 'tool/result') {
        const callId = event.data.message.toolCallId, text = event.data.message.content.filter(part => part.type === 'text').map(part => part.text).join('\n'), attachments = conversationAttachments(event.data.message.content)
        messages.push({ sequence: event.seq, role: 'assistant', kind: 'tool', ...conversationText(text), ...(attachments.length ? { attachments } : {}),
          tool: { callId, name: toolNames.get(callId) ?? '工具', status: event.data.message.isError ? 'failed' : 'completed', result: text.slice(0, 100_000) } })
      }
    }
    return messages
  }
  /** Use the same cancellation command as DSH's native conversation surface. */
  async cancel(sessionId: string): Promise<void> {
    if (this.ctx.agents.get(sessionId as SessionId)) this.ctx.sessionController.cancel({ sessionId: sessionId as SessionId })
  }
  /** Cancel without discarding pending inbox work, then wait for the whole native agent and persistence. */
  async settlePrototype(sessionId: string, cancel: boolean, allowPending = false): Promise<boolean> {
    const handle = this.handles.get(sessionId)
    if (!handle) return false
    const agent = handle.agent
    if (cancel) agent.cancel({ kind: 'user' }, { keepInbox: true })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const idle = await Promise.race([agent.whenIdle().then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 30_000) })])
      if (!idle || agent.status !== 'idle' || !allowPending && agent.inbox.hasPending) return false
      const flushed = await this.ctx.sessions.flush(agent.session)
      return flushed && agent.status === 'idle' && (allowPending || !agent.inbox.hasPending)
    } finally { if (timer) clearTimeout(timer) }
  }
  /** Release only the Agent handles owned by one task worktree; other tasks keep running. */
  async releaseWorktree(worktree: string): Promise<void> {
    const target = path.resolve(worktree), released: AgentHandle[] = [], closing: Promise<void>[] = []
    for (const [sessionId, directory] of [...this.worktrees]) {
      if (directory !== target) continue
      const handle = this.handles.get(sessionId)
      this.worktrees.delete(sessionId); this.handles.delete(sessionId); this.durableSessions.delete(sessionId); this.bindings.delete(sessionId)
      for (const key of [...this.imageCalls.keys()]) if (key.startsWith(`${sessionId}:`)) this.imageCalls.delete(key)
      if (handle) released.push(handle)
      if (this.prototypeBrowser) closing.push(this.prototypeBrowser.close(sessionId))
    }
    const results = await Promise.allSettled([...released.map(handle => handle.dispose()), ...closing]), failures = results.filter(result => result.status === 'rejected')
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), '原生事项资源未能完整释放')
  }
  /** Stop model work, persist durable inbox state, and keep live handles when shutdown cannot settle. */
  async dispose(): Promise<void> {
    const prototypeIds = [...this.bindings.keys()]
    const settled = await Promise.all(prototypeIds.map(id => this.settlePrototype(id, true, true)))
    if (settled.some(value => !value)) throw new Error('原型会话尚未收敛或保存，关闭已暂停；事项和现场保持原状')
    await this.prototypeBrowser?.dispose()
    this.releaseOutput(); this.releaseInheritance()
    const handles = [...this.handles.values()]
    this.handles.clear(); this.worktrees.clear(); this.durableSessions.clear(); this.imageCalls.clear(); this.bindings.clear()
    const results = await Promise.allSettled(handles.map(handle => handle.dispose())), failures = results.filter(result => result.status === 'rejected')
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), '原生会话句柄未能完整释放')
  }
}
declare module '@deepseek-ai/dsh-llm' { interface MessageSourceMap { 'studio-task': { kind: 'studio-task'; operationId?: string } } }
