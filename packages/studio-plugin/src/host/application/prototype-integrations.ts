import path from 'node:path'
import { canonical } from '@eadp/asset-domain'
import type { AbortPrototypeIntegrationRequest, CancelPrototypeTaskRequest, ProjectState, PrototypeIntegrationRequest, PrototypeTaskView } from '@eadp/contracts'
import type { TaskView } from '../../shared/studio.ts'
import { AtomicState } from '../adapters/local-state/atomic-state.ts'
import { CollaborationClient, CollaborationError } from '../adapters/collaboration/client.ts'
import type { HostPorts } from './ports.ts'
import type { StudioStore } from './state.ts'

export type PrototypeGitRecovery = 'clear' | 'unknown' | 'reconcile-required'
interface IntegrationView {
  id: string; prototypeTaskId: string; status: 'prepared' | 'accepted' | 'aborted';
  sourceSha: string; expectedHead: string; candidateSha: string; acceptanceId?: string; baselineId?: string;
  gitRecovery?: 'pending' | 'reconciled'
}
export type PrototypeAcceptanceDeliveryStep = 'projection' | 'adoptions' | 'preview' | 'release' | 'main' | 'cleanup'
export type PrototypeTaskEndDeliveryStep = 'projection' | 'preview' | 'release'
export interface PrototypeIntegrationOperation {
  id: string; accountId: number; projectId: string; taskId: string; worktree: string; sessionId: string
  request: PrototypeIntegrationRequest
  phase: 'fixed' | 'source-uploading' | 'source-uploaded' | 'candidate-uploading' | 'uploaded' | 'preparing' | 'prepared' | 'pushing' | 'pushed' | 'completing' | 'aborting' | 'accepted' | 'aborted' | 'unknown'
  integrationId?: string; accepted?: IntegrationView; aborted?: IntegrationView; abortRequest?: AbortPrototypeIntegrationRequest; message?: string; deliveryMessage?: string
  delivery?: { step: PrototypeAcceptanceDeliveryStep; completed: PrototypeAcceptanceDeliveryStep[] }
}
type CancelledPrototypeTask = PrototypeTaskView & { gitRecovery: PrototypeGitRecovery }
export interface PrototypeTaskEndOperation {
  id: string; accountId: number; projectId: string; taskId: string; sessionId: string; worktree: string; request: CancelPrototypeTaskRequest
  phase: 'prepared' | 'reconciling' | 'accepting' | 'aborting' | 'cancelling' | 'projecting' | 'accepted' | 'cancelled' | 'unknown'
  integrationOperationId?: string
  result?: { status: 'accepted'; integrationId: string; baselineId: string } | { status: 'cancelled'; task: PrototypeTaskView; gitRecovery: PrototypeGitRecovery }
  message?: string
  delivery?: { step: PrototypeTaskEndDeliveryStep; completed: PrototypeTaskEndDeliveryStep[] }
}
interface RecordFile { operations: PrototypeIntegrationOperation[]; taskEnds: PrototypeTaskEndOperation[] }
interface Dependencies {
  /** Resolve a locally registered task and recheck its server authorization. */
  task(taskId: string): Promise<TaskView>
  cancellation(taskId: string): { projectId: string; task: PrototypeTaskView; sessionId: string; worktree: string }
  accepted(taskId: string, baselineId: string): Promise<void>
  completeAdoptions(taskId: string, baselineId: string): Promise<void>
  cancelled(taskId: string, gitRecovery: PrototypeGitRecovery): Promise<void>
  stopPreview(sessionId: string): Promise<void>
  releaseTask?(worktree: string): Promise<void>
  syncMain(projectId: string, candidateSha: string, accountId: number): Promise<void>
  cleanup(operationId: string): Promise<void>
}

/** Publication retains the author's exact request and never replaces an unknown operation. */
export class PrototypeIntegrations {
  private record: RecordFile | undefined
  private storage?: AtomicState<RecordFile>
  private account?: number
  private loading: { accountId: number; promise: Promise<RecordFile> } | undefined
  constructor(private readonly store: StudioStore, private readonly api: CollaborationClient, private readonly ports: HostPorts, private readonly deps: Dependencies) {}

