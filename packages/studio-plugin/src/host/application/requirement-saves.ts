import { realpath } from 'node:fs/promises'
import { canonical } from '@eadp/asset-domain'
import { isMaterialMetadata, type EntityView, type MaterialMetadata, type OccupationToken, type ProjectState, type UpdateEntityRequest, type UpdateRelationsRequest } from '@eadp/contracts'
import type { MaterialDraft, TaskView } from '../../shared/studio.ts'
import type { RequirementSaveView, RequirementWorkspaceCommand } from '../../shared/requirement-workspace.ts'
import { digest, readMaterial } from '../adapters/assets/materials.ts'
import { CollaborationError, type CollaborationClient } from '../adapters/collaboration/client.ts'
import { sameTemplate, type ScenarioDocumentService } from './scenario-documents.ts'
import { syncProjectContext } from './scenario-package.ts'
import type { StudioStore } from './state.ts'

type SaveCommand = Extract<RequirementWorkspaceCommand, { action: 'saveRequirement' }>
type SaveContext = { remote: ProjectState; entity: EntityView; task: TaskView }
type Phase = RequirementSaveView['phase']
type Reason = RequirementSaveView['reason']
interface RemoteStep<T> { request: T; accepted?: EntityView }

/** One immutable user request and the accepted facts of its three independent writes. */
export interface RequirementSaveOperation {
  operationId: string; projectId: string; entityId: string; accountId: number;
  request: SaveCommand; fingerprint: string;
  phase: Phase; status: 'pending' | 'recovery' | 'applied' | 'superseded';
  reason: Reason; message: string;
  root?: string; occupation?: OccupationToken; metadata?: MaterialMetadata;
  relations?: RemoteStep<UpdateRelationsRequest>; relationsAccepted?: boolean;
  document?: MaterialDraft; directory?: RemoteStep<UpdateEntityRequest>;
}
export interface RequirementSaveOwner { requirementSaves?: RequirementSaveOperation[] }
interface Dependencies {
  context(entityId: string, projectId?: string): Promise<SaveContext>
  owned(entity: EntityView): Promise<OccupationToken>
  record(entityId: string, projectId?: string): Promise<RequirementSaveOwner>
  documents(): ScenarioDocumentService
  applied?(operation: RequirementSaveOperation): void
}
class SaveProblem extends Error { constructor(readonly reason: Reason, message: string) { super(message) } }
class ScopeChanged extends Error {}
const occupationKey = (token: OccupationToken): string => canonical([token.occupationId, token.generation, token.taskId, token.clientId])
const tokenOf = ({ occupationId, generation, taskId, clientId, expectedRevision }: OccupationToken): OccupationToken => ({ occupationId, generation, taskId, clientId, expectedRevision })
/** Formal scenario relationships exclude adoption provenance retained in the material. */
const scenarioSources = (metadata: MaterialMetadata, projectId: string): MaterialMetadata['sources'] => metadata.sources.filter(source => source.projectId === projectId && metadata.scenarioIds.includes(source.entityId))
const sameRelations = (entity: EntityView, metadata: MaterialMetadata, projectId: string): boolean => canonical(entity.scenarioIds) === canonical(metadata.scenarioIds) && canonical(entity.scenarioSources ?? []) === canonical(scenarioSources(metadata, projectId)) && canonical(entity.prerequisites) === canonical(metadata.prerequisites)
const last = (owner: RequirementSaveOwner): RequirementSaveOperation | undefined => owner.requirementSaves?.at(-1)
const identifier = (value: string): void => { if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value)) throw new Error('需求保存操作 ID 无效') }
const stepId = (operationId: string, phase: 'relations' | 'directory'): string => `${digest(operationId)}-${phase}`

/** Owns requirement saves, including remote receipts and directory-only recovery. */
export class RequirementSaves {
  constructor(private readonly store: StudioStore, private readonly api: CollaborationClient, private readonly deps: Dependencies) {}

