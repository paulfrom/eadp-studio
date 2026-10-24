import { ScenarioFileObserver, type ScenarioObservedTask } from './scenario-file-observer.ts'
import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { BindTemplateRequest, EntityView, MaterialMetadata, OccupationToken, ProjectState, RepairStartRequest } from '@eadp/contracts'
import type { MaterialDraft, TaskView } from '../../shared/studio.ts'
import type { ScenarioCommand, ScenarioConflict, ScenarioSource, ScenarioWorkspace, ScenarioWriteProposal, ScenarioWriteReceipt } from '../../shared/scenarios.ts'
import type { RequirementWorkspaceCommand } from '../../shared/requirement-workspace.ts'
import { containedFile, atomicWriteFile, digest, findMaterialFile, materialText, parseMaterial, readMaterial } from '../adapters/assets/materials.ts'
import { CollaborationError, type CollaborationClient } from '../adapters/collaboration/client.ts'
import type { HostPorts } from './ports.ts'
import type { StudioStore } from './state.ts'
import type { ProjectWorkspaces } from './projects.ts'
import { ScenarioDocumentService, sameTemplate } from './scenario-documents.ts'
import { MaterialConfirmationChecks, type MaterialConfirmationOperation } from './material-confirmations.ts'
import { conclusionKey, parseWriteProposal, proposalInvalidReason, summarizeWrite, type ProposalCurrent } from './scenario-write-proposals.ts'
import { MaterialSources } from './material-sources.ts'
import { syncProjectContext } from './scenario-package.ts'
import type { TemplateCatalogResponse } from './scenario-templates.ts'
import { RequirementSaves, type RequirementSaveOperation } from './requirement-saves.ts'

