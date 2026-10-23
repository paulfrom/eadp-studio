import { randomUUID } from 'node:crypto'
import { isSubmitConsistencyComparisonRequest, type ConsistencyComparisonView, type ConsistencyContextView, type SubmitConsistencyComparisonRequest } from '@eadp/contracts'
import type { ConsistencyModelInput, ConsistencyTaskView } from '../../shared/consistency.ts'
import { digest } from '../adapters/assets/materials.ts'
import { CollaborationError, type CollaborationClient } from '../adapters/collaboration/client.ts'
import { collectComparisonInputs, readComparisonBytes } from './consistency-inputs.ts'
import type { HostPorts } from './ports.ts'
import type { StudioStore } from './state.ts'

/** Only the finite backend submission survives a restart; input material text is never persisted. */
export interface LocalConsistencyComparison extends Omit<ConsistencyTaskView, 'freshness'> {
  submission?: SubmitConsistencyComparisonRequest;
}
interface ComparisonRequest { projectId: string; entityId: string; worktree: string; trigger: 'manual' | 'confirmation'; confirmationId?: string }
interface InputDigest { path: string; sha256: string }
interface RuntimeComparison { root: string; inputs: InputDigest[]; controller: AbortController; done: Promise<void>; inputsRead: Promise<void>; releaseInputs(): void }
const route = (projectId: string, suffix: string): string => `/v1/projects/${encodeURIComponent(projectId)}${suffix}`
/** One cache slot per query scope: the project-level key keeps an empty entity segment. */
const historyKey = (projectId: string, entityId: string | undefined): string => `${projectId}:${entityId ?? ''}`

/** Independent local-only comparison orchestration; this service has no Git capability. */
export class ConsistencyComparisons {
  private readonly runtime = new Map<string, RuntimeComparison>()
  private readonly freshness = new Map<string, ConsistencyTaskView['freshness']>()
  /** Queried history is kept per scope so an entity-level read never replaces the project-level projection. */
  private readonly history = new Map<string, ConsistencyComparisonView[]>()
  /** True latest observations are fetched independently of the history page a user is inspecting. */
  private readonly latest = new Map<string, ConsistencyComparisonView[]>()
  constructor(private readonly store: StudioStore, private readonly api: CollaborationClient,
    private readonly ports: Pick<HostPorts, 'account' | 'compareConsistency'>) {}

  async start(request: ComparisonRequest): Promise<{ inputsRead: Promise<void> }> {
    if (request.trigger === 'confirmation' && !request.confirmationId) throw new Error('自动对比缺少确认事件')
    const local = await this.store.read()
    const previous = request.confirmationId ? local.consistencyComparisons.find(value => value.projectId === request.projectId && value.trigger === 'confirmation' && value.confirmationId === request.confirmationId) : undefined
    if (previous) return { inputsRead: this.runtime.get(previous.id)?.inputsRead ?? Promise.resolve() }
    const record: LocalConsistencyComparison = { id: randomUUID(), projectId: request.projectId, entityId: request.entityId, trigger: request.trigger,
      ...(request.confirmationId ? { confirmationId: request.confirmationId } : {}), phase: 'running', createdAt: new Date().toISOString() }
    local.consistencyComparisons.push(record); await this.store.save()
    let releaseInputs!: () => void
    const inputsRead = new Promise<void>(resolve => { releaseInputs = resolve })
    const runtime: RuntimeComparison = { root: request.worktree, inputs: [], controller: new AbortController(), done: Promise.resolve(), inputsRead, releaseInputs }
    this.runtime.set(record.id, runtime)
    const owner = this.store.accountId
    runtime.done = this.run(record, runtime, owner).catch(() => { /* The saved finite result remains pending for an explicit retry. */ })
    return { inputsRead }
  }

