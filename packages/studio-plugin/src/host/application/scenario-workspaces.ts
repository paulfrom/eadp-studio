import { ScenarioFileObserver, type ScenarioObservedTask } from './scenario-file-observer.ts'
import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { EntityView, OccupationToken, ProjectState, RepairStartRequest } from '@eadp/contracts'
import type { MaterialDraft, TaskView } from '../../shared/studio.ts'
import type { ScenarioCommand, ScenarioConflict, ScenarioSource, ScenarioWorkspace, ScenarioWriteProposal, ScenarioWriteReceipt } from '../../shared/scenarios.ts'
import { containedFile, atomicWriteFile, digest, findMaterialFile, materialText, parseMaterial, readMaterial } from '../adapters/assets/materials.ts'
import type { CollaborationClient } from '../adapters/collaboration/client.ts'
import type { HostPorts } from './ports.ts'
import type { StudioStore } from './state.ts'
import type { ProjectWorkspaces } from './projects.ts'
import { ScenarioDocumentService, checkScenarioDocument, scenarioFileErrors } from './scenario-documents.ts'
import { conclusionKey, parseWriteProposal, proposalInvalidReason, summarizeWrite } from './scenario-write-proposals.ts'
import { MaterialSources } from './material-sources.ts'
import { syncProjectContext } from './scenario-package.ts'

