import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { EntityView, MaterialMetadata, ProjectState } from '@eadp/contracts'
import type { MaterialDraft, TaskView } from '../../shared/studio.ts'
import type { ScenarioCommand, ScenarioSource } from '../../shared/scenarios.ts'
import { containedFile, digest, readMaterial } from '../adapters/assets/materials.ts'
import type { HostPorts, SessionOutput } from './ports.ts'
import type { StudioStore } from './state.ts'
import type { ProjectWorkspaces } from './projects.ts'
import type { ScenarioDependencies, ScenarioRecord } from './scenario-workspaces.ts'
import { ScenarioDocumentService } from './scenario-documents.ts'
import { archiveSelectedEvidence } from './scenario-evidence.ts'
import { syncProjectContext } from './scenario-package.ts'

/** Owns attachments and evidence for scenario and requirement materials in the existing local source store. */
export class MaterialSources {
  constructor(private readonly store: StudioStore, private readonly ports: HostPorts, private readonly projects: ProjectWorkspaces, private readonly deps: ScenarioDependencies, private readonly record: (entityId: string, projectId?: string) => Promise<ScenarioRecord>) {}

  async editable(entityId: string, projectId?: string, kind?: 'scenario') {
    const context = await this.deps.entity(entityId, projectId)
    if (kind && context.entity.kind !== kind) throw new Error('此操作只适用于项目场景')
    if (!['scenario', 'requirement'].includes(context.entity.kind)) throw new Error('资料只适用于场景与需求材料')
    if (context.entity.current && !context.entity.occupation) throw new Error('已确认材料只读，请先开始修订')
    if (context.entity.occupation && context.entity.occupation.purpose !== 'design') throw new Error('当前占用不是材料设计任务')
    const task = await this.deps.task(context.remote, context.entity)
    const fresh = await this.deps.entity(entityId, projectId)
    await this.deps.owned(fresh.entity)
    return { ...fresh, task }
  }

  /** Rebuilds the original read status from hash-verified archived reading records, never from the extracted-text range alone. */
  async fixedSources(projectId: string, commitSha: string, draft: { metadata: Pick<MaterialMetadata, 'businessEvidence'> }): Promise<ScenarioSource[]> {
    return Promise.all(draft.metadata.businessEvidence.map(async (evidence, index): Promise<ScenarioSource> => {
      const source: ScenarioSource = { id: `fixed-${index}`, name: evidence.label, format: 'unknown', sha256: evidence.files[0]!.sha256, status: 'failed', ranges: [], text: '', selected: true, formal: true }
      try {
        const scopes = evidence.files.filter(file => /^reading-[a-f0-9]{64}\.json$/.test(path.basename(file.path)))
        if (scopes.length !== 1) throw new Error('固定依据缺少唯一可验证的读取记录')
        const scope = scopes[0]!, bytes = await this.projects.readFixed(projectId, commitSha, scope.path, scope.sha256)
        if (digest(bytes) !== scope.sha256 || path.basename(scope.path) !== `reading-${scope.sha256}.json`) throw new Error('固定依据读取记录 hash 不符')
        const parsed: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'))
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('固定依据读取记录无效')
        const reading = parsed as Record<string, unknown>
        if (typeof reading.sourceId !== 'string' || evidence.reference !== `source:${reading.sourceId}` || reading.name !== evidence.label || typeof reading.format !== 'string' || !reading.format || typeof reading.originalHash !== 'string' || !/^[a-f0-9]{64}$/.test(reading.originalHash) || !['read', 'partial'].includes(String(reading.status)) || !Array.isArray(reading.ranges) || !reading.ranges.length || reading.ranges.some(range => typeof range !== 'string' || !range.trim()) || reading.error !== undefined && typeof reading.error !== 'string') throw new Error('固定依据读取记录字段无效')
        if (!evidence.files.some(file => path.basename(file.path).startsWith('original.') && file.sha256 === reading.originalHash)) throw new Error('固定依据原始文件与读取记录不符')
        return { ...source, name: reading.name as string, format: reading.format, sha256: reading.originalHash, status: reading.status as 'read' | 'partial', ranges: reading.ranges as string[], ...(reading.error !== undefined ? { error: reading.error as string } : {}) }
      } catch (error) {
        return { ...source, error: error instanceof Error ? error.message : '固定依据读取记录无法验证' }
      }
    }))
  }
  /** Requirement attachments share scenario storage; fixed evidence is authoritative on a read-only material. */
  async views(remote: ProjectState, drafts: MaterialDraft[]): Promise<Array<{ entityId: string; readOnly: boolean; sources: ScenarioSource[] }>> {
    const local = await this.store.read(), account = await this.ports.account()
    return Promise.all(remote.entities.filter((entity): entity is EntityView => 'generation' in entity && entity.kind === 'requirement' && !entity.legacyCurrent).map(async entity => {
      const occupation = entity.occupation
      const owned = !!occupation && occupation.ownerId === account?.id && occupation.clientId === local.clientId && occupation.purpose === 'design'
      const readOnly = !!entity.current && !owned || !!entity.occupation && !owned
      const draft = drafts.find(value => value.entityId === entity.id)
      const record = local.scenarios.find(value => value.projectId === remote.project.id && value.entityId === entity.id)
      const sources = readOnly && entity.current
        ? await this.fixedSources(remote.project.id, entity.current.fixed.commitSha, { metadata: entity.current.metadata })
        : draft ? record?.sources ?? [] : []
      return { entityId: entity.id, readOnly, sources: sources.map(source => ({ ...source, text: '' })) }
    }))
  }