  private async run(record: LocalConsistencyComparison, runtime: RuntimeComparison, owner: number | undefined): Promise<void> {
    const signal = AbortSignal.any([runtime.controller.signal, AbortSignal.timeout(120_000)])
    let input: ConsistencyModelInput | undefined
    try {
      await this.assertOwner(owner)
      let context: ConsistencyContextView | undefined
      try { context = await this.abortable(this.api.request('GET', route(record.projectId, `/entities/${encodeURIComponent(record.entityId)}/consistency-context`)), signal) }
      catch (error) { if (signal.aborted || error instanceof CollaborationError && [401, 403, 404].includes(error.status)) throw error }
      if (context && (context.entity.id !== record.entityId || !['scenario', 'requirement'].includes(context.entity.kind))) throw new Error('对比目标无效')
      input = await collectComparisonInputs(runtime.root, record.projectId, record.entityId, context, (await this.store.read()).tasks, signal)
      runtime.inputs = input.materials.map(({ path, sha256 }) => ({ path, sha256 }))
      runtime.releaseInputs()
      if (!input.materials.some(value => value.entityId === record.entityId)) {
        record.submission = this.failure(record, 'read-failed', '目标材料在当前工作区缺失或不可读取')
      } else {
        if (!this.ports.compareConsistency) throw new Error('对比模型不可用')
        const output = await this.abortable(this.ports.compareConsistency(input, signal), signal)
        await this.assertOwner(owner)
        record.submission = comparisonSubmission(record, input, output)
      }
    } catch (error) {
      if (this.store.accountId !== owner) return
      const cancelled = runtime.controller.signal.aborted, timedOut = signal.aborted && !cancelled
      const denied = error instanceof CollaborationError && [401, 403].includes(error.status)
      record.submission = cancelled ? { id: record.id, idempotencyKey: record.id, entityId: record.entityId, ...trigger(record), result: 'cancelled', coverage: 'partial', summary: '本次对比已取消', failureCode: 'cancelled', conflicts: [] }
        : this.failure(record, timedOut ? 'timeout' : denied ? 'permission-denied' : 'model-failed', timedOut ? '本次对比超时，请重新发起' : denied ? '当前身份没有本次对比权限' : '本次对比未完成或模型结果无效，请重新发起')
    } finally { runtime.releaseInputs() }
    await this.assertOwner(owner)
    this.freshness.set(record.id, await this.changed(runtime))
    record.phase = 'pending-sync'; await this.store.save()
    await this.submit(record, owner)
  }

  private failure(record: LocalConsistencyComparison, code: 'read-failed' | 'timeout' | 'permission-denied' | 'model-failed', summary: string): SubmitConsistencyComparisonRequest {
    return { id: record.id, idempotencyKey: record.id, entityId: record.entityId, ...trigger(record), result: 'failed', coverage: 'partial', summary, failureCode: code, conflicts: [] }
  }
  /** Reconcile the same result ID first; network recovery never runs the model again. */
  private async submit(record: LocalConsistencyComparison, owner = this.store.accountId): Promise<void> {
    if (!record.submission || record.phase === 'shared') return
    await this.assertOwner(owner)
    try {
      let result: ConsistencyComparisonView
      try { result = await this.api.request('GET', route(record.projectId, `/consistency-comparisons/${record.id}`)) }
      catch (error) {
        if (!(error instanceof CollaborationError) || error.code !== 'COMPARISON_NOT_FOUND') throw error
        result = await this.api.request('POST', route(record.projectId, '/consistency-comparisons'), record.submission)
      }
      await this.assertOwner(owner)
      record.result = result; record.phase = 'shared'; delete record.message; await this.store.save()
    } catch {
      if (this.store.accountId !== owner) return
      record.phase = 'pending-sync'; record.message = '对比结果尚未共享，重试将先核对原结果'; await this.store.save()
    }
  }
  async retry(id: string, projectId: string): Promise<void> { await this.submit(await this.record(id, projectId)) }
  async cancel(id: string, projectId: string): Promise<void> {
    const record = await this.record(id, projectId)
    if (record.phase === 'running') this.runtime.get(id)?.controller.abort()
  }
  async checkFreshness(id: string, projectId: string): Promise<void> {
    await this.record(id, projectId)
    const runtime = this.runtime.get(id)
    this.freshness.set(id, runtime ? await this.changed(runtime) : 'unknown')
  }
  async list(projectId: string, entityId: string | undefined, limit: number, offset: number): Promise<void> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) throw new Error('对比历史分页无效')
    const owner = this.store.accountId
    await this.assertOwner(owner)
    const items = await this.api.request<ConsistencyComparisonView[]>('GET', route(projectId, `/consistency-comparisons?limit=${limit}&offset=${offset}${entityId ? `&entityId=${encodeURIComponent(entityId)}` : ''}`))
    await this.assertOwner(owner)
    this.history.set(historyKey(projectId, entityId), items)
  }
  async listLatest(projectId: string): Promise<void> {
    const owner = this.store.accountId
    await this.assertOwner(owner)
    const items: ConsistencyComparisonView[] = []
    for (let offset = 0; ; offset += 100) {
      const page = await this.api.request<ConsistencyComparisonView[]>('GET', route(projectId, `/consistency-comparisons?latestPerEntity=true&limit=100&offset=${offset}`))
      await this.assertOwner(owner)
      items.push(...page)
      if (page.length < 100) break
    }
    this.latest.set(projectId, items)
  }
  latestViews(projectId?: string): ConsistencyComparisonView[] { return projectId === undefined ? [] : this.latest.get(projectId) ?? [] }
  historyViews(projectId?: string, entityId?: string): ConsistencyComparisonView[] {
    return projectId === undefined ? [] : this.history.get(historyKey(projectId, entityId)) ?? []
  }
  async views(projectId?: string): Promise<ConsistencyTaskView[]> {
    return (await this.store.read()).consistencyComparisons.filter(value => value.projectId === projectId).map(({ submission, ...value }) => ({ ...value, freshness: this.freshness.get(value.id) ?? 'unknown',
      ...(submission ? { outcome: { result: submission.result, coverage: submission.coverage, summary: submission.summary, conflicts: submission.conflicts, conflictCount: submission.conflicts.length, ...('failureCode' in submission ? { failureCode: submission.failureCode } : {}) } } : {}),
      ...(value.phase === 'running' && !this.runtime.has(value.id) ? { message: '本机任务已中断，请重新发起对比' } : {}) }))
  }
  async settle(): Promise<void> { await Promise.all([...this.runtime.values()].map(value => value.done)) }
  async dispose(): Promise<void> { for (const value of this.runtime.values()) value.controller.abort(); await this.settle(); this.runtime.clear(); this.history.clear(); this.latest.clear(); this.freshness.clear() }
  private async record(id: string, projectId: string): Promise<LocalConsistencyComparison> {
    const value = (await this.store.read()).consistencyComparisons.find(value => value.id === id && value.projectId === projectId)
    if (!value) throw new Error('对比任务不存在或不属于当前项目')
    return value
  }
  private async changed(runtime: RuntimeComparison): Promise<ConsistencyTaskView['freshness']> {
    if (!runtime.inputs.length) return 'unknown'
    try { for (const input of runtime.inputs) if (digest(await readComparisonBytes(runtime.root, input.path)) !== input.sha256) return 'stale'; return 'current' }
    catch { return 'unknown' }
  }
  private async assertOwner(owner: number | undefined): Promise<void> {
    if (!owner || owner !== this.store.accountId || (await this.ports.account())?.id !== owner) throw new Error('对比任务登录身份已变化')
  }
  private async abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    let abort: (() => void) | undefined
    try {
      return await Promise.race([work, new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason)
        if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true })
      })])
    } finally { if (abort) signal.removeEventListener('abort', abort) }
  }
}

