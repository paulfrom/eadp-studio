import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { canonical, PROTOTYPE_MERGE_POLICY } from '@eadp/asset-domain'
import type { CreatePrototypeTaskRequest, ProjectState, PrototypeTaskView, UpdatePrototypeClaimsRequest, UpdatePrototypeScopeRequest } from '@eadp/contracts'
import type { PrototypeCollaborationCommand, PrototypeEditBuffer, PrototypeFileCommand, PrototypeFileResult, PrototypeInstructionDraft, PrototypeQueueView } from '../../shared/prototype.ts'
import type { TaskView } from '../../shared/studio.ts'
import { digest } from '../adapters/assets/materials.ts'
import { CollaborationClient, CollaborationError } from '../adapters/collaboration/client.ts'
import { AtomicState } from '../adapters/local-state/atomic-state.ts'
import { readTemplateManifest } from '../prototype/template.js'
import { PrototypeFiles, type PrototypeFileWorkspace } from '../prototype/files.ts'
import type { HostPorts, SessionOutput } from './ports.ts'
import { StudioStore } from './state.ts'
import { resolvePrototypeRequirements } from './prototype-requirement-identities.ts'

type Start = Extract<PrototypeCollaborationCommand, { action: 'startPrototypeCollaboration' }>
type Continue = Extract<PrototypeCollaborationCommand, { action: 'continuePrototypeCollaboration' | 'extendPrototypeDevelopment' }>
type Phase = 'prepared' | 'creating' | 'claimed' | 'scope' | 'workspace' | 'sending' | 'sent' | 'unknown'
interface Operation { id: string; request: Start | Continue; phase: Phase; resolvedRequirementIds?: string[]; create?: CreatePrototypeTaskRequest; claims?: UpdatePrototypeClaimsRequest; scope?: UpdatePrototypeScopeRequest; taskId?: string; message?: string }
interface LocalTask { projectId: string; task: PrototypeTaskView; sessionId: string; worktree: string; sessionOpened?: boolean; state: 'queued' | 'running' | 'awaiting-user' | 'paused' | 'recovery-required'; nextAction?: string; pauseOperationId?: string; endOperationId?: string; gitRecovery?: 'clear' | 'unknown' | 'reconcile-required' }
interface FileSaveOperation { id: string; prototypeTaskId: string; path: string; expectedHash: string; contentHash: string; result?: Extract<PrototypeFileResult, { kind: 'saved' }> }
interface QueueRecord { revision: number; selectedTaskId?: string; tasks: LocalTask[]; operations: Operation[]; queueReorders?: Array<{ id: string; fingerprint: string }>; pauses?: Array<{ id: string; taskId: string; status: 'waiting' | 'settled' }>; drafts?: PrototypeInstructionDraft[]; draftWrites?: Array<{ id: string; fingerprint: string }>; buffers?: PrototypeEditBuffer[]; bufferWrites?: Array<{ id: string; fingerprint: string }>; fileSaves?: FileSaveOperation[] }

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
    return { revision: data.revision, ...(data.selectedTaskId ? { selectedTaskId: data.selectedTaskId } : {}), items: data.tasks.map(item => { const pause = (data.pauses ?? []).findLast(value => value.taskId === item.task.id && value.status === 'waiting'); return { projectId: item.projectId, prototypeTaskId: item.task.id, title: item.task.title, sessionId: item.sessionId, taskStatus: item.task.status, localDispatchState: item.state, ...(item.nextAction ? { nextAction: item.nextAction } : {}), ...(item.gitRecovery ? { gitRecovery: item.gitRecovery } : {}), ...(item.endOperationId ? { endOperationId: item.endOperationId } : {}), ...(pause ? { pauseOperationId: pause.id } : {}), developmentRequirementIds: item.task.developmentRequirementIds } }) }
  }
  cancellation(taskId: string): { projectId: string; task: PrototypeTaskView; sessionId: string; worktree: string } {
    const item = this.record?.tasks.find(value => value.task.id === taskId)
    if (!item) throw new Error('本机未登记该事项')
    return { projectId: item.projectId, task: structuredClone(item.task), sessionId: item.sessionId, worktree: item.worktree }
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
    const result = await this.files.save(workspace, command, () => this.fileWorkspace(command.prototypeTaskId))
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
    return { paths: unique, hash: digest(canonical({ protectedPaths, writablePrefixes: allowed, mergePolicy: PROTOTYPE_MERGE_POLICY })) }
  }
  private localTask(item: LocalTask): TaskView { return { projectId: item.projectId, entityId: item.task.id, purpose: 'prototype', sessionId: item.sessionId, inputHash: '', worktree: item.worktree, baseHead: item.task.sourceBaseHead, writePaths: item.task.writeScope } }
  private async perform<T>(projectId: string, method: 'POST' | 'PUT', endpoint: string, request: { idempotencyKey: string }): Promise<T> {
    try { return (await this.api.request<{ result: T }>('GET', this.route(projectId, `/operations/${encodeURIComponent(request.idempotencyKey)}`))).result }
    catch (error) {
      if (!(error instanceof CollaborationError) || error.code !== 'OPERATION_NOT_FOUND') throw error
      return this.api.request<T>(method, this.route(projectId, endpoint), request)
    }
  }
  /** Persist the user's resolved development targets before any claim or scope mutation. */
  private async identify(operation: Operation, projectId: string, existingIds: string[], explicitIds: string[]): Promise<string[]> {
    if (operation.resolvedRequirementIds) return operation.resolvedRequirementIds
    const accountId = this.store.accountId
    if (!accountId || (await this.ports.account())?.id !== accountId) throw new Error('协同账号已变化')
    const project = await this.api.request<ProjectState>('GET', this.route(projectId, ''))
    if (project.project.id !== projectId || this.store.accountId !== accountId || (await this.ports.account())?.id !== accountId) throw new Error('需求目录或协同账号已变化，原指令已保留')
    const result = await resolvePrototypeRequirements(this.ports, project, operation.request.instruction, existingIds, explicitIds)
    if (this.store.accountId !== accountId || (await this.ports.account())?.id !== accountId) throw new Error('协同账号已变化，原指令已保留')
    operation.resolvedRequirementIds = result; delete operation.message; await this.save()
    return result
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
  private async existingWorkspace(item: LocalTask): Promise<void> {
    const existing = await stat(item.worktree).then(info => info.isDirectory(), error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error })
    if (!existing) throw new Error('原事项现场缺失，已保留记录供核对')
    if ((await this.ports.git.state(item.worktree)).branch !== item.task.branch) throw new Error('事项现场分支已变化，已保留现场')
  }
  async start(command: Start): Promise<void> {
    const data = await this.data(), local = await this.store.read(), accountId = this.store.accountId!
    const manifest = await readTemplateManifest(this.manifest())
    const scope = await this.scope(command.writeScope.length ? command.writeScope : manifest.contract.writablePrefixes)
    let operation = data.operations.find(value => value.id === command.operationId)
    if (operation && canonical(operation.request) !== canonical(command)) throw new Error('同一操作不能绑定不同实现指令')
    if (!operation) {
      operation = { id: command.operationId, request: structuredClone(command), phase: 'prepared' }; data.operations.push(operation); await this.save()
    }
    if (operation.phase === 'unknown' || operation.phase === 'sending') throw new Error('原指令的投递结果未知，请核对消息记录；输入已保留')
    if (operation.phase === 'sent') return
    if (!operation.taskId) {
      const ids = operation.phase === 'creating' && operation.create ? operation.create.developmentRequirementIds : await this.identify(operation, command.projectId, [], command.developmentRequirementIds)
      if (!ids.length) { operation.message = '未识别实际开发需求，请补充需求名称或编号；原指令已保留'; await this.save(); throw new Error(operation.message) }
      if (!operation.create) {
        operation.create = { idempotencyKey: command.operationId, clientId: local.clientId, title: command.title, developmentRequirementIds: ids, referenceRequirementIds: command.referenceRequirementIds.filter(id => !ids.includes(id)), writeScope: scope.paths, policyHash: scope.hash, instruction: { userActionId: command.operationId, summary: '用户发送了原型实现指令' } }
        await this.save()
      } else if (canonical(operation.create.developmentRequirementIds) !== canonical(ids)) throw new Error('原创建操作的需求身份与识别结果不一致，请保留原操作核对')
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
    const requireExisting = item.sessionOpened || data.operations.some(value => value.taskId === item.task.id && ['sending', 'sent', 'unknown'].includes(value.phase))
    await this.ports.session(this.localTask(item), '按用户明确指令实现项目原型。需求材料只读，不自行确认或发布。', requireExisting)
    item.sessionOpened = true; await this.save()
    operation.phase = 'sending'; item.state = 'running'; delete item.nextAction; data.selectedTaskId = item.task.id; await this.save()
    try { await this.ports.prompt(item.sessionId, instruction, operation.id, operation.request.attachments); operation.phase = 'sent'; await this.save() }
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
    const explicitIds = command.action === 'extendPrototypeDevelopment' ? command.developmentRequirementIds : []
    const identified = await this.identify(operation, item.projectId, task.developmentRequirementIds, explicitIds)
    const targets = [...new Set([...task.developmentRequirementIds, ...identified])]
    if (operation.claims || targets.some(id => !task.developmentRequirementIds.includes(id))) {
      const requestedScope = command.action === 'extendPrototypeDevelopment' ? command.writeScope : []
      const scope = await this.scope(requestedScope.length ? requestedScope : task.writeScope), token = () => ({ prototypeTaskId: task.id, generation: task.generation, clientId: task.clientId, expectedRevision: task.revision }), instruction = { userActionId: command.operationId, summary: '用户发送了扩大开发范围的指令' }
      if (operation.phase === 'prepared') {
        operation.claims ??= { idempotencyKey: digest(`${operation.id}:claims`), token: token(), developmentRequirementIds: targets, instruction }
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
  async select(taskId: string, operationId: string): Promise<void> {
    const data = await this.data()
    if (!data.tasks.some(item => item.task.id === taskId)) throw new Error('本机未登记该事项')
    const active = data.tasks.find(item => item.task.id !== taskId && (item.state === 'running' || item.state === 'recovery-required'))
    if (active) {
      const pending = (data.pauses ?? []).findLast(value => value.taskId === active.task.id && value.status === 'waiting')
      if (active.state === 'recovery-required' && !pending) throw new Error('请先核对当前会话执行结果，再切换事项')
      await this.pause(active.task.id, pending?.id ?? operationId)
    }
    data.selectedTaskId = taskId; await this.save()
  }
  /** Reordering changes local scheduling only; the complete account queue prevents losing other projects' items. */
  async reorder(command: Extract<PrototypeCollaborationCommand, { action: 'reorderPrototypeQueue' }>): Promise<void> {
    const data = await this.data(), fingerprint = digest(canonical(command))
    const prior = (data.queueReorders ?? []).find(value => value.id === command.operationId)
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new Error('队列重排操作不能用于其他顺序')
      await this.storage!.write(data)
      return
    }
    if (command.expectedRevision !== data.revision) throw new Error('事项队列已变化，请刷新后重新排序')
    const items = new Map(data.tasks.map(item => [item.task.id, item]))
    if (items.size !== data.tasks.length || command.prototypeTaskIds.length !== items.size || new Set(command.prototypeTaskIds).size !== items.size || command.prototypeTaskIds.some(id => !items.has(id))) throw new Error('队列顺序必须包含本机全部事项')
    data.tasks = command.prototypeTaskIds.map(id => items.get(id)!)
    ;(data.queueReorders ??= []).push({ id: command.operationId, fingerprint })
    await this.save()
  }
  /** Preserve the pause operation before cancelling; a retry only observes its original result. */
  async pause(taskId: string, operationId: string): Promise<void> {
    const data = await this.data(), item = data.tasks.find(value => value.task.id === taskId)
    if (!item) throw new Error('本机未登记该事项')
    let operation = (data.pauses ?? []).find(value => value.id === operationId)
    if (operation && operation.taskId !== taskId) throw new Error('暂停操作不能用于其他事项')
    if (operation?.status === 'settled') return
    const first = !operation
    if (first) {
      if (item.state !== 'running') throw new Error('当前事项没有正在执行的轮次')
      operation = { id: operationId, taskId, status: 'waiting' }
      ;(data.pauses ??= []).push(operation)
      item.state = 'recovery-required'; item.nextAction = '暂停结果待核对，现场和开发占用已保留'; await this.save()
    }
    // A restarted process has no live handle; recover only the original session before observing it.
    if (!first) await this.restoreSession(item.sessionId)
    const settled = await this.ports.settlePrototypeSession(item.sessionId, first)
    if (!settled) { item.state = 'recovery-required'; item.nextAction = '暂停结果待核对，现场和开发占用已保留'; await this.save(); throw new Error(item.nextAction) }
    operation!.status = 'settled'; item.state = 'paused'; item.nextAction = '已暂停，继续时请发送指令'; await this.save()
  }
  /** Keep the original end-operation identity and settle native execution before changing server state. */
  async prepareCancellation(taskId: string, operationId: string): Promise<string> {
    const data = await this.data(), item = data.tasks.find(value => value.task.id === taskId)
    if (!item) throw new Error('本机未登记该事项')
    if (item.endOperationId && item.endOperationId !== operationId) throw new Error('该事项已有结束操作，请核对原操作')
    if (!item.endOperationId) {
      if (item.task.status !== 'active') throw new Error('只有活动事项可以结束')
      item.endOperationId = operationId; item.nextAction = '结束事项操作已保存，正在核对原生执行'; await this.save()
    }
    const pause = (data.pauses ?? []).findLast(value => value.taskId === taskId && value.status === 'waiting')
    if (item.state === 'running' || item.state === 'recovery-required' && pause) await this.pause(taskId, pause?.id ?? operationId)
    else if (item.state === 'recovery-required') throw new Error('请先核对当前会话执行结果，再结束事项')
    return item.endOperationId
  }
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
    const operation = data.operations.find(value => value.taskId === taskId && (value.phase === 'unknown' || value.phase === 'sending'))
      ?? [...data.operations].reverse().find(value => value.taskId === taskId && value.phase === 'sent')
    if (!operation) throw new Error('没有待核对的消息操作')
    const result = await this.ports.inspectPrompt(item.sessionId, operation.id)
    if (result === 'delivered' || result === 'admitted') {
      operation.phase = 'sent'; delete operation.message
      item.nextAction = result === 'delivered' ? '原生记录中已找到该指令；请核对执行结果' : '原指令曾进入原生队列；请核对执行结果'
    } else { operation.phase = 'unknown'; item.nextAction = '消息结果仍未知，原指令未重发' }
    await this.save()
    if (result === 'delivered' && item.state === 'recovery-required') {
      await this.restoreSession(item.sessionId)
      if (await this.ports.settlePrototypeSession(item.sessionId, false)) {
        item.state = 'awaiting-user'; item.nextAction = '原指令已记录，会话已收敛；可继续发送指令'; await this.save()
      }
    }
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
    await this.current(item); await this.existingWorkspace(item); await this.scope(item.task.writeScope)
    return this.ports.session(this.localTask(item), '按用户明确指令实现项目原型。需求材料只读，不自行确认或发布。', true)
  }
  async task(taskId: string): Promise<TaskView> {
    const item = (await this.data()).tasks.find(value => value.task.id === taskId)
    if (!item) throw new Error('本机未登记该事项')
    await this.current(item); await this.existingWorkspace(item); await this.scope(item.task.writeScope)
    return this.localTask(item)
  }
  /** A fixed source must not omit pending editor buffers or an active native turn. */
  async confirmationTask(taskId: string): Promise<{ task: TaskView; authorization: PrototypeTaskView }> {
    const data = await this.data(), item = data.tasks.find(value => value.task.id === taskId)
    if (!item) throw new Error('本机未登记该事项')
    if (item.state === 'running' || item.state === 'recovery-required') throw new Error('请先核对当前会话执行结果')
    if (data.operations.some(value => value.taskId === taskId && value.request.action === 'startPrototypeCollaboration' && value.phase === 'workspace')) throw new Error('首次指令尚未执行，不能固定成果')
    if ((data.buffers ?? []).some(value => value.prototypeTaskId === taskId && value.content !== value.baseContent)) throw new Error('请先保存或保留并处理相关编辑缓冲')
    const authorization = await this.current(item), policy = await this.scope(authorization.writeScope)
    if (policy.hash !== authorization.policyHash) throw new Error('原型模板写入策略已变化，现场已保留')
    await this.existingWorkspace(item)
    return { task: this.localTask(item), authorization: structuredClone(authorization) }
  }
  /** Bind each native write to the task, complete claims and write scope last authorized for this session. */
  async writeAuthorization(localTask: TaskView): Promise<() => Promise<void>> {
    const item = (await this.data()).tasks.find(value => value.task.id === localTask.entityId)
    if (!item || item.projectId !== localTask.projectId || item.sessionId !== localTask.sessionId || path.resolve(item.worktree) !== path.resolve(localTask.worktree) || localTask.purpose !== 'prototype') throw new Error('原型会话与事项现场不一致')
    const binding = (task: PrototypeTaskView) => canonical({ id: task.id, prototypeId: task.prototypeId, ownerId: task.ownerId, clientId: task.clientId, generation: task.generation,
      claims: [...task.developmentClaims].sort((a, b) => a.requirementId.localeCompare(b.requirementId)), claimsDigest: task.claimsDigest,
      requirements: [...task.developmentRequirementIds].sort(), writeScope: [...task.writeScope].sort(), policyHash: task.policyHash })
    const initial = await this.current(item)
    if (canonical([...(localTask.writePaths ?? [])].sort()) !== canonical([...initial.writeScope].sort())) throw new Error('原型会话写入范围与当前事项授权不一致')
    if ((await this.scope(initial.writeScope)).hash !== initial.policyHash) throw new Error('原型模板写入策略已变化，现场已保留')
    const expected = binding(initial)
    return async () => {
      const latest = await this.current(item)
      if (binding(latest) !== expected) throw new Error('事项开发占用或写入范围已变化，原生写入已停止并保留现场')
      if ((await this.scope(latest.writeScope)).hash !== latest.policyHash) throw new Error('原型模板写入策略已变化，现场已保留')
    }
  }
  async sessionId(taskId: string): Promise<string | undefined> { return (await this.data()).tasks.find(value => value.task.id === taskId)?.sessionId }
  /** Persist the backend's accepted fact without deleting the original worktree or session. */
  async accepted(taskId: string, baselineId: string): Promise<void> {
    const accountId = this.store.accountId
    if (!accountId) throw new Error('协同账号已变化，后台接受结果待原账号恢复')
    const data = await this.data(), storage = this.storage, item = data.tasks.find(value => value.task.id === taskId)
    if (!item) throw new Error('原事项本地记录缺失，后台接受事实不受影响')
    const remote = await this.api.request<PrototypeTaskView>('GET', this.route(item.projectId, `/prototype/tasks/${encodeURIComponent(taskId)}`))
    const local = await this.store.read()
    const activeAccount = await this.ports.account()
    if (this.store.accountId !== accountId || this.accountId !== accountId || this.record !== data || this.storage !== storage || activeAccount?.id !== accountId) throw new Error('协同账号已变化，后台接受结果待原账号恢复')
    if (remote.id !== taskId || remote.status !== 'accepted' || remote.ownerId !== accountId || remote.clientId !== local.clientId) throw new Error('后台接受事项身份无法核对')
    item.task = remote; item.state = 'awaiting-user'; item.nextAction = `后台已接受原型基线 ${baselineId}；本机现场已保留`
    if (!storage) throw new Error('事项队列尚未初始化')
    data.revision++; await storage.write(data)
  }
  /** Persist cancellation without deleting the author's worktree, session log or local operation history. */
  async cancelled(taskId: string, gitRecovery: 'clear' | 'unknown' | 'reconcile-required'): Promise<void> {
    const accountId = this.store.accountId
    if (!accountId) throw new Error('协同账号已变化，后台取消结果待原账号恢复')
    const data = await this.data(), storage = this.storage, item = data.tasks.find(value => value.task.id === taskId)
    if (!item) throw new Error('原事项本地记录缺失，后台取消事实不受影响')
    const remote = await this.api.request<PrototypeTaskView>('GET', this.route(item.projectId, `/prototype/tasks/${encodeURIComponent(taskId)}`))
    const local = await this.store.read(), activeAccount = await this.ports.account()
    if (this.store.accountId !== accountId || this.accountId !== accountId || this.record !== data || this.storage !== storage || activeAccount?.id !== accountId) throw new Error('协同账号已变化，后台取消结果待原账号恢复')
    if (remote.id !== taskId || remote.status !== 'cancelled' || remote.ownerId !== accountId || remote.clientId !== local.clientId) throw new Error('后台取消事项身份无法核对')
    item.task = remote; item.state = 'awaiting-user'; item.gitRecovery = gitRecovery
    item.nextAction = gitRecovery === 'clear' ? '事项已结束；本机现场已保留' : `事项已结束；Git 恢复状态为 ${gitRecovery}，本机现场已保留`
    if (!storage) throw new Error('事项队列尚未初始化')
    data.revision++; await storage.write(data)
  }
  async accept(sessionId: string, output: SessionOutput): Promise<boolean> {
    const data = await this.data(), item = data.tasks.find(value => value.sessionId === sessionId)
    if (!item) return false
    if (output.kind === 'turn-ended' && item.state !== 'paused' && !(data.pauses ?? []).some(value => value.taskId === item.task.id && value.status === 'waiting')) {
      const settled = await this.ports.settlePrototypeSession(item.sessionId, false)
      item.state = settled ? 'awaiting-user' : 'recovery-required'
      if (settled) delete item.nextAction; else item.nextAction = '执行收敛或会话保存待核对'
      await this.save()
    }
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
    if (active && 'hash' in scope && scope.hash !== task.policyHash) throw new Error('原型模板写入策略已变化，现场已保留')
    if (task.generation === item.task.generation) item.task = task
    return { source: { kind: 'task', projectId: item.projectId, prototypeTaskId: task.id }, root: path.join(item.worktree, '原型代码'), manifestPath: this.manifest(), writablePaths: scope.paths }
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
