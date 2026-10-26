import { randomUUID } from 'node:crypto'
import type { MaterialStatusTrigger, SubmitMaterialStatusReportRequest } from '@eadp/contracts'
import type { CollaborationClient } from '../adapters/collaboration/client.ts'
import type { HostPorts } from './ports.ts'
import type { ScenarioRecord } from './scenario-workspaces.ts'
import type { StudioStore } from './state.ts'

export interface LocalMaterialStatusReport {
  id: string; projectId: string; entityId: string; trigger: MaterialStatusTrigger;
  submission?: SubmitMaterialStatusReportRequest; shared: boolean; message?: string;
}
export interface MaterialStatusReportInput {
  projectId: string; entityId: string; trigger: MaterialStatusTrigger; worktree: string; baseHead?: string;
}
interface Dependencies {
  record(entityId: string, projectId?: string): Promise<ScenarioRecord>
  deliver(work: () => Promise<void>): void
}
interface StatusPath { path: string; status: string }
const LIMIT = 500
/** Mechanical digest of one porcelain status; the backend stores this text verbatim. */
export function mechanicalSummary(paths: StatusPath[]): string {
  if (!paths.length) return '工作区无未提交变更'
  const names = paths.map(value => `${value.path}（${value.status === 'D' ? '删除' : value.status === 'A' || value.status === '??' ? '新增' : '修改'}）`)
  return `未提交变更 ${paths.length} 个文件：${names.join('、')}`
}

/** Records local material git status at explicit action points; failures stay local for resume. */
export class MaterialStatusReports {
  constructor(private readonly store: StudioStore, private readonly api: CollaborationClient,
    private readonly ports: Pick<HostPorts, 'git' | 'gitLocal' | 'summarize'>, private readonly deps: Dependencies) {}

  async report(input: MaterialStatusReportInput): Promise<void> {
    const owner = await this.deps.record(input.entityId, input.projectId)
    const record: LocalMaterialStatusReport = { id: randomUUID(), projectId: input.projectId, entityId: input.entityId, trigger: input.trigger, shared: false }
    ;(owner.statusReports ??= []).push(record)
    await this.store.save()
    this.deps.deliver(async () => {
      try {
        const state = await this.ports.git.state(input.worktree)
        const paths = await this.changedPaths(input.worktree)
        let summary = mechanicalSummary(paths)
        if (this.ports.summarize) {
          try {
            const ai = await this.ports.summarize({ subject: '本地材料 git 状态摘要', facts: JSON.stringify({ entityId: input.entityId, trigger: input.trigger, baseHead: input.baseHead ?? state.head, worktreeHead: state.head, paths }) }, AbortSignal.timeout(30_000))
            if (ai.trim()) summary = `${summary}；${ai.trim()}`
          } catch { /* AI 摘要失败只保留机械摘要 */ }
        }
        record.submission = { idempotencyKey: record.id, id: record.id, entityId: input.entityId, trigger: input.trigger,
          baseHead: input.baseHead ?? state.head, worktreeHead: state.head, changedPathCount: paths.length, summary: summary.slice(0, LIMIT) }
        await this.store.save()
        await this.submit(record)
      } catch (error) { record.message = error instanceof Error ? error.message : '状态记录待核对'; await this.store.save() }
    })
  }

  /** Re-deliver unfinished submissions; a successful POST is idempotent on its record key. */
  resume(projectId: string): void {
    void this.store.read().then(local => {
      for (const owner of local.scenarios.filter(record => record.projectId === projectId)) {
        for (const record of owner.statusReports ?? []) {
          if (record.shared || !record.submission) continue
          this.deps.deliver(() => this.submit(record))
        }
      }
    }).catch(() => undefined)
  }

  private async submit(record: LocalMaterialStatusReport): Promise<void> {
    if (!record.submission || record.shared) return
    try {
      await this.api.request('POST', `/v1/projects/${encodeURIComponent(record.projectId)}/entities/${encodeURIComponent(record.entityId)}/status-reports`, record.submission)
      record.shared = true; delete record.message; await this.store.save()
    } catch (error) { record.message = error instanceof Error ? error.message : '状态记录待核对'; await this.store.save() }
  }

  private async changedPaths(worktree: string): Promise<StatusPath[]> {
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