  view(owner: RequirementSaveOwner): RequirementSaveView | undefined {
    const operation = last(owner)
    if (!operation || operation.status === 'applied' || operation.status === 'superseded') return undefined
    return { operationId: operation.operationId, phase: operation.phase, status: operation.status, reason: operation.reason, message: operation.message, documentSaved: !!operation.document,
      ...(!operation.document ? { input: { body: operation.request.body, metadata: structuredClone(operation.request.metadata) } } : {}) }
  }
  /** A completed save names exact bytes; callers must compare them again before confirming. */
  result(owner: RequirementSaveOwner, operationId: string): MaterialDraft | undefined {
    const operation = owner.requirementSaves?.find(value => value.operationId === operationId)
    return operation?.status === 'applied' && operation.document ? structuredClone(operation.document) : undefined
  }
  async automatic(projectId: string): Promise<Array<{ entityId: string; operationId: string }>> {
    const local = await this.store.read()
    return local.scenarios.filter(owner => owner.projectId === projectId).flatMap(owner => {
      const operation = last(owner)
      return operation && operation.accountId === this.store.accountId && operation.status === 'pending' && operation.phase === 'directory' && operation.document && operation.relationsAccepted
        ? [{ entityId: operation.entityId, operationId: operation.operationId }] : []
    })
  }
  async save(command: SaveCommand, projectId?: string): Promise<void> {
    identifier(command.operationId)
    const local = await this.store.read(), accountId = this.store.accountId
    projectId ??= local.selectedProjectId
    if (!projectId || !accountId) throw new Error('请选择当前账号的项目后保存需求')
    const owner = await this.deps.record(command.entityId, projectId)
    const fingerprint = digest(canonical(command))
    let operation = owner.requirementSaves?.find(value => value.operationId === command.operationId)
    if (operation) {
      this.scope(operation)
      if (operation.fingerprint !== fingerprint) throw new Error('同一需求保存操作不能用于不同输入')
      if (operation.status === 'applied') return
      if (operation.status === 'superseded') throw new Error('该保存已由新的用户选择承接，请核对当前保存')
    } else {
      operation = { operationId: command.operationId, projectId, entityId: command.entityId, accountId, request: structuredClone(command), fingerprint,
        phase: 'relations', status: 'pending', reason: 'network', message: '正在保存需求' }
      ;(owner.requirementSaves ??= []).push(operation)
      await this.persist(operation)
    }
    await this.run(owner, operation)
  }
  async retry(entityId: string, operationId: string, projectId?: string): Promise<void> {
    identifier(operationId)
    const owner = await this.deps.record(entityId, projectId)
    const operation = owner.requirementSaves?.find(value => value.operationId === operationId)
    if (!operation || operation.entityId !== entityId) throw new Error('未找到需求保存操作')
    this.scope(operation)
    if (operation.status === 'applied') return
    if (last(owner) !== operation || operation.status === 'superseded') throw new Error('请恢复当前用户选择对应的保存操作')
    await this.run(owner, operation)
  }
  private scope(operation: RequirementSaveOperation): void {
    if (!this.store.scoped || this.store.accountId !== operation.accountId) throw new ScopeChanged('登录身份已变化，原需求保存保留供核对')
  }
  private async persist(operation: RequirementSaveOperation): Promise<void> { this.scope(operation); await this.store.save() }
  private route(operation: RequirementSaveOperation, suffix: string): string { return `/v1/projects/${encodeURIComponent(operation.projectId)}${suffix}` }
  /** Reads back the document this save wrote; a missing or unreadable file stops the published directory. */
  private async read(operation: RequirementSaveOperation): Promise<MaterialDraft> {
    try { return await readMaterial(operation.root!, 'requirement', operation.entityId) }
    catch (error) { throw new SaveProblem('invalid', `本地材料无法读取，请保留输入并修复文件后继续：${error instanceof Error ? error.message : '文件不可用'}`) }
  }
  private async context(operation: RequirementSaveOperation): Promise<SaveContext & { token: OccupationToken }> {
    this.scope(operation)
    const context = await this.deps.context(operation.entityId, operation.projectId)
    this.scope(operation)
    if (context.remote.project.id !== operation.projectId || context.entity.id !== operation.entityId || context.entity.kind !== 'requirement' || context.task.entityId !== operation.entityId || context.task.projectId !== operation.projectId || context.task.purpose !== 'material') throw new SaveProblem('invalid', '需求保存的项目或任务身份已变化，请重新打开当前需求')
    const root = await realpath(context.task.worktree)
    if (operation.root && operation.root !== root) throw new SaveProblem('occupation', '当前编辑任务已变化，请保留输入并核对编辑权')
    let token: OccupationToken
    try { token = tokenOf(await this.deps.owned(context.entity)) }
    catch (error) { throw new SaveProblem('occupation', error instanceof Error ? error.message : '请重新取得当前需求的编辑权') }
    if (operation.occupation && occupationKey(operation.occupation) !== occupationKey(token)) throw new SaveProblem('occupation', '需求占用已变化，请重新取得编辑权或保留输入退出编辑')
    if (operation.relationsAccepted && !sameRelations(context.entity, operation.request.metadata, operation.projectId)) throw new SaveProblem('relations', '需求来源或前置关系已变化，请核对当前选择后继续')
    return { ...context, token }
  }
  private revision(operation: RequirementSaveOperation, token: OccupationToken): void {
    const expected = operation.directory?.accepted?.revision ?? operation.relations?.accepted?.revision ?? operation.occupation?.expectedRevision
    if (token.expectedRevision !== expected) throw new SaveProblem('occupation', '需求在本次保存之外发生了变更，请核对当前版本后继续')
  }
  private async prepare(operation: RequirementSaveOperation): Promise<void> {
    const { request } = operation
    if (!isMaterialMetadata(request.metadata) || request.metadata.kind !== 'requirement' || request.metadata.entityId !== operation.entityId || typeof request.body !== 'string' || request.body.length > 1_000_000) throw new SaveProblem('invalid', '需求材料身份或内容无效，请核对当前输入')
    const context = await this.context(operation), metadata = request.metadata
    if (!context.entity.templateRef || metadata.templateId !== context.entity.templateId || !sameTemplate(metadata.templateRef, context.entity.templateRef)) throw new SaveProblem('invalid', '编辑期间需求模板固定，请核对当前需求的模板')
    operation.root ??= await realpath(context.task.worktree)
    operation.occupation ??= structuredClone(context.token)
    const currentMetadata = await syncProjectContext(operation.root, metadata)
    if (operation.metadata && canonical(operation.metadata) !== canonical(currentMetadata)) throw new SaveProblem('invalid', '项目上下文已变化，请核对当前材料后重新保存')
    operation.metadata ??= structuredClone(currentMetadata)
    await this.persist(operation)
  }
  private async lookup<T extends UpdateEntityRequest | UpdateRelationsRequest>(operation: RequirementSaveOperation, phase: 'relations' | 'directory', step: RemoteStep<T>): Promise<boolean> {
    if (step.accepted) return true
    try {
      const receipt = await this.api.request<{ action: string; result: EntityView }>('GET', this.route(operation, `/operations/${encodeURIComponent(step.request.idempotencyKey)}`))
      this.scope(operation)
      if (receipt.action !== `${phase === 'relations' ? 'relations.write' : 'entity.update'}:${operation.entityId}`) throw new SaveProblem('invalid', '后台操作回执不属于当前需求保存')
      this.accepted(operation, phase, step, receipt.result)
      await this.persist(operation)
      return true
    } catch (error) {
      if (error instanceof CollaborationError && error.code === 'OPERATION_NOT_FOUND') return false
      throw error
    }
  }
  private accepted<T extends UpdateEntityRequest | UpdateRelationsRequest>(operation: RequirementSaveOperation, phase: 'relations' | 'directory', step: RemoteStep<T>, value: EntityView): void {
    const request = step.request
    if (!value || value.id !== operation.entityId || value.kind !== 'requirement' || !value.occupation || occupationKey(value.occupation) !== occupationKey(request.token) || value.revision !== request.token.expectedRevision + 1 || value.occupation.expectedRevision !== value.revision) throw new SaveProblem('invalid', '后台接受结果与原需求保存请求不一致')
    if (phase === 'relations') {
      const relations = request as UpdateRelationsRequest
      if (canonical(value.scenarioIds) !== canonical(relations.scenarioIds) || canonical(value.scenarioSources ?? []) !== canonical(relations.sources) || canonical(value.prerequisites) !== canonical(relations.prerequisites)) throw new SaveProblem('invalid', '后台已接受的来源关系与原请求不一致')
    } else {
      const directory = request as UpdateEntityRequest
      if (value.title !== directory.title || directory.summary !== undefined && value.summary !== directory.summary) throw new SaveProblem('invalid', '后台已接受的标题或摘要与原请求不一致')
    }
    step.accepted = structuredClone(value)
  }
  private async reconcilePrevious(owner: RequirementSaveOwner, operation: RequirementSaveOperation): Promise<void> {
    for (const previous of owner.requirementSaves ?? []) {
      if (previous === operation) break
      if (previous.status === 'applied' || previous.status === 'superseded') continue
      this.scope(previous)
      if (previous.relations) await this.lookup(previous, 'relations', previous.relations)
      if (previous.directory) await this.lookup(previous, 'directory', previous.directory)
      previous.status = 'superseded'
      await this.persist(previous)
    }
  }
  private async remote<T extends UpdateEntityRequest | UpdateRelationsRequest>(operation: RequirementSaveOperation, phase: 'relations' | 'directory', step: RemoteStep<T>): Promise<void> {
    if (await this.lookup(operation, phase, step)) return
    const context = await this.context(operation)
    if (context.token.expectedRevision !== step.request.token.expectedRevision) throw new SaveProblem('occupation', '需求版本已变化，原请求尚未被接受，请核对后重新保存')
    const result = await this.api.request<EntityView>('PUT', this.route(operation, `/entities/${encodeURIComponent(operation.entityId)}${phase === 'relations' ? '/relations' : ''}`), step.request)
    this.scope(operation)
    this.accepted(operation, phase, step, result)
    await this.persist(operation)
  }
  private async writeRelations(operation: RequirementSaveOperation): Promise<void> {
    if (operation.relationsAccepted) return
    operation.phase = 'relations'
    const { entity, token } = await this.context(operation), metadata = operation.request.metadata
    if (operation.relations) await this.remote(operation, 'relations', operation.relations)
    else if (!sameRelations(entity, metadata, operation.projectId)) {
      this.revision(operation, token)
      operation.relations = { request: { idempotencyKey: stepId(operation.operationId, 'relations'), token: structuredClone(token), scenarioIds: structuredClone(metadata.scenarioIds), sources: structuredClone(scenarioSources(metadata, operation.projectId)), prerequisites: structuredClone(metadata.prerequisites) } }
      await this.persist(operation)
      await this.remote(operation, 'relations', operation.relations)
    }
    operation.relationsAccepted = true
    await this.persist(operation)
  }
  private async writeDocument(operation: RequirementSaveOperation): Promise<void> {
    if (!operation.document) {
      operation.phase = 'document'
      await this.persist(operation)
      this.revision(operation, (await this.context(operation)).token)
      if (canonical(await syncProjectContext(operation.root!, operation.request.metadata)) !== canonical(operation.metadata)) throw new SaveProblem('invalid', '项目上下文在保存期间变化，请核对后重新保存')
      operation.document = await this.deps.documents().save({ root: operation.root!, metadata: operation.metadata!, body: operation.request.body, operationId: operation.operationId })
      await this.persist(operation)
    }
  }
  private async writeDirectory(operation: RequirementSaveOperation): Promise<void> {
    operation.phase = 'directory'
    await this.persist(operation)
    const { entity, token } = await this.context(operation), metadata = operation.request.metadata
    await this.ensureDocument(operation)
    if (operation.directory) await this.remote(operation, 'directory', operation.directory)
    else if (metadata.title !== entity.title || metadata.summary !== undefined && metadata.summary !== entity.summary) {
      this.revision(operation, token)
      operation.directory = { request: { idempotencyKey: stepId(operation.operationId, 'directory'), token: structuredClone(token), title: metadata.title, ...(metadata.summary !== undefined ? { summary: metadata.summary } : {}) } }
      await this.persist(operation)
      await this.remote(operation, 'directory', operation.directory)
    }
    this.revision(operation, (await this.context(operation)).token)
    operation.status = 'applied'; operation.message = '需求已保存'
    await this.persist(operation)
    this.deps.applied?.(operation)
  }
  /** Re-asserts the submitted document when the file moved after this save wrote it, so the published title and the material stay one version. */
  private async ensureDocument(operation: RequirementSaveOperation): Promise<void> {
    if ((await this.read(operation)).sha256 === operation.document!.sha256) return
    operation.document = await this.deps.documents().save({ root: operation.root!, metadata: operation.metadata!, body: operation.request.body, operationId: `${operation.operationId}-reassert` })
    await this.persist(operation)
  }
  private async run(owner: RequirementSaveOwner, operation: RequirementSaveOperation): Promise<void> {
    try {
      await this.prepare(operation)
      await this.reconcilePrevious(owner, operation)
      await this.writeRelations(operation)
      await this.writeDocument(operation)
      await this.writeDirectory(operation)
    } catch (error) {
      this.scope(operation)
      let reason: Reason = 'network'
      if (error instanceof SaveProblem) reason = error.reason
      else if (error instanceof CollaborationError) reason = /OCCUPATION|REVISION|LOGIN|PERMISSION|FORBIDDEN|ACCESS/.test(error.code) || error.status === 401 || error.status === 403 ? 'occupation' : error.status >= 500 || error.status === 429 || error.status === 408 ? 'network' : operation.phase === 'relations' ? 'relations' : 'invalid'
      else if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^(ENOENT|EACCES|ENOSPC|EROFS)$/.test(error.code)) reason = 'invalid'
      else if (error instanceof Error && /占用|编辑权|只读|occupation/i.test(error.message)) reason = 'occupation'
      else if (error instanceof Error && /同一.*操作|模板|身份|上下文/.test(error.message)) reason = 'invalid'
      operation.reason = reason; operation.status = reason === 'network' ? 'pending' : 'recovery'
      operation.message = error instanceof Error ? error.message : '保存尚未完成，请选择恢复方式'
      await this.persist(operation)
    }
  }
}
