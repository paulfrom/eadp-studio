import { randomUUID } from 'node:crypto'
import type { SessionPromptRequest } from '@deepseek-ai/dsh-api-session-controller'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { canonical, PROTOTYPE_MERGE_POLICY } from '@eadp/asset-domain'
import type { ClaimPrototypeDevelopmentRequest, CreatePrototypeTaskRequest, DevelopmentClaimToken, ProjectState, PrototypeTaskToken, PrototypeTaskView, SynchronizePrototypeDevelopmentRequest } from '@eadp/contracts'
import type { PrototypeCollaborationCommand, PrototypeEditBuffer, PrototypeFileCommand, PrototypeFileResult, PrototypeInstructionDraft, PrototypeQueueView, PrototypeRequirementDevelopmentStage, PrototypeRequirementReviewStatus } from '../../shared/prototype.ts'
import type { TaskView } from '../../shared/studio.ts'
import { digest } from '../adapters/assets/materials.ts'
import { CollaborationClient, CollaborationError } from '../adapters/collaboration/client.ts'
import { ProjectRecord } from '../adapters/project-record.ts'
import { readTemplateManifest } from '../prototype/template.ts'
import { PrototypeFiles, type PrototypeFileWorkspace } from '../prototype/files.ts'
import type { HostPorts, SessionOutput, PrototypeRuntimeAction, PrototypeRuntimeResult } from './ports.ts'
import { StudioStore } from './state.ts'
import { resolvePrototypeRequirements } from './prototype-requirement-identities.ts'
import { runtimeRepairInstruction } from './prototype-runtime-repair.ts'

type Start = Extract<PrototypeCollaborationCommand, { action: 'startPrototypeCollaboration' }>
type Correct = Extract<PrototypeCollaborationCommand, { action: 'correctPrototypeRequirement' }>
type Confirm = Extract<PrototypeCollaborationCommand, { action: 'confirmPrototypeRequirement' }>
type Claim = DevelopmentClaimToken
type TaskToken = PrototypeTaskToken
type CreateRequest = CreatePrototypeTaskRequest
type ClaimRequest = ClaimPrototypeDevelopmentRequest
type SynchronizeRequest = SynchronizePrototypeDevelopmentRequest
type Phase = 'superseded' | 'not-delivered' | 'prepared' | 'creating' | 'claimed' | 'workspace' | 'sending' | 'sent' | 'unknown' | 'fixing' | 'commit-known' | 'pushing' | 'pushed' | 'synchronizing' | 'awaiting-review' | 'confirming' | 'reviewed'
interface Operation {
  runtimeRequest?: true
  parentRunId?: string
  nativePrompt?: SessionPromptRequest
  automaticRepair?: true; id: string; request: Start | Correct | Confirm; phase: Phase; resolvedRequirementIds?: string[]; create?: CreateRequest
  taskId?: string; message?: string; claimRequest?: ClaimRequest; synchronizeRequest?: SynchronizeRequest; commitId?: string; checksPassed?: boolean; turnSeq?: number; turnStartHead?: string; turnStartFingerprint?: string
}
interface RequirementDevelopment {
  entry?: { id: string; phase: 'observed' | 'fetched' | 'updated' | 'synchronized'; target?: string; request?: SynchronizeRequest }
  requirementId: string; runId?: string; stage: PrototypeRequirementDevelopmentStage; reviewStatus: PrototypeRequirementReviewStatus
  startCommitId: string; remoteRef: string; claim?: Claim; claimReleased: boolean; commitId?: string; correction?: string; message?: string; lastTurnSeq?: number
}
/** A native request and its latest real execution receipt, never an assistant's success claim. */
interface RuntimeRun { operationId: string; kind: 'preview' | 'checks'; status: 'pending' | 'running' | 'passed' | 'blocked'; lastAttemptId?: string; sourceFingerprint?: string }
interface LocalTask { runtimeRun?: RuntimeRun; projectId: string; task: PrototypeTaskView; sessionId: string; worktree: string; sessionOpened?: boolean; state: 'queued' | 'running' | 'awaiting-user' | 'paused' | 'recovery-required'; nextAction?: string; pauseOperationId?: string; endOperationId?: string; gitRecovery?: 'clear' | 'unknown' | 'reconcile-required'; development?: RequirementDevelopment }
interface FileSaveOperation { id: string; prototypeTaskId: string; path: string; expectedHash: string; contentHash: string; result?: Extract<PrototypeFileResult, { kind: 'saved' }> }
interface LocalTask { nativeRunId?: string; focusedRequirementId?: string }
interface QueueRecord { revision: number; queueOrder?: string[]; selectedTaskId?: string; tasks: LocalTask[]; operations: Operation[]; queueReorders?: Array<{ id: string; fingerprint: string }>; pauses?: Array<{ id: string; taskId: string; status: 'waiting' | 'settled' }>; drafts?: PrototypeInstructionDraft[]; draftWrites?: Array<{ id: string; fingerprint: string }>; buffers?: PrototypeEditBuffer[]; bufferWrites?: Array<{ id: string; fingerprint: string }>; fileSaves?: FileSaveOperation[] }