  private async data(): Promise<RecordFile> {
    const account = this.store.accountId
    if (!account) throw new Error('请先登录后处理原型集成')
    if (this.account === account && this.record) return this.record
    if (this.loading?.accountId === account) return this.loading.promise
    if (this.account !== account || !this.storage) {
      this.account = account
      this.record = undefined
      this.storage = new AtomicState(path.join(this.store.directory, 'prototype-integrations.json'))
    }
    const storage = this.storage!
    const promise = (async () => {
      const record = await storage.read() ?? { operations: [], taskEnds: [] }
      if (this.store.accountId !== account || this.account !== account || this.storage !== storage) throw new Error('协同账号已变化')
      if (!Array.isArray(record.operations) || !Array.isArray(record.taskEnds)) throw new Error('原型集成记录不可读取，请保留现场')
      this.record = record
      return record
    })()
    this.loading = { accountId: account, promise }
    try { return await promise } finally { if (this.loading?.promise === promise) this.loading = undefined }
  }
  private async owner(accountId: number): Promise<void> {
    if (this.account !== accountId || this.store.accountId !== accountId || (await this.ports.account())?.id !== accountId || this.store.accountId !== accountId) throw new Error('协同账号已变化，原集成保留供核对')
  }
  private async save(operation: { accountId: number }): Promise<void> {
    await this.owner(operation.accountId)
    await this.storage!.write(this.record!)
    await this.owner(operation.accountId)
  }
  private async external<T>(operation: { accountId: number }, action: () => Promise<T>): Promise<T> {
    await this.owner(operation.accountId)
    try { const result = await action(); await this.owner(operation.accountId); return result }
    catch (error) { await this.owner(operation.accountId); throw error }
  }
  private route(operation: { projectId: string }, suffix: string): string { return `/v1/projects/${encodeURIComponent(operation.projectId)}${suffix}` }
  private assertRequest(operation: PrototypeIntegrationOperation): PrototypeIntegrationRequest {
    const request = operation.request, prefix = `refs/heads/studio-private/${operation.taskId}/${operation.id}`
    if (request.idempotencyKey !== operation.id || request.stage !== 'prototype' || request.token.prototypeTaskId !== operation.taskId || request.sourceRef !== `${prefix}/source` || request.candidateRef !== `${prefix}/candidate` ||
      request.authorConfirmation.sourceSha !== request.sourceSha || request.authorConfirmation.claimsDigest !== request.claimsDigest || request.evidence.candidateSha !== request.candidateSha ||
      request.evidence.checks.length !== 3 || new Set(request.evidence.checks.map(item => item.name)).size !== 3 || request.evidence.checks.some(item => !item.passed)) throw new Error('原型固定请求、作者确认或工程证据不一致')
    if (request.derivation.kind === 'author-confirmed' && (request.sourceSha !== request.candidateSha || request.sourceBaseHead !== request.expectedHead)) throw new Error('原型直接候选与作者确认不一致')
    return request
  }
  private async assertTask(operation: PrototypeIntegrationOperation): Promise<void> {
    const request = this.assertRequest(operation)
    const task = await this.external(operation, () => this.deps.task(operation.taskId))
    if (task.projectId !== operation.projectId || task.entityId !== operation.taskId || task.sessionId !== operation.sessionId || path.resolve(task.worktree) !== operation.worktree || task.purpose !== 'prototype') throw new Error('原型事项现场已变化，请保留原候选')
    const remote = await this.external(operation, () => this.api.request<PrototypeTaskView>('GET', this.route(operation, `/prototype/tasks/${encodeURIComponent(operation.taskId)}`)))
    if (remote.status !== 'active' || remote.ownerId !== operation.accountId || remote.id !== operation.taskId || remote.prototypeId !== request.prototypeId || remote.clientId !== request.token.clientId || remote.generation !== request.token.generation || remote.revision !== request.token.expectedRevision || remote.sourceBaseHead !== request.sourceBaseHead || remote.claimsDigest !== request.claimsDigest || canonical([...remote.developmentClaims].sort((a, b) => a.requirementId.localeCompare(b.requirementId))) !== canonical([...request.developmentClaims].sort((a, b) => a.requirementId.localeCompare(b.requirementId))) || canonical([...remote.developmentRequirementIds].sort()) !== canonical([...request.developmentRequirementIds].sort())) throw new Error('原型事项授权已变化，请保留原候选')
  }
  private integration(operation: PrototypeIntegrationOperation, view: IntegrationView): IntegrationView {
    const input = operation.request
    if (!view || !view.id || view.prototypeTaskId !== operation.taskId || view.sourceSha !== input.sourceSha || view.expectedHead !== input.expectedHead || view.candidateSha !== input.candidateSha || !['prepared', 'accepted', 'aborted'].includes(view.status) || (operation.integrationId && view.id !== operation.integrationId) || (view.status === 'accepted' && (!view.acceptanceId || !view.baselineId))) throw new Error('后台集成结果与原型固定候选不一致')
    return view
  }
  private async receipt<T>(operation: PrototypeIntegrationOperation | PrototypeTaskEndOperation, key: string, action: string): Promise<T | undefined> {
    try {
      const receipt = await this.external(operation, () => this.api.request<{ action: string; result: T }>('GET', this.route(operation, `/operations/${encodeURIComponent(key)}`)))
      if (receipt.action !== action) throw new Error('原操作回执与请求动作不一致')
      return receipt.result
    } catch (error) {
      if (!(error instanceof CollaborationError) || error.code !== 'OPERATION_NOT_FOUND') throw error
      return undefined
    }
  }
  /** Resolve only the original prepare receipt and integration; never create a replacement during recovery. */
  private async observe(operation: PrototypeIntegrationOperation): Promise<IntegrationView | undefined> {
    if (!operation.integrationId) {
      const view = await this.receipt<IntegrationView>(operation, operation.id, 'prototype.integration.prepare')
      if (!view) return undefined
      this.integration(operation, view)
      operation.integrationId = view.id; operation.phase = 'prepared'; await this.save(operation)
    }
    const view = this.integration(operation, await this.external(operation, () => this.api.request<IntegrationView>('GET', this.route(operation, `/prototype/integrations/${encodeURIComponent(operation.integrationId!)}`))))
    if (operation.phase === 'accepted' && view.status !== 'accepted' || operation.phase === 'aborted' && view.status !== 'aborted') throw new Error('本机与后台的原集成结果不一致，请保留现场核对')
    if (view.status === 'accepted') {
      operation.accepted = structuredClone(view); operation.phase = 'accepted'; delete operation.message; await this.save(operation)
    } else if (view.status === 'aborted') {
      const changed = operation.phase !== 'aborted' || canonical(operation.aborted) !== canonical(view)
      operation.aborted = structuredClone(view); operation.phase = 'aborted'
      if (changed) await this.save(operation)
    }
    return view
  }
  private async stableHead(operation: PrototypeIntegrationOperation): Promise<string> {
    const project = await this.external(operation, () => this.api.request<ProjectState>('GET', this.route(operation, '')))
    if (project.project.id !== operation.projectId || !project.project.stableBranch) throw new Error('原型所属项目状态无效')
    const branch = project.project.stableBranch
    await this.external(operation, () => this.ports.git.fetch(operation.worktree, branch))
    return this.external(operation, () => this.ports.git.remoteHead(operation.worktree, branch))
  }
  private async abortPrepared(operation: PrototypeIntegrationOperation, view: IntegrationView): Promise<void> {
    const expected: AbortPrototypeIntegrationRequest = { idempotencyKey: `${operation.id}-abort`, token: structuredClone(operation.request.token) }
    if (operation.abortRequest && canonical(operation.abortRequest) !== canonical(expected)) throw new Error('原撤销请求与固定候选不一致')
    operation.abortRequest ??= expected; operation.phase = 'aborting'; await this.save(operation)
    let aborted = await this.receipt<IntegrationView>(operation, expected.idempotencyKey, `prototype.integration.abort:${view.id}`)
    if (!aborted) aborted = await this.external(operation, () => this.api.request<IntegrationView>('POST', this.route(operation, `/prototype/integrations/${encodeURIComponent(view.id)}/abort`), expected))
    this.integration(operation, aborted)
    if (aborted.status !== 'aborted') throw new Error('后台未确认原集成已撤销')
    operation.aborted = structuredClone(aborted); operation.phase = 'aborted'; delete operation.message; await this.save(operation)
  }
  private async upload(operation: PrototypeIntegrationOperation, branch: string, sha: string, phase: 'source-uploading' | 'candidate-uploading', done: 'source-uploaded' | 'uploaded'): Promise<void> {
    operation.phase = phase; await this.save(operation)
    const current = await this.external(operation, () => this.ports.git.optionalRemoteHead(operation.worktree, branch))
    if (current && current !== sha) throw new Error('原操作远程引用已指向其他提交，已保留现场')
    if (!current) await this.external(operation, () => this.ports.git.pushNewBranch(operation.worktree, branch, sha))
    if (await this.external(operation, () => this.ports.git.optionalRemoteHead(operation.worktree, branch)) !== sha) throw new Error('原操作远程引用尚未确认，请核对原操作')
    operation.phase = done; await this.save(operation)
  }
  /** Persist each accepted-delivery position and completion independently so a retry never repeats publication. */
  private async deliver(operation: PrototypeIntegrationOperation, accepted: IntegrationView): Promise<void> {
    if (!accepted.baselineId) throw new Error('原型接受结果缺少基线')
    const delivery = operation.delivery ??= { step: 'projection', completed: [] }
    const run = async (step: PrototypeAcceptanceDeliveryStep, action: () => Promise<void>): Promise<void> => {
      if (delivery.completed.includes(step)) return
      delivery.step = step; await this.save(operation)
      await this.external(operation, action)
      delivery.completed.push(step)
      try { await this.save(operation) }
      catch (error) { delivery.completed.pop(); throw error }
    }
    await run('projection', () => this.deps.accepted(operation.taskId, accepted.baselineId!))
    await run('adoptions', () => this.deps.completeAdoptions(operation.taskId, accepted.baselineId!))
    await run('preview', () => this.deps.stopPreview(operation.sessionId))
    await run('release', async () => {
      if (!this.deps.releaseTask) throw new Error('本机缺少原生事项资源释放能力，原现场已保留，请恢复能力后重试')
      await this.deps.releaseTask(operation.worktree)
    })
    await run('main', () => this.deps.syncMain(operation.projectId, operation.request.candidateSha, operation.accountId))
    await run('cleanup', () => this.deps.cleanup(operation.id))
  }