interface DesignRequestContext extends ProposalCurrent { occupationKey: string }
/** Retains one exact backend request while a local template rebind is being reconciled. */
export interface MaterialTemplateBinding {
  projectId: string; kind: 'scenario'; expectedHash: string; request: BindTemplateRequest;
  status: 'pending' | 'applied'; backendAccepted?: boolean; message?: string;
  /** A fresh user decision can preserve newer local bytes after the backend already accepted the binding. */
  application?: { operationId: string; expectedHash: string };
}
type DesignCommand = ScenarioCommand | RequirementWorkspaceCommand
type SaveCommand = Extract<DesignCommand, { action: 'saveScenario' | 'resolveScenarioConflict' | 'saveRequirement' | 'resolveRequirementConflict' }>
type ResolveWriteCommand = Extract<DesignCommand, { action: 'resolveScenarioWriteProposal' | 'resolveRequirementWriteProposal' }>
type UndoWriteCommand = Extract<DesignCommand, { action: 'undoScenarioWrite' | 'undoRequirementWrite' }>
const occupationKey = (token: OccupationToken): string => `${token.occupationId}:${token.generation}:${token.taskId}:${token.clientId}`
const matchesTemplate = (metadata: MaterialMetadata, entity: EntityView): boolean => (metadata.kind === 'scenario' || metadata.kind === 'requirement') && metadata.templateId === entity.templateId && !!entity.templateRef && sameTemplate(metadata.templateRef, entity.templateRef)
export interface ScenarioRecord {
  projectId: string; entityId: string; sources: ScenarioSource[]; sourcePaths: Record<string, string>; localEvidencePaths?: string[]; activeSessionId?: string; conflict?: ScenarioConflict; splitOffered?: boolean; writeProposal?: ScenarioWriteProposal; writeProposalOccupationKey?: string; requestContexts?: Record<string, DesignRequestContext>; templateBinding?: MaterialTemplateBinding; writeReceipt?: ScenarioWriteReceipt; rejectedConclusions?: string[]; observationError?: string; impact?: ScenarioWorkspace['impact']; repairAuthorization?: { request: RepairStartRequest; task: TaskView; status: 'pending' | 'accepted'; message?: string };
  requirementSaves?: RequirementSaveOperation[];
  /** Exact confirmation requests and their accepted progress, retained across recovery choices. */
  materialConfirmations?: MaterialConfirmationOperation[];
}
export interface ScenarioDependencies {
  entity(id: string, projectId?: string): Promise<{ remote: ProjectState; entity: EntityView }>
  task(remote: ProjectState, entity: EntityView): Promise<TaskView>
  owned(entity: EntityView): Promise<OccupationToken>
  deliver(work: () => Promise<void>): void
  changed?(task: ScenarioObservedTask, error?: string): Promise<void>
}
/** Owns scenario and requirement design state; fixed Git bytes remain the accepted document authority. */
export class ScenarioWorkspaces {
  readonly sources: MaterialSources
  readonly requirementSaves: RequirementSaves
  readonly confirmationChecks: MaterialConfirmationChecks
  get documents(): ScenarioDocumentService { return new ScenarioDocumentService(this.store.directory) }
  activeEntityId: string | undefined
  private observer: ScenarioFileObserver | undefined
  private observerDirectory: string | undefined
  constructor(readonly store: StudioStore, readonly api: CollaborationClient, readonly ports: HostPorts, readonly projects: ProjectWorkspaces, readonly deps: ScenarioDependencies) {
    this.sources = new MaterialSources(store, ports, projects, deps, (entityId, projectId) => this.record(entityId, projectId))
    this.requirementSaves = new RequirementSaves(store, api, {
      context: (entityId, projectId) => this.requirementContext(entityId, projectId),
      owned: entity => deps.owned(entity), record: (entityId, projectId) => this.record(entityId, projectId), documents: () => this.documents,
    })
    this.confirmationChecks = new MaterialConfirmationChecks(store, ports, this, projects)
  }
  stopObservation(task: ScenarioObservedTask): void { this.observer?.unobserve(task) }
  /** Release every observation owned by one task worktree. */
  stopWorktree(worktree: string): void { this.observer?.unobserveWorktree(worktree) }
  dispose(): void { this.observer?.dispose(); this.observer = undefined; this.observerDirectory = undefined; this.activeEntityId = undefined }
  private observe(task: TaskView, relative: string): void {
    const directory = this.store.directory
    if (this.observerDirectory !== directory) {
      this.observer?.dispose(); this.observerDirectory = directory
      this.observer = new ScenarioFileObserver(event => this.deps.deliver(async () => {
        if (!this.store.scoped || this.store.directory !== directory || this.store.accountId !== (await this.ports.account())?.id) return
        const record = await this.record(event.task.entityId, event.task.projectId)
        if (event.kind === 'unavailable') record.observationError = event.message
        await this.deps.changed?.(event.task, event.kind === 'unavailable' ? event.message : undefined)
        await this.store.save()
      }))
    }
    if (this.observer!.observe(task, relative)) {
      void this.record(task.entityId, task.projectId).then(record => { delete record.observationError }).catch(() => undefined)
    }
  }
  /** Selected sources actually read; the proposal evidence set and its expiry both use it. */
  private readEvidenceIds(record: ScenarioRecord): string[] {
    return record.sources.filter(source => source.selected && (source.status === 'read' || source.status === 'partial')).map(source => source.id).sort()
  }
  /** Current project-root CONTEXT.md bytes and hash; absent is a distinct state, not an empty file. */
  private async projectContext(root: string): Promise<{ bytes?: Buffer; hash: string }> {
    try { const bytes = await readFile(path.join(root, 'CONTEXT.md')); return { bytes, hash: digest(bytes) } }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { hash: 'absent' }; throw error }
  }
  async record(entityId: string, projectId?: string): Promise<ScenarioRecord> {
    const local = await this.store.read(); projectId ??= local.selectedProjectId!; if (!local.projects.some(project => project.id === projectId)) throw new Error('材料项目不属于当前登录用户的本地工程')
    let value = local.scenarios.find(v => v.projectId === projectId && v.entityId === entityId)
    if (!value) { value = { projectId, entityId, sources: [], sourcePaths: {} }; local.scenarios.push(value); await this.store.save() }
    return value
  }
  async editable(entityId: string, projectId?: string) {
    const context = await this.sources.editable(entityId, projectId)
    const { task, entity } = context
    if (entity.kind !== 'scenario' && entity.kind !== 'requirement') throw new Error('请选择场景或需求材料')
    const relative = await findMaterialFile(task.worktree, entity.kind, task.entityId)
    if (relative) this.observe(task, relative)
    return context
  }
  /** Recovery reads an existing owned task; acquiring a new occupation requires a user action. */
  async requirementContext(entityId: string, projectId?: string): Promise<{ remote: ProjectState; entity: EntityView; task: TaskView }> {
    const { remote, entity } = await this.deps.entity(entityId, projectId)
    if (entity.kind !== 'requirement') throw new Error('请选择需求材料')
    const token = await this.deps.owned(entity), local = await this.store.read()
    const task = local.tasks.findLast(value => value.projectId === remote.project.id && value.entityId === entityId && value.purpose === 'material' && !value.cleanup && path.basename(value.worktree) === token.taskId)
    if (!task) throw new Error('需求编辑现场已变化，请重新打开需求并核对编辑权')
    const relative = await findMaterialFile(task.worktree, 'requirement', entityId)
    if (relative) this.observe(task, relative)
    return { remote, entity, task }
  }
  async snapshot(remote: ProjectState): Promise<ScenarioWorkspace | undefined> {
    const local = await this.store.read(), entity = remote.entities.find((e): e is EntityView => e.id === this.activeEntityId && 'generation' in e && (e.kind === 'scenario' || e.kind === 'requirement') && !e.builtinKey)
    if (!entity) return undefined
    const record = await this.record(entity.id), account = await this.ports.account()
    const projectSync = local.projects.find(project => project.id === remote.project.id)?.sync
    const owned = entity.occupation?.ownerId === account?.id && entity.occupation?.clientId === local.clientId
    const requirementSave = entity.kind === 'requirement' ? this.requirementSaves.view(record) : undefined
    const lastConfirmation = record.materialConfirmations?.at(-1)
    const confirmation = lastConfirmation && !['accepted', 'superseded'].includes(lastConfirmation.phase) ? lastConfirmation : undefined
    const recoveringRequirement = !!requirementSave || !!confirmation
    const tasks = local.tasks.filter(t => t.projectId === remote.project.id && t.entityId === entity.id && t.purpose === 'material')
    const task = tasks.find(t => t.sessionId === record.activeSessionId && (!entity.occupation || path.basename(t.worktree) === entity.occupation.taskId)) ?? tasks.findLast(t => entity.occupation && path.basename(t.worktree) === entity.occupation.taskId)
      ?? (recoveringRequirement ? tasks.findLast(t => !t.cleanup) : undefined)
    const settlementTask = task ?? tasks.findLast(item => item.cleanup)
    const readOnly = !!entity.current && !owned
    let draft: MaterialDraft
    if (readOnly && !recoveringRequirement) {
      const fixed = entity.current!.fixed, bytes = await this.projects.localFixed(remote.project.id, fixed.commitSha, fixed.path, fixed.sha256)
      // The fixed version is not local yet: the lane is fetching it, and the
      // workspace appears on the read that follows.
      if (!bytes) return undefined
      draft = parseMaterial(Buffer.from(bytes), fixed.path)
    } else {
      if (!task) return undefined
      draft = await readMaterial(task.worktree, entity.kind, entity.id)
    }
    if (draft.metadata.kind !== 'scenario' && draft.metadata.kind !== 'requirement') throw new Error('材料元数据无效')
    const fixed = draft.metadata.templateRef
    const check = await this.confirmationChecks.inspect({ projectId: remote.project.id, entity, ...(task ? { task } : {}), draft })
    if (!check) return undefined
    const templateBody = check.templateBody
    const gates = check.groups
    if (!readOnly && task) this.observe(task, draft.path)
    const cleanup = settlementTask?.cleanup
    const settlement: ScenarioWorkspace['settlement'] = !entity.current
      ? { status: 'draft' }
      : projectSync && projectSync.status !== 'synced'
        ? { status: 'sync-pending', sync: { status: projectSync.status, ...(projectSync.message ? { message: projectSync.message } : {}) }, ...(cleanup ? { cleanup } : {}) }
        : cleanup && cleanup.status !== 'done'
          ? { status: 'cleanup-pending', ...(projectSync ? { sync: { status: projectSync.status, ...(projectSync.message ? { message: projectSync.message } : {}) } } : {}), cleanup }
          : { status: 'settled', ...(projectSync ? { sync: { status: projectSync.status, ...(projectSync.message ? { message: projectSync.message } : {}) } } : {}), ...(cleanup ? { cleanup } : {}) }
    return { entityId: entity.id, draft, readOnly, template: { id: draft.metadata.templateId, name: draft.metadata.templateId, fixed, body: templateBody }, structureCheck: local.scenarioStructureCheck, gates, sources: (readOnly && !recoveringRequirement ? await this.sources.fixedSources(remote.project.id, entity.current!.fixed.commitSha, draft) : record.sources).map(source => ({ ...source, text: '' })),
      ...(record.writeProposal ? { writeProposal: { id: record.writeProposal.id, baseHash: record.writeProposal.baseHash, createdAt: record.writeProposal.createdAt, conclusions: record.writeProposal.conclusions.map(conclusion => conclusion.text), evidenceCount: record.writeProposal.evidenceIds.length, ...(record.writeProposal.target ? { target: record.writeProposal.target } : {}), status: record.writeProposal.status, ...(record.writeProposal.error ? { error: record.writeProposal.error } : {}) } } : {}), settlement,
      ...(record.writeReceipt && !record.writeReceipt.undone ? { writeReceipt: { operationId: record.writeReceipt.operationId, createdAt: record.writeReceipt.createdAt, afterHash: record.writeReceipt.afterHash, summary: record.writeReceipt.summary, canUndo: !readOnly && !record.conflict && draft.sha256 === record.writeReceipt.afterHash } } : {}), sessions: readOnly ? [] : tasks, ...(!readOnly && (record.activeSessionId ?? task?.sessionId) ? { activeSessionId: (record.activeSessionId ?? task?.sessionId)! } : {}), ...(!readOnly && record.conflict ? { conflict: record.conflict } : {}), ...(record.splitOffered !== undefined ? { splitOffered: record.splitOffered } : {}), ...(record.impact ? { impact: record.impact } : {}),
      ...(requirementSave ? { requirementSave } : {}),
      ...(confirmation ? { confirmationRecovery: { operationId: confirmation.operationId, message: confirmation.message ?? requirementSave?.message ?? '请按选择恢复保存并继续确认', ...(confirmation.savedHash ? { expectedHash: confirmation.savedHash } : {}) } } : {}),
      ...(entity.current ? { confirmedBy: entity.current.confirmedBy, confirmedAt: entity.current.confirmedAt } : {}),
      ...(!readOnly && task ? { git: await this.ports.git.state(task.worktree) } : {}) }
  }
  async open(entityId: string): Promise<void> {
    const { entity, remote } = await this.deps.entity(entityId)
    if (entity.kind !== 'scenario' && entity.kind !== 'requirement' || entity.builtinKey) throw new Error('请选择可整理的场景或需求')
    this.activeEntityId = entityId
    if (!entity.current && !entity.occupation) await this.deps.task(remote, entity)
  }
  /** Records a fixed template choice before sending its backend request; no body is regenerated. */
  async bindTemplate(entityId: string, templateId: string, expectedHash: string, operationId: string): Promise<void> {
    const target = await this.deps.entity(entityId)
    if (target.entity.kind !== 'scenario') throw new Error('需求创建后模板固定，编辑期间不能切换模板')
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(operationId) || !/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error('模板绑定操作或阅读版本无效')
    const record = await this.record(entityId), previous = record.templateBinding
    if (previous && (previous.request.idempotencyKey === operationId || previous.application?.operationId === operationId)) {
      const boundHash = previous.request.idempotencyKey === operationId ? previous.expectedHash : previous.application!.expectedHash
      if (previous.request.templateId !== templateId || boundHash !== expectedHash) throw new Error('同一模板绑定操作不能用于不同输入')
      if (previous.status !== 'applied') await this.retryTemplateBinding(entityId)
      return
    }
    const { remote, entity, task } = await this.editable(entityId)
    if (entity.kind !== 'scenario') throw new Error('需求创建后模板固定，编辑期间不能切换模板')
    const draft = await readMaterial(task.worktree, entity.kind, entity.id)
    if (draft.sha256 !== expectedHash) throw new Error('当前材料不是用户阅读的版本，请重新核对模板绑定')
    if (previous?.status === 'pending') {
      if (!previous.backendAccepted || previous.request.templateId !== templateId) throw new Error('上次模板绑定尚未完成，请先核对原操作')
      // The original request remains immutable. This decision authorizes only
      // applying that accepted binding to the newly read local document.
      previous.application = { operationId, expectedHash }; await this.store.save()
      await this.retryTemplateBinding(entityId); return
    }
    if (!matchesTemplate(draft.metadata, entity)) throw new Error('材料模板绑定与后台不一致，请先核对模板绑定操作')
    const catalog = await this.api.request<TemplateCatalogResponse>('GET', `/v1/projects/${remote.project.id}/templates`)
    const template = catalog.scenarios.templates.find(value => value.id === templateId)
    if (!template || catalog.acceptedHead !== remote.project.recognizedHead) throw new Error('模板目录已变化，请刷新项目后重试')
    record.templateBinding = { projectId: remote.project.id, kind: entity.kind, expectedHash, request: { idempotencyKey: operationId, token: { ...await this.deps.owned(entity) }, templateId, templateRef: { ...template.fixed } }, status: 'pending' }
    await this.store.save()
    await this.retryTemplateBinding(entityId)
  }
  /** Reconciles the original backend operation before applying its fixed binding to unchanged local bytes. */
  async retryTemplateBinding(entityId: string): Promise<void> {
    const record = await this.record(entityId), binding = record.templateBinding
    if (!binding) throw new Error('没有待恢复的模板绑定操作')
    if (binding.status === 'applied') return
    const request = binding.request, route = `/v1/projects/${binding.projectId}`
    const application = binding.application ?? { operationId: request.idempotencyKey, expectedHash: binding.expectedHash }
    try {
      let context = await this.editable(entityId, binding.projectId)
      if (context.entity.kind !== binding.kind || occupationKey(await this.deps.owned(context.entity)) !== occupationKey(request.token)) throw new Error('材料占用已变化，不能继续原模板绑定操作')
      if (!binding.backendAccepted) {
        let accepted: EntityView
        try {
          const operation = await this.api.request<{ action: string; result: EntityView }>('GET', `${route}/operations/${request.idempotencyKey}`)
          if (operation.action !== `scenario.template:${entityId}`) throw new Error('原操作不是当前材料的模板绑定')
          accepted = operation.result
        } catch (error) {
          if (!(error instanceof CollaborationError) || error.code !== 'OPERATION_NOT_FOUND') throw error
          const draft = await readMaterial(context.task.worktree, binding.kind, entityId)
          if (draft.sha256 !== application.expectedHash) throw new Error('本地材料已变化，未发送模板绑定，请保留原操作并核对当前内容')
          accepted = await this.api.request<EntityView>('PUT', `${route}/entities/${entityId}/template`, request)
        }
        if (accepted.id !== entityId || accepted.kind !== binding.kind || !accepted.occupation || occupationKey(accepted.occupation) !== occupationKey(request.token) || accepted.revision !== request.token.expectedRevision + 1 || accepted.templateId !== request.templateId || !accepted.templateRef || !sameTemplate(accepted.templateRef, request.templateRef)) throw new Error('后台模板绑定结果与原请求不一致')
        binding.backendAccepted = true; await this.store.save()
      }
      context = await this.editable(entityId, binding.projectId)
      if (context.entity.kind !== binding.kind || occupationKey(await this.deps.owned(context.entity)) !== occupationKey(request.token) || context.entity.templateId !== request.templateId || !context.entity.templateRef || !sameTemplate(context.entity.templateRef, request.templateRef)) throw new Error('后台材料绑定已变化，请核对原模板操作')
      await this.documents.bindTemplate({ root: context.task.worktree, kind: binding.kind, entityId, templateId: request.templateId, templateRef: request.templateRef, expectedHash: application.expectedHash, operationId: application.operationId })
      binding.status = 'applied'; delete binding.message
      delete record.writeProposal; delete record.writeProposalOccupationKey; delete record.requestContexts; delete record.writeReceipt; delete record.conflict
      await this.store.save()
    } catch (error) {
      binding.message = error instanceof Error ? error.message : '模板绑定结果待核对'
      if (error && typeof error === 'object' && 'conflict' in error && error.conflict) record.conflict = error.conflict as ScenarioConflict
      await this.store.save(); throw error
    }
  }
  async save(command: SaveCommand): Promise<void> {
    if (command.action === 'saveRequirement' || command.action === 'resolveRequirementConflict') return this.requirementSaves.save(command)
    const { task, entity, remote } = await this.editable(command.entityId), record = await this.record(entity.id)
    if (command.metadata.kind !== entity.kind || command.metadata.entityId !== entity.id || !matchesTemplate(command.metadata, entity)) throw new Error('材料身份与模板绑定不能通过编辑改变')
    if (record.conflict && command.action !== 'resolveScenarioConflict') throw new Error('请先解决外部修改冲突')
    try {
      await this.documents.save({ root: task.worktree, metadata: await syncProjectContext(task.worktree, command.metadata), body: command.body, expectedHash: command.expectedHash, operationId: command.operationId })
      if (command.metadata.title !== entity.title || command.metadata.summary !== entity.summary) await this.api.request('PUT', `/v1/projects/${remote.project.id}/entities/${entity.id}`, { idempotencyKey: `${command.operationId}-directory`, token: await this.deps.owned(entity), title: command.metadata.title, ...(command.metadata.summary !== undefined ? { summary: command.metadata.summary } : {}) })
      delete record.conflict; await this.store.save()
    } catch (error) {
      if (error && typeof error === 'object' && 'conflict' in error && error.conflict) { record.conflict = error.conflict as ScenarioConflict; await this.store.save(); return }
      throw error
    }
  }
  /**
   * Consumes a proposal only on an explicit user decision. Every bound version
   * must still match; the whole body is written through the serialized document
   * service with the proposal ID as receipt, so a repeated decision writes once.
   */
  async resolveWriteProposal(command: ResolveWriteCommand): Promise<void> {
    const record = await this.record(command.entityId), proposal = record.writeProposal
    try {
      await this.consumeWriteProposal(command)
      if (proposal?.id === command.proposalId && proposal.error) { delete proposal.error; await this.store.save() }
    } catch (error) {
      if (command.decision === 'write' && proposal?.id === command.proposalId && proposal.status === 'pending') {
        proposal.error = error instanceof Error ? error.message : '写入失败，请重试'
        await this.store.save()
      }
      throw error
    }
  }
  private async consumeWriteProposal(command: ResolveWriteCommand): Promise<void> {
    const { task, entity } = await this.editable(command.entityId), record = await this.record(entity.id), proposal = record.writeProposal
    if (!proposal || proposal.id !== command.proposalId || proposal.entityId !== entity.id) throw new Error('写入提议不存在或已被替换，请重新提问')
    if (proposal.status === 'consumed') return
    if (proposal.status === 'rejected') { if (command.decision === 'reject') return; throw new Error('写入提议已拒绝，请重新讨论后再提问') }
    if (command.decision === 'reject') {
      const keys = proposal.conclusions.map(conclusionKey)
      record.rejectedConclusions = [...new Set([...(record.rejectedConclusions ?? []), ...keys])].slice(-200)
      proposal.status = 'rejected'; await this.store.save(); return
    }
    if (record.writeProposalOccupationKey !== occupationKey(await this.deps.owned(entity))) throw new Error('材料占用已变化，写入提议已作废，请重新提问')
    // A context proposal binds only the project-root file; it never rewrites the scenario body.
    if (proposal.target === 'context') return this.resolveContextProposal(task, proposal)
    if (record.conflict) throw new Error('请先解决文件冲突')
    const draft = await readMaterial(task.worktree, entity.kind, entity.id)
    if (draft.metadata.kind !== 'scenario' && draft.metadata.kind !== 'requirement') throw new Error('材料元数据无效')
    if (!matchesTemplate(draft.metadata, entity)) throw new Error('材料模板绑定与后台不一致，请先核对模板绑定操作')
    // A process may stop after the file was replaced and before the record said so.
    if (record.writeReceipt?.operationId === proposal.id && draft.sha256 === record.writeReceipt.afterHash) {
      proposal.status = 'consumed'; proposal.operationId = proposal.id; await this.store.save(); return
    }
    if (command.expectedHash !== draft.sha256) throw new Error('当前正文不是用户确认的版本，请刷新后重新提问')
    const invalid = proposalInvalidReason(proposal, { draftHash: draft.sha256, templateRef: draft.metadata.templateRef, contextHash: (await this.projectContext(task.worktree)).hash, evidenceIds: this.readEvidenceIds(record) })
    if (invalid) throw new Error(invalid)
    const evidence = record.sources.filter(source => proposal.evidenceIds.includes(source.id)).map(source => source.name)
    const metadata = await syncProjectContext(task.worktree, draft.metadata)
    record.writeReceipt = {
      operationId: proposal.id, createdAt: new Date().toISOString(), beforeBody: draft.body, beforeHash: draft.sha256,
      afterHash: digest(materialText(metadata, proposal.body)),
      summary: summarizeWrite(draft.body, proposal.body, evidence, draft.metadata.openQuestions.filter(question => question.blocking).map(question => question.limitation)),
    }
    await this.store.save()
    try {
      await this.documents.save({ root: task.worktree, metadata, body: proposal.body, expectedHash: draft.sha256, operationId: proposal.id })
    } catch (error) {
      delete record.writeReceipt
      if (error && typeof error === 'object' && 'conflict' in error && error.conflict) { record.conflict = error.conflict as ScenarioConflict; await this.store.save(); return }
      await this.store.save(); throw error
    }
    proposal.status = 'consumed'; proposal.operationId = proposal.id; await this.store.save()
  }
  /**
   * Saves an explicitly accepted project-context conclusion inside the task
   * worktree without committing. The task baseline, this worktree and the
   * latest accepted version are compared first; a concurrent accepted change
   * returns to the conversation instead of overwriting it.
   */
  private async resolveContextProposal(task: TaskView, proposal: ScenarioWriteProposal): Promise<void> {
    const current = await this.projectContext(task.worktree)
    if (current.hash !== proposal.baseHash) throw new Error('CONTEXT.md 已变化，写入提议已作废，请重新提问')
    const { remote } = await this.deps.entity(task.entityId, task.projectId)
    const head = (await this.ports.git.state(task.worktree)).head
    const base = await this.ports.git.readOptionalBlob(task.worktree, head, 'CONTEXT.md')
    const accepted = await this.ports.git.readOptionalBlob(task.worktree, remote.project.recognizedHead!, 'CONTEXT.md')
    const sameBytes = (left?: Buffer, right?: Buffer): boolean => left === undefined ? right === undefined : right !== undefined && left.equals(right)
    if (!sameBytes(accepted, base) && !sameBytes(current.bytes, accepted)) throw new Error('项目上下文已被其他已确认版本修改，请在对话中核对差异后重新提问')
    const target = await containedFile(task.worktree, 'CONTEXT.md', true)
    await atomicWriteFile(target, proposal.body)
    try {
      // The confirmation package must carry the new hash; writing it here avoids a manual save step.
      const { entity } = await this.deps.entity(task.entityId, task.projectId)
      const draft = await readMaterial(task.worktree, entity.kind, task.entityId)
      const metadata = await syncProjectContext(task.worktree, draft.metadata)
      if (digest(materialText(metadata, draft.body)) !== draft.sha256) await this.documents.save({ root: task.worktree, metadata, body: draft.body, expectedHash: draft.sha256, operationId: `${proposal.id}-context` })
    } catch (error) {
      // Never leave a written context whose package hash was not recorded.
      if (current.bytes) await atomicWriteFile(target, current.bytes)
      else await rm(target, { force: true })
      throw error
    }
    proposal.status = 'consumed'; proposal.operationId = proposal.id; await this.store.save()
  }
  /** Restores the body saved before the latest whole-body write; the current hash must still be that write's result. */
  async undoWrite(command: UndoWriteCommand): Promise<void> {
    const { task, entity } = await this.editable(command.entityId), record = await this.record(entity.id), receipt = record.writeReceipt
    if (!receipt || receipt.operationId !== command.operationId) throw new Error('没有可撤销的整篇写入')
    if (receipt.undone) return
    if (record.conflict) throw new Error('请先解决文件冲突')
    const draft = await readMaterial(task.worktree, entity.kind, entity.id)
    if (draft.metadata.kind !== 'scenario' && draft.metadata.kind !== 'requirement') throw new Error('材料元数据无效')
    if (!matchesTemplate(draft.metadata, entity)) throw new Error('材料模板绑定与后台不一致，请先核对模板绑定操作')
    if (draft.sha256 !== receipt.afterHash || command.expectedHash !== draft.sha256) throw new Error('正文已变化，无法撤销本次写入，请先处理当前编辑')
    try {
      await this.documents.save({ root: task.worktree, metadata: await syncProjectContext(task.worktree, draft.metadata), body: receipt.beforeBody, expectedHash: draft.sha256, operationId: `${receipt.operationId}-undo` })
    } catch (error) {
      if (error && typeof error === 'object' && 'conflict' in error && error.conflict) { record.conflict = error.conflict as ScenarioConflict; await this.store.save(); return }
      throw error
    }
    receipt.undone = true; await this.store.save()
  }
  async newSession(entityId: string): Promise<string> {
    const { task, entity } = await this.editable(entityId), local = await this.store.read(), record = await this.record(entityId)
    const next = { ...task, sessionId: `studio-${randomUUID()}` }; local.tasks.push(next); record.activeSessionId = next.sessionId; await this.store.save()
    return this.ports.session(next, `你是${entity.kind === 'scenario' ? '场景' : '需求'}设计助手。使用 grilling 逐问推进设计，用 domain-modeling 沉淀术语与决策；回答先用可读中文归纳明确结论、已读资料与仍缺的业务答案；满足条件时提出针对目标文件的整篇写入提议，不满足时继续讨论，不直接写入文件或确认。`)
  }
  async selectSession(entityId: string, sessionId: string): Promise<string> {
    const { task } = await this.editable(entityId), local = await this.store.read()
    const found = local.tasks.find(t => t.projectId === task.projectId && t.entityId === entityId && t.sessionId === sessionId && t.purpose === 'material')
    if (!found) throw new Error('此会话不属于当前材料')
    const record = await this.record(entityId); record.activeSessionId = sessionId; await this.store.save()
    return this.ports.session(found, '材料设计会话：先用可读中文归纳明确结论、已读资料与仍缺的业务答案；满足条件时提出针对目标文件的整篇写入提议，不满足时继续讨论，不直接写入文件。')
  }
  /** Resolves the currently occupied worktree even when a historical conversation is resumed. */
  private async currentInput(task: TaskView) {
    const local = await this.store.read()
    const { entity } = await this.deps.entity(task.entityId, task.projectId)
    if (entity.kind !== 'scenario' && entity.kind !== 'requirement' || entity.builtinKey) throw new Error('材料上下文身份无效')
    const token = await this.deps.owned(entity)
    const currentTask = local.tasks.findLast(value => value.projectId === task.projectId && value.entityId === task.entityId && value.purpose === 'material' && path.basename(value.worktree) === token.taskId)
    if (!currentTask) throw new Error('当前修订的本地材料现场不存在，请先恢复修订任务')
    const draft = await readMaterial(currentTask.worktree, entity.kind, task.entityId)
    if (draft.metadata.kind !== 'scenario' && draft.metadata.kind !== 'requirement' || draft.metadata.kind !== entity.kind) throw new Error('材料上下文无效')
    if (!matchesTemplate(draft.metadata, entity)) throw new Error('材料模板绑定与后台不一致，请先核对模板绑定操作')
    return { entity, token, task: currentTask, draft }
  }
  async context(task: TaskView): Promise<string> {
    const local = await this.store.read(); if (!local.tasks.some(t => t.sessionId === task.sessionId && t.projectId === task.projectId) && !local.scenarioRepairs.some(r => r.task.sessionId === task.sessionId && r.projectId === task.projectId)) throw new Error('会话不属于当前登录用户')
    const { entity, token, task: currentTask, draft } = await this.currentInput(task)
    if (draft.metadata.kind !== 'scenario' && draft.metadata.kind !== 'requirement') throw new Error('材料上下文无效')
    const ref = draft.metadata.templateRef, bytes = await this.projects.readFixed(task.projectId, ref.commitSha, ref.path, ref.sha256)
    if (digest(bytes) !== ref.sha256) throw new Error('模板 hash 不符')
    const record = await this.record(entity.id, task.projectId)
    record.requestContexts ??= {}
    record.requestContexts[task.sessionId] = { draftHash: draft.sha256, templateRef: { ...ref }, contextHash: (await this.projectContext(currentTask.worktree)).hash, evidenceIds: this.readEvidenceIds(record), occupationKey: occupationKey(token) }
    await this.store.save()
    const protocol = task.scenarioRepair
      ? `当前为已授权修复任务，场景 ${task.entityId}，baseHash=${draft.sha256}。不得写文件或自行确认，缺业务答案只输出 question，不能编造。先用可读中文说明本轮修复要点、依据的已读资料与仍缺的业务答案，再在回答最后给出唯一 eadp-repair 代码块。`
      : `当前${entity.kind === 'scenario' ? '场景' : '需求'} ${task.entityId}，整文件 baseHash=${draft.sha256}。仅输出候选，不写入、不确认，禁止引用未读取资料。
回答规则：先用可读中文归纳本轮明确结论、依据哪些已读资料、还缺哪些业务答案；满足条件时提出针对目标文件的整篇写入提议，不满足时继续讨论，不直接写入文件。
当本轮形成新明确结论、且核心规则与验收所需信息已具备时，先向用户提问是否写入，并在回答最后追加唯一 eadp-write-proposal 代码块：{"entityId":"${task.entityId}","conclusions":[{"id":"结论ID","text":"本轮结论"}],"evidenceIds":["实际已读资料ID"],"body":"整篇新正文"}。块内只写这四个字段，不得写提议 ID、hash、授权或确认字段；Host 自行生成提议并校验 baseHash、模板、CONTEXT.md 与依据。用户必须在界面点击“写入”才生效，聊天中的肯定、否认、未答或歧义都不写入；同一结论被拒绝后不要重复提问，除非出现新结论。`
    return `${protocol}\n当前有效材料绝对路径：${path.join(currentTask.worktree, draft.path)}；历史会话的旧工作目录不构成本轮文件上下文，读取材料必须使用本路径。\n当前元数据：${JSON.stringify(draft.metadata)}\n当前Markdown正文：\n${draft.body}\n固定模板：\n${Buffer.from(bytes).toString('utf8')}\n${await this.sources.context(task)}`
  }
  async accept(sessionId: string, content: string): Promise<boolean> {
    const local = await this.store.read(), task = local.tasks.find(t => t.sessionId === sessionId && t.purpose === 'material')
    if (!task) return false
    if (!content.includes('```eadp-write-proposal')) return false
    const record = await this.record(task.entityId, task.projectId)
    try {
      const { draft, task: currentTask, token } = await this.currentInput(task)
      if (draft.metadata.kind !== 'scenario' && draft.metadata.kind !== 'requirement') throw new Error('材料元数据无效')
      const input = record.requestContexts?.[sessionId]
      if (!input || input.occupationKey !== occupationKey(token)) throw new Error('会话材料占用上下文已失效')
      const invalid = proposalInvalidReason({ baseHash: input.draftHash, templateRef: input.templateRef, contextHash: input.contextHash, evidenceIds: input.evidenceIds }, { draftHash: draft.sha256, templateRef: draft.metadata.templateRef, contextHash: (await this.projectContext(currentTask.worktree)).hash, evidenceIds: this.readEvidenceIds(record) })
      if (invalid) throw new Error(invalid)
      const parsed = parseWriteProposal(content, draft, this.readEvidenceIds(record))
      if (parsed.conclusions.map(conclusionKey).some(key => record.rejectedConclusions?.includes(key))) throw new Error('同一结论已被拒绝，出现新结论后再提问')
      // Host owns the ID and every bound hash; the answer only supplied content.
      if (parsed.target === 'context') {
        const context = await this.projectContext(currentTask.worktree)
        if (context.bytes?.toString('utf8') === parsed.body) throw new Error('写入提议与当前项目上下文相同')
        record.writeProposal = { id: randomUUID(), entityId: task.entityId, target: 'context', baseHash: context.hash, templateRef: draft.metadata.templateRef, contextHash: context.hash, evidenceIds: this.readEvidenceIds(record), conclusions: parsed.conclusions, body: parsed.body, createdAt: new Date().toISOString(), status: 'pending' }
      } else {
        record.writeProposal = { id: randomUUID(), entityId: task.entityId, baseHash: draft.sha256, templateRef: draft.metadata.templateRef, contextHash: (await this.projectContext(currentTask.worktree)).hash, evidenceIds: this.readEvidenceIds(record), conclusions: parsed.conclusions, body: parsed.body, createdAt: new Date().toISOString(), status: 'pending' }
      }
      record.writeProposalOccupationKey = input.occupationKey
      await this.store.save(); return true
    } catch (error) {
      // An unverifiable proposal never becomes actionable; the answer remains chat only.
      return true
    }
  }
}