/** Local operations retain their exact user instruction and idempotency keys across restart. */
export class PrototypeCollaboration {
  private readonly cancelledWithPendingQueue = new Set<string>()
  private readonly nativeSignals = new Map<string, AbortSignal>()
  private readonly liveClaims = new Map<string, { accountId: number; claim: string }>()
  private readonly files = new PrototypeFiles()
  private record?: QueueRecord
  private accountId?: number
  private projectIdentity?: string
  private storage?: ProjectRecord<QueueRecord>
  private loading: Promise<QueueRecord> | undefined
  constructor(private readonly store: StudioStore, private readonly api: CollaborationClient, private readonly ports: HostPorts, private readonly executeRuntime?: (task: TaskView, kind: 'preview' | 'checks', operationId: string) => Promise<void>) {}
  private route(projectId: string, suffix: string): string { return `/v1/projects/${encodeURIComponent(projectId)}${suffix}` }
  private async data(): Promise<QueueRecord> {
    const account = this.store.accountId
    if (!account) throw new Error('请登录后访问原型事项')
    const projectIdentity = canonical((await this.store.read()).projects.map(project => [project.id, project.workspaceDirectory]).sort())
    if (this.accountId === account && this.loading) return this.loading
    if (this.accountId !== account || this.projectIdentity !== projectIdentity || !this.record) {
      this.projectIdentity = projectIdentity
      this.liveClaims.clear()
      this.accountId = account
      this.storage = new ProjectRecord<QueueRecord>(this.store, 'prototype-queue.json', () => ({ revision: 0, tasks: [], operations: [] }), (value, id) => {
        const tasks = value.tasks.filter(x => x.projectId === id), taskIds = new Set(tasks.map(x => x.task.id))
        return { revision: value.revision, tasks, operations: value.operations.filter(x => ('projectId' in x.request ? x.request.projectId === id : taskIds.has(x.request.prototypeTaskId))),
          drafts: (value.drafts ?? []).filter(x => x.projectId === id), buffers: (value.buffers ?? []).filter(x => taskIds.has(x.prototypeTaskId)),
          pauses: (value.pauses ?? []).filter(x => taskIds.has(x.taskId)), fileSaves: (value.fileSaves ?? []).filter(x => taskIds.has(x.prototypeTaskId)) }
      }, values => ({ revision: Math.max(0, ...values.map(x => x.revision)), tasks: values.flatMap(x => x.tasks), operations: values.flatMap(x => x.operations),
        drafts: values.flatMap(x => x.drafts ?? []), buffers: values.flatMap(x => x.buffers ?? []), pauses: values.flatMap(x => x.pauses ?? []), fileSaves: values.flatMap(x => x.fileSaves ?? []) }), {
        select: value => ({ revision: value.revision, tasks: [], operations: [], queueOrder: value.queueOrder ?? [], ...(value.selectedTaskId ? { selectedTaskId: value.selectedTaskId } : {}), queueReorders: value.queueReorders ?? [], draftWrites: value.draftWrites ?? [], bufferWrites: value.bufferWrites ?? [] }),
        merge: (value, metadata) => ({ ...value, revision: Math.max(value.revision, metadata.revision), queueOrder: metadata.queueOrder ?? [], ...(metadata.selectedTaskId ? { selectedTaskId: metadata.selectedTaskId } : {}), queueReorders: metadata.queueReorders ?? [], draftWrites: metadata.draftWrites ?? [], bufferWrites: metadata.bufferWrites ?? [] }),
      })
      const storage = this.storage
      const loading = (async () => {
        const record = await storage.read() ?? { revision: 0, tasks: [], operations: [] }
        if (this.accountId !== account || this.store.accountId !== account) throw new Error('协同账号已变化')
        this.record = record
        // A previous process cannot establish that a model call has settled.
        let changed = false
        for (const task of record.tasks) if (task.state === 'running') { task.state = 'recovery-required'; task.nextAction = '核对原生会话中的执行结果'; changed = true }
        for (const task of record.tasks) if (task.runtimeRun) { task.runtimeRun.status = 'blocked'; delete task.runtimeRun.sourceFingerprint; task.nextAction = '上次预览进程已结束，现场已保留；核对原会话后可重新运行'; changed = true }
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
    const pending = data.operations.filter(value => !value.taskId && value.phase !== 'superseded' && value.request.action === 'startPrototypeCollaboration').map(value => {
      const request = value.request as Start
      return { projectId: request.projectId, prototypeTaskId: `queued:${value.id}`, title: request.title, taskStatus: 'active' as const, localDispatchState: value.message ? 'recovery-required' as const : 'queued' as const, developmentRequirementIds: request.developmentRequirementIds, ...(request.developmentRequirementIds.length === 1 ? { requirementId: request.developmentRequirementIds[0], developmentStage: value.message ? 'blocked' as const : 'queued' as const, reviewStatus: 'pending' as const } : {}), pendingCreation: true, nextAction: value.message ?? '已保存，等待前一项完成' }
    })
    const projectId = (await this.store.read()).selectedProjectId
    const items = data.tasks.map<PrototypeQueueView['items'][number]>(item => {
      const pause = (data.pauses ?? []).findLast(value => value.taskId === item.task.id && value.status === 'waiting')
      const confirmation = data.operations.findLast(value => value.taskId === item.task.id && value.request.action === 'confirmPrototypeRequirement' && value.phase !== 'reviewed')
      const development = item.development
      const native = data.operations.findLast(value => value.taskId === item.task.id && value.nativePrompt && ['prepared', 'sending', 'unknown', 'not-delivered'].includes(value.phase))
      return {
        projectId: item.projectId, prototypeTaskId: item.task.id, title: item.task.title, sessionId: item.sessionId,
        taskStatus: item.task.status, localDispatchState: item.state, developmentRequirementIds: item.task.developmentRequirementIds,
        ...(item.nextAction ? { nextAction: item.nextAction } : {}),
        ...(item.gitRecovery ? { gitRecovery: item.gitRecovery } : {}),
        ...(item.endOperationId ? { endOperationId: item.endOperationId } : {}),
        ...(item.focusedRequirementId ? { focusedRequirementId: item.focusedRequirementId } : {}),
        ...(pause ? { pauseOperationId: pause.id } : {}),
        ...(confirmation ? { pendingConfirmationOperationId: confirmation.id } : {}),
        ...(native ? { pendingNativePromptOperationId: native.id, nativePromptDelivery: native.phase === 'not-delivered' ? 'not-delivered' as const : 'unknown' as const } : {}),
        ...(development ? { requirementId: development.requirementId, developmentStage: development.stage, reviewStatus: development.reviewStatus,
          ...(development.commitId ? { commitId: development.commitId } : {}) } : {}),
      }
    }).concat(pending).sort((a, b) => this.queuePosition(data, a.prototypeTaskId) - this.queuePosition(data, b.prototypeTaskId))
    const visible = projectId ? items.filter(item => item.projectId === projectId) : items
    const selectedTaskId = visible.find(item => item.prototypeTaskId === data.selectedTaskId)?.prototypeTaskId ?? visible[0]?.prototypeTaskId
    return { revision: data.revision, ...(selectedTaskId ? { selectedTaskId } : {}), items }
  }
  private queuePosition(data: QueueRecord, id: string): number {
    const index = data.queueOrder?.indexOf(id) ?? -1
    return index < 0 ? Number.MAX_SAFE_INTEGER : index
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
    const previous = drafts[index]
    if (previous?.pendingStartOperationId && canonical(previous) !== canonical(draft)) {
      const pending = data.operations.find(value => value.id === previous.pendingStartOperationId)
      if (pending && (pending.phase !== 'prepared' || pending.create || pending.taskId)) throw new Error('原发送结果尚未核清，请先核对原发送操作，草稿已保留')
    }
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
    if (this.hasLiveClaim(item)) return item.task
    const task = await this.api.request<PrototypeTaskView>('GET', this.route(item.projectId, `/prototype/tasks/${encodeURIComponent(item.task.id)}`))
    const account = this.store.accountId, local = await this.store.read(), development = item.development
    if (task.status !== 'active' || task.ownerId !== account || task.clientId !== local.clientId || task.generation !== item.task.generation || !development && !task.developmentClaims.length || development && development.remoteRef !== `refs/heads/${task.branch}`) throw new Error('事项开发占用已变化，现场已保留')
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
  /** Focus narrows the conversation topic without changing the authorized project or write scope. */
  private sessionRules(item: LocalTask): string {
    const focus = item.focusedRequirementId ?? item.development?.requirementId ?? item.task.developmentRequirementIds[0]
    return '按用户明确指令实现项目原型。需求材料只读，不自行确认、集成、发布或生成基线。'
      + (focus ? `\n本次会话以需求 ${focus} 为当前业务上下文；实现前读取该需求及相关材料。切换关注需求不扩大已有开发授权。` : '')
  }
  private async performKeyed<T>(projectId: string, endpoint: string, request: { key: string }): Promise<T> {
    try { return (await this.api.request<{ result: T }>('GET', this.route(projectId, `/operations/${encodeURIComponent(request.key)}`))).result }
    catch (error) {
      if (!(error instanceof CollaborationError) || error.code !== 'OPERATION_NOT_FOUND') throw error
      return this.api.request<T>('POST', this.route(projectId, endpoint), request)
    }
  }
  private token(task: PrototypeTaskView): TaskToken { return { prototypeTaskId: task.id, generation: task.generation, clientId: task.clientId, expectedRevision: task.revision } }
  private async remoteClaim(item: LocalTask): Promise<Claim | null> {
    const development = item.development!
    const claim = await this.api.request<Claim | null>('GET', this.route(item.projectId, `/prototype/requirements/${encodeURIComponent(development.requirementId)}/development-claim`))
    return claim ? { requirementId: claim.requirementId, claimId: claim.claimId, generation: claim.generation } : null
  }
  private async requireClaim(item: LocalTask): Promise<Claim> {
    if (!item.development?.claim || !this.hasLiveClaim(item)) throw new Error('开发段许可已失效，请显式进入或恢复会话')
    return item.development.claim
  }
  /** Only an explicit development entry or recovery may grant process-local write authority. */
  private async enterClaimedSegment(item: LocalTask): Promise<Claim> {
    const development = item.development!, expected = development.claim
    if (expected && this.hasLiveClaim(item)) return expected
    await this.current(item)
    const observed = expected && !development.claimReleased ? await this.api.request<import('@eadp/contracts').DevelopmentClaimView | null>('GET', this.route(item.projectId, `/prototype/requirements/${encodeURIComponent(development.requirementId)}/development-claim`)) : undefined
    const current = observed ? { requirementId: observed.requirementId, claimId: observed.claimId, generation: observed.generation } : undefined
    if (!expected || development.claimReleased || !current || canonical(current) !== canonical(expected)) throw new Error('需求开发占用已变化，代码写入已停止并保留现场')
    if (observed) await this.synchronizeEntry(item, observed)
    this.liveClaims.set(item.task.id, { accountId: this.store.accountId!, claim: canonical(expected) })
    return current
  }
  /** A process-local development segment never survives pause, release, or account changes. */
  private hasLiveClaim(item: LocalTask): boolean {
    const permit = this.liveClaims.get(item.task.id), development = item.development
    if (!development) return !!permit && permit.accountId === this.store.accountId && item.task.status === 'active' && item.state !== 'paused' && !item.endOperationId && permit.claim === canonical(item.task.developmentClaims)
    return !!permit && permit.accountId === this.store.accountId && !!development?.claim && !development.claimReleased && item.state !== 'paused' && !item.endOperationId && permit.claim === canonical(development.claim)
  }
  /** Reconcile only the managed result branch, retaining dirty and divergent work for explicit recovery. */
  private async synchronizeEntry(item: LocalTask, claim: import('@eadp/contracts').DevelopmentClaimView): Promise<void> {
    const development = item.development!, data = await this.data()
    if (claim.remoteRef !== development.remoteRef) throw new Error('需求成果引用与事项不一致，现场已保留')
    const state = await this.ports.git.state(item.worktree)
    if (state.branch !== item.task.branch) throw new Error('事项现场分支已变化，已保留现场')
    let entry = development.entry
    if (!entry || entry.phase === 'synchronized') {
      if (claim.commitId === state.head) return
      entry = development.entry = { id: randomUUID(), phase: 'observed' }; await this.save()
    }
    if (state.dirty || (data.buffers ?? []).some(buffer => buffer.prototypeTaskId === item.task.id && buffer.content !== buffer.baseContent)) throw new Error('现场存在未提交修改或编辑缓冲，已保留；请处理后恢复同步')
    if (entry.phase === 'observed') {
      await this.ports.git.fetch(item.worktree, item.task.branch)
      entry.target = await this.ports.git.remoteHead(item.worktree, item.task.branch)
      entry.phase = 'fetched'; await this.save()
    }
    if (entry.phase === 'fetched') {
      if (!entry.target) throw new Error('受管分支同步目标缺失，已保留现场')
      await this.ports.git.fastForward(item.worktree, entry.target)
      entry.phase = 'updated'; await this.save()
    }
    if (entry.phase === 'updated') {
      const head = (await this.ports.git.state(item.worktree)).head
      if (head !== entry.target) throw new Error('受管分支同步后现场发生变化，请先核对')
      if (head !== claim.commitId) {
        entry.request ??= { key: digest(`${entry.id}:entry-sync`), token: this.token(item.task), claim: development.claim!, commitId: head, remoteRef: development.remoteRef, release: false }
        await this.save()
        await this.performKeyed(item.projectId, `/prototype/tasks/${encodeURIComponent(item.task.id)}/development-claims/${encodeURIComponent(development.requirementId)}/synchronize`, entry.request)
      }
      entry.phase = 'synchronized'; await this.save()
    }
  }
  /** Persist the user's resolved development targets before any claim or scope mutation. */
  private async identify(operation: Operation, projectId: string, existingIds: string[], explicitIds: string[]): Promise<string[]> {
    if (!('instruction' in operation.request)) throw new Error('该操作没有需求识别指令')
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
  async start(command: Start, select = false): Promise<void> {
    try {
      if (select) {
        const current = await this.data()
        const draft = current.drafts?.find(value => value.projectId === command.projectId && !value.prototypeTaskId)
        if (draft?.pendingStartOperationId && draft.pendingStartOperationId !== command.operationId) throw new Error('原指令仍有待核对的发送操作，请沿用原操作继续')
        const operation = await this.recordStart(command)
        const data = await this.data()
        data.selectedTaskId = operation.taskId ?? `queued:${operation.id}`; await this.save()
      }
      await this.startQueued(command)
      // Admission is durable even when the new task is waiting in the local queue.
      const data = await this.data(), index = (data.drafts ?? []).findIndex(draft => draft.projectId === command.projectId && !draft.prototypeTaskId && draft.pendingStartOperationId === command.operationId)
      if (index >= 0) {
        data.drafts![index] = { projectId: command.projectId, title: '', instruction: '', developmentRequirementIds: [] }
        await this.save()
      }
    }
    catch (error) {
      const operation = (await this.data()).operations.find(value => value.id === command.operationId)
      if (operation && !operation.taskId) { operation.message = error instanceof Error ? error.message : '需求开发领取待恢复'; await this.save() }
      throw error
    }
  }
  /** Enter the existing requirement workspace, or retain one durable queued start for it. */
  async enterRequirement(command: Start): Promise<void> {
    const requirementId = command.developmentRequirementIds[0]
    if (!requirementId || command.developmentRequirementIds.length !== 1) throw new Error('进入需求开发必须指定一个实际需求')
    const data = await this.data()
    const existing = data.tasks.findLast(value => value.projectId === command.projectId && value.task.status === 'active' && (value.development?.requirementId === requirementId || value.task.developmentRequirementIds.includes(requirementId)))
    if (existing) {
      await this.select(existing.task.id, command.operationId)
      existing.focusedRequirementId = requirementId; await this.save()
      const first = data.operations.find(value => value.taskId === existing.task.id && value.request.action === 'startPrototypeCollaboration' && ['claimed', 'workspace'].includes(value.phase))
      if (existing.state === 'queued' && first?.request.action === 'startPrototypeCollaboration') await this.start(first.request)
      if (existing.sessionOpened) await this.restoreSession(existing.sessionId)
      return
    }
    if (await this.restoreClaimedRequirement(command.projectId, requirementId)) return
    const pending = data.operations.find(value => !value.taskId && value.phase !== 'superseded' && value.request.action === 'startPrototypeCollaboration' && value.request.projectId === command.projectId && (value.resolvedRequirementIds ?? value.request.developmentRequirementIds).includes(requirementId))
    const start = pending?.request.action === 'startPrototypeCollaboration' ? pending.request : command
    if (!pending) await this.recordStart(start, [requirementId])
    data.selectedTaskId = `queued:${start.operationId}`; await this.save()
    await this.start(start)
  }
  /** Reattach an owned remote task to its existing local worktree and persisted conversation. */
  private async restoreClaimedRequirement(projectId: string, requirementId: string): Promise<boolean> {
    const claim = await this.api.request<import('@eadp/contracts').DevelopmentClaimView | null>('GET', this.route(projectId, `/prototype/requirements/${encodeURIComponent(requirementId)}/development-claim`))
    if (!claim) return false
    if (!claim.active || !claim.taskId) throw new Error('需求仍有开发占用，但缺少可恢复的事项；请在诊断中核对原占用')
    const data = await this.data(), local = await this.store.read(), accountId = this.store.accountId
    const task = await this.api.request<PrototypeTaskView>('GET', this.route(projectId, `/prototype/tasks/${encodeURIComponent(claim.taskId)}`))
    const token = { requirementId, claimId: claim.claimId, generation: claim.generation }
    if (task.id !== claim.taskId || task.status !== 'active' || task.ownerId !== accountId || task.clientId !== local.clientId || !task.developmentClaims.some(value => canonical(value) === canonical(token)) || claim.remoteRef !== `refs/heads/${task.branch}`) throw new Error('需求由其他账号、设备或开发代次占用，原现场已保留')
    const scope = await this.scope(task.writeScope)
    if (scope.hash !== task.policyHash) throw new Error('原事项写入策略已变化，现场已保留')
    const worktree = path.join(await this.store.projectDirectory(projectId), 'worktrees', task.id)
    const sessions = await this.ports.findPrototypeSessions(worktree)
    if (sessions.length !== 1) throw new Error('无法唯一定位原事项的持久会话，工作现场已保留')
    const item: LocalTask = { projectId, task, worktree, sessionId: sessions[0]!, sessionOpened: true, state: 'awaiting-user', focusedRequirementId: requirementId,
      nextAction: '已找回原开发现场和会话，可以继续修改或运行；此前未登记的执行结果未记为成功',
      development: { requirementId, stage: 'blocked', reviewStatus: 'correcting', startCommitId: task.startHead, remoteRef: claim.remoteRef, claim: token, claimReleased: false } }
    await this.existingWorkspace(item)
    if (this.store.accountId !== accountId) throw new Error('协同账号已变化，恢复已停止')
    // A failed replacement start is retained as history, never treated as an admitted native request.
    for (const operation of data.operations) if (!operation.taskId && operation.request.action === 'startPrototypeCollaboration' && operation.request.projectId === projectId && (operation.resolvedRequirementIds ?? operation.request.developmentRequirementIds).includes(requirementId)) {
      operation.phase = 'superseded'; operation.message = '已找回原事项，此新建请求未发送'
      if (data.queueOrder) data.queueOrder = data.queueOrder.filter(id => id !== `queued:${operation.id}`)
    }
    data.tasks.push(item); (data.queueOrder ??= []).push(task.id); data.selectedTaskId = task.id
    await this.save()
    await this.ports.session(this.localTask(item), this.sessionRules(item), true)
    if (!await this.ports.settlePrototypeSession(item.sessionId, false)) throw new Error('原会话尚未收敛，现场已保留，请等待后重新进入')
    return true
  }
  /** Preserve one exact start identity before either structured entry or free-form dispatch. */
  private async recordStart(command: Start, resolvedRequirementIds?: string[]): Promise<Operation> {
    const data = await this.data(), existing = data.operations.find(value => value.id === command.operationId)
    if (existing) {
      if (canonical(existing.request) !== canonical(command)) throw new Error('同一操作不能绑定不同实现指令')
      return existing
    }
    const operation: Operation = { id: command.operationId, request: structuredClone(command), phase: 'prepared', ...(resolvedRequirementIds ? { resolvedRequirementIds } : {}) }
    data.operations.push(operation)
    data.queueOrder ??= data.tasks.map(value => value.task.id)
    data.queueOrder.push(`queued:${operation.id}`); await this.save()
    return operation
  }
  private async startQueued(command: Start): Promise<void> {
    const data = await this.data(), local = await this.store.read(), accountId = this.store.accountId!
    let operation = data.operations.find(value => value.id === command.operationId)
    const draft = data.drafts?.find(value => value.projectId === command.projectId && !value.prototypeTaskId)
    if (!operation && draft?.pendingStartOperationId && draft.pendingStartOperationId !== command.operationId) throw new Error('原指令仍有待核对的发送操作，请沿用原操作继续')
    if (operation && canonical(operation.request) !== canonical(command)) throw new Error('同一操作不能绑定不同实现指令')
    const existingTask = operation?.taskId ? data.tasks.find(value => value.task.id === operation!.taskId) : undefined
    if (existingTask?.development && existingTask.development.runId !== operation!.id) return
    if (!operation) operation = await this.recordStart(command)
    if (operation.phase === 'superseded') throw new Error('此新建请求已由找回的原事项替代，请继续原会话')
    if (!operation.taskId && data.tasks.some(value => value.state === 'running' || value.state === 'recovery-required' || value.state === 'queued' && value.development && this.queuePosition(data, value.task.id) < this.queuePosition(data, `queued:${operation!.id}`))) return
    if (!operation.taskId && data.operations.some(value => value !== operation && !value.taskId && value.phase !== 'superseded' && value.request.action === 'startPrototypeCollaboration' && ['prepared', 'creating'].includes(value.phase) && this.queuePosition(data, `queued:${value.id}`) < this.queuePosition(data, `queued:${operation!.id}`))) return
    const manifest = await readTemplateManifest(this.manifest())
    const scope = await this.scope(command.writeScope.length ? command.writeScope : manifest.contract.writablePrefixes)
    if (operation.phase === 'unknown' || operation.phase === 'sending') throw new Error('原指令的投递结果未知，请核对消息记录；输入已保留')
    if (operation.taskId && !['claimed', 'workspace'].includes(operation.phase)) return
    if (!operation.taskId) {
      const ids = operation.phase === 'creating' && operation.create ? operation.create.developmentRequirementIds : await this.identify(operation, command.projectId, [], command.developmentRequirementIds)
      if (!ids.length) { operation.message = '未识别实际开发需求，请补充需求名称或编号；原指令已保留'; await this.save(); throw new Error(operation.message) }
      if (!operation.create) {
        const remote = await this.api.request<ProjectState>('GET', this.route(command.projectId, ''))
        if (!remote.project.recognizedHead) throw new Error('项目尚未形成可开发的固定起点')
        operation.create = { idempotencyKey: command.operationId, clientId: local.clientId, title: command.title, developmentRequirementIds: ids, referenceRequirementIds: command.referenceRequirementIds.filter(id => !ids.includes(id)), writeScope: scope.paths, policyHash: scope.hash, instruction: { userActionId: command.operationId, summary: '用户发送了原型实现指令' }, commitId: remote.project.recognizedHead, remoteRef: `refs/heads/studio/prototype/${operation.id}` }
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
      if (task.startHead !== operation.create.commitId || `refs/heads/${task.branch}` !== operation.create.remoteRef) throw new Error('后台事项分支或开发起点与原请求不一致，现场已保留')
      operation.taskId = task.id; operation.phase = 'claimed'
      if (data.selectedTaskId === `queued:${operation.id}`) data.selectedTaskId = task.id
      data.queueOrder = (data.queueOrder ?? []).map(id => id === `queued:${operation!.id}` ? task.id : id)
      const claim = ids.length === 1 ? task.developmentClaims.find(value => value.requirementId === ids[0]) : undefined
      if (ids.length === 1 && !claim) throw new Error('后台未返回需求开发占用，不能开始写入')
      const development: RequirementDevelopment | undefined = ids.length === 1 ? { requirementId: ids[0]!, runId: operation.id, stage: 'queued', reviewStatus: 'pending', startCommitId: task.startHead, remoteRef: operation.create.remoteRef, claim: claim!, claimReleased: false } : undefined
      data.tasks.push({ projectId: command.projectId, task, sessionId: `studio-${randomUUID()}`, worktree: path.join(await this.store.projectDirectory(command.projectId), 'worktrees', task.id), state: 'queued', ...(development ? { development } : {}) })
      await this.save()
    }
    const item = data.tasks.find(value => value.task.id === operation!.taskId)
    if (!item) throw new Error('事项本地记录不存在')
    await this.current(item); await this.workspace(item); operation.phase = 'workspace'; await this.save()
    if (data.tasks.some(value => value !== item && (value.state === 'running' || value.state === 'recovery-required'))) { item.nextAction = item.development ? '首次指令已保存，等待前一项完成' : '首次指令已保存，等待手动继续'; await this.save(); return }
    await this.dispatch(item, operation, command.instruction)
  }
  private async dispatch(item: LocalTask, operation: Operation, instruction: string): Promise<void> {
    const data = await this.data()
    if (data.tasks.some(value => value !== item && (value.state === 'running' || value.state === 'recovery-required'))) { item.state = 'queued'; item.nextAction = item.development ? '等待前一项完成' : '等待手动继续'; await this.save(); return }
    await this.current(item); await this.scope(item.task.writeScope)
    if (!item.development) this.liveClaims.set(item.task.id, { accountId: this.store.accountId!, claim: canonical(item.task.developmentClaims) })
    if (item.development) { await this.enterClaimedSegment(item); item.development.runId = operation.id; item.development.stage = 'sending'; item.development.reviewStatus = operation.request.action === 'correctPrototypeRequirement' ? 'correcting' : 'pending' }
    const requireExisting = item.sessionOpened || data.operations.some(value => value.taskId === item.task.id && ['sending', 'sent', 'unknown'].includes(value.phase))
    await this.ports.session(this.localTask(item), this.sessionRules(item), requireExisting)
    item.sessionOpened = true; await this.save()
    if (item.development) { operation.turnStartHead = (await this.ports.git.state(item.worktree)).head; operation.turnStartFingerprint = await this.ports.git.workingFingerprint(item.worktree) }
    operation.phase = 'sending'; item.state = 'running'; item.nativeRunId = operation.id; delete item.nextAction
    if (!data.selectedTaskId || data.selectedTaskId === `queued:${operation.id}`) data.selectedTaskId = item.task.id
    await this.save()
    const attachments = 'attachments' in operation.request ? operation.request.attachments : undefined
    try {
      if (operation.nativePrompt) {
        if (!this.ports.nativePrototypePrompt) throw new Error('原生消息发送服务不可用')
        const signal = this.nativeSignals.get(operation.id)
        signal?.throwIfAborted()
        await this.ports.nativePrototypePrompt(operation.nativePrompt, signal)
      } else await this.ports.prompt(item.sessionId, instruction, operation.id, attachments)
      operation.phase = 'sent'; if (operation.runtimeRequest) item.nextAction = 'AI 正在运行工程，可在当前对话中查看进展'; if (item.development) item.development.stage = 'developing'; await this.save()
    } catch (error) {
      this.liveClaims.delete(item.task.id)
      operation.phase = 'unknown'; item.state = 'recovery-required'; item.nextAction = '核对原生会话中的消息结果'; operation.message = error instanceof Error ? error.message : '消息投递结果未知'
      if (item.development) { item.development.stage = 'sending'; item.development.message = operation.message }
      await this.save(); throw error
    }
  }
  private async claimForRun(item: LocalTask, operation: Operation): Promise<void> {
    const development = item.development!
    try {
      await this.current(item); await this.existingWorkspace(item)
      const commitId = (await this.ports.git.state(item.worktree)).head
      operation.claimRequest ??= { key: digest(`${operation.id}:claim`), token: this.token(item.task), requirementId: development.requirementId, commitId, remoteRef: development.remoteRef }
      development.stage = 'claiming'; development.runId = operation.id; await this.save()
      const claimed = await this.performKeyed<Claim>(item.projectId, `/prototype/tasks/${encodeURIComponent(item.task.id)}/development-claims`, operation.claimRequest)
      if (claimed.requirementId !== development.requirementId || !claimed.claimId || !Number.isSafeInteger(claimed.generation) || claimed.generation < 1) throw new Error('后台返回的需求开发占用无效')
      const claim: Claim = { requirementId: claimed.requirementId, claimId: claimed.claimId, generation: claimed.generation }
      development.claim = claim; development.claimReleased = false; development.stage = 'queued'; development.reviewStatus = 'correcting'; operation.phase = 'claimed'
      item.task.developmentRequirementIds = [development.requirementId]; item.task.developmentClaims = [claim]
      delete development.message; await this.save()
    } catch (error) {
      development.stage = 'blocked'; development.message = error instanceof Error ? error.message : '需求开发领取结果未知'
      item.state = 'recovery-required'; item.nextAction = development.message
      await this.save(); throw error
    }
  }
  /** Queue edits cannot revive a paused or released development segment. */
  invalidateNativeSession(sessionId: string): void {
    const item = this.record?.tasks.find(value => value.sessionId === sessionId)
    if (item && this.hasLiveClaim(item) && this.ports.hasPendingPrototypeMessages?.(sessionId)) { this.cancelledWithPendingQueue.add(sessionId); return }
    if (item) this.liveClaims.delete(item.task.id)
  }
  async nativeControl(sessionId: string, action: 'updateQueue' | 'cancel'): Promise<void> {
    const item = (await this.data()).tasks.find(value => value.sessionId === sessionId)
    if (!item) return
    if (action === 'cancel') { this.liveClaims.delete(item.task.id); return }
    if (!this.hasLiveClaim(item) || item.state !== 'running') throw new Error('原生队列仅可在有效开发段中调整；请先恢复当前事项')
  }
  /** Persist native identity and exact content before entering the authorized development segment. */
  async nativePrompt(request: SessionPromptRequest, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted()
    const data = await this.data(), item = data.tasks.find(value => value.sessionId === request.sessionId)
    if (!item) return false
    if (!request.content.some(part => part.type !== 'text' || part.text.trim())) throw new Error('请输入开发指令或附件')
    const prior = data.operations.find(value => value.id === request.requestId)
    if (prior) {
      if (canonical(prior.nativePrompt) !== canonical(request)) throw new Error('原生消息身份不能用于不同内容')
      if (['sent', 'fixing', 'commit-known', 'pushing', 'pushed', 'synchronizing', 'awaiting-review', 'confirming', 'reviewed'].includes(prior.phase)) return true
      if (['prepared', 'sending', 'unknown'].includes(prior.phase)) {
        const delivery = await this.ports.inspectPrompt(item.sessionId, prior.id)
        if (delivery === 'delivered' || delivery === 'admitted') { prior.phase = 'sent'; await this.save(); return true }
        if (delivery === 'absent') { prior.phase = 'not-delivered'; await this.save(); throw new Error('已核对原消息尚未投递，内容已保留；请明确重试发送') }
      }
      if (prior.phase === 'not-delivered' && !prior.parentRunId) {
        if (prior.request.action !== 'correctPrototypeRequirement') throw new Error('原生开发操作类型不一致')
        this.nativeSignals.set(request.requestId, signal)
        prior.phase = 'prepared'; await this.save()
        if (item.development) await this.correct(prior.request)
        else await this.dispatch(item, prior, prior.request.instruction)
        if (data.operations.find(value => value.id === prior.id)?.phase !== 'sent') throw new Error('原生重试尚未确认进入会话，原操作已保留')
        return true
      }
      throw new Error('原生发送结果待恢复核对，请保留原消息，勿重复发送')
    }
    const continuedFirst = item.development && !item.development.claimReleased && item.state === 'awaiting-user' && item.development.stage === 'developing' && item.development.reviewStatus === 'pending'
      && data.operations.some(value => value.id === item.development!.runId && value.request.action === 'startPrototypeCollaboration' && value.phase === 'sent')
    if (continuedFirst) {
      await this.enterClaimedSegment(item)
      await this.ports.session(this.localTask(item), this.sessionRules(item), true)
      item.state = 'running'; await this.save()
    }
    if (data.tasks.some(value => value !== item && (value.state === 'running' || value.state === 'recovery-required')) || item.state === 'recovery-required') throw new Error('请等待当前开发完成或恢复后，再发送下一轮指令')
    if (item.state === 'running' && !this.hasLiveClaim(item)) throw new Error('当前开发段许可已失效，请先恢复会话')
    const command: Correct = { action: 'correctPrototypeRequirement', prototypeTaskId: item.task.id, operationId: request.requestId, instruction: request.content.filter(part => part.type === 'text').map(part => part.text).join('\n') }
    const operation: Operation = { id: request.requestId, request: command, nativePrompt: structuredClone(request), taskId: item.task.id, phase: 'prepared' }
    if (item.state === 'running') {
      const parentRunId = item.development?.runId ?? item.nativeRunId
      if (!parentRunId) throw new Error('当前原生开发段记录缺失，请先恢复事项')
      operation.parentRunId = parentRunId
    }
    if (item.state !== 'running' && !item.development) { item.nativeRunId = operation.id; item.state = 'queued' }
    if (item.state !== 'running' && item.development) { item.development.runId = operation.id; item.development.stage = 'queued' }
    this.nativeSignals.set(request.requestId, signal)
    data.operations.push(operation); await this.save()
    if (item.state === 'running') {
      if (!this.ports.nativePrototypePrompt) throw new Error('原生消息发送服务不可用')
      operation.phase = 'sending'; await this.save()
      try { signal.throwIfAborted(); await this.ports.nativePrototypePrompt(request, signal); operation.phase = 'sent'; await this.save(); return true }
      catch (error) { operation.phase = 'unknown'; item.state = 'recovery-required'; this.liveClaims.delete(item.task.id); await this.save(); throw error }
    }
    if (item.development) await this.correct(command)
    else await this.dispatch(item, operation, command.instruction)
    if (operation.phase !== 'sent') throw new Error('原生指令已保留，尚未确认进入会话，请先恢复核对')
    return true
  }
  /** Explicit recovery reuses the durable native identity and never guesses delivery from message text. */
  async retryNativePrompt(taskId: string, operationId: string): Promise<void> {
    const data = await this.data(), item = data.tasks.find(value => value.task.id === taskId)
    const operation = data.operations.find(value => value.id === operationId && value.taskId === taskId)
    if (!item || !operation?.nativePrompt) throw new Error('原生消息恢复记录不存在')
    const delivery = await this.ports.inspectPrompt(item.sessionId, operation.id)
    if (delivery === 'unknown') throw new Error('原生消息结果仍未知，原指令未重发')
    if (delivery === 'delivered' || delivery === 'admitted') {
      if (['prepared', 'sending', 'unknown', 'not-delivered'].includes(operation.phase)) { operation.phase = 'sent'; await this.save() }
      if (item.state === 'recovery-required') await this.restoreSession(item.sessionId)
      return
    }
    if (!['prepared', 'sending', 'unknown', 'not-delivered'].includes(operation.phase)) throw new Error('已完成操作的投递记录缺失，现场已保留')
    operation.phase = 'not-delivered'; await this.save()
    const parent = operation.parentRunId
    const activeParent = parent && parent === (item.development?.runId ?? item.nativeRunId) && data.operations.some(value => value.id === parent && value.phase === 'sent') && (!item.development || !item.development.claimReleased)
    if (activeParent) {
      if (item.state !== 'running') { item.state = 'recovery-required'; await this.save(); await this.restoreSession(item.sessionId) }
      if (!this.hasLiveClaim(item) || !this.ports.nativePrototypePrompt) throw new Error('原开发段许可不可用，原消息已保留')
      operation.phase = 'sending'; await this.save()
      try { await this.ports.nativePrototypePrompt(operation.nativePrompt); operation.phase = 'sent'; await this.save(); return }
      catch (error) { operation.phase = 'unknown'; item.state = 'recovery-required'; this.liveClaims.delete(item.task.id); await this.save(); throw error }
    }
    if (item.state === 'running' || !await this.ports.settlePrototypeSession(item.sessionId, false)) throw new Error('请先等待当前会话收敛再恢复原消息')
    delete operation.parentRunId
    item.state = 'awaiting-user'; await this.save()
    await this.nativePrompt(operation.nativePrompt, new AbortController().signal)
  }
  async correct(command: Correct): Promise<void> {
    const data = await this.data(), item = data.tasks.find(value => value.task.id === command.prototypeTaskId), development = item?.development
    if (!item || !development) throw new Error('本机未登记该需求开发事项')
    let operation = data.operations.find(value => value.id === command.operationId)
    if (operation && canonical(operation.request) !== canonical(command)) throw new Error('同一操作不能绑定不同纠偏指令')
    if (!operation) {
      operation = { id: command.operationId, request: structuredClone(command), taskId: item.task.id, phase: 'prepared' }
      data.operations.push(operation); development.correction = command.instruction; await this.save()
    }
    if (item.state === 'running' || item.state === 'recovery-required' && development.stage !== 'blocked') throw new Error('请先核对当前会话执行结果；纠偏输入已保留')
    development.runId = operation.id; development.stage = 'queued'; development.reviewStatus = 'correcting'
    item.state = 'queued'; item.nextAction = '纠偏输入已保存，等待开发队列'; await this.save()
    if (data.tasks.some(value => value !== item && (value.state === 'running' || value.state === 'recovery-required'))) return
    await this.prepareCorrection(item, operation); await this.dispatch(item, operation, command.instruction)
  }
  private async prepareCorrection(item: LocalTask, operation: Operation): Promise<void> {
    if (item.development?.claim && !item.development.claimReleased) { await this.enterClaimedSegment(item); operation.phase = 'claimed'; await this.save(); return }
    await this.claimForRun(item, operation)
  }
  private async advanceQueue(): Promise<void> {
    const data = await this.data()
    if (data.tasks.some(value => value.state === 'running' || value.state === 'recovery-required')) return
    const candidates: Array<{ id: string; item: LocalTask } | { id: string; operation: Operation }> = [...data.tasks.filter(item => item.development && item.state === 'queued').map(item => ({ id: item.task.id, item })), ...data.operations.filter(value => !value.taskId && value.phase !== 'superseded' && value.request.action === 'startPrototypeCollaboration' && ['prepared', 'creating'].includes(value.phase)).map(operation => ({ id: `queued:${operation.id}`, operation }))].sort((a, b) => this.queuePosition(data, a.id) - this.queuePosition(data, b.id))
    for (const candidate of candidates) {
      if ('operation' in candidate) {
        const pending = candidate.operation
        if (pending.request.action === 'startPrototypeCollaboration') {
          try { await this.start(pending.request); delete pending.message }
          catch (error) { pending.message = error instanceof Error ? error.message : '需求开发领取待恢复'; await this.save() }
        }
        return
      }
      const item = candidate.item, development = item.development
      if (!development) continue
      const operation = data.operations.find(value => value.id === development.runId)
      if (!operation) throw new Error('需求开发操作记录缺失，队列已停止')
      if (operation.phase === 'workspace' && operation.request.action === 'startPrototypeCollaboration') await this.dispatch(item, operation, operation.request.instruction)
      else if (operation.phase === 'prepared' && operation.request.action === 'correctPrototypeRequirement') { await this.prepareCorrection(item, operation); await this.dispatch(item, operation, operation.request.instruction) }
      else continue
      return
    }
  }
  /** Persist the run intent before dispatching it to the existing native conversation. */
  async runRuntime(taskId: string, kind: 'preview' | 'checks', operationId: string): Promise<void> {
    const data = await this.data(), item = data.tasks.find(value => value.task.id === taskId)
    if (!item) throw new Error('本机未登记该事项')
    const instruction = [
      kind === 'preview' ? '请运行当前工程，实际启动受管预览，让我可以体验。' : '请检查当前工程，确认实际工程检查结果。',
      `先调用 prototype_runtime 的 ${kind} 动作；失败时读取本次诊断，在当前授权范围内修复后再次调用，直到成功或遇到具体阻碍。`,
      '修复、重试都在当前会话完成，最后一次代码修改后必须重新调用工具验证。不要绕过受管工具启动进程、删除检查或伪造成功。',
      '向我简短反馈进展和实际结果，遇到权限、凭据或业务决定缺失时说明原因；完整日志留在诊断中。',
    ].join('\n\n')
    const command: Correct = { action: 'correctPrototypeRequirement', prototypeTaskId: taskId, operationId, instruction }
    const prior = data.operations.find(value => value.id === operationId)
    if (prior) {
      if (!prior.runtimeRequest || canonical(prior.request) !== canonical(command)) throw new Error('同一运行操作不能绑定其他目标')
      return
    }
    if (item.state === 'recovery-required') await this.reconcileUndelivered(item)
    if (item.state === 'running' || item.state === 'recovery-required') throw new Error('AI 正在处理当前事项，请稍候或暂停后继续')
    if (item.state === 'queued') throw new Error('当前事项已有排队指令，请等待执行或先继续该指令')
    if ((data.buffers ?? []).some(value => value.prototypeTaskId === taskId && value.content !== value.baseContent)) throw new Error('请先保存当前编辑内容')
    await this.current(item); await this.existingWorkspace(item)
    data.operations.push({ id: operationId, request: command, taskId, phase: 'prepared', runtimeRequest: true })
    item.runtimeRun = { operationId, kind, status: 'pending' }
    item.nextAction = '运行指令已保存，正在交给 AI'; await this.save()
    if (item.development) await this.correct(command)
    else await this.dispatch(item, data.operations.at(-1)!, instruction)
  }
  /** Absence is conclusive only after the restored native Agent and its inbox have settled. */
  private async reconcileUndelivered(item: LocalTask): Promise<void> {
    const data = await this.data(), operation = [...data.operations].reverse().find(value => value.taskId === item.task.id && ['sending', 'unknown', 'sent'].includes(value.phase))
    if (!operation) return
    // Reconcile an unknown root delivery before restoreSession, which requires a known admitted request.
    if (operation.phase === 'sending' || operation.phase === 'unknown') {
      const delivery = await this.ports.inspectPrompt(item.sessionId, operation.id)
      if (delivery === 'unknown') return
      if (delivery !== 'absent') { operation.phase = 'sent'; await this.save() }
      else {
        // Restore the native handle to prove settlement, without granting write authority to an absent prompt.
        await this.ports.session(this.localTask(item), this.sessionRules(item), true)
        if (!await this.ports.settlePrototypeSession(item.sessionId, false)) return
        operation.phase = 'not-delivered'; delete operation.message
        item.state = 'awaiting-user'; item.nextAction = '已核实上次指令未发送，原输入已保留，可以重新运行或继续说明'
        if (item.development) { item.development.stage = 'blocked'; item.development.message = item.nextAction }
        await this.save(); return
      }
    }
    await this.restoreSession(item.sessionId)
    if (!await this.ports.settlePrototypeSession(item.sessionId, false)) return
    const delivery = await this.ports.inspectPrompt(item.sessionId, operation.id)
    const lastTurn = await this.ports.lastPrototypeTurn?.(item.sessionId)
    // A settled, empty inbox with an admitted but unconsumed prompt proves native pre-step rejection.
    if (delivery !== 'absent' && !(delivery === 'admitted' && lastTurn && lastTurn.reason !== 'completed' && lastTurn.seq !== undefined)) return
    if (item.development && lastTurn?.seq !== undefined) item.development.lastTurnSeq = Math.max(item.development.lastTurnSeq ?? -1, lastTurn.seq)
    operation.phase = 'not-delivered'; delete operation.message
    item.state = 'awaiting-user'; item.nextAction = '已核实上次指令未发送，原输入已保留，可以重新运行或继续说明'
    if (item.development) { item.development.stage = 'blocked'; item.development.message = item.nextAction }
    await this.save()
  }
  /** Runtime capability is scoped to the current live native segment, including recovery and cancellation. */
  private async runtimeTask(task: TaskView): Promise<LocalTask> {
    const data = await this.data(), item = data.tasks.find(value => value.task.id === task.entityId)
    if (!item || canonical(this.localTask(item)) !== canonical(task)) throw new Error('运行工具的会话或事项身份不一致')
    const operation = data.operations.find(value => value.id === (item.development?.runId ?? item.nativeRunId))
    if (item.state !== 'running' || !operation || !['sending', 'sent'].includes(operation.phase) || !this.hasLiveClaim(item)) throw new Error('当前原生开发段已停止或许可已失效')
    await this.current(item); await this.existingWorkspace(item)
    return item
  }
  private async runtimeReports(item: LocalTask, operationId?: string): Promise<NonNullable<PrototypeRuntimeResult['reports']>> {
    const reports = await this.ports.prototypeCheckReports?.([{ projectId: item.projectId, prototypeTaskId: item.task.id }]) ?? []
    return reports.filter(value => value.projectId === item.projectId && value.prototypeTaskId === item.task.id && !value.baselineId && (!operationId || value.operationId === operationId))
  }
  private async runtimeFingerprint(item: LocalTask): Promise<string> {
    return digest(canonical({ head: (await this.ports.git.state(item.worktree)).head, files: await this.ports.git.workingFingerprint(item.worktree) }))
  }
  /** A stopped or crashed preview invalidates its receipt even when the source did not change. */
  async previewStopped(taskId: string): Promise<void> {
    const item = (await this.data()).tasks.find(value => value.task.id === taskId), run = item?.runtimeRun
    if (!item || !run || run.kind !== 'preview' || run.status === 'blocked') return
    run.status = 'blocked'; delete run.sourceFingerprint
    item.nextAction = '预览已停止，重新运行后可以继续体验'; await this.save()
  }
  /** Return real process results to the calling model; the model owns repair and retry within the same turn. */
  async executeRuntimeTool(task: TaskView, action: PrototypeRuntimeAction, signal: AbortSignal): Promise<PrototypeRuntimeResult> {
    signal.throwIfAborted()
    const item = await this.runtimeTask(task), accountId = this.store.accountId
    const runId = item.development?.runId ?? item.nativeRunId
    if (action === 'diagnostics') return { status: 'idle', message: '以下为当前事项的实际运行诊断，历史通过不代表当前预览仍在运行', reports: await this.runtimeReports(item, item.runtimeRun?.lastAttemptId) }
    if (action === 'stop') {
      await this.ports.stopPreview(item.sessionId)
      if (item.runtimeRun) { item.runtimeRun.status = 'blocked'; delete item.runtimeRun.sourceFingerprint }
      item.nextAction = '预览已停止'; await this.save()
      return { status: 'stopped', message: item.nextAction }
    }
    const operationId = randomUUID()
    // A direct conversation request can run without a preceding button click.
    if (!item.runtimeRun || item.runtimeRun.operationId !== runId) item.runtimeRun = { operationId: runId!, kind: action, status: 'pending' }
    const run = item.runtimeRun
    if (run.kind === action) { run.status = 'running'; delete run.sourceFingerprint }
    run.lastAttemptId = operationId
    item.nextAction = 'AI 正在调用工程运行工具'; await this.save()
    const fingerprint = await this.runtimeFingerprint(item)
    let failure: unknown
    try {
      if (!this.executeRuntime) throw new Error('工程运行入口未配置')
      await this.executeRuntime(this.localTask(item), action, operationId)
      if (await this.runtimeFingerprint(item) !== fingerprint) throw new Error('执行期间源码已变化，请重新运行当前工程')
    } catch (error) { failure = error }
    if (signal.aborted || this.store.accountId !== accountId || item.state !== 'running' || !this.hasLiveClaim(item)) {
      if (action === 'preview') await this.ports.stopPreview(item.sessionId)
      run.status = 'blocked'; delete run.sourceFingerprint; await this.save()
      signal.throwIfAborted()
      throw new Error('运行期间会话或账号许可已变化，结果未记为成功')
    }
    const reports = await this.runtimeReports(item, operationId)
    if (run.kind === action) {
      run.status = failure ? 'blocked' : 'passed'
      if (!failure) run.sourceFingerprint = fingerprint
    }
    item.nextAction = failure ? '运行遇到问题，AI 可根据诊断修复后重试' : action === 'preview' ? '原型已运行，可以开始体验' : '工程检查已完成'
    // Persistence failures are Host failures, never a successful tool receipt or another model dispatch.
    try { await this.save() }
    catch (error) { run.status = 'blocked'; delete run.sourceFingerprint; item.nextAction = '运行结果未能保存，请核对诊断后继续'; throw error }
    return { status: failure ? 'failed' : 'passed', message: failure ? (failure instanceof Error ? failure.message : '工程执行失败') : item.nextAction, reports }
  }
  /** Only a failed report for this exact attempt can authorize a diagnostic repair. */
  private async repairCheckFailure(item: LocalTask, checkId: string): Promise<boolean> {
    const reports = await this.ports.prototypeCheckReports?.([{ projectId: item.projectId, prototypeTaskId: item.task.id }])
    const report = reports?.find(value => value.operationId === checkId && value.projectId === item.projectId && value.prototypeTaskId === item.task.id && value.status === 'failed' && !value.baselineId)
    const engineeringFailure = report?.steps.some(step => step.status === 'failed' && (step.exitCode !== undefined && step.exitCode !== 0 || step.name === 'browser' || step.name === 'preview'))
    if (!report || !engineeringFailure || !item.development) return false
    const data = await this.data()
    await this.current(item); await this.existingWorkspace(item)
    const command: Correct = { action: 'correctPrototypeRequirement', prototypeTaskId: item.task.id, operationId: randomUUID(), instruction: runtimeRepairInstruction(report) }
    const operation: Operation = { automaticRepair: true, id: command.operationId, request: command, taskId: item.task.id, phase: 'prepared' }
    data.operations.push(operation)
    item.development.runId = operation.id; item.development.stage = 'queued'; item.development.reviewStatus = 'correcting'
    item.state = 'queued'; item.nextAction = '运行遇到问题，AI 将自动修复并重新尝试'; await this.save()
    // The shared queue remains the only model dispatcher, including across projects.
    await this.advanceQueue()
    return true
  }
  private async finishDevelopment(item: LocalTask, operation: Operation, release: boolean, final = false): Promise<void> {
    const development = item.development!
    await this.existingWorkspace(item)
    if (operation.phase === 'sent') {
      const observed = await this.ports.git.state(item.worktree)
      if (!operation.turnStartHead || !operation.turnStartFingerprint) throw new Error('开发轮次的工作现场起点未记录，不能自动固定成果')
      const unchanged = observed.head === operation.turnStartHead && await this.ports.git.workingFingerprint(item.worktree) === operation.turnStartFingerprint
      if (operation.runtimeRequest && unchanged) {
        operation.phase = 'awaiting-review'; item.state = 'awaiting-user'
        development.stage = 'awaiting-review'; development.reviewStatus = 'awaiting-review'
        await this.runtimeOutcome(item, operation); await this.save(); await this.advanceQueue(); return
      }
      if ((operation.request.action === 'startPrototypeCollaboration' || operation.request.action === 'correctPrototypeRequirement') && unchanged) {
        item.state = 'awaiting-user'; item.nextAction = '本轮未形成代码改动，请核对答复后决定是否纠偏'; development.stage = operation.request.action === 'correctPrototypeRequirement' ? 'awaiting-review' : 'developing'; if (operation.request.action === 'correctPrototypeRequirement') development.reviewStatus = 'awaiting-review'; development.message = item.nextAction
        await this.save(); return
      }
      operation.phase = 'fixing'; development.stage = 'fixing'; delete development.message; await this.save()
    }
    if (operation.phase === 'confirming') { operation.phase = 'fixing'; development.stage = 'fixing'; await this.save() }
    if (['fixing', 'commit-known', 'pushing'].includes(operation.phase)) await this.requireClaim(item)
    if (!operation.commitId) {
      const identity = await this.ports.git.identity(item.worktree)
      operation.commitId = await this.ports.git.commitAll(item.worktree, `${final ? '确认' : '实现'}需求 ${development.requirementId}`, identity)
      development.commitId = operation.commitId; operation.phase = 'commit-known'; development.stage = 'commit-known'; await this.save()
    }
    if (!operation.checksPassed) {
      try { await this.ports.candidateChecks(this.localTask(item), operation.commitId, operation.id) }
      catch (error) {
        item.state = 'awaiting-user'
        if (await this.repairCheckFailure(item, operation.id)) return
        item.state = 'running'; throw error
      }
      operation.checksPassed = true; await this.save()
    }
    if (operation.phase === 'commit-known' || operation.phase === 'fixing') { operation.phase = 'pushing'; development.stage = 'pushing'; await this.save() }
    if (operation.phase === 'pushing') {
      let remote = await this.ports.git.optionalRemoteHead(item.worktree, item.task.branch)
      if (remote !== operation.commitId) {
        if (remote !== undefined && !await this.ports.git.isAncestor(item.worktree, remote, operation.commitId)) throw new Error('任务远端分支已指向其他提交，现场已保留')
        await this.ports.git.conditionalUpdate(item.worktree, item.task.branch, remote, operation.commitId)
        remote = await this.ports.git.optionalRemoteHead(item.worktree, item.task.branch)
      }
      if (remote !== operation.commitId) throw new Error('任务远端提交尚未核验，后端状态保持未同步')
      operation.phase = 'pushed'; development.stage = 'pushed'; await this.save()
    }
    if (operation.phase === 'pushed') {
      if (!development.claim) throw new Error('需求开发占用记录缺失，不能同步后端')
      operation.synchronizeRequest ??= { key: digest(`${operation.id}:sync`), token: this.token(item.task), claim: development.claim, commitId: operation.commitId, remoteRef: development.remoteRef, release }
      operation.phase = 'synchronizing'; development.stage = 'synchronizing'; await this.save()
    }
    if (operation.phase === 'synchronizing') {
      await this.performKeyed<unknown>(item.projectId, `/prototype/tasks/${encodeURIComponent(item.task.id)}/development-claims/${encodeURIComponent(development.requirementId)}/synchronize`, operation.synchronizeRequest!)
      development.claimReleased = release
      if (release) this.liveClaims.delete(item.task.id)
      if (final) {
        operation.phase = 'reviewed'; development.stage = 'reviewed'; development.reviewStatus = 'reviewed'; item.nextAction = '需求成果已确认，未生成整体原型基线'
      } else {
        operation.phase = 'awaiting-review'; development.stage = 'awaiting-review'; development.reviewStatus = 'awaiting-review'; item.nextAction = release ? '需求成果待核对，已自动推进下一项' : '纠偏成果待核对，开发占用保留至最终确认'
      }
      item.state = 'awaiting-user'; delete development.message; await this.save()
      if (!final) await this.advanceQueue()
    }
  }
  /** An ended turn cannot turn an absent, failed or obsolete tool receipt into a running preview. */
  private async runtimeOutcome(item: LocalTask, operation: Operation): Promise<void> {
    const run = item.runtimeRun
    if (!operation.runtimeRequest || run?.operationId !== operation.id) return
    if (run.status !== 'passed' || run.sourceFingerprint !== await this.runtimeFingerprint(item)) { run.status = 'blocked'; delete run.sourceFingerprint }
    item.nextAction = run.status === 'passed' ? (run.kind === 'preview' ? '原型已运行，可以开始体验' : '工程检查已完成') : '本轮尚未取得当前工程的运行成功结果，请查看 AI 说明后继续'
  }
  async confirm(command: Confirm): Promise<void> {
    const data = await this.data(), item = data.tasks.find(value => value.task.id === command.prototypeTaskId), development = item?.development
    if (!item || !development) throw new Error('本机未登记该需求开发事项')
    let operation = data.operations.find(value => value.id === command.operationId)
    if (operation && canonical(operation.request) !== canonical(command)) throw new Error('同一操作不能绑定其他最终确认')
    // A remounted client must finish the recorded confirmation instead of replacing its side effects.
    operation ??= data.operations.findLast(value => value.taskId === item.task.id && value.request.action === 'confirmPrototypeRequirement' && value.phase !== 'reviewed')
    if (!operation) { operation = { id: command.operationId, request: structuredClone(command), taskId: item.task.id, phase: 'prepared' }; data.operations.push(operation); await this.save() }
    if (operation.phase === 'reviewed') return
    const resumes = development.runId === operation.id && operation.phase !== 'prepared'
    if ((item.state === 'running' || item.state === 'recovery-required') && !resumes) throw new Error('请先核对当前开发或恢复结果')
    if (!resumes && (data.buffers ?? []).some(value => value.prototypeTaskId === item.task.id && value.content !== value.baseContent)) throw new Error('请先保存或处理当前成果编辑缓冲')
    if (!resumes) { development.runId = operation.id; development.stage = 'confirming'; operation.phase = 'confirming' }
    item.state = 'running'; item.nextAction = '正在固定并核对当前所阅需求成果'; await this.save()
    try {
      if (resumes) {
        // A synchronized release may already have succeeded; resume its original phase without reacquiring it.
        if (['confirming', 'fixing', 'commit-known', 'pushing'].includes(operation.phase)) await this.enterClaimedSegment(item)
        await this.finishDevelopment(item, operation, true, true)
        return
      }
      await this.current(item); await this.existingWorkspace(item)
      const observed = await this.ports.git.state(item.worktree)
      const currentClaim = development.claim && !development.claimReleased ? await this.remoteClaim(item) : null
      const changed = observed.dirty || observed.head !== development.commitId
      if (!changed && !currentClaim) {
        if (development.commitId !== observed.head) throw new Error('当前所阅成果与首次同步提交不一致')
        if (await this.remoteClaim(item)) throw new Error('需求当前由其他开发占用持有，不能沿用旧授权确认')
        if (await this.ports.git.optionalRemoteHead(item.worktree, item.task.branch) !== observed.head) throw new Error('当前所阅提交与任务远端不一致')
        const first = data.operations.find(value => value.taskId === item.task.id && value.synchronizeRequest?.release && value.synchronizeRequest.commitId === observed.head)
        if (!first) throw new Error('首次成果同步记录缺失，不能伪造新的开发占用')
        await this.api.request('GET', this.route(item.projectId, `/operations/${encodeURIComponent(first.synchronizeRequest!.key)}`))
        operation.phase = 'reviewed'; development.stage = 'reviewed'; development.reviewStatus = 'reviewed'; item.state = 'awaiting-user'; item.nextAction = '需求成果已确认，未生成整体原型基线'; await this.save(); return
      }
      if (currentClaim && development.claim && canonical(currentClaim) !== canonical(development.claim)) throw new Error('需求开发占用已变化，现场已保留')
      if (!currentClaim) {
        item.state = 'awaiting-user'; development.stage = 'awaiting-review'; operation.phase = 'prepared'; await this.save()
        throw new Error('成果在释放占用后发生变化，请先发起纠偏并重新核对')
      }
      operation.phase = 'confirming'
      await this.enterClaimedSegment(item)
      await this.finishDevelopment(item, operation, true, true)
    } catch (error) {
      if (item.state === 'awaiting-user') throw error
      item.state = 'recovery-required'; item.nextAction = error instanceof Error ? error.message : '最终确认结果待恢复'; development.message = item.nextAction
      await this.save(); throw error
    }
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
    const pending = data.operations.filter(value => !value.taskId && value.phase !== 'superseded' && value.request.action === 'startPrototypeCollaboration').map(value => `queued:${value.id}`)
    const all = new Set([...items.keys(), ...pending])
    if (items.size !== data.tasks.length || command.prototypeTaskIds.length !== all.size || new Set(command.prototypeTaskIds).size !== all.size || command.prototypeTaskIds.some(id => !all.has(id))) throw new Error('队列顺序必须包含本机全部事项')
    data.queueOrder = [...command.prototypeTaskIds]
    data.tasks = command.prototypeTaskIds.flatMap(id => { const item = items.get(id); return item ? [item] : [] })
    ;(data.queueReorders ??= []).push({ id: command.operationId, fingerprint })
    await this.save()
  }
  /** Preserve the pause operation before cancelling; a retry only observes its original result. */
  async pause(taskId: string, operationId: string): Promise<void> {
    this.liveClaims.delete(taskId)
    const data = await this.data(), item = data.tasks.find(value => value.task.id === taskId)
    if (!item) throw new Error('本机未登记该事项')
    this.cancelledWithPendingQueue.delete(item.sessionId)
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
    operation!.status = 'settled'; if (item.runtimeRun) item.runtimeRun.status = 'blocked'; item.state = 'paused'; item.nextAction = '已暂停，继续时请发送指令'; await this.save()
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
    if (operation.parentRunId) {
      if (result === 'unknown') { item.state = 'recovery-required'; item.nextAction = '追加消息结果仍未知，原指令未重发'; await this.save(); return }
      operation.phase = result === 'absent' ? 'not-delivered' : 'sent'
      item.nextAction = result === 'absent' ? '原生日志未找到追加消息；现场已保留，请重新明确发送意图' : '追加消息已在原生日志核对，正在恢复原开发段'
      await this.save()
      await this.restoreSession(item.sessionId)
      return
    }
    if (result === 'absent') { await this.reconcileUndelivered(item); return }
    if (result === 'delivered' || result === 'admitted') {
      operation.phase = 'sent'; delete operation.message
      item.nextAction = result === 'delivered' ? '原生记录中已找到该指令；请核对执行结果' : '原指令曾进入原生队列；请核对执行结果'
    } else { operation.phase = 'unknown'; item.nextAction = '消息结果仍未知，原指令未重发' }
    await this.save()
    if (result === 'delivered' && item.state === 'recovery-required') {
      await this.restoreSession(item.sessionId)
      if (await this.ports.settlePrototypeSession(item.sessionId, false)) {
        if (item.development) { item.state = 'recovery-required'; item.nextAction = '原生日志已恢复，等待官方轮次结束事件'; }
        else { item.state = 'awaiting-user'; item.nextAction = '原指令已记录，会话已收敛；可继续发送指令' }
        await this.save()
      }
    }
  }
  async restoreSession(sessionId: string): Promise<string | undefined> {
    const data = await this.data(), item = data.tasks.find(value => value.sessionId === sessionId)
    if (!item) return undefined
    await this.current(item); await this.existingWorkspace(item); await this.scope(item.task.writeScope)
    await this.reconcileNativeChildren(item)
    if (item.development && !item.development.claimReleased && (item.state === 'recovery-required' || item.state === 'running' && !this.hasLiveClaim(item))) {
      const operation = data.operations.find(value => value.id === item.development!.runId)
      const unknown = data.operations.some(value => value.taskId === item.task.id && value.parentRunId === item.development!.runId && ['prepared', 'sending', 'unknown'].includes(value.phase))
      if (operation?.phase !== 'sent' || unknown) throw new Error('开发消息结果尚未核对，现场已保留')
      this.liveClaims.delete(item.task.id)
      await this.enterClaimedSegment(item)
      item.state = 'running'; await this.save()
    }
    if (!item.development && (item.state === 'recovery-required' || item.state === 'running' && !this.hasLiveClaim(item))) {
      const operation = data.operations.find(value => value.id === item.nativeRunId)
      if (operation?.phase !== 'sent') throw new Error('补充事项原生发送结果尚未核对，现场已保留')
      this.liveClaims.set(item.task.id, { accountId: this.store.accountId!, claim: canonical(item.task.developmentClaims) })
      item.state = 'running'; await this.save()
    }
    return this.ports.session(this.localTask(item), this.sessionRules(item), true)
  }
  /** Reconcile exact native identities; a missing occurrence never authorizes an automatic resend. */
  private async reconcileNativeChildren(item: LocalTask): Promise<void> {
    const data = await this.data(), runId = item.development?.runId ?? item.nativeRunId
    for (const operation of data.operations.filter(value => value.taskId === item.task.id && value.parentRunId === runId && ['prepared', 'sending', 'unknown'].includes(value.phase))) {
      const delivery = await this.ports.inspectPrompt(item.sessionId, operation.id)
      if (delivery === 'unknown') throw new Error('追加消息结果仍未知，原指令未重发')
      operation.phase = delivery === 'absent' ? 'not-delivered' : 'sent'
      await this.save()
    }
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
    if (item.development) {
      const development = item.development
      return async () => {
        const runId = development.runId, expectedClaim = canonical(development.claim)
        const operation = this.record?.operations.find(value => value.id === runId)
        if (development.runId !== runId || item.state !== 'running' || !operation || !['sending', 'sent'].includes(operation.phase) || canonical(development.claim) !== expectedClaim) throw new Error('需求开发代次或当前操作已变化，原生写入已停止并保留现场')
        if (!this.hasLiveClaim(item)) throw new Error('开发段许可已失效，请显式恢复会话后继续')
        if ((await this.scope(item.task.writeScope)).hash !== item.task.policyHash) throw new Error('原型模板写入策略已变化，现场已保留')
        if (development.runId !== runId || canonical(development.claim) !== expectedClaim || !this.hasLiveClaim(item)) throw new Error('开发段已变化，原生写入已停止并保留现场')
      }
    }
    const expected = binding(initial)
    return async () => {
      if (item.state !== 'running' || !this.hasLiveClaim(item)) throw new Error('补充事项开发段已停止，原生写入已停止并保留现场')
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
    this.liveClaims.delete(taskId)
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
  /** Resume durable development steps without repeating a model request or an already verified Git step. */
  async recover(): Promise<void> {
    const data = await this.data(), accountId = this.store.accountId
    if (!accountId || (await this.ports.account())?.id !== accountId) throw new Error('协同账号已变化，任务现场保留供原账号恢复')
    for (const item of data.tasks) {
      const development = item.development
      if (item.state === 'paused' || item.endOperationId) continue
      if (!development && item.nativeRunId && ['queued', 'running', 'recovery-required'].includes(item.state)) {
        await this.recoverCall(item, async () => {
          await this.reconcileNativeChildren(item)
          const operation = data.operations.find(value => value.id === item.nativeRunId)
          if (!operation) throw new Error('补充事项原生开发操作记录缺失')
          if (['prepared', 'sending', 'unknown'].includes(operation.phase)) {
            const delivery = await this.ports.inspectPrompt(item.sessionId, operation.id)
            if (delivery === 'unknown') throw new Error('补充事项原生消息结果仍未知，原指令未重发')
            if (delivery === 'absent') { operation.phase = 'not-delivered'; item.state = 'awaiting-user'; item.nextAction = '原生日志未找到原指令，现场已保留，等待明确发送'; await this.save(); return }
            operation.phase = 'sent'; await this.save()
          }
          await this.restoreSession(item.sessionId)
          await this.ports.settlePrototypeSession(item.sessionId, false)
        })
        return
      }
      if (!development || !development.runId && item.state === 'awaiting-user' || development.stage === 'reviewed' || development.stage === 'awaiting-review') continue
      for (const child of data.operations.filter(value => value.taskId === item.task.id && value.parentRunId === development.runId && ['prepared', 'sending', 'unknown'].includes(value.phase))) {
        const delivery = await this.ports.inspectPrompt(item.sessionId, child.id)
        if (delivery === 'unknown') { item.state = 'recovery-required'; item.nextAction = '追加消息结果仍未知，原指令未重发'; await this.save(); return }
        child.phase = delivery === 'absent' ? 'not-delivered' : 'sent'
        await this.save()
      }
      const operation = data.operations.find(value => value.id === development.runId)
      if (!operation) throw new Error('需求开发操作记录缺失，现场已保留')
      if (operation.nativePrompt && operation.phase === 'prepared') {
        const delivery = await this.ports.inspectPrompt(item.sessionId, operation.id)
        if (delivery === 'unknown') { item.state = 'recovery-required'; item.nextAction = '原生发送结果仍未知，原指令未重发'; await this.save(); return }
        if (delivery === 'absent') { operation.phase = 'not-delivered'; item.state = 'awaiting-user'; development.stage = 'blocked'; item.nextAction = '原指令已保留但尚未投递，等待用户明确重试'; await this.save(); return }
        operation.phase = 'sent'; development.stage = 'developing'; item.state = 'recovery-required'; await this.save()
      }
      if (item.state === 'awaiting-user' || development.stage === 'blocked') return
      if (operation.request.action === 'startPrototypeCollaboration' && ['prepared', 'creating', 'claimed'].includes(operation.phase)) { await this.recoverCall(item, () => this.start(operation.request as Start)); return }
      if (operation.phase === 'workspace') { item.state = 'queued'; await this.save(); await this.advanceQueue(); return }
      if (operation.phase === 'unknown' || operation.phase === 'sending') {
        const delivery = await this.ports.inspectPrompt(item.sessionId, operation.id)
        if (delivery === 'absent') { await this.reconcileUndelivered(item); return }
        if (delivery === 'unknown') { item.state = 'recovery-required'; item.nextAction = '消息结果仍未知，原指令未重发'; development.stage = 'sending'; await this.save(); return }
        operation.phase = 'sent'; development.stage = 'developing'; item.state = 'recovery-required'; await this.save()
      }
      if (operation.phase === 'sent') {
        await this.restoreSession(item.sessionId)
        item.nextAction = '正在恢复 AI 处理进度'; await this.save()
        await this.ports.settlePrototypeSession(item.sessionId, false)
        return
      }
      if (operation.phase === 'claimed' && operation.request.action === 'correctPrototypeRequirement') { await this.recoverCall(item, () => this.dispatch(item, operation, (operation.request as Correct).instruction)); return }
      if (['fixing', 'commit-known', 'pushing', 'pushed', 'synchronizing', 'confirming'].includes(operation.phase)) {
        const release = operation.request.action === 'correctPrototypeRequirement' ? false : true
        await this.recoverCall(item, async () => { if (['fixing', 'commit-known', 'pushing', 'confirming'].includes(operation.phase)) await this.enterClaimedSegment(item); await this.finishDevelopment(item, operation, release, operation.request.action === 'confirmPrototypeRequirement') }); return
      }
      return
    }
    await this.advanceQueue()
  }
  private async recoverCall(item: LocalTask, work: () => Promise<void>): Promise<void> {
    try { await work() }
    catch (error) {
      if (item.development?.stage !== 'awaiting-review' && item.development?.stage !== 'reviewed') {
        item.state = 'recovery-required'; item.nextAction = error instanceof Error ? error.message : '需求开发恢复未完成'
        if (item.development && item.development.stage !== 'blocked') item.development.message = item.nextAction
        await this.save()
      }
      throw error
    }
  }
  async accept(sessionId: string, output: SessionOutput): Promise<boolean> {
    const data = await this.data(), item = data.tasks.find(value => value.sessionId === sessionId)
    if (!item) return false
    if (output.kind === 'turn-ended' && output.reason !== 'completed' && this.cancelledWithPendingQueue.delete(sessionId)) return true
    if (output.kind === 'turn-ended' && output.reason === 'completed') this.cancelledWithPendingQueue.delete(sessionId)
    if (output.kind === 'turn-ended' && output.reason !== 'completed') this.liveClaims.delete(item.task.id)
    if (output.kind !== 'turn-ended' || item.state === 'paused' || (data.pauses ?? []).some(value => value.taskId === item.task.id && value.status === 'waiting')) return true
    const development = item.development
    if (!development) {
      const settled = output.reason === 'completed' && await this.ports.settlePrototypeSession(item.sessionId, false)
      const operation = data.operations.find(value => value.id === item.nativeRunId)
      if (settled && operation) operation.phase = 'awaiting-review'
      item.state = settled ? 'awaiting-user' : 'recovery-required'
      if (settled) { delete item.nextAction; if (operation) await this.runtimeOutcome(item, operation) }
      else item.nextAction = output.reason === 'completed' ? '执行收敛或会话保存待核对' : `原生轮次未成功完成：${output.reason}`
      await this.save(); return true
    }
    const operation = data.operations.find(value => value.id === development.runId)
    if (!operation || operation.phase !== 'sent' || !['startPrototypeCollaboration', 'correctPrototypeRequirement'].includes(operation.request.action)) return true
    if (output.seq === undefined || !Number.isSafeInteger(output.seq)) return true
    const recoveringTurn = operation.phase === 'sent' && operation.turnSeq === output.seq
    if (development.lastTurnSeq !== undefined && (output.seq < development.lastTurnSeq || output.seq === development.lastTurnSeq && !recoveringTurn)) return true
    development.lastTurnSeq = output.seq
    if (output.reason !== 'completed') {
      if (item.runtimeRun) item.runtimeRun.status = 'blocked'
      item.state = 'recovery-required'; item.nextAction = `原生轮次未成功完成：${output.reason}；未提交或释放需求`; development.message = item.nextAction
      await this.save(); return true
    }
    if (operation.phase !== 'sent') { await this.save(); return true }
    operation.turnSeq = output.seq; await this.save()
    try {
      if (await this.ports.inspectPrompt(item.sessionId, operation.id) !== 'delivered') throw new Error('原生记录未证明当前开发指令已投递，不能完成开发')
      if (!await this.ports.settlePrototypeSession(item.sessionId, false)) throw new Error('原生会话尚未收敛或日志尚未保存')
      item.state = 'running'; await this.save()
      await this.runtimeOutcome(item, operation)
      const runtimeMessage = operation.runtimeRequest ? item.nextAction : undefined
      await this.finishDevelopment(item, operation, operation.request.action !== 'correctPrototypeRequirement')
      if (runtimeMessage && ['awaiting-review'].includes(operation.phase)) { item.nextAction = runtimeMessage; await this.save() }
    } catch (error) {
      if (development.stage !== 'awaiting-review' && development.stage !== 'reviewed') {
        item.state = 'recovery-required'; item.nextAction = error instanceof Error ? error.message : '需求开发完成步骤待恢复'; development.message = item.nextAction
        await this.save()
      }
    }
    return true
  }
  async fileWorkspace(taskId: string): Promise<PrototypeFileWorkspace> {
    const data = await this.data(), item = data.tasks.find(value => value.task.id === taskId)
    if (!item) throw new Error('本机未登记该事项')
    const task = item.task
    const local = await this.store.read()
    if (task.ownerId !== this.store.accountId || task.clientId !== local.clientId) throw new Error('该事项不属于当前账号或设备')
    const active = task.status === 'active' && task.generation === item.task.generation && this.hasLiveClaim(item)
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
