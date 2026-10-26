import path from 'node:path'
import { canonical } from '@eadp/asset-domain'
import { isMaterialIntegrationRequest, type IntegrationView, type MaterialIntegrationRequest, type ProjectState } from '@eadp/contracts'
import type { MaterialDraft, TaskView } from '../../shared/studio.ts'
import { CollaborationError, type CollaborationClient } from '../adapters/collaboration/client.ts'
import type { BackgroundLane } from './background-lane.ts'
import type { HostPorts } from './ports.ts'
import type { PendingOperation, StudioStore } from './state.ts'

interface Dependencies {
  accepted(operation: PendingOperation, integration: IntegrationView, task: TaskView): Promise<void>
}
class ScopeChanged extends Error {}
const taskBinding = (task: TaskView): PendingOperation['task'] => ({ projectId: task.projectId, entityId: task.entityId, worktree: path.resolve(task.worktree), purpose: task.purpose, sessionId: task.sessionId, inputHash: task.inputHash })
const binding = (operation: PendingOperation): string => canonical({ accountId: operation.accountId, projectId: operation.projectId, entityId: operation.entityId, task: operation.task, candidateSha: operation.candidateSha, expectedHead: operation.expectedHead, fixedPath: operation.fixedPath, sha256: operation.sha256, prepare: operation.prepare, token: operation.token })
const message = (error: unknown): string => error instanceof Error ? error.message : '原集成结果待核对'

/** Owns one fixed candidate's Git publication and backend acceptance, independently of later business work. */
export class GitIntegrations {
  private readonly running = new Map<string, Promise<void>>()
  constructor(private readonly store: StudioStore, private readonly api: CollaborationClient, private readonly ports: HostPorts,
    private readonly lane: BackgroundLane, private readonly deps: Dependencies) {}

  /** Persist the exact candidate and original task before any remote work can begin. */
  async submit(task: TaskView, draft: MaterialDraft, prepare: MaterialIntegrationRequest): Promise<PendingOperation> {
    const accountId = this.store.accountId
    if (!accountId) throw new ScopeChanged('请先登录后提交固定候选')
    await this.assertOwner(accountId)
    const local = await this.store.read()
    await this.assertOwner(accountId)
    const operation: PendingOperation = { id: prepare.idempotencyKey, accountId, projectId: task.projectId, entityId: task.entityId, task: taskBinding(task),
      phase: 'fixed', candidateSha: prepare.candidateSha, expectedHead: prepare.expectedHead, fixedPath: draft.path, sha256: draft.sha256,
      prepare: structuredClone(prepare), token: structuredClone(prepare.token),
      adoptionIds: local.adoptions.filter(value => value.projectId === task.projectId && value.entityId === task.entityId && path.resolve(value.worktree) === path.resolve(task.worktree) && value.applied && draft.metadata.sources.some(source => source.projectId === value.request.source.projectId && source.entityId === value.request.source.entityId && source.version === value.request.source.version)).map(value => value.id) }
    this.prepare(operation)
    if (draft.entityId !== task.entityId || draft.metadata.entityId !== task.entityId) throw new Error('固定候选材料与原任务身份不一致')
    this.originalTask(operation, local.tasks)
    if (!local.projects.some(project => project.id === operation.projectId)) throw new Error('固定候选所属项目未在本机登记')
    const previous = local.operations.find(value => value.projectId === operation.projectId && value.id === operation.id)
    if (previous) {
      if (binding(previous) !== binding(operation)) throw new Error('同一集成操作不能用于不同的固定候选或任务')
      this.schedule(previous)
      return previous
    }
    local.operations.push(operation)
    await this.persist(operation)
    this.schedule(operation)
    return operation
  }

  /** Accepted delivery has its own key so a completed publication cannot suppress its recovery. */
  schedule(operation: PendingOperation): void {
    const identity = `${operation.accountId}:${operation.projectId}:${operation.id}`
    this.lane.schedule(`${operation.phase === 'accepted' ? 'accepted' : 'operation'}:${identity}`, () => this.resume(operation))
  }

