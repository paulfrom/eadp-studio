import { ScenarioFileObserver, type ScenarioObservedTask } from './scenario-file-observer.ts'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { EntityView, OccupationToken, ProjectState, RepairStartRequest } from '@eadp/contracts'
import type { MaterialDraft, TaskView } from '../../shared/studio.ts'
import type { ScenarioCommand, ScenarioConflict, ScenarioSource, ScenarioSuggestionBatch, ScenarioWorkspace } from '../../shared/scenarios.ts'
import { containedFile, digest, parseMaterial, readMaterial } from '../adapters/assets/materials.ts'
import type { CollaborationClient } from '../adapters/collaboration/client.ts'
import type { HostPorts } from './ports.ts'
import type { StudioStore } from './state.ts'
import type { ProjectWorkspaces } from './projects.ts'
import { ScenarioDocumentService, checkScenarioDocument, scenarioFileErrors } from './scenario-documents.ts'
import { parseSuggestionBatch } from './scenario-suggestions.ts'
import { archiveSelectedEvidence } from './scenario-evidence.ts'

export interface ScenarioRecord { projectId: string; entityId: string; suggestions: ScenarioSuggestionBatch[]; sources: ScenarioSource[]; sourcePaths: Record<string, string>; localEvidencePaths?: string[]; activeSessionId?: string; conflict?: ScenarioConflict; splitOffered?: boolean; observationError?: string; impact?: ScenarioWorkspace['impact']; repairAuthorization?: { request: RepairStartRequest; task: TaskView; status: 'pending' | 'accepted'; message?: string } }
export interface ScenarioDependencies {
  entity(id: string, projectId?: string): Promise<{ remote: ProjectState; entity: EntityView }>
  task(remote: ProjectState, entity: EntityView): Promise<TaskView>
  owned(entity: EntityView): Promise<OccupationToken>
  deliver(work: () => Promise<void>): void
  changed?(task: ScenarioObservedTask, error?: string): Promise<void>
}
/** Owns local scene editing state; fixed Git bytes remain the accepted document authority. */
export class ScenarioWorkspaces {
  get documents(): ScenarioDocumentService { return new ScenarioDocumentService(this.store.directory) }
  activeEntityId: string | undefined
  private observer: ScenarioFileObserver | undefined
  private observerDirectory: string | undefined
  constructor(readonly store: StudioStore, readonly api: CollaborationClient, readonly ports: HostPorts, readonly projects: ProjectWorkspaces, readonly deps: ScenarioDependencies) {}
  stopObservation(task: ScenarioObservedTask): void { this.observer?.unobserve(task) }
  dispose(): void { this.observer?.dispose(); this.observer = undefined; this.observerDirectory = undefined; this.activeEntityId = undefined }
  private observe(task: TaskView): void {
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
    if (this.observer!.observe(task)) {
      void this.record(task.entityId, task.projectId).then(record => { delete record.observationError }).catch(() => undefined)
    }
  }
  async record(entityId: string, projectId?: string): Promise<ScenarioRecord> {
    const local = await this.store.read(); projectId ??= local.selectedProjectId!; if (!local.projects.some(project => project.id === projectId)) throw new Error('场景项目不属于当前登录用户的本地工程')
    let value = local.scenarios.find(v => v.projectId === projectId && v.entityId === entityId)
    if (!value) { value = { projectId, entityId, suggestions: [], sources: [], sourcePaths: {} }; local.scenarios.push(value); await this.store.save() }
    return value
  }
  async editable(entityId: string, projectId?: string) {
    const context = await this.deps.entity(entityId, projectId)
    if (context.entity.kind !== 'scenario') throw new Error('此操作只适用于项目场景')
    if (context.entity.current && !context.entity.occupation) throw new Error('已确认场景只读，请先查看影响清单并开始修订')
    const task = await this.deps.task(context.remote, context.entity)
    const fresh = await this.deps.entity(entityId, projectId)
    await this.deps.owned(fresh.entity)
    this.observe(task)
    return { ...fresh, task }
  }
  async snapshot(remote: ProjectState): Promise<ScenarioWorkspace | undefined> {
    const local = await this.store.read(), entity = remote.entities.find((e): e is EntityView => e.id === this.activeEntityId && 'generation' in e && e.kind === 'scenario')
    if (!entity) return undefined
    const record = await this.record(entity.id), account = await this.ports.account()
    const owned = entity.occupation?.ownerId === account?.id && entity.occupation?.clientId === local.clientId
    const tasks = local.tasks.filter(t => t.projectId === remote.project.id && t.entityId === entity.id && t.purpose === 'material')
    const task = tasks.find(t => t.sessionId === record.activeSessionId && (!entity.occupation || path.basename(t.worktree) === entity.occupation.taskId)) ?? tasks.findLast(t => entity.occupation && path.basename(t.worktree) === entity.occupation.taskId)
    const readOnly = !!entity.current && !owned
    let draft: MaterialDraft
    if (readOnly) {
      const fixed = entity.current!.fixed, bytes = await this.projects.readFixed(remote.project.id, fixed.commitSha, fixed.path, fixed.sha256)
      if (digest(bytes) !== fixed.sha256) throw new Error('固定场景内容 hash 不符')
      draft = parseMaterial(Buffer.from(bytes), fixed.path)
    } else {
      if (!task) return undefined
      draft = await readMaterial(task.worktree, 'scenario', entity.id)
    }
    if (draft.metadata.kind !== 'scenario') throw new Error('场景元数据无效')
    const fixed = draft.metadata.templateRef, bytes = await this.projects.readFixed(remote.project.id, fixed.commitSha, fixed.path, fixed.sha256)
    if (digest(bytes) !== fixed.sha256) throw new Error('固定模板 hash 不符')
    const templateBody = Buffer.from(bytes).toString('utf8')
    for (const batch of record.suggestions) if (batch.status === 'current' && (batch.baseHash !== draft.sha256 || JSON.stringify(batch.templateRef) !== JSON.stringify(fixed))) batch.status = 'stale'
    const check = checkScenarioDocument({ draft, expectedHash: draft.sha256, hasPermission: !!account, hasOccupation: !!owned, conflict: !!record.conflict, structureCheck: local.scenarioStructureCheck, templateBody, fileErrors: !readOnly && task ? await scenarioFileErrors(task.worktree, draft) : [] })
    const gates = check.groups
    if (!readOnly && task) this.observe(task)
    if (record.observationError) { const versionGate = gates.find(gate => gate.id === 'version')!; versionGate.status = 'blocked'; versionGate.messages.push(record.observationError) }
    return { entityId: entity.id, draft, readOnly, template: { id: draft.metadata.templateId, name: draft.metadata.templateId, fixed, body: templateBody }, structureCheck: local.scenarioStructureCheck, gates, suggestions: readOnly ? [] : record.suggestions, sources: readOnly ? await this.fixedSources(remote.project.id, entity.current!.fixed.commitSha, draft) : record.sources.map(source => ({ ...source, text: '' })), sessions: readOnly ? [] : tasks, ...(!readOnly && (record.activeSessionId ?? task?.sessionId) ? { activeSessionId: (record.activeSessionId ?? task?.sessionId)! } : {}), ...(!readOnly && record.conflict ? { conflict: record.conflict } : {}), ...(record.splitOffered !== undefined ? { splitOffered: record.splitOffered } : {}), ...(record.impact ? { impact: record.impact } : {}),
      ...(entity.current ? { confirmedBy: entity.current.confirmedBy, confirmedAt: entity.current.confirmedAt } : {}),
      ...(!readOnly && task ? { git: await this.ports.git.state(task.worktree) } : {}) }
  }
  private async fixedSources(projectId: string, commitSha: string, draft: MaterialDraft): Promise<ScenarioSource[]> {
    return Promise.all(draft.metadata.businessEvidence.map(async (evidence, index) => {
      const textFile = evidence.files.find(file => file.path.endsWith('.txt'))
      let text = ''
      if (textFile) { const bytes = await this.projects.readFixed(projectId, commitSha, textFile.path, textFile.sha256); if (digest(bytes) !== textFile.sha256) throw new Error('固定依据 hash 不符'); text = Buffer.from(bytes).toString('utf8') }
      return { id: `fixed-${index}`, name: evidence.label, format: 'text', sha256: textFile?.sha256 ?? evidence.files[0]!.sha256, status: 'read' as const, ranges: evidence.ranges.map(range => `${range.path}:${range.startLine}-${range.endLine}`), text, selected: true, formal: true }
    }))
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
      await this.documents.save({ root: task.worktree, metadata: command.metadata, body: command.body, expectedHash: command.expectedHash, operationId: command.operationId })
      if (command.metadata.title !== entity.title || command.metadata.summary !== entity.summary) await this.api.request('PUT', `/v1/projects/${remote.project.id}/entities/${entity.id}`, { idempotencyKey: `${command.operationId}-directory`, token: await this.deps.owned(entity), title: command.metadata.title, ...(command.metadata.summary !== undefined ? { summary: command.metadata.summary } : {}) })
      delete record.conflict; await this.store.save()
    } catch (error) {
      if (error && typeof error === 'object' && 'conflict' in error && error.conflict) { record.conflict = error.conflict as ScenarioConflict; await this.store.save(); return }
      throw error
    }
  }
  async adopt(command: Extract<ScenarioCommand, { action: 'adoptScenarioSuggestions' }>): Promise<void> {
    const { task } = await this.editable(command.entityId), record = await this.record(command.entityId)
    if (record.conflict) throw new Error('请先解决文件冲突')
    const batch = record.suggestions.find(b => b.id === command.batchId)
    if (!batch || batch.status !== 'current' && batch.status !== 'applied') throw new Error('建议已过期，请按当前材料重新生成')
    const draft = await readMaterial(task.worktree, 'scenario', command.entityId)
    await this.documents.apply({ root: task.worktree, draft, batch, selectedItemIds: command.itemIds, expectedHash: command.expectedHash, operationId: command.operationId, readEvidenceIds: record.sources.filter(s => (s.status === 'read' || s.status === 'partial') && s.selected).map(s => s.id) })
    batch.status = 'applied'; for (const other of record.suggestions) if (other !== batch && other.status === 'current') other.status = 'stale'
    await this.store.save()
  }
  async newSession(entityId: string): Promise<string> {
    const { task } = await this.editable(entityId), local = await this.store.read(), record = await this.record(entityId)
    const next = { ...task, sessionId: `studio-${randomUUID()}` }; local.tasks.push(next); record.activeSessionId = next.sessionId; await this.store.save()
    return this.ports.session(next, '你是场景设计助手。普通整理只输出 eadp-suggestions 候选，绝不直接写入文件或确认。')
  }
  async selectSession(entityId: string, sessionId: string): Promise<string> {
    const { task } = await this.editable(entityId), local = await this.store.read()
    const found = local.tasks.find(t => t.projectId === task.projectId && t.entityId === entityId && t.sessionId === sessionId && t.purpose === 'material')
    if (!found) throw new Error('此会话不属于当前场景')
    const record = await this.record(entityId); record.activeSessionId = sessionId; await this.store.save()
    return this.ports.session(found, '场景设计会话：读取当前上下文后输出建议，不直接写入文件。')
  }
  async importSource(command: Extract<ScenarioCommand, { action: 'importScenarioSource' }>): Promise<void> {
    await this.editable(command.entityId)
    if (!command.name || command.name.length > 250 || command.base64.length > 32_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(command.base64)) throw new Error('资料名称或大小无效（最大 24MB）')
    const bytes = Buffer.from(command.base64, 'base64'), record = await this.record(command.entityId)
    if (record.sources.some(s => s.id === command.operationId)) return
    const source: ScenarioSource = { id: command.operationId, name: path.basename(command.name), format: path.extname(command.name).slice(1).toLowerCase(), sha256: digest(bytes), status: 'failed', ranges: [], text: '', selected: true, formal: false }
    const directory = path.join(this.store.directory, 'scenario-sources', record.projectId, command.entityId)
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(source.id)) throw new Error('资料操作标识无效')
    await mkdir(directory, { recursive: true }); const filename = path.join(directory, `${source.id}.${source.format.replace(/[^a-z0-9]/g, '') || 'bin'}`)
    await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); record.sources.push(source); record.sourcePaths[source.id] = filename; await this.store.save()
    await this.retrySource(command.entityId, source.id)
  }
  async retrySource(entityId: string, sourceId: string): Promise<void> {
    await this.editable(entityId)
    const record = await this.record(entityId), source = record.sources.find(s => s.id === sourceId), filename = record.sourcePaths[sourceId]
    if (!source || !filename) throw new Error('资料不存在')
    const bytes = await readFile(filename); if (digest(bytes) !== source.sha256) throw new Error('原始资料已变化，请重新导入')
    const reader = this.ports.readScenarioSource
    if (!reader) throw new Error('宿主资料读取服务不可用')
    source.status = 'reading'; source.text = ''; source.ranges = []; delete source.error
    const userDirectory = this.store.directory, expectedHash = source.sha256
    await this.store.save()
    // Office conversion and PDF extraction must never hold the UI command queue.
    void reader({ path: filename, name: source.name }).catch(error => ({ status: 'failed' as const, text: '', ranges: [] as string[], error: error instanceof Error ? error.message : '资料读取失败' })).then(result => {
      this.deps.deliver(async () => {
        if (!this.store.scoped || this.store.directory !== userDirectory) return
        const current = await this.record(entityId, record.projectId), target = current.sources.find(value => value.id === sourceId)
        if (!target || target.sha256 !== expectedHash || digest(await readFile(filename)) !== expectedHash) return
        Object.assign(target, result); await this.store.save()
      })
    })
  }
  async selectSource(command: Extract<ScenarioCommand, { action: 'selectScenarioSource' }>): Promise<void> {
    const { task } = await this.editable(command.entityId), record = await this.record(command.entityId), source = record.sources.find(s => s.id === command.sourceId)
    if (!source) throw new Error('资料不存在')
    if (command.formal && (!['read', 'partial'].includes(source.status) || !source.text)) throw new Error('请先实际读取资料，才能选择正式依据')
    source.selected = command.selected; source.formal = command.formal
    const records = await Promise.all(record.sources.filter(s => s.formal).map(async s => ({ source: s, original: await readFile(record.sourcePaths[s.id]!) })))
    const businessEvidence = await archiveSelectedEvidence(task.worktree, records, records.map(r => r.source.id))
    record.localEvidencePaths = [...new Set([...(record.localEvidencePaths ?? []), ...businessEvidence.flatMap(evidence => evidence.files.map(file => file.path))])]
    await this.store.save()
    const draft = await readMaterial(task.worktree, 'scenario', command.entityId)
    await this.documents.save({ root: task.worktree, metadata: { ...draft.metadata, businessEvidence }, body: draft.body, expectedHash: draft.sha256, operationId: randomUUID() })
    await this.pruneEvidence(task)
    await this.store.save()
  }
  /** Removes only Host-created, untracked archives no material in this worktree still references. */
  async pruneEvidence(task: TaskView): Promise<void> {
    const local = await this.store.read()
    const tasks = local.tasks.filter(value => value.projectId === task.projectId && path.resolve(value.worktree) === path.resolve(task.worktree) && (value.purpose === 'material' || value.purpose === 'handoff'))
    const byEntity = new Map(tasks.map(value => [value.entityId, value]))
    const records = local.scenarios.filter(value => value.projectId === task.projectId && byEntity.has(value.entityId))
    const registered = [...new Set(records.flatMap(value => value.localEvidencePaths ?? []))]
    if (!registered.length) return
    if (registered.some(relative => !relative.startsWith('.eadp/evidence/'))) throw new Error('本地依据清理记录包含越界路径')
    const referenced = new Set<string>()
    for (const current of byEntity.values()) {
      const { entity } = await this.deps.entity(current.entityId, current.projectId)
      const draft = await readMaterial(current.worktree, entity.kind, entity.id)
      for (const file of [...draft.metadata.businessEvidence.flatMap(value => value.files), ...(draft.metadata.files ?? [])]) referenced.add(file.path)
    }
    const candidates = registered.filter(relative => !referenced.has(relative))
    if (!candidates.length) return
    const tracked = new Set((await this.ports.gitLocal(['ls-files', '-z', '--', ...candidates], task.worktree)).split('\0').filter(Boolean))
    const removed = new Set<string>()
    for (const relative of candidates) {
      if (tracked.has(relative)) continue
      try { await rm(await containedFile(task.worktree, relative), { force: true }) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      removed.add(relative)
    }
    for (const value of records) if (value.localEvidencePaths) value.localEvidencePaths = value.localEvidencePaths.filter(relative => !removed.has(relative))
    await this.store.save()
  }
  async context(task: TaskView): Promise<string> {
    const local = await this.store.read(); if (!local.tasks.some(t => t.sessionId === task.sessionId && t.projectId === task.projectId) && !local.scenarioRepairs.some(r => r.task.sessionId === task.sessionId && r.projectId === task.projectId)) throw new Error('会话不属于当前登录用户')
    const { entity } = await this.deps.entity(task.entityId, task.projectId)
    const token = await this.deps.owned(entity)
    const currentTask = local.tasks.findLast(value => value.projectId === task.projectId && value.entityId === task.entityId && value.purpose === 'material' && path.basename(value.worktree) === token.taskId)
    if (!currentTask) throw new Error('当前修订的本地材料现场不存在，请先恢复修订任务')
    const draft = await readMaterial(currentTask.worktree, 'scenario', task.entityId), record = await this.record(task.entityId, task.projectId)
    if (draft.metadata.kind !== 'scenario') throw new Error('场景上下文无效')
    const ref = draft.metadata.templateRef, bytes = await this.projects.readFixed(task.projectId, ref.commitSha, ref.path, ref.sha256)
    if (digest(bytes) !== ref.sha256) throw new Error('模板 hash 不符')
    const sources = record.sources.filter(s => s.selected && (s.status === 'read' || s.status === 'partial'))
    const pendingImages = record.sources.filter(s => s.selected && ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(s.format)).map(s => ({ id: s.id, path: record.sourcePaths[s.id], status: s.status }))
    const protocol = task.scenarioRepair
      ? `当前为已授权修复任务，场景 ${task.entityId}，baseHash=${draft.sha256}。不得写文件或自行确认。遵循可信Host本轮输入，输出唯一 eadp-repair 代码块；缺业务答案只输出question，不能编造。`
      : `当前场景 ${task.entityId}，整文件 baseHash=${draft.sha256}。仅输出候选，不写入、不确认。所有替换start/end为正文JS字符偏移，original须精确匹配。禁止引用未读取资料。建议唯一代码块 eadp-suggestions，JSON格式：{"id":"批次ID","entityId":"${task.entityId}","baseHash":"${draft.sha256}","templateRef":${JSON.stringify(ref)},"groups":[{"id":"组ID","title":"说明","items":[{"id":"条目ID","start":0,"end":${draft.body.length},"original":${JSON.stringify(draft.body)},"replacement":"新正文","evidenceIds":[]}]}]}。`
    return `${protocol}\n当前有效材料绝对路径：${path.join(currentTask.worktree, draft.path)}；历史会话的旧工作目录不构成本轮文件上下文，读取材料必须使用本路径。\n当前元数据：${JSON.stringify(draft.metadata)}\n当前Markdown正文：\n${draft.body}\n固定模板：\n${Buffer.from(bytes).toString('utf8')}\n可用原生read_image读取的图片（未读取前禁止引用）：${JSON.stringify(pendingImages)}\n实际已读资料：\n${JSON.stringify(sources.map(s => ({ id: s.id, name: s.name, sha256: s.sha256, ranges: s.ranges, text: s.text })))}`
  }
  async accept(sessionId: string, content: string): Promise<boolean> {
    const local = await this.store.read(), task = local.tasks.find(t => t.sessionId === sessionId && t.purpose === 'material')
    if (!task || !content.includes('```eadp-suggestions')) return false
    const record = await this.record(task.entityId, task.projectId)
    try {
      const batch = parseSuggestionBatch(content)
      if (batch.entityId !== task.entityId) throw new Error('候选场景身份不一致')
      if (!record.suggestions.some(b => b.id === batch.id)) record.suggestions.push({ ...batch, status: 'current' })
    } catch (error) { record.suggestions.push({ id: randomUUID(), entityId: task.entityId, baseHash: '', templateRef: { commitSha: '', path: '', sha256: '' }, groups: [], status: 'invalid', error: error instanceof Error ? error.message : '候选格式无效' }) }
    await this.store.save(); return true
  }
}
