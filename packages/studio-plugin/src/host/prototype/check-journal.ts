import path from 'node:path'
import { createHash } from 'node:crypto'
import type { PrototypeCheckReport } from '../../shared/prototype.ts'
import type { TaskView } from '../../shared/studio.ts'
import { AtomicState } from '../adapters/local-state/atomic-state.ts'
import type { StudioStore } from '../application/state.ts'
import type { PrototypeCheckResult, PrototypeCheckStep } from './checks.ts'

/** Account-scoped check history contains step outcomes and fingerprints, not process output. */
export class PrototypeCheckJournal {
  private readonly active = new Set<string>()
  constructor(private readonly store: StudioStore) {}
  private key(projectId: string, taskId: string): string { return createHash('sha256').update(JSON.stringify([projectId, taskId])).digest('hex') }
  private storage(projectId: string, taskId: string): AtomicState<PrototypeCheckReport[]> {
    if (!this.store.accountId) throw new Error('请先登录后查看工程检查')
    return new AtomicState(path.join(this.store.directory, 'prototype-checks', `${this.key(projectId, taskId)}.json`))
  }
  async begin(task: TaskView, sourceSha: string, operationId: string, kind: PrototypeCheckReport['kind']) {
    const accountId = this.store.accountId, storage = this.storage(task.projectId, task.entityId), reports = await storage.read() ?? []
    if (this.store.accountId !== accountId) throw new Error('协同账号已变化')
    if (reports.some(report => report.operationId === operationId)) throw new Error('原工程检查已有记录，请查看结果后发起新的检查')
    const report: PrototypeCheckReport = { operationId, projectId: task.projectId, prototypeTaskId: task.entityId, ...(task.prototypeBaseline ? { baselineId: task.prototypeBaseline.id } : {}), kind, sourceSha, startedAt: new Date().toISOString(), status: 'running', steps: [] }
    reports.push(report)
    const activeKey = `${accountId}:${task.projectId}:${task.entityId}:${operationId}`
    const write = async () => { if (this.store.accountId !== accountId) throw new Error('协同账号已变化'); await storage.write(reports) }
    await write(); this.active.add(activeKey)
    return {
      step: async (name: PrototypeCheckStep, status: 'running' | 'passed' | 'failed', exitCode?: number) => {
        const previous = report.steps.find(value => value.name === name)
        if (previous) { previous.status = status; if (exitCode !== undefined) previous.exitCode = exitCode }
        else report.steps.push({ name, status, ...(exitCode !== undefined ? { exitCode } : {}) })
        await write()
      },
      finish: async (status: 'passed' | 'failed', result?: PrototypeCheckResult) => {
        report.status = status; report.completedAt = new Date().toISOString()
        if (result) { report.inputHash = result.inputHash; report.outputHash = result.outputHash }
        if (status === 'failed') { for (const step of report.steps) if (step.status === 'running') step.status = 'failed'; report.message = '检查未完成，请查看失败步骤并重新发起检查。' }
        try { await write() } finally { this.active.delete(activeKey) }
      },
    }
  }
  async latest(tasks: Array<{ projectId: string; prototypeTaskId: string }>): Promise<PrototypeCheckReport[]> {
    const accountId = this.store.accountId
    const reports = await Promise.all(tasks.map(async task => {
      const values = await this.storage(task.projectId, task.prototypeTaskId).read()
      const last = values?.at(-1)
      if (!last) return undefined
      const activeKey = `${accountId}:${task.projectId}:${task.prototypeTaskId}:${last.operationId}`
      return last.status === 'running' && !this.active.has(activeKey) ? { ...last, status: 'interrupted' as const } : last
    }))
    if (this.store.accountId !== accountId) throw new Error('协同账号已变化')
    return reports.filter((value): value is PrototypeCheckReport => value !== undefined)
  }
}
