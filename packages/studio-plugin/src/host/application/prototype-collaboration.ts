import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { canonical } from '@eadp/asset-domain'
import type { CreatePrototypeTaskRequest, PrototypeTaskView, UpdatePrototypeClaimsRequest, UpdatePrototypeScopeRequest } from '@eadp/contracts'
import type { PrototypeCollaborationCommand, PrototypeEditBuffer, PrototypeFileCommand, PrototypeFileResult, PrototypeInstructionDraft, PrototypeQueueView } from '../../shared/prototype.ts'
import type { TaskView } from '../../shared/studio.ts'
import { digest } from '../adapters/assets/materials.ts'
import { CollaborationClient, CollaborationError } from '../adapters/collaboration/client.ts'
import { AtomicState } from '../adapters/local-state/atomic-state.ts'
import { readTemplateManifest } from '../prototype/template.js'
import { PrototypeFiles, type PrototypeFileWorkspace } from '../prototype/files.ts'
import type { HostPorts, SessionOutput } from './ports.ts'
import { StudioStore } from './state.ts'

type Start = Extract<PrototypeCollaborationCommand, { action: 'startPrototypeCollaboration' }>
type Continue = Extract<PrototypeCollaborationCommand, { action: 'continuePrototypeCollaboration' | 'extendPrototypeDevelopment' }>
type Phase = 'prepared' | 'creating' | 'claimed' | 'scope' | 'workspace' | 'sending' | 'sent' | 'unknown'
interface Operation { id: string; request: Start | Continue; phase: Phase; create?: CreatePrototypeTaskRequest; claims?: UpdatePrototypeClaimsRequest; scope?: UpdatePrototypeScopeRequest; taskId?: string; message?: string }
interface LocalTask { projectId: string; task: PrototypeTaskView; sessionId: string; worktree: string; state: 'queued' | 'running' | 'awaiting-user' | 'paused' | 'recovery-required'; nextAction?: string }
interface FileSaveOperation { id: string; prototypeTaskId: string; path: string; expectedHash: string; contentHash: string; result?: Extract<PrototypeFileResult, { kind: 'saved' }> }
interface QueueRecord { revision: number; selectedTaskId?: string; tasks: LocalTask[]; operations: Operation[]; drafts?: PrototypeInstructionDraft[]; draftWrites?: Array<{ id: string; fingerprint: string }>; buffers?: PrototypeEditBuffer[]; bufferWrites?: Array<{ id: string; fingerprint: string }>; fileSaves?: FileSaveOperation[] }

