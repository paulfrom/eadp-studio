import { constants } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import path from 'node:path'
import type { EntityView, ProjectState } from '@eadp/contracts'
import type { PrototypeMaterialRead } from '../../shared/prototype.ts'
import type { TaskView } from '../../shared/studio.ts'
import { containedFile, digest, findMaterialFile, parseMaterial, readMaterial } from '../adapters/assets/materials.ts'
import { ProjectRecord } from '../adapters/project-record.ts'
import type { CollaborationClient } from '../adapters/collaboration/client.ts'
import type { HostPorts } from './ports.ts'
import type { StudioStore } from './state.ts'

const MAX_BYTES = 1024 * 1024, MAX_LINES = 200, MAX_RETURN_BYTES = 64 * 1024
type ReadableRequirement = EntityView & { kind: 'requirement' }

/** Provides only this account's registered draft workspaces and readable fixed materials. */
export class PrototypeMaterialContext {
  private pending: Promise<unknown> = Promise.resolve()
  constructor(private readonly store: StudioStore, private readonly api: CollaborationClient, private readonly ports: HostPorts) {}
  private async state(task: TaskView): Promise<{ remote: ProjectState; accountId: number; clientId: string }> {
    const accountId = this.store.accountId, account = await this.ports.account(), local = await this.store.read()
    if (!accountId || account?.id !== accountId || task.purpose !== 'prototype' || !local.projects.some(value => value.id === task.projectId)) throw new Error('当前账号不能访问该项目材料')
    const remote = await this.api.request<ProjectState>('GET', `/v1/projects/${encodeURIComponent(task.projectId)}`)
    if (remote.project.id !== task.projectId || this.store.accountId !== accountId || (await this.ports.account())?.id !== accountId) throw new Error('项目或账号授权已变化')
    return { remote, accountId, clientId: local.clientId }
  }
  private requirement(state: ProjectState, id: string): ReadableRequirement {
    const entity = state.entities.find((value): value is EntityView => value.id === id && value.kind === 'requirement' && 'generation' in value)
    if (!entity || entity.kind !== 'requirement') throw new Error('需求不存在或当前账号不可读取')
    return entity as ReadableRequirement
  }
  private async draftTask(task: TaskView, entity: ReadableRequirement): Promise<TaskView | undefined> {
    const local = await this.store.read()
    // The store is scoped to this account; retaining a local draft does not require a live material occupation.
    return local.tasks.findLast(item => item.projectId === task.projectId && item.entityId === entity.id && item.purpose === 'material' && !item.cleanup)
  }
  async catalog(task: TaskView) {
    const { remote, accountId } = await this.state(task)
    const result = []
    for (const entity of remote.entities) {
      if (entity.kind !== 'requirement' || !('generation' in entity)) continue
      const draft = await this.draftTask(task, entity as ReadableRequirement)
      result.push({ id: entity.id, title: entity.title, ...(entity.code ? { code: entity.code } : {}), draftAvailable: !!draft, ...(entity.current ? { acceptedVersion: entity.current.version } : {}) })
    }
    if (this.store.accountId !== accountId || (await this.ports.account())?.id !== accountId) throw new Error('账号授权已变化')
    return result
  }
  async read(task: TaskView, requirementId: string, source: 'draft' | 'accepted', startLine: number, count: number) {
    if (!Number.isSafeInteger(startLine) || startLine < 1 || !Number.isSafeInteger(count) || count < 1 || count > MAX_LINES) throw new Error('读取范围无效')
    const before = await this.state(task), entity = this.requirement(before.remote, requirementId)
    let bytes: Buffer, relative: string, version: number | undefined, draftTask: TaskView | undefined
    if (source === 'draft') {
      draftTask = await this.draftTask(task, entity)
      if (!draftTask) throw new Error('本人当前设备没有可读取的需求草稿现场')
      relative = (await findMaterialFile(draftTask.worktree, 'requirement', requirementId)) ?? ''
      if (!relative) throw new Error('已登记需求草稿不存在')
      const target = await containedFile(draftTask.worktree, relative)
      const file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        const info = await file.stat()
        if (!info.isFile() || info.size > MAX_BYTES) throw new Error('需求草稿不可读取或超过大小限制')
        bytes = await file.readFile()
        const after = await file.stat(), current = await stat(await containedFile(draftTask.worktree, relative))
        if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs || current.dev !== info.dev || current.ino !== info.ino) throw new Error('需求草稿在读取期间发生变化')
      } finally { await file.close() }
    } else {
      const fixed = entity.current
      if (!fixed) throw new Error('该需求没有可读取的已确认版本')
      const local = await this.store.read(), project = local.projects.find(value => value.id === task.projectId)
      if (!project) throw new Error('项目未在本机登记')
      if (!await this.ports.git.hasCommit(project.directory, fixed.fixed.commitSha)) await this.ports.git.fetchCommit(project.directory, fixed.fixed.commitSha)
      relative = fixed.fixed.path; bytes = await this.ports.git.readBlob(project.directory, fixed.fixed.commitSha, relative)
      if (digest(bytes) !== fixed.fixed.sha256) throw new Error('固定需求内容与确认版本不一致')
      version = fixed.version
    }
    const draft = parseMaterial(bytes, relative)
    if (draft.entityId !== requirementId || draft.metadata.kind !== 'requirement') throw new Error('需求材料身份不一致')
    const lines = draft.body.split('\n')
    if (startLine > lines.length) throw new Error('读取起始行超出需求正文')
    const selected: string[] = []
    let used = 0
    for (const line of lines.slice(startLine - 1, startLine - 1 + count)) {
      const length = Buffer.byteLength(line, 'utf8') + (selected.length ? 1 : 0)
      if (used + length > MAX_RETURN_BYTES) break
      selected.push(line); used += length
    }
    if (!selected.length) throw new Error('需求正文单行超过读取大小限制')
    const after = await this.state(task), current = this.requirement(after.remote, requirementId)
    if (after.accountId !== before.accountId || after.clientId !== before.clientId) throw new Error('账号或设备授权已变化')
    if (source === 'draft') {
      const next = await this.draftTask(task, current)
      if (!next || !draftTask || path.resolve(next.worktree) !== path.resolve(draftTask.worktree) || next.sessionId !== draftTask.sessionId) throw new Error('需求草稿读取授权已变化')
    } else if (!current.current || current.current.version !== version || current.current.fixed.sha256 !== entity.current?.fixed.sha256 || current.current.fixed.commitSha !== entity.current?.fixed.commitSha) throw new Error('需求固定版本已变化，请重新读取')
    const receipt: PrototypeMaterialRead = { accountId: before.accountId, projectId: task.projectId, prototypeTaskId: task.entityId, sessionId: task.sessionId, requirementId, title: entity.title, source, ...(version === undefined ? {} : { version }), hash: draft.sha256, startLine, endLine: startLine + selected.length - 1, readAt: new Date().toISOString() }
    return { ...receipt, content: selected.join('\n'), totalLines: lines.length, truncated: receipt.endLine < lines.length }
  }
  /** Persist the actual read before its content can enter a native tool result. */
  record(receipt: PrototypeMaterialRead): Promise<void> {
    const accountId = receipt.accountId
    if (this.store.accountId !== accountId) return Promise.reject(new Error('账号授权已变化'))
    const storage = new ProjectRecord<PrototypeMaterialRead[]>(this.store, 'prototype-material-reads.json', () => [], (values, id) => values.filter(x => x.projectId === id), values => values.flat())
    const work = this.pending.catch(() => undefined).then(async () => {
      if (this.store.accountId !== accountId) throw new Error('账号授权已变化')
      const records = await storage.read() ?? []
      records.push(receipt)
      if (this.store.accountId !== accountId) throw new Error('账号授权已变化')
      await storage.write(records)
    })
    this.pending = work
    return work
  }
  async reads(taskIds: string[]): Promise<PrototypeMaterialRead[]> {
    const accountId = this.store.accountId
    if (!accountId) return []
    const records = await new ProjectRecord<PrototypeMaterialRead[]>(this.store, 'prototype-material-reads.json', () => [], (values, id) => values.filter(x => x.projectId === id), values => values.flat()).read() ?? []
    if (this.store.accountId !== accountId) throw new Error('账号授权已变化')
    const local = await this.store.read(), projects = new Map<string, ProjectState>(), result: PrototypeMaterialRead[] = []
    for (const record of records.filter(value => taskIds.includes(value.prototypeTaskId))) {
      let remote = projects.get(record.projectId)
      if (!remote) {
        remote = await this.api.request<ProjectState>('GET', `/v1/projects/${encodeURIComponent(record.projectId)}`)
        projects.set(record.projectId, remote)
      }
      const entity = remote.entities.find(value => value.id === record.requirementId && value.kind === 'requirement')
      let stale = true
      if (record.source === 'accepted') {
        const current = entity && 'current' in entity ? entity.current : undefined
        stale = !current || current.version !== record.version || current.fixed.sha256 !== record.hash
      } else {
        const draft = local.tasks.findLast(item => item.projectId === record.projectId && item.entityId === record.requirementId && item.purpose === 'material' && !item.cleanup)
        if (draft) {
          try { stale = (await readMaterial(draft.worktree, 'requirement', record.requirementId)).sha256 !== record.hash }
          catch { stale = true }
        }
      }
      result.push({ ...record, ...(stale ? { stale: true } : {}) })
    }
    return result
  }
}