export interface ScenarioRecord { projectId: string; entityId: string; sources: ScenarioSource[]; sourcePaths: Record<string, string>; localEvidencePaths?: string[]; activeSessionId?: string; conflict?: ScenarioConflict; splitOffered?: boolean; writeProposal?: ScenarioWriteProposal; writeReceipt?: ScenarioWriteReceipt; rejectedConclusions?: string[]; observationError?: string; impact?: ScenarioWorkspace['impact']; repairAuthorization?: { request: RepairStartRequest; task: TaskView; status: 'pending' | 'accepted'; message?: string } }
export interface ScenarioDependencies {
  entity(id: string, projectId?: string): Promise<{ remote: ProjectState; entity: EntityView }>
  task(remote: ProjectState, entity: EntityView): Promise<TaskView>
  owned(entity: EntityView): Promise<OccupationToken>
  deliver(work: () => Promise<void>): void
  changed?(task: ScenarioObservedTask, error?: string): Promise<void>
}
/** Owns local scene editing state; fixed Git bytes remain the accepted document authority. */
export class ScenarioWorkspaces {
  readonly sources: MaterialSources
  get documents(): ScenarioDocumentService { return new ScenarioDocumentService(this.store.directory) }
  activeEntityId: string | undefined
  private observer: ScenarioFileObserver | undefined
  private observerDirectory: string | undefined
  constructor(readonly store: StudioStore, readonly api: CollaborationClient, readonly ports: HostPorts, readonly projects: ProjectWorkspaces, readonly deps: ScenarioDependencies) { this.sources = new MaterialSources(store, ports, projects, deps, (entityId, projectId) => this.record(entityId, projectId)) }
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
    const local = await this.store.read(); projectId ??= local.selectedProjectId!; if (!local.projects.some(project => project.id === projectId)) throw new Error('场景项目不属于当前登录用户的本地工程')
    let value = local.scenarios.find(v => v.projectId === projectId && v.entityId === entityId)
    if (!value) { value = { projectId, entityId, sources: [], sourcePaths: {} }; local.scenarios.push(value); await this.store.save() }
    return value
  }
  async editable(entityId: string, projectId?: string) {
    const context = await this.sources.editable(entityId, projectId, 'scenario')
    const { task } = context
    const relative = await findMaterialFile(task.worktree, 'scenario', task.entityId)
    if (relative) this.observe(task, relative)
    return context
  }
  async snapshot(remote: ProjectState): Promise<ScenarioWorkspace | undefined> {
    const local = await this.store.read(), entity = remote.entities.find((e): e is EntityView => e.id === this.activeEntityId && 'generation' in e && e.kind === 'scenario')
    if (!entity) return undefined
    const record = await this.record(entity.id), account = await this.ports.account()
    const projectSync = local.projects.find(project => project.id === remote.project.id)?.sync
    const owned = entity.occupation?.ownerId === account?.id && entity.occupation?.clientId === local.clientId
    const tasks = local.tasks.filter(t => t.projectId === remote.project.id && t.entityId === entity.id && t.purpose === 'material')
    const task = tasks.find(t => t.sessionId === record.activeSessionId && (!entity.occupation || path.basename(t.worktree) === entity.occupation.taskId)) ?? tasks.findLast(t => entity.occupation && path.basename(t.worktree) === entity.occupation.taskId)
    const settlementTask = task ?? tasks.findLast(item => item.cleanup)
    const readOnly = !!entity.current && !owned
    let draft: MaterialDraft
    if (readOnly) {
      const fixed = entity.current!.fixed, bytes = await this.projects.localFixed(remote.project.id, fixed.commitSha, fixed.path, fixed.sha256)
      // The fixed version is not local yet: the lane is fetching it, and the
      // workspace appears on the read that follows.
      if (!bytes) return undefined
      draft = parseMaterial(Buffer.from(bytes), fixed.path)
    } else {
      if (!task) return undefined
      draft = await readMaterial(task.worktree, 'scenario', entity.id)
    }
    if (draft.metadata.kind !== 'scenario') throw new Error('场景元数据无效')
    const fixed = draft.metadata.templateRef, fixedTemplate = await this.projects.localFixed(remote.project.id, fixed.commitSha, fixed.path, fixed.sha256)
    if (!fixedTemplate) return undefined
    const templateBody = Buffer.from(fixedTemplate).toString('utf8')
    const check = checkScenarioDocument({ draft, expectedHash: draft.sha256, hasPermission: !!account, hasOccupation: !!owned, conflict: !!record.conflict, structureCheck: local.scenarioStructureCheck, templateBody, fileErrors: !readOnly && task ? await scenarioFileErrors(task.worktree, draft) : [] })
    const gates = check.groups
    if (!readOnly && task) this.observe(task, draft.path)
    if (record.observationError) { const versionGate = gates.find(gate => gate.id === 'version')!; versionGate.status = 'blocked'; versionGate.messages.push(record.observationError) }
    const cleanup = settlementTask?.cleanup
    const settlement: ScenarioWorkspace['settlement'] = !entity.current
      ? { status: 'draft' }
      : projectSync && projectSync.status !== 'synced'
        ? { status: 'sync-pending', sync: { status: projectSync.status, ...(projectSync.message ? { message: projectSync.message } : {}) }, ...(cleanup ? { cleanup } : {}) }
        : cleanup && cleanup.status !== 'done'
          ? { status: 'cleanup-pending', ...(projectSync ? { sync: { status: projectSync.status, ...(projectSync.message ? { message: projectSync.message } : {}) } } : {}), cleanup }
          : { status: 'settled', ...(projectSync ? { sync: { status: projectSync.status, ...(projectSync.message ? { message: projectSync.message } : {}) } } : {}), ...(cleanup ? { cleanup } : {}) }
    return { entityId: entity.id, draft, readOnly, template: { id: draft.metadata.templateId, name: draft.metadata.templateId, fixed, body: templateBody }, structureCheck: local.scenarioStructureCheck, gates, sources: (readOnly ? await this.sources.fixedSources(remote.project.id, entity.current!.fixed.commitSha, draft) : record.sources).map(source => ({ ...source, text: '' })),
      ...(record.writeProposal ? { writeProposal: { id: record.writeProposal.id, baseHash: record.writeProposal.baseHash, createdAt: record.writeProposal.createdAt, conclusions: record.writeProposal.conclusions.map(conclusion => conclusion.text), evidenceCount: record.writeProposal.evidenceIds.length, ...(record.writeProposal.target ? { target: record.writeProposal.target } : {}), status: record.writeProposal.status, ...(record.writeProposal.error ? { error: record.writeProposal.error } : {}) } } : {}), settlement,
      ...(record.writeReceipt && !record.writeReceipt.undone ? { writeReceipt: { operationId: record.writeReceipt.operationId, createdAt: record.writeReceipt.createdAt, afterHash: record.writeReceipt.afterHash, summary: record.writeReceipt.summary, canUndo: !readOnly && !record.conflict && draft.sha256 === record.writeReceipt.afterHash } } : {}), sessions: readOnly ? [] : tasks, ...(!readOnly && (record.activeSessionId ?? task?.sessionId) ? { activeSessionId: (record.activeSessionId ?? task?.sessionId)! } : {}), ...(!readOnly && record.conflict ? { conflict: record.conflict } : {}), ...(record.splitOffered !== undefined ? { splitOffered: record.splitOffered } : {}), ...(record.impact ? { impact: record.impact } : {}),
      ...(entity.current ? { confirmedBy: entity.current.confirmedBy, confirmedAt: entity.current.confirmedAt } : {}),
      ...(!readOnly && task ? { git: await this.ports.git.state(task.worktree) } : {}) }
  }
  async open(entityId: string): Promise<void> {
    const { entity, remote } = await this.deps.entity(entityId)
    if (entity.kind !== 'scenario') throw new Error('请选择场景')
    this.activeEntityId = entityId
    if (!entity.current && !entity.occupation) await this.deps.task(remote, entity)
  }
  async save(command: Extract<ScenarioCommand, { action: 'saveScenario' | 'resolveScenarioConflict' }>): Promise<void> {
    const { task, entity, remote } = await this.editable(command.entityId), record = await this.record(entity.id)
    if (command.metadata.kind !== 'scenario' || command.metadata.entityId !== entity.id || command.metadata.templateId !== entity.templateId || JSON.stringify(command.metadata.templateRef) !== JSON.stringify(entity.templateRef)) throw new Error('场景身份与模板绑定不能通过编辑改变')
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
  async resolveWriteProposal(command: Extract<ScenarioCommand, { action: 'resolveScenarioWriteProposal' }>): Promise<void> {
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
  private async consumeWriteProposal(command: Extract<ScenarioCommand, { action: 'resolveScenarioWriteProposal' }>): Promise<void> {
    const { task, entity } = await this.editable(command.entityId), record = await this.record(entity.id), proposal = record.writeProposal
    if (!proposal || proposal.id !== command.proposalId || proposal.entityId !== entity.id) throw new Error('写入提议不存在或已被替换，请重新提问')
    if (proposal.status === 'consumed') return
    if (proposal.status === 'rejected') { if (command.decision === 'reject') return; throw new Error('写入提议已拒绝，请重新讨论后再提问') }
    if (command.decision === 'reject') {
      const keys = proposal.conclusions.map(conclusionKey)
      record.rejectedConclusions = [...new Set([...(record.rejectedConclusions ?? []), ...keys])].slice(-200)
      proposal.status = 'rejected'; await this.store.save(); return
    }
    // A context proposal binds only the project-root file; it never rewrites the scenario body.
    if (proposal.target === 'context') return this.resolveContextProposal(task, proposal)
    if (record.conflict) throw new Error('请先解决文件冲突')
    const draft = await readMaterial(task.worktree, 'scenario', entity.id)
    if (draft.metadata.kind !== 'scenario') throw new Error('场景元数据无效')
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
      const draft = await readMaterial(task.worktree, 'scenario', task.entityId)
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
  async undoWrite(command: Extract<ScenarioCommand, { action: 'undoScenarioWrite' }>): Promise<void> {
    const { task, entity } = await this.editable(command.entityId), record = await this.record(entity.id), receipt = record.writeReceipt
    if (!receipt || receipt.operationId !== command.operationId) throw new Error('没有可撤销的整篇写入')
    if (receipt.undone) return
    if (record.conflict) throw new Error('请先解决文件冲突')
    const draft = await readMaterial(task.worktree, 'scenario', entity.id)
    if (draft.metadata.kind !== 'scenario') throw new Error('场景元数据无效')
    if (draft.sha256 !== receipt.afterHash || command.expectedHash !== draft.sha256) throw new Error('正文已变化，无法撤销本次写入，请先处理当前编辑')
    try {
      await this.documents.save({ root: task.worktree, metadata: await syncProjectContext(task.worktree, draft.metadata), body: receipt.beforeBody, expectedHash: draft.sha256, operationId: command.operationId })
    } catch (error) {
      if (error && typeof error === 'object' && 'conflict' in error && error.conflict) { record.conflict = error.conflict as ScenarioConflict; await this.store.save(); return }
      throw error
    }
    receipt.undone = true; await this.store.save()
  }
  async newSession(entityId: string): Promise<string> {
    const { task } = await this.editable(entityId), local = await this.store.read(), record = await this.record(entityId)
    const next = { ...task, sessionId: `studio-${randomUUID()}` }; local.tasks.push(next); record.activeSessionId = next.sessionId; await this.store.save()
    return this.ports.session(next, '你是场景设计助手。使用 grilling 逐问推进设计，用 domain-modeling 沉淀术语与决策；回答先用可读中文归纳明确结论、已读资料与仍缺的业务答案；满足条件时提出针对目标文件的整篇写入提议，不满足时继续讨论，不直接写入文件或确认。')
  }
  async selectSession(entityId: string, sessionId: string): Promise<string> {
    const { task } = await this.editable(entityId), local = await this.store.read()
    const found = local.tasks.find(t => t.projectId === task.projectId && t.entityId === entityId && t.sessionId === sessionId && t.purpose === 'material')
    if (!found) throw new Error('此会话不属于当前场景')
    const record = await this.record(entityId); record.activeSessionId = sessionId; await this.store.save()
    return this.ports.session(found, '场景设计会话：先用可读中文归纳明确结论、已读资料与仍缺的业务答案；满足条件时提出针对目标文件的整篇写入提议，不满足时继续讨论，不直接写入文件。')
  }
  async context(task: TaskView): Promise<string> {
    const local = await this.store.read(); if (!local.tasks.some(t => t.sessionId === task.sessionId && t.projectId === task.projectId) && !local.scenarioRepairs.some(r => r.task.sessionId === task.sessionId && r.projectId === task.projectId)) throw new Error('会话不属于当前登录用户')
    const { entity } = await this.deps.entity(task.entityId, task.projectId)
    const token = await this.deps.owned(entity)
    const currentTask = local.tasks.findLast(value => value.projectId === task.projectId && value.entityId === task.entityId && value.purpose === 'material' && path.basename(value.worktree) === token.taskId)
    if (!currentTask) throw new Error('当前修订的本地材料现场不存在，请先恢复修订任务')
    const draft = await readMaterial(currentTask.worktree, 'scenario', task.entityId)
    if (draft.metadata.kind !== 'scenario') throw new Error('场景上下文无效')
    const ref = draft.metadata.templateRef, bytes = await this.projects.readFixed(task.projectId, ref.commitSha, ref.path, ref.sha256)
    if (digest(bytes) !== ref.sha256) throw new Error('模板 hash 不符')
    const protocol = task.scenarioRepair
      ? `当前为已授权修复任务，场景 ${task.entityId}，baseHash=${draft.sha256}。不得写文件或自行确认，缺业务答案只输出 question，不能编造。先用可读中文说明本轮修复要点、依据的已读资料与仍缺的业务答案，再在回答最后给出唯一 eadp-repair 代码块。`
      : `当前场景 ${task.entityId}，整文件 baseHash=${draft.sha256}。仅输出候选，不写入、不确认，禁止引用未读取资料。
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
      const draft = await readMaterial(task.worktree, 'scenario', task.entityId)
      if (draft.metadata.kind !== 'scenario') throw new Error('场景元数据无效')
      const parsed = parseWriteProposal(content, draft, this.readEvidenceIds(record))
      if (parsed.conclusions.map(conclusionKey).some(key => record.rejectedConclusions?.includes(key))) throw new Error('同一结论已被拒绝，出现新结论后再提问')
      // Host owns the ID and every bound hash; the answer only supplied content.
      if (parsed.target === 'context') {
        const context = await this.projectContext(task.worktree)
        if (context.bytes?.toString('utf8') === parsed.body) throw new Error('写入提议与当前项目上下文相同')
        record.writeProposal = { id: randomUUID(), entityId: task.entityId, target: 'context', baseHash: context.hash, templateRef: draft.metadata.templateRef, contextHash: context.hash, evidenceIds: this.readEvidenceIds(record), conclusions: parsed.conclusions, body: parsed.body, createdAt: new Date().toISOString(), status: 'pending' }
      } else {
        record.writeProposal = { id: randomUUID(), entityId: task.entityId, baseHash: draft.sha256, templateRef: draft.metadata.templateRef, contextHash: (await this.projectContext(task.worktree)).hash, evidenceIds: this.readEvidenceIds(record), conclusions: parsed.conclusions, body: parsed.body, createdAt: new Date().toISOString(), status: 'pending' }
      }
      await this.store.save(); return true
    } catch (error) {
      // An unverifiable proposal never becomes actionable; the answer remains chat only.
      return true
    }
    await this.store.save(); return true
  }
}