  /** Called only after the user confirms the exact source, claims and displayed summary. */
  async submitConfirmed(task: TaskView, request: PrototypeIntegrationRequest): Promise<PrototypeIntegrationOperation> {
    const accountId = this.store.accountId
    if (!accountId) throw new Error('请先登录后提交原型')
    const data = await this.data(), worktree = path.resolve(task.worktree)
    const proposed: PrototypeIntegrationOperation = { id: request.idempotencyKey, accountId, projectId: task.projectId, taskId: task.entityId, worktree, sessionId: task.sessionId, request: structuredClone(request), phase: 'fixed' }
    this.assertRequest(proposed)
    if (task.purpose !== 'prototype') throw new Error('原型集成必须绑定原事项现场')
    const existing = data.operations.find(value => value.id === proposed.id)
    if (existing) {
      if (canonical({ accountId: existing.accountId, projectId: existing.projectId, taskId: existing.taskId, worktree: existing.worktree, sessionId: existing.sessionId, request: existing.request }) !== canonical({ accountId, projectId: proposed.projectId, taskId: proposed.taskId, worktree, sessionId: proposed.sessionId, request })) throw new Error('同一原型操作不能绑定不同候选或现场')
      return this.resume(existing.id)
    }
    data.operations.push(proposed); await this.save(proposed)
    return this.resume(proposed.id)
  }
  async operation(id: string): Promise<PrototypeIntegrationOperation | undefined> { return structuredClone((await this.data()).operations.find(value => value.id === id)) }
  /** An aborted operation is settled history and must not block a newly keyed candidate. */
  async unresolved(taskId: string): Promise<PrototypeIntegrationOperation | undefined> {
    const operation = (await this.data()).operations.find(value => value.taskId === taskId && value.phase !== 'accepted' && value.phase !== 'aborted')
    return operation && structuredClone(operation)
  }
  /** Abort only the original prepared integration while the stable branch is still its expected head. */
  async abort(id: string): Promise<PrototypeIntegrationOperation> {
    const operation = (await this.data()).operations.find(value => value.id === id)
    if (!operation) throw new Error('原型集成操作不存在')
    this.assertRequest(operation)
    try {
      const view = await this.observe(operation)
      if (!view) {
        if (operation.phase !== 'aborted') {
          operation.phase = 'aborted'; operation.message = '后台未登记原集成，未重新固定或提交；原候选和事项现场已保留'; await this.save(operation)
        }
        return structuredClone(operation)
      }
      if (view.status === 'accepted') return this.resume(operation.id)
      if (view.status === 'aborted') return structuredClone(operation)
      const head = await this.stableHead(operation)
      if (head === operation.request.candidateSha) return this.resume(operation.id)
      if (head !== operation.request.expectedHead) throw new Error('项目 Git 头已变化，原候选可能形成分叉；请受保护核对，未宣称撤销成功')
      await this.abortPrepared(operation, view)
      return structuredClone(operation)
    } catch (error) {
      await this.owner(operation.accountId)
      const message = error instanceof Error ? error.message : '原型集成撤销结果待核对'
      if (operation.phase === 'accepted') operation.deliveryMessage = message
      else if (operation.phase !== 'aborted') { operation.phase = 'unknown'; operation.message = message }
      await this.save(operation)
      throw error
    }
  }
  private cancelledResult(operation: PrototypeTaskEndOperation, result: CancelledPrototypeTask): CancelledPrototypeTask {
    if (!result || result.id !== operation.taskId || result.status !== 'cancelled' || result.ownerId !== operation.accountId || result.clientId !== operation.request.token.clientId || !['clear', 'unknown', 'reconcile-required'].includes(result.gitRecovery)) throw new Error('后台结束事项结果的身份或 Git 恢复状态无法核对')
    return structuredClone(result)
  }
  private async acceptTaskEnd(operation: PrototypeTaskEndOperation, integration: PrototypeIntegrationOperation): Promise<PrototypeTaskEndOperation> {
    operation.phase = 'accepting'; await this.save(operation)
    const accepted = await this.resume(integration.id), view = accepted.accepted
    if (accepted.phase !== 'accepted' || !view?.baselineId || !accepted.integrationId) throw new Error('原集成接受结果缺少基线，不能结束为取消')
    operation.result = { status: 'accepted', integrationId: accepted.integrationId, baselineId: view.baselineId }
    operation.phase = 'accepted'; delete operation.message; await this.save(operation)
    return structuredClone(operation)
  }
  private async projectTaskEnd(operation: PrototypeTaskEndOperation): Promise<PrototypeTaskEndOperation> {
    if (operation.result?.status !== 'cancelled') throw new Error('结束事项结果尚未确认')
    const delivery = operation.delivery ??= { step: 'projection', completed: [] }
    const run = async (step: PrototypeTaskEndDeliveryStep, action: () => Promise<void>): Promise<void> => {
      if (delivery.completed.includes(step)) return
      delivery.step = step; await this.save(operation)
      await this.external(operation, action)
      delivery.completed.push(step)
      try { await this.save(operation) }
      catch (error) { delivery.completed.pop(); throw error }
    }
    operation.phase = 'projecting'; await this.save(operation)
    await run('projection', () => this.deps.cancelled(operation.taskId, operation.result!.status === 'cancelled' ? operation.result!.gitRecovery : 'unknown'))
    await run('preview', () => this.deps.stopPreview(operation.sessionId))
    await run('release', async () => {
      if (!this.deps.releaseTask) throw new Error('本机缺少原生事项资源释放能力，原现场已保留，请恢复能力后重试')
      await this.deps.releaseTask(operation.worktree)
    })
    operation.phase = 'cancelled'
    if (operation.result.gitRecovery === 'clear') delete operation.message
    else operation.message ??= `事项已结束；Git 恢复状态为 ${operation.result.gitRecovery}，本机现场已保留`
    await this.save(operation)
    return structuredClone(operation)
  }
  /** End the task through one durable request, recovering prepare, abort, accept and cancel from their original keys. */
  async cancel(taskId: string, operationId: string): Promise<PrototypeTaskEndOperation> {
    const data = await this.data(), accountId = this.store.accountId!
    let operation = data.taskEnds.find(value => value.id === operationId)
    if (operation && (operation.taskId !== taskId || operation.accountId !== accountId || operation.request.idempotencyKey !== operationId)) throw new Error('同一结束操作不能绑定其他事项')
    if (operation?.phase === 'accepted' || operation?.phase === 'cancelled') return structuredClone(operation)
    if (!operation) {
      const pending = data.taskEnds.findLast(value => value.taskId === taskId && value.phase !== 'accepted' && value.phase !== 'cancelled')
      if (pending) throw new Error(`该事项已有结束操作 ${pending.id}，请核对原操作`)
      const integration = data.operations.findLast(value => value.taskId === taskId && value.phase !== 'accepted' && value.phase !== 'aborted')
      const local = integration ? undefined : this.deps.cancellation(taskId)
      const projectId = integration?.projectId ?? local!.projectId, authorization = integration?.request.token ?? local!.task
      const sessionId = integration?.sessionId ?? local!.sessionId, worktree = integration?.worktree ?? local!.worktree
      if (local && (local.task.id !== taskId || local.task.status !== 'active' || local.task.ownerId !== accountId)) throw new Error('只有本机当前账号的 active 事项可以结束')
      operation = {
        id: operationId, accountId, projectId, taskId, sessionId, worktree, phase: 'prepared', ...(integration ? { integrationOperationId: integration.id } : {}),
        request: { idempotencyKey: operationId, token: { prototypeTaskId: taskId, generation: authorization.generation, clientId: authorization.clientId, expectedRevision: 'expectedRevision' in authorization ? authorization.expectedRevision : authorization.revision }, reason: '用户明确结束原型事项，保留本机现场' },
      }
      data.taskEnds.push(operation); await this.save(operation)
    }
    if (operation.result?.status === 'cancelled') return this.projectTaskEnd(operation)
    try {
      operation.phase = 'reconciling'; await this.save(operation)
      const integration = operation.integrationOperationId ? data.operations.find(value => value.id === operation.integrationOperationId) : undefined
      if (operation.integrationOperationId && (!integration || integration.taskId !== taskId)) throw new Error('结束事项关联的原集成记录缺失')
      if (integration) {
        const view = await this.observe(integration)
        if (view?.status === 'accepted') return this.acceptTaskEnd(operation, integration)
        if (view?.status === 'prepared') {
          let head: string | undefined
          try { head = await this.stableHead(integration) }
          catch (error) {
            await this.owner(operation.accountId)
            operation.message = `真实 Git 头无法核对：${error instanceof Error ? error.message : '未知错误'}；结束后台事项后仍需 Git 核对`; await this.save(operation)
          }
          if (head === integration.request.candidateSha) return this.acceptTaskEnd(operation, integration)
          if (head === integration.request.expectedHead) {
            operation.phase = 'aborting'; await this.save(operation)
            await this.abort(integration.id)
            if (integration.phase === 'accepted') return this.acceptTaskEnd(operation, integration)
          } else if (head !== undefined) {
            operation.message = '项目 Git 头已偏离原候选；后台接受权可结束，但分叉仍需受保护核对'; await this.save(operation)
          }
        }
      }
      operation.phase = 'cancelling'; await this.save(operation)
      let result = await this.receipt<CancelledPrototypeTask>(operation, operation.request.idempotencyKey, `prototype.task.cancel:${taskId}`)
      if (!result) result = await this.external(operation, () => this.api.request<CancelledPrototypeTask>('POST', this.route(operation, `/prototype/tasks/${encodeURIComponent(taskId)}/cancel`), operation.request))
      const cancelled = this.cancelledResult(operation, result)
      operation.result = { status: 'cancelled', task: structuredClone(cancelled), gitRecovery: cancelled.gitRecovery }
      return this.projectTaskEnd(operation)
    } catch (error) {
      await this.owner(operation.accountId)
      if (operation.phase !== 'accepted' && operation.phase !== 'cancelled') {
        operation.phase = 'unknown'; operation.message = error instanceof Error ? error.message : '结束事项结果待核对'; await this.save(operation)
      }
      throw error
    }
  }
  async taskEnd(id: string): Promise<PrototypeTaskEndOperation | undefined> { return structuredClone((await this.data()).taskEnds.find(value => value.id === id)) }
  /** Reconcile the original prepare and Git head before sending any new side effect. */
  async resume(id: string): Promise<PrototypeIntegrationOperation> {
    const operation = (await this.data()).operations.find(value => value.id === id)
    if (!operation) throw new Error('原型集成操作不存在')
    const input = this.assertRequest(operation)
    try {
      if (operation.phase !== 'accepted') {
        if (!operation.integrationId) {
          let view: IntegrationView | undefined
          try {
            const receipt = await this.external(operation, () => this.api.request<{ action: string; result: IntegrationView }>('GET', this.route(operation, `/operations/${encodeURIComponent(operation.id)}`)))
            if (receipt.action !== 'prototype.integration.prepare') throw new Error('原操作不是原型集成')
            view = this.integration(operation, receipt.result)
          } catch (error) {
            if (!(error instanceof CollaborationError) || error.code !== 'OPERATION_NOT_FOUND') throw error
          }
          if (!view) {
            await this.assertTask(operation)
            await this.upload(operation, input.sourceRef.slice('refs/heads/'.length), input.sourceSha, 'source-uploading', 'source-uploaded')
            await this.upload(operation, input.candidateRef.slice('refs/heads/'.length), input.candidateSha, 'candidate-uploading', 'uploaded')
            if (await this.external(operation, () => this.ports.git.optionalRemoteHead(operation.worktree, input.sourceRef.slice('refs/heads/'.length))) !== input.sourceSha) throw new Error('原作者来源引用已变化')
            operation.phase = 'preparing'; await this.save(operation)
            view = this.integration(operation, await this.external(operation, () => this.api.request<IntegrationView>('POST', this.route(operation, '/prototype/integrations'), input)))
          }
          operation.integrationId = view.id; operation.phase = 'prepared'; await this.save(operation)
        }
        let view = this.integration(operation, await this.external(operation, () => this.api.request<IntegrationView>('GET', this.route(operation, `/prototype/integrations/${encodeURIComponent(operation.integrationId!)}`))))
        if (view.status === 'aborted') { operation.phase = 'aborted'; await this.save(operation); throw new Error('原型集成已中止，原候选和事项现场已保留') }
        if (view.status === 'prepared') {
          await this.assertTask(operation)
          const project = await this.external(operation, () => this.api.request<ProjectState>('GET', this.route(operation, '')))
          if (project.project.id !== operation.projectId || !project.project.stableBranch) throw new Error('原型所属项目状态无效')
          const branch = project.project.stableBranch
          await this.external(operation, () => this.ports.git.fetch(operation.worktree, branch))
          const head = await this.external(operation, () => this.ports.git.remoteHead(operation.worktree, branch))
          if (head === input.expectedHead) {
            operation.phase = 'pushing'; await this.save(operation)
            await this.external(operation, () => this.ports.git.conditionalUpdate(operation.worktree, branch, input.expectedHead, input.candidateSha))
          } else if (head !== input.candidateSha) throw new Error('项目 Git 头已变化，请按原操作核对并重新构造候选')
          operation.phase = 'pushed'; await this.save(operation)
          operation.phase = 'completing'; await this.save(operation)
          view = this.integration(operation, await this.external(operation, () => this.api.request<IntegrationView>('POST', this.route(operation, `/prototype/integrations/${encodeURIComponent(view.id)}/complete`), { idempotencyKey: `${operation.id}-complete`, token: input.token, developmentClaims: input.developmentClaims, claimsDigest: input.claimsDigest })))
        }
        if (view.status !== 'accepted') throw new Error('原型候选尚未被后台接受')
        operation.accepted = structuredClone(view); operation.phase = 'accepted'; delete operation.message; await this.save(operation)
      }
      const accepted = this.integration(operation, operation.accepted!)
      await this.deliver(operation, accepted)
      delete operation.deliveryMessage; await this.save(operation)
      return structuredClone(operation)
    } catch (error) {
      await this.owner(operation.accountId)
      const message = error instanceof Error ? error.message : '原型集成结果待核对'
      if (operation.phase === 'accepted') operation.deliveryMessage = message
      else if (operation.phase !== 'aborted') { operation.phase = 'unknown'; operation.message = message }
      await this.save(operation)
      throw error
    }
  }
}
