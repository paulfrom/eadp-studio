import path from 'node:path'
import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import type { PrototypeCheckDiagnostic, PrototypeCheckReport } from '../../shared/prototype.ts'
import type { TaskView } from '../../shared/studio.ts'
import { AtomicState } from '../adapters/local-state/atomic-state.ts'
import type { StudioStore } from '../application/state.ts'
import type { PrototypeCheckResult, PrototypeCheckStep } from './checks.ts'

/** Account-scoped check history retains bounded diagnostics with step outcomes and fingerprints. */
export class PrototypeCheckJournal {
  private readonly active = new Set<string>()
  constructor(private readonly store: StudioStore, private readonly toolsHash: string) {}
  private key(projectId: string, taskId: string): string { return createHash('sha256').update(JSON.stringify([projectId, taskId])).digest('hex') }
  private async storage(projectId: string, taskId: string): Promise<AtomicState<PrototypeCheckReport[]>> {
    if (!this.store.accountId) throw new Error('请先登录后查看工程检查')
    return new AtomicState(path.join(await this.store.projectDirectory(projectId), 'prototype-checks', `${this.key(projectId, taskId)}.json`))
  }
  async begin(task: TaskView, sourceSha: string, operationId: string, kind: PrototypeCheckReport['kind']) {
    const accountId = this.store.accountId, storage = await this.storage(task.projectId, task.entityId), reports = await storage.read() ?? []
    const project = (await this.store.read()).projects.find(value => value.id === task.projectId)
    if (!project) throw new Error('项目文件夹尚未登记。')
    if (this.store.accountId !== accountId) throw new Error('协同账号已变化')
    if (reports.some(report => report.operationId === operationId)) throw new Error('原工程检查已有记录，请查看结果后发起新的检查')
    const report: PrototypeCheckReport = { operationId, projectId: task.projectId, prototypeTaskId: task.entityId, ...(task.prototypeBaseline ? { baselineId: task.prototypeBaseline.id } : {}), kind, sourceSha, startedAt: new Date().toISOString(), status: 'running', steps: [] }
    reports.push(report)
    const activeKey = `${accountId}:${task.projectId}:${task.entityId}:${operationId}`
    const write = async () => {
      if (this.store.accountId !== accountId) throw new Error('协同账号已变化')
      if (!(await stat(project.workspaceDirectory)).isDirectory()) throw new Error('项目文件夹已丢失，请重新打开项目。')
      await storage.write(reports)
    }
    await write(); this.active.add(activeKey)
    return {
      step: async (name: PrototypeCheckStep, status: 'running' | 'passed' | 'failed', exitCode?: number, diagnostic?: PrototypeCheckDiagnostic) => {
        const previous = report.steps.find(value => value.name === name)
        if (previous) { previous.status = status; if (exitCode !== undefined) previous.exitCode = exitCode }
        else report.steps.push({ name, status, ...(exitCode !== undefined ? { exitCode } : {}) })
        if (diagnostic) report.steps.find(value => value.name === name)!.diagnostic = diagnostic
        await write()
      },
      finish: async (status: 'passed' | 'failed', result?: PrototypeCheckResult, error?: unknown) => {
        report.status = status; report.completedAt = new Date().toISOString()
        if (result) { report.inputHash = result.inputHash; report.outputHash = result.outputHash; report.rulesHash = result.rulesSha256; report.toolsHash = this.toolsHash }
        if (status === 'failed') { for (const step of report.steps) if (step.status === 'running') step.status = 'failed'; report.message = '检查未完成，请查看失败步骤并重新发起检查。' }
        if (error instanceof Error) report.message = error.message.slice(0, 4096)
        try { await write() } finally { this.active.delete(activeKey) }
      },
    }
  }
  /** Read recorded outcomes only; current engineering evidence is checked by the operation that uses it. */
  async latest(tasks: Array<{ projectId: string; prototypeTaskId: string }>): Promise<PrototypeCheckReport[]> {
    const accountId = this.store.accountId
    const reports = await Promise.all(tasks.map(async (task): Promise<PrototypeCheckReport | undefined> => {
      const values = await (await this.storage(task.projectId, task.prototypeTaskId)).read()
      const last = values?.at(-1)
      if (!last) return undefined
      const activeKey = `${accountId}:${task.projectId}:${task.prototypeTaskId}:${last.operationId}`
      if (last.status === 'running' && !this.active.has(activeKey)) return { ...last, status: 'interrupted' as const }
      return last
    }))
    if (this.store.accountId !== accountId) throw new Error('协同账号已变化')
    return reports.filter((value): value is PrototypeCheckReport => value !== undefined)
  }
}
