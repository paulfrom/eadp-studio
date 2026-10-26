import { randomUUID } from 'node:crypto'
import type { MaterialStatusTrigger, SubmitMaterialStatusReportRequest } from '@eadp/contracts'
import type { CollaborationClient } from '../adapters/collaboration/client.ts'
import type { HostPorts } from './ports.ts'
import type { ScenarioRecord } from './scenario-workspaces.ts'
import type { StudioStore } from './state.ts'

export interface LocalMaterialStatusReport {
  id: string; projectId: string; entityId: string; trigger: MaterialStatusTrigger; worktree: string; baseHead?: string;
  submission?: SubmitMaterialStatusReportRequest; shared: boolean; message?: string;
}
export interface MaterialStatusReportInput {
  projectId: string; entityId: string; trigger: MaterialStatusTrigger; worktree: string; baseHead?: string;
}
interface Dependencies {
  record(entityId: string, projectId?: string): Promise<ScenarioRecord>
  deliver(work: () => Promise<void>): void
  baseHead?(worktree: string): Promise<string | undefined>
}
interface StatusPath { path: string; status: string }
const LIMIT = 500
const PATH_LIMIT = 3000
/** Mechanical digest of committed and uncommitted changes; the backend stores this text verbatim. */
export function mechanicalSummary(paths: StatusPath[]): string {
  if (!paths.length) return '工作区无变更'
  const names = paths.map(value => `${value.path}（${value.status === 'D' ? '删除' : value.status === 'A' || value.status === '??' ? '新增' : '修改'}）`)
  return `变更 ${paths.length} 个文件：${names.join('、')}`
}

/** Records local material git status at explicit action points; failures stay local for resume. */
export class MaterialStatusReports {
  private readonly inflight = new Set<string>()

  constructor(private readonly store: StudioStore, private readonly api: CollaborationClient,
    private readonly ports: Pick<HostPorts, 'git' | 'gitLocal' | 'summarize'>, private readonly deps: Dependencies) {}

  async report(input: MaterialStatusReportInput): Promise<void> {
    let record: LocalMaterialStatusReport | undefined
    try {
      const owner = await this.deps.record(input.entityId, input.projectId)
      const created: LocalMaterialStatusReport = { id: randomUUID(), projectId: input.projectId, entityId: input.entityId, trigger: input.trigger, worktree: input.worktree, ...(input.baseHead ? { baseHead: input.baseHead } : {}), shared: false }
      record = created
      ;(owner.statusReports ??= []).push(created)
      await this.store.save()
      this.schedule(input, created)
    } catch (error) {
      if (record) await this.fail(record, error)
    }
  }

  /** Recollect or re-deliver unfinished records; a successful POST is idempotent on its record key. */
  resume(projectId: string): void {
    void this.store.read().then(async local => {
      for (const owner of local.scenarios.filter(record => record.projectId === projectId)) {
        for (const record of owner.statusReports ?? []) {
          if (record.shared) continue
          const input: MaterialStatusReportInput = { projectId: record.projectId, entityId: record.entityId, trigger: record.trigger, worktree: record.worktree, ...(record.baseHead ? { baseHead: record.baseHead } : {}) }
          try { this.schedule(input, record) }
          catch (error) { await this.fail(record, error) }
        }
      }
    }).catch(() => undefined)
  }

  private schedule(input: MaterialStatusReportInput, record: LocalMaterialStatusReport): void {
    if (record.shared || this.inflight.has(record.id)) return
    this.inflight.add(record.id)
    try { this.deps.deliver(() => this.process(input, record)) }
    catch (error) { this.inflight.delete(record.id); throw error }
  }

  private async process(input: MaterialStatusReportInput, record: LocalMaterialStatusReport): Promise<void> {
    try { await (record.submission ? this.submit(record) : this.collect(input, record)) }
    finally { this.inflight.delete(record.id) }
  }

  private async collect(input: MaterialStatusReportInput, record: LocalMaterialStatusReport): Promise<void> {
    if (record.shared) return
    try {
      const state = await this.ports.git.state(input.worktree)
      const baseHead = input.baseHead ?? (await this.deps.baseHead?.(input.worktree)) ?? state.head
      const paths = await this.changedPaths(input.worktree, baseHead, state.head)
      let summary = mechanicalSummary(paths)
      if (this.ports.summarize) {
        try {
          const ai = await this.ports.summarize({ subject: '本地材料 git 状态摘要', facts: JSON.stringify({ entityId: input.entityId, trigger: input.trigger, baseHead, worktreeHead: state.head, paths }) }, AbortSignal.timeout(30_000))
          if (ai.trim()) summary = `${summary}；${ai.trim()}`
        } catch { /* AI 摘要失败只保留机械摘要 */ }
      }
      record.submission = { idempotencyKey: record.id, id: record.id, entityId: input.entityId, trigger: input.trigger,
        baseHead, worktreeHead: state.head, changedPathCount: Math.min(paths.length, PATH_LIMIT), summary: summary.slice(0, LIMIT) }
      await this.store.save()
      await this.submit(record)
    } catch (error) { await this.fail(record, error) }
  }

  private async submit(record: LocalMaterialStatusReport): Promise<void> {
    if (!record.submission || record.shared) return
    try {
      await this.api.request('POST', `/v1/projects/${encodeURIComponent(record.projectId)}/entities/${encodeURIComponent(record.entityId)}/status-reports`, record.submission)
      record.shared = true; delete record.message; await this.store.save()
    } catch (error) { record.shared = false; await this.fail(record, error) }
  }

  private async fail(record: LocalMaterialStatusReport, error: unknown): Promise<void> {
    record.message = error instanceof Error ? error.message : '状态记录待核对'
    try { await this.store.save() } catch { /* 状态记录不得影响原业务动作 */ }
  }

  private async changedPaths(worktree: string, baseHead: string, worktreeHead: string): Promise<StatusPath[]> {
    const paths = new Map((await this.ports.git.changedPathStatuses(worktree, baseHead, worktreeHead)).map(value => [value.path, value]))
    for (const value of await this.uncommittedPaths(worktree)) paths.set(value.path, value)
    return [...paths.values()]
  }

  private async uncommittedPaths(worktree: string): Promise<StatusPath[]> {
    const entries = (await this.ports.gitLocal(['status', '--porcelain=v1', '-z', '--untracked-files=all'], worktree)).split('\0').filter(Boolean)
    const paths: StatusPath[] = []
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]!, name = entry.slice(3), code = entry.trim().split(/\s+/, 1)[0]!
      paths.push({ path: name, status: code.includes('D') ? 'D' : code.includes('?') || code.includes('A') ? code.includes('?') ? '??' : 'A' : 'M' })
      if (/[RC]/.test(entry.slice(0, 2))) index++
    }
    return paths
  }
}