/** Local operations retain their exact user instruction and idempotency keys across restart. */
export class PrototypeCollaboration {
  private readonly files = new PrototypeFiles()
  private record?: QueueRecord
  private accountId?: number
  private storage?: AtomicState<QueueRecord>
  private loading?: Promise<QueueRecord>
  constructor(private readonly store: StudioStore, private readonly api: CollaborationClient, private readonly ports: HostPorts) {}
  private route(projectId: string, suffix: string): string { return `/v1/projects/${encodeURIComponent(projectId)}${suffix}` }
  private async data(): Promise<QueueRecord> {
    const account = this.store.accountId
    if (!account) throw new Error('请登录后访问原型事项')
    if (this.accountId === account && this.loading) return this.loading
    if (this.accountId !== account || !this.record) {
      this.accountId = account
      this.storage = new AtomicState(path.join(this.store.directory, 'prototype-queue.json'))
      const storage = this.storage
      const loading = (async () => {
        const record = await storage.read() ?? { revision: 0, tasks: [], operations: [] }
        if (this.accountId !== account || this.store.accountId !== account) throw new Error('协同账号已变化')
        this.record = record
        // A previous process cannot establish that a model call has settled.
        let changed = false
        for (const task of record.tasks) if (task.state === 'running') { task.state = 'recovery-required'; task.nextAction = '核对原生会话中的执行结果'; changed = true }
        for (const operation of record.operations) if (operation.phase === 'sending') { operation.phase = 'unknown'; operation.message = '消息投递结果未知，请核对原生会话'; changed = true }
        if (changed) await this.save()
        return record
      })()
      this.loading = loading
      try { return await loading } finally { if (this.loading === loading) this.loading = undefined }
    }
    return this.record
  }
  private async save(): Promise<void> { if (!this.record || !this.storage) throw new Error('事项队列尚未初始化'); this.record.revision++; await this.storage.write(this.record) }
  async view(): Promise<PrototypeQueueView> {
    const data = await this.data()
    return { revision: data.revision, ...(data.selectedTaskId ? { selectedTaskId: data.selectedTaskId } : {}), items: data.tasks.map(item => ({ projectId: item.projectId, prototypeTaskId: item.task.id, title: item.task.title, sessionId: item.sessionId, localDispatchState: item.state, ...(item.nextAction ? { nextAction: item.nextAction } : {}), developmentRequirementIds: item.task.developmentRequirementIds })) }
  }
  async drafts(): Promise<PrototypeInstructionDraft[]> { return structuredClone((await this.data()).drafts ?? []) }
  async saveDraft(operationId: string, draft: PrototypeInstructionDraft): Promise<void> {
    const data = await this.data(), fingerprint = digest(canonical(draft)), prior = (data.draftWrites ?? []).find(value => value.id === operationId)
    if (prior) { if (prior.fingerprint !== fingerprint) throw new Error('草稿保存操作不能用于其他内容'); return }
    const drafts = data.drafts ??= [], index = drafts.findIndex(value => value.projectId === draft.projectId && value.prototypeTaskId === draft.prototypeTaskId)
    if (index >= 0) drafts[index] = structuredClone(draft); else drafts.push(structuredClone(draft))
    ;(data.draftWrites ??= []).push({ id: operationId, fingerprint })
    await this.save()
  }
  async readBuffer(taskId: string, filePath: string): Promise<PrototypeEditBuffer | null> {
    const data = await this.data()
    if (!data.tasks.some(value => value.task.id === taskId)) throw new Error('本机未登记该事项')
    return structuredClone(data.buffers?.find(value => value.prototypeTaskId === taskId && value.path === filePath) ?? null)
  }
  async saveBuffer(operationId: string, buffer: PrototypeEditBuffer): Promise<void> {
    if (Buffer.byteLength(buffer.content, 'utf8') > 1024 * 1024 || Buffer.byteLength(buffer.baseContent, 'utf8') > 1024 * 1024) throw new Error('编辑缓冲超过大小限制')
    const data = await this.data(), fingerprint = digest(canonical(buffer)), prior = (data.bufferWrites ?? []).find(value => value.id === operationId)
    if (!data.tasks.some(value => value.task.id === buffer.prototypeTaskId)) throw new Error('本机未登记该事项')
    if (prior) { if (prior.fingerprint !== fingerprint) throw new Error('编辑缓冲操作不能用于其他内容'); return }
    const buffers = data.buffers ??= [], index = buffers.findIndex(value => value.prototypeTaskId === buffer.prototypeTaskId && value.path === buffer.path)
    if (index >= 0) buffers[index] = structuredClone(buffer); else buffers.push(structuredClone(buffer))
    ;(data.bufferWrites ??= []).push({ id: operationId, fingerprint })
    await this.save()
  }
  async clearBuffer(taskId: string, filePath: string, expectedContent: string): Promise<void> {
    const data = await this.data()
    if (!data.tasks.some(value => value.task.id === taskId)) throw new Error('本机未登记该事项')
    const index = (data.buffers ?? []).findIndex(value => value.prototypeTaskId === taskId && value.path === filePath && value.content === expectedContent)
    if (index >= 0) { data.buffers!.splice(index, 1); await this.save() }
  }
  /** Keep the original save identity before touching disk, and recover an interrupted rename from actual bytes. */
  async saveFile(command: Extract<PrototypeFileCommand, { action: 'savePrototypeFile' }>): Promise<PrototypeFileResult> {
    const workspace = await this.fileWorkspace(command.prototypeTaskId), data = await this.data()
    const contentHash = digest(command.content), operations = data.fileSaves ??= []
    let operation = operations.find(value => value.id === command.operationId)
    if (operation && (operation.prototypeTaskId !== command.prototypeTaskId || operation.path !== command.path || operation.expectedHash !== command.expectedHash || operation.contentHash !== contentHash)) throw new Error('文件保存操作不能用于其他内容')
    if (operation?.result) return operation.result
    if (!operation) {
      operation = { id: command.operationId, prototypeTaskId: command.prototypeTaskId, path: command.path, expectedHash: command.expectedHash, contentHash }
      operations.push(operation); await this.save()
    }
    const observed = await this.files.read(workspace, { action: 'readPrototypeFile', prototypeTaskId: command.prototypeTaskId, path: command.path })
    if (observed.kind !== 'file') throw new Error('无法核对原文件保存操作')
    if (observed.readOnly) throw new Error('文件不在事项授权的可写范围内')
    const result = observed.hash === contentHash
      ? { kind: 'saved' as const, projectId: workspace.projectId, prototypeTaskId: workspace.prototypeTaskId, path: command.path, hash: contentHash }
      : await this.files.save(workspace, command)
    if (result.kind !== 'saved') throw new Error('文件保存结果无效')
    operation.result = result; await this.save()
    return result
  }
  private async current(item: LocalTask): Promise<PrototypeTaskView> {
    const task = await this.api.request<PrototypeTaskView>('GET', this.route(item.projectId, `/prototype/tasks/${encodeURIComponent(item.task.id)}`))
    const account = this.store.accountId, local = await this.store.read()
    if (task.status !== 'active' || task.ownerId !== account || task.clientId !== local.clientId || task.generation !== item.task.generation || !task.developmentClaims.length) throw new Error('事项开发占用已变化，现场已保留')
    item.task = task
    return task
  }
  private manifest(): string { if (!this.ports.prototypeManifestPath) throw new Error('原型模板未配置'); return this.ports.prototypeManifestPath }
  private async scope(paths: readonly string[]): Promise<{ paths: string[]; hash: string }> {
    const manifest = await readTemplateManifest(this.manifest()), allowed = manifest.contract.writablePrefixes, protectedPaths = manifest.contract.protectedPaths
    const unique = [...new Set(paths)]
    for (const value of unique) {
      const prefix = value.endsWith('/'), clean = prefix ? value.slice(0, -1) : value
      if (!clean || clean.includes('\\') || clean.includes('\0') || path.isAbsolute(clean) || clean.split('/').some(part => !part || part === '.' || part === '..') ||
        !allowed.some(item => item.endsWith('/') ? (prefix ? value.startsWith(item) : clean.startsWith(item)) : !prefix && item === clean) ||
        protectedPaths.some(item => clean === item || clean.startsWith(`${item}/`))) throw new Error('事项写入范围超出原型模板可写区域')
    }
    return { paths: unique, hash: digest(canonical({ protectedPaths, writablePrefixes: allowed })) }
  }
  private localTask(item: LocalTask): TaskView { return { projectId: item.projectId, entityId: item.task.id, purpose: 'prototype', sessionId: item.sessionId, inputHash: '', worktree: item.worktree, baseHead: item.task.sourceBaseHead, writePaths: item.task.writeScope } }
  private async perform<T>(projectId: string, method: 'POST' | 'PUT', endpoint: string, request: { idempotencyKey: string }): Promise<T> {
    try { return (await this.api.request<{ result: T }>('GET', this.route(projectId, `/operations/${encodeURIComponent(request.idempotencyKey)}`))).result }
    catch (error) {
      if (!(error instanceof CollaborationError) || error.code !== 'OPERATION_NOT_FOUND') throw error
      return this.api.request<T>(method, this.route(projectId, endpoint), request)
    }
  }
  private async workspace(item: LocalTask): Promise<void> {
    const local = await this.store.read(), project = local.projects.find(value => value.id === item.projectId)
    if (!project) throw new Error('项目未在本机登记')
    if (!await this.ports.git.hasCommit(project.directory, item.task.startHead)) await this.ports.git.fetchCommit(project.directory, item.task.startHead)
    const exists = await stat(item.worktree).then(() => true, error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error })
    if (!exists) await this.ports.git.createWorktree(project.directory, item.worktree, item.task.branch, item.task.startHead)
    const observed = await this.ports.git.state(item.worktree)
    if (observed.branch !== item.task.branch) throw new Error('已有现场的分支与事项不一致，已保留现场')
  }
  async start(command: Start): Promise<void> {
    const data = await this.data(), local = await this.store.read(), accountId = this.store.accountId!
    const manifest = await readTemplateManifest(this.manifest())
    const scope = await this.scope(command.writeScope.length ? command.writeScope : manifest.contract.writablePrefixes)
    let operation = data.operations.find(value => value.id === command.operationId)
    if (operation && canonical(operation.request) !== canonical(command)) throw new Error('同一操作不能绑定不同实现指令')
    if (!operation) {
      const create: CreatePrototypeTaskRequest = { idempotencyKey: command.operationId, clientId: local.clientId, title: command.title, developmentRequirementIds: command.developmentRequirementIds, referenceRequirementIds: command.referenceRequirementIds, writeScope: scope.paths, policyHash: scope.hash, instruction: { userActionId: command.operationId, summary: '用户发送了原型实现指令' } }
      operation = { id: command.operationId, request: structuredClone(command), phase: 'prepared', create }; data.operations.push(operation); await this.save()
    }
    if (!command.developmentRequirementIds.length) { operation.message = '未识别实际开发需求，原指令已保留'; await this.save(); throw new Error(operation.message) }
    if (operation.phase === 'unknown' || operation.phase === 'sending') throw new Error('原指令的投递结果未知，请核对消息记录；输入已保留')
    if (operation.phase === 'sent') return
    if (!operation.taskId) {
      let task: PrototypeTaskView
      if (operation.phase === 'creating') {
        try { task = (await this.api.request<{ result: PrototypeTaskView }>('GET', this.route(command.projectId, `/operations/${encodeURIComponent(operation.id)}`))).result }
        catch (error) { if (!(error instanceof CollaborationError) || error.code !== 'OPERATION_NOT_FOUND') throw error; task = await this.api.request<PrototypeTaskView>('POST', this.route(command.projectId, '/prototype/tasks'), operation.create) }
      } else {
        operation.phase = 'creating'; await this.save()
        task = await this.api.request<PrototypeTaskView>('POST', this.route(command.projectId, '/prototype/tasks'), operation.create)
      }
      if (this.store.accountId !== accountId || task.ownerId !== accountId || task.clientId !== local.clientId) throw new Error('事项账号或设备身份已变化')
      operation.taskId = task.id; operation.phase = 'claimed'
      data.tasks.push({ projectId: command.projectId, task, sessionId: `studio-${randomUUID()}`, worktree: path.join(this.store.directory, 'worktrees', command.projectId, task.id), state: 'queued' })
      await this.save()
    }
    const item = data.tasks.find(value => value.task.id === operation!.taskId)
    if (!item) throw new Error('事项本地记录不存在')
    await this.current(item); await this.workspace(item); operation.phase = 'workspace'; await this.save()
    if (data.tasks.some(value => value !== item && (value.state === 'running' || value.state === 'recovery-required'))) { item.nextAction = '首次指令已保存，等待手动继续'; await this.save(); return }
    await this.dispatch(item, operation, command.instruction)
  }
  private async dispatch(item: LocalTask, operation: Operation, instruction: string): Promise<void> {
    const data = await this.data()
    if (data.tasks.some(value => value !== item && (value.state === 'running' || value.state === 'recovery-required'))) { item.state = 'queued'; item.nextAction = '等待手动继续'; await this.save(); return }
    await this.current(item); await this.scope(item.task.writeScope)
    await this.ports.session(this.localTask(item), '按用户明确指令实现项目原型。需求材料只读，不自行确认或发布。')
    operation.phase = 'sending'; item.state = 'running'; delete item.nextAction; data.selectedTaskId = item.task.id; await this.save()
    try { await this.ports.prompt(item.sessionId, instruction, operation.id); operation.phase = 'sent'; await this.save() }
    catch (error) { operation.phase = 'unknown'; item.state = 'recovery-required'; item.nextAction = '核对原生会话中的消息结果'; operation.message = error instanceof Error ? error.message : '消息投递结果未知'; await this.save(); throw error }
  }
  async continue(command: Continue): Promise<void> {
    const data = await this.data(), item = data.tasks.find(value => value.task.id === command.prototypeTaskId)
    if (!item) throw new Error('本机未登记该事项')
    let operation = data.operations.find(value => value.id === command.operationId)
    if (operation && canonical(operation.request) !== canonical(command)) throw new Error('同一操作不能绑定不同实现指令')
    if (!operation) { operation = { id: command.operationId, request: structuredClone(command), taskId: item.task.id, phase: 'prepared' }; data.operations.push(operation); await this.save() }
    if (operation.phase === 'sending' || operation.phase === 'unknown') throw new Error('原指令的投递结果未知，请核对消息记录；输入已保留')
    if (operation.phase === 'sent') return
    if (item.state === 'running' || item.state === 'recovery-required') throw new Error('请先核对当前会话执行结果')
    const initial = data.operations.find(value => value.taskId === item.task.id && value.request.action === 'startPrototypeCollaboration' && value.phase === 'workspace')
    if (initial && initial.request.action === 'startPrototypeCollaboration') {
      throw new Error('该事项有待发送的首次指令，请先继续事项；本次输入已保留')
    }
    let task = await this.current(item)
    if (command.action === 'extendPrototypeDevelopment') {
      const scope = await this.scope(command.writeScope.length ? command.writeScope : task.writeScope), token = () => ({ prototypeTaskId: task.id, generation: task.generation, clientId: task.clientId, expectedRevision: task.revision }), instruction = { userActionId: command.operationId, summary: '用户发送了扩大开发范围的指令' }
      if (operation.phase === 'prepared') {
        operation.claims ??= { idempotencyKey: digest(`${operation.id}:claims`), token: token(), developmentRequirementIds: command.developmentRequirementIds, instruction }
        await this.save()
        task = await this.perform<PrototypeTaskView>(item.projectId, 'POST', `/prototype/tasks/${encodeURIComponent(task.id)}/development-claims`, operation.claims)
        item.task = task; operation.phase = 'claimed'; await this.save()
      }
      if (operation.phase === 'claimed') {
        operation.scope ??= { idempotencyKey: digest(`${operation.id}:scope`), token: token(), writeScope: scope.paths, policyHash: scope.hash, instruction }
        await this.save()
        task = await this.perform<PrototypeTaskView>(item.projectId, 'PUT', `/prototype/tasks/${encodeURIComponent(task.id)}/write-scope`, operation.scope)
        item.task = task; operation.phase = 'scope'; await this.save()
      }
    }
    await this.dispatch(item, operation, command.instruction)
  }
  async select(taskId: string): Promise<void> { const data = await this.data(); if (!data.tasks.some(item => item.task.id === taskId)) throw new Error('本机未登记该事项'); data.selectedTaskId = taskId; await this.save() }
  /** User selection does not dispatch: resume sends only the original queued instruction. */
  async resumeQueued(taskId: string): Promise<void> {
    const data = await this.data(), item = data.tasks.find(value => value.task.id === taskId)
    if (!item) throw new Error('本机未登记该事项')
    const initial = data.operations.find(value => value.taskId === taskId && value.request.action === 'startPrototypeCollaboration' && value.phase === 'workspace')
    if (!initial || initial.request.action !== 'startPrototypeCollaboration') throw new Error('没有待发送的首次指令')
    await this.dispatch(item, initial, initial.request.instruction)
  }
  async queryMessage(taskId: string): Promise<void> {
    const data = await this.data(), item = data.tasks.find(value => value.task.id === taskId)
    if (!item) throw new Error('本机未登记该事项')
    const operation = [...data.operations].reverse().find(value => value.taskId === taskId && (value.phase === 'unknown' || value.phase === 'sending' || value.phase === 'sent'))
    if (!operation) throw new Error('没有待核对的消息操作')
    const result = await this.ports.inspectPrompt(item.sessionId, operation.id)
    if (result === 'delivered') {
      operation.phase = 'sent'; delete operation.message
      item.nextAction = '原生记录中已找到该指令；请核对执行结果'
    } else { operation.phase = 'unknown'; item.nextAction = '消息结果仍未知，原指令未重发' }
    await this.save()
  }
  async conversation(taskId: string) {
    const data = await this.data(), item = data.tasks.find(value => value.task.id === taskId)
    if (!item) throw new Error('本机未登记该事项')
    const queued = data.operations.some(value => value.taskId === taskId && value.request.action === 'startPrototypeCollaboration' && value.phase === 'workspace')
    if (queued) return []
    return this.ports.readPrototypeConversation(item.sessionId)
  }
  async restoreSession(sessionId: string): Promise<string | undefined> {
    const data = await this.data(), item = data.tasks.find(value => value.sessionId === sessionId)
    if (!item) return undefined
    await this.current(item); await this.workspace(item); await this.scope(item.task.writeScope)
    return this.ports.session(this.localTask(item), '按用户明确指令实现项目原型。需求材料只读，不自行确认或发布。')
  }
  async task(taskId: string): Promise<TaskView> {
    const item = (await this.data()).tasks.find(value => value.task.id === taskId)
    if (!item) throw new Error('本机未登记该事项')
    await this.current(item); await this.workspace(item); await this.scope(item.task.writeScope)
    return this.localTask(item)
  }
  async sessionId(taskId: string): Promise<string | undefined> { return (await this.data()).tasks.find(value => value.task.id === taskId)?.sessionId }
  async accept(sessionId: string, output: SessionOutput): Promise<boolean> {
    const data = await this.data(), item = data.tasks.find(value => value.sessionId === sessionId)
    if (!item) return false
    if (output.kind === 'turn-ended') { item.state = 'awaiting-user'; delete item.nextAction; await this.save() }
    return true
  }
  async fileWorkspace(taskId: string): Promise<PrototypeFileWorkspace> {
    const data = await this.data(), item = data.tasks.find(value => value.task.id === taskId)
    if (!item) throw new Error('本机未登记该事项')
    const task = await this.api.request<PrototypeTaskView>('GET', this.route(item.projectId, `/prototype/tasks/${encodeURIComponent(taskId)}`))
    const local = await this.store.read()
    if (task.ownerId !== this.store.accountId || task.clientId !== local.clientId) throw new Error('该事项不属于当前账号或设备')
    const active = task.status === 'active' && task.generation === item.task.generation && task.developmentClaims.length > 0
    const scope = active ? await this.scope(task.writeScope) : { paths: [] }
    if (task.generation === item.task.generation) item.task = task
    return { projectId: item.projectId, prototypeTaskId: task.id, root: path.join(item.worktree, '原型代码'), manifestPath: this.manifest(), writablePaths: scope.paths }
  }
  async diff(command: Extract<PrototypeFileCommand, { action: 'readPrototypeDiff' }>): Promise<PrototypeFileResult> {
    const item = (await this.data()).tasks.find(value => value.task.id === command.prototypeTaskId)
    if (!item) throw new Error('本机未登记该事项')
    const workspace = await this.fileWorkspace(command.prototypeTaskId), base = item.task.sourceBaseHead
    const changes = await this.ports.git.prototypeWorkingChanges(item.worktree, base)
    return this.files.diff(workspace, base, changes, relative => this.ports.git.readOptionalBlob(item.worktree, base, `原型代码/${relative}`), command)
  }
  get fileService(): PrototypeFiles { return this.files }
}