function trigger(record: Pick<LocalConsistencyComparison, 'trigger' | 'confirmationId'>): { trigger: 'manual' } | { trigger: 'confirmation'; confirmationId: string } {
  return record.trigger === 'manual' ? { trigger: 'manual' } : { trigger: 'confirmation', confirmationId: record.confirmationId! }
}
/** Validate model output separately from the Host-owned result identity and trigger. */
export function comparisonSubmission(record: Pick<LocalConsistencyComparison, 'id' | 'entityId' | 'trigger' | 'confirmationId'>, input: ConsistencyModelInput, output: string): SubmitConsistencyComparisonRequest {
  if (Buffer.byteLength(output) > 100_000) throw new Error('对比结果超限')
  const raw = JSON.parse(output) as Record<string, unknown>
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => key !== 'summary' && key !== 'conflicts') || !Array.isArray(raw.conflicts)) throw new Error('对比结果字段无效')
  const conflicts = raw.conflicts.map((value: unknown, index: number) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['summary', 'relation', 'entities'].includes(key))) throw new Error('冲突字段无效')
    return { ...value, id: randomUUID(), ordinal: index + 1 } as { id: string; ordinal: number; summary: string; relation: string; entities: string[] }
  })
  const result: unknown = { id: record.id, idempotencyKey: record.id, entityId: record.entityId, ...trigger(record), result: 'completed', coverage: input.coverage, summary: raw.summary, conflicts }
  if (!isSubmitConsistencyComparisonRequest(result)) throw new Error('对比结果不符合共享契约')
  for (const conflict of result.conflicts) {
    if (conflict.entities.some(id => !input.materials.some(material => material.entityId === id))) throw new Error('冲突引用未实际读取的材料')
    if (conflict.relation === 'formal' && conflict.entities.some(id => input.materials.find(material => material.entityId === id)?.relation === 'potential')) throw new Error('潜在关联不能冒充正式关系')
  }
  return result
}