  /** Reconcile the original receipt and candidate; an accepted operation only replays delivery. */
  resume(operation: PendingOperation): Promise<void> {
    const identity = `${operation.accountId}:${operation.projectId}:${operation.id}`
    const previous = this.running.get(identity)
    if (previous) return previous
    const started = this.run(operation)
    this.running.set(identity, started)
    const settled = (): void => { if (this.running.get(identity) === started) this.running.delete(identity) }
    void started.then(settled, settled)
    return started
  }

  private async assertOwner(accountId: number): Promise<void> {
    if (!this.store.scoped || this.store.accountId !== accountId) throw new ScopeChanged('登录身份已变化，原集成保留供核对')
    const account = await this.ports.account()
    if (this.store.accountId !== accountId || account?.id !== accountId) throw new ScopeChanged('登录身份已变化，原集成保留供核对')
  }
  /** Check both sides of every external wait before continuing or persisting its result. */
  private async external<T>(operation: PendingOperation, work: () => Promise<T>): Promise<T> {
    await this.assertOwner(operation.accountId)
    let result: T
    try { result = await work() }
    catch (error) { await this.assertOwner(operation.accountId); throw error }
    await this.assertOwner(operation.accountId)
    return result
  }
  private async persist(operation: PendingOperation): Promise<void> {
    await this.assertOwner(operation.accountId)
    await this.store.save()
    await this.assertOwner(operation.accountId)
  }
  private route(operation: PendingOperation, suffix = ''): string { return `/v1/projects/${encodeURIComponent(operation.projectId)}${suffix}` }
  private originalTask(operation: PendingOperation, tasks: TaskView[]): TaskView {
    const task = tasks.find(value => canonical(taskBinding(value)) === canonical(operation.task))
    if (!task || task.projectId !== operation.projectId || task.entityId !== operation.entityId) throw new Error('原集成任务现场缺失或身份已变化，已停止恢复')
    return task
  }
  private prepare(operation: PendingOperation): MaterialIntegrationRequest {
    const request = operation.prepare
    if (!isMaterialIntegrationRequest(request) || request.idempotencyKey !== operation.id || request.entityId !== operation.entityId || request.candidateSha !== operation.candidateSha || request.expectedHead !== operation.expectedHead || canonical(request.token) !== canonical(operation.token)) throw new Error('原集成请求与固定候选记录不一致')
    if (operation.task.projectId !== operation.projectId || operation.task.entityId !== operation.entityId || path.basename(operation.task.worktree) !== request.token.taskId || (request.stage === 'prototype' ? operation.task.purpose !== 'prototype' : !['material', 'handoff'].includes(operation.task.purpose))) throw new Error('原集成请求与任务占用身份不一致')
    if (request.confirmations.length !== 1 || request.confirmations[0]!.entityId !== operation.entityId || request.confirmations[0]!.fixed.path !== operation.fixedPath || request.confirmations[0]!.fixed.sha256 !== operation.sha256 || request.stage === 'material' && request.confirmations[0]!.fixed.commitSha !== request.candidateSha) throw new Error('原集成请求未包含精确固定材料')
    return request
  }
  private integration(operation: PendingOperation, request: MaterialIntegrationRequest, value: IntegrationView): IntegrationView {
    if (!value || typeof value.id !== 'string' || !value.id || value.ownerId !== operation.accountId || value.entityId !== operation.entityId || value.stage !== request.stage || value.sourceSha !== request.sourceSha || value.expectedHead !== request.expectedHead || value.candidateSha !== request.candidateSha || !['prepared', 'accepted', 'aborted'].includes(value.status) || operation.integrationId && value.id !== operation.integrationId) throw new Error('后台集成结果与原固定候选不一致')
    if (value.status === 'accepted' && (!Array.isArray(value.confirmationIds) || value.confirmationIds.length !== request.confirmations.length || value.confirmationIds.some(id => typeof id !== 'string' || !id))) throw new Error('后台接受结果缺少本次固定确认记录')
    return value
  }
  private async publish(operation: PendingOperation, request: MaterialIntegrationRequest, directory: string): Promise<IntegrationView> {
    if (!operation.integrationId) {
      let result: IntegrationView
      try {
        const receipt = await this.external(operation, () => this.api.request<{ action: string; result: IntegrationView }>('GET', this.route(operation, `/operations/${encodeURIComponent(operation.id)}`)))
        if (receipt.action !== 'integration.prepare') throw new Error('原操作不是固定候选集成')
        result = this.integration(operation, request, receipt.result)
      } catch (error) {
        if (!(error instanceof CollaborationError) || error.code !== 'OPERATION_NOT_FOUND') throw error
        // A rebuilt confirmation fixes a new candidate; its own Host branch keeps
        // the old and new bytes reachable without a force push.
        await this.external(operation, () => this.ports.git.push(operation.task.worktree, operation.candidateSha, `studio-fixed/${operation.id}-${operation.candidateSha.slice(0, 12)}`))
        result = this.integration(operation, request, await this.external(operation, () => this.api.request<IntegrationView>('POST', this.route(operation, '/integrations'), request)))
      }
      operation.integrationId = result.id
      operation.phase = 'prepared'
      await this.persist(operation)
    }
    let integration = this.integration(operation, request, await this.external(operation, () => this.api.request<IntegrationView>('GET', this.route(operation, `/integrations/${encodeURIComponent(operation.integrationId!)}`))))
    if (integration.status === 'aborted') throw new Error('原集成操作已中止，本地成果已保留')
    if (integration.status !== 'accepted') {
      const remote = await this.external(operation, () => this.api.request<ProjectState>('GET', this.route(operation)))
      if (remote.project.id !== operation.projectId || remote.project.initializationStatus !== 'ready' || !remote.project.stableBranch) throw new Error('原集成所属项目状态无效')
      const branch = remote.project.stableBranch
      const head = await this.external(operation, () => this.ports.git.remoteHead(directory, branch))
      if (head === operation.expectedHead) await this.external(operation, () => this.ports.git.conditionalUpdate(operation.task.worktree, branch, operation.expectedHead, operation.candidateSha))
      else if (head !== operation.candidateSha) throw new Error('Git 集成头已变化，需核对原候选并重新集成')
      operation.phase = 'pushed'
      await this.persist(operation)
      integration = this.integration(operation, request, await this.external(operation, () => this.api.request<IntegrationView>('POST', this.route(operation, `/integrations/${encodeURIComponent(integration.id)}/complete`), { idempotencyKey: `${operation.id}-complete`, token: request.token })))
    }
    if (integration.status !== 'accepted') throw new Error('固定候选尚未被后台接受，请核对原操作')
    return integration
  }
  private async run(input: PendingOperation): Promise<void> {
    await this.assertOwner(input.accountId)
    const local = await this.store.read()
    await this.assertOwner(input.accountId)
    const operation = local.operations.find(value => value.projectId === input.projectId && value.id === input.id)
    if (!operation || binding(operation) !== binding(input)) throw new Error('原集成记录不存在或固定身份已变化')
    try {
      const request = this.prepare(operation)
      this.originalTask(operation, local.tasks)
      if (operation.phase !== 'accepted') {
        const project = local.projects.find(value => value.id === operation.projectId)
        if (!project) throw new Error('原集成所属项目未在本机登记')
        const integration = await this.publish(operation, request, project.directory)
        operation.accepted = structuredClone(integration)
        operation.phase = 'accepted'
        delete operation.message
        await this.persist(operation)
      }
      const accepted = this.integration(operation, request, operation.accepted!)
      if (accepted.status !== 'accepted') throw new Error('原集成缺少后台接受事实')
      const task = this.originalTask(operation, (await this.store.read()).tasks)
      await this.external(operation, () => this.deps.accepted(operation, structuredClone(accepted), task))
      delete operation.deliveryMessage
      await this.persist(operation)
    } catch (error) {
      await this.assertOwner(operation.accountId)
      if (operation.phase === 'accepted') operation.deliveryMessage = message(error)
      else if (error instanceof CollaborationError && error.status >= 400 && error.status < 500 && !operation.integrationId) {
        // The backend gave a definite answer and no integration was created;
        // this input can be fixed and submitted again instead of staying unknown.
        operation.phase = 'rejected'; operation.message = message(error)
      } else { operation.phase = 'unknown'; operation.message = message(error) }
      await this.persist(operation)
      throw error
    }
  }
}