  /** Only selected sources that were actually read enter the conversation; unread images keep their explicit status. */
  async context(task: TaskView): Promise<string> {
    const record = await this.record(task.entityId, task.projectId)
    const sources = record.sources.filter(source => source.selected && ['read', 'partial'].includes(source.status))
    const images = record.sources.filter(source => source.selected && ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(source.format)).map(source => ({ id: source.id, path: record.sourcePaths[source.id], status: source.status }))
    return `可用原生read_image读取的图片（未读取前禁止引用）：${JSON.stringify(images)}\n实际已读资料：\n${JSON.stringify(sources.map(source => ({ id: source.id, name: source.name, sha256: source.sha256, ranges: source.ranges, text: source.text })))}`
  }

  async readPaths(task: TaskView): Promise<string[]> {
    const record = await this.record(task.entityId, task.projectId)
    return record.sources.filter(source => source.selected).map(source => record.sourcePaths[source.id]!).filter(Boolean)
  }

  /** Accept native image evidence only for the current design task and unchanged, selected imported bytes. */
  async acceptRead(task: TaskView, output: Extract<SessionOutput, { kind: 'source-read' }>): Promise<void> {
    if (task.purpose !== 'material' || !output.attachmentId || !output.ranges.length) return
    const { entity } = await this.deps.entity(task.entityId, task.projectId)
    if (!entity.occupation || entity.occupation.purpose !== 'design' || path.basename(task.worktree) !== entity.occupation.taskId) return
    try { await this.deps.owned(entity) } catch { return }
    const record = await this.record(task.entityId, task.projectId)
    const source = record.sources.find(value => value.selected && ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(value.format) && record.sourcePaths[value.id] && path.resolve(record.sourcePaths[value.id]!) === path.resolve(task.worktree, output.path))
    if (!source) return
    const filename = record.sourcePaths[source.id]!
    const relative = path.relative(this.store.directory, filename)
    try { if (digest(await readFile(await containedFile(this.store.directory, relative))) !== source.sha256) return } catch { return }
    source.status = 'read'; source.ranges = output.ranges; source.text = `原生 read_image 已读取图像，attachmentId=${output.attachmentId}；范围=${output.ranges.join('；')}`; delete source.error
    await this.store.save()
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
    const { task, entity } = await this.editable(command.entityId), record = await this.record(command.entityId), source = record.sources.find(s => s.id === command.sourceId)
    const draft = await readMaterial(task.worktree, entity.kind, command.entityId)
    if (!source) throw new Error('资料不存在')
    if (command.formal && (!['read', 'partial'].includes(source.status) || !source.text)) throw new Error('请先实际读取资料，才能选择正式依据')
    const previous = { selected: source.selected, formal: source.formal }
    source.selected = command.selected; source.formal = command.formal
    try {
      const records = await Promise.all(record.sources.filter(s => s.formal).map(async s => {
        const original = await readFile(record.sourcePaths[s.id]!)
        if (digest(original) !== s.sha256) throw new Error('原始资料已变化，请重新导入')
        return { source: s, original }
      }))
      const businessEvidence = await archiveSelectedEvidence(task.worktree, records, records.map(r => r.source.id))
      record.localEvidencePaths = [...new Set([...(record.localEvidencePaths ?? []), ...businessEvidence.flatMap(evidence => evidence.files.map(file => file.path))])]
      await this.store.save()
      await new ScenarioDocumentService(this.store.directory).save({ root: task.worktree, metadata: await syncProjectContext(task.worktree, { ...draft.metadata, businessEvidence }), body: draft.body, expectedHash: draft.sha256, operationId: randomUUID() })
    } catch (error) {
      Object.assign(source, previous)
      await this.store.save()
      throw error
    }
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
}
