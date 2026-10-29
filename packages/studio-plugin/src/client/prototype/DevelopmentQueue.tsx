import { useState } from 'react'
import type { EntityView, StudioCommand, StudioReply } from '../../shared/studio.ts'
import type { PrototypeQueueItem, PrototypeQueueView } from '../../shared/prototype.ts'
import css from './prototype.module.css'

export type DevelopmentQueueItem = PrototypeQueueItem

type QueueOperation = { instruction: string; operationId?: string }
type QueueFeedback = { error?: string; notice?: string }

const stageLabels: Record<string, string> = {
  queued: '等待开发', claiming: '领取开发占用', sending: '发送开发指令', developing: '开发中', fixing: '工程修复',
  'commit-known': '提交已固定', pushing: '推送成果', pushed: '已推送待同步', synchronizing: '后端同步',
  'awaiting-review': '待核对', confirming: '确认并同步', reviewed: '已完成', blocked: '恢复／失败待处理',
}
const reviewLabels: Record<string, string> = {
  pending: '未核对', 'awaiting-review': '待核对', correcting: '纠偏开发中', reviewed: '已确认完成',
}

function requirementKey(item: DevelopmentQueueItem): string {
  return `${item.prototypeTaskId}:${item.requirementId ?? 'supplemental'}`
}

function stageLabel(item: DevelopmentQueueItem): string {
  return item.developmentStage ? stageLabels[item.developmentStage] ?? item.developmentStage : '补充事项'
}

function reviewLabel(item: DevelopmentQueueItem): string {
  return item.reviewStatus ? reviewLabels[item.reviewStatus] ?? item.reviewStatus : '未进入逐需求核对'
}

function isAwaitingReview(item: DevelopmentQueueItem): boolean {
  return item.developmentStage === 'awaiting-review' || item.reviewStatus === 'awaiting-review'
}

function hostResult(item: DevelopmentQueueItem): string {
  return `Host 返回：${stageLabel(item)} · ${reviewLabel(item)}${item.nextAction ? ` · ${item.nextAction}` : ''}`
}

/** Per-requirement local development progress, correction, and final Host-backed confirmation. */
export function DevelopmentQueue({ queue, items, entities, selectedTaskId, busy, error, call, onSelect, onMove }: {
  queue: PrototypeQueueView | undefined
  items: DevelopmentQueueItem[]
  entities: EntityView[]
  selectedTaskId: string | undefined
  busy: boolean
  error: string
  call(command: StudioCommand): Promise<StudioReply | undefined>
  onSelect(prototypeTaskId: string): void
  onMove(prototypeTaskId: string, direction: -1 | 1): void
}) {
  const [corrections, setCorrections] = useState<Record<string, QueueOperation>>({})
  const [confirmOperations, setConfirmOperations] = useState<Record<string, string>>({})
  const [feedback, setFeedback] = useState<Record<string, QueueFeedback>>({})
  const [pending, setPending] = useState<string>()

  const correct = async (item: DevelopmentQueueItem) => {
    const key = requirementKey(item)
    const current = corrections[key] ?? { instruction: '' }
    const instruction = current.instruction.trim()
    if (!instruction) return
    const operationId = current.operationId ?? crypto.randomUUID()
    setCorrections(previous => ({ ...previous, [key]: { instruction: current.instruction, operationId } }))
    setFeedback(previous => ({ ...previous, [key]: {} }))
    setPending(`correct:${key}`)
    const command: StudioCommand = { action: 'correctPrototypeRequirement', prototypeTaskId: item.prototypeTaskId, operationId, instruction }
    const reply = await call(command)
    setPending(undefined)
    if (!reply?.ok) {
      setFeedback(previous => ({ ...previous, [key]: { error: reply && !reply.ok ? reply.message : '纠偏结果待核对，输入和原操作已保留。' } }))
      return
    }
    setFeedback(previous => ({ ...previous, [key]: { notice: '纠偏已提交；开发完成后仍需核对本项成果。' } }))
  }

  const confirm = async (item: DevelopmentQueueItem) => {
    const key = requirementKey(item)
    const operationId = confirmOperations[key] ?? crypto.randomUUID()
    setConfirmOperations(previous => ({ ...previous, [key]: operationId }))
    setFeedback(previous => ({ ...previous, [key]: {} }))
    setPending(`confirm:${key}`)
    const command: StudioCommand = { action: 'confirmPrototypeRequirement', prototypeTaskId: item.prototypeTaskId, operationId }
    const reply = await call(command)
    setPending(undefined)
    if (!reply?.ok) {
      setFeedback(previous => ({ ...previous, [key]: { error: reply && !reply.ok ? reply.message : '确认结果待核对，原操作已保留。' } }))
      return
    }
    const updated = reply.state.prototypeQueue?.items.find(candidate => candidate.prototypeTaskId === item.prototypeTaskId
      && (candidate as DevelopmentQueueItem).requirementId === item.requirementId) as DevelopmentQueueItem | undefined
    setFeedback(previous => ({ ...previous, [key]: { notice: updated ? hostResult(updated) : 'Host 已返回确认结果，当前核对与同步状态见本项状态。' } }))
  }

  return <details className={css.tasks} open>
    <summary>我的协作事项 · {items.length} 项</summary>
    <p className={css.queueIntro}>确认需求后自动入队，桌面串行开发；单项进入待核对不会阻断后续需求。自动提交、推送和后端同步只更新本项开发成果，项目接受与原型基线仍按独立流程处理。</p>
    <ol className={css.developmentQueue}>{items.map((item, index) => {
      const key = requirementKey(item)
      const entity = entities.find(candidate => candidate.kind === 'requirement' && candidate.id === item.requirementId)
      const code = entity?.code ?? item.requirementId
      const title = entity?.title ?? item.title
      const name = item.requirementId ? `${code} · ${title}` : item.title
      const awaitingReview = isAwaitingReview(item)
      const correction = corrections[key] ?? { instruction: '' }
      const state = feedback[key]
      return <li key={key} className={css.developmentItem}>
        <article aria-label={name}>
          <div className={css.developmentHeading}>
            <button disabled={item.pendingCreation} aria-current={selectedTaskId === item.prototypeTaskId ? 'true' : undefined} onClick={() => onSelect(item.prototypeTaskId)}>{name}</button>
            <span>{stageLabel(item)}</span>
            <span>{reviewLabel(item)}</span>
            <button type="button" disabled={busy || index === 0} aria-label={`上移${name}`} onClick={() => onMove(item.prototypeTaskId, -1)}>↑</button>
            <button type="button" disabled={busy || index === items.length - 1} aria-label={`下移${name}`} onClick={() => onMove(item.prototypeTaskId, 1)}>↓</button>
          </div>
          {item.nextAction && <p className={css.developmentStatus}>{item.nextAction}</p>}
          {awaitingReview && <div className={css.requirementReview}>
            <form onSubmit={event => { event.preventDefault(); void correct(item) }}>
              <label>纠偏指令<textarea aria-label={`纠偏 ${name}`} rows={3} value={correction.instruction} onChange={event => {
                const instruction = event.target.value
                setCorrections(previous => ({ ...previous, [key]: { instruction } }))
              }} /></label>
              <button disabled={busy || pending !== undefined || !correction.instruction.trim()}>{pending === `correct:${key}` ? '正在提交纠偏' : '发送纠偏'}</button>
            </form>
            <button type="button" disabled={busy || pending !== undefined} onClick={() => void confirm(item)}>{pending === `confirm:${key}` ? '正在确认并同步' : '确认完成'}</button>
          </div>}
          {state?.error && <p role="alert" className={css.fileError}>{state.error}</p>}
          {state?.notice && <p role="status" className={css.developmentStatus}>{state.notice}</p>}
          <details className={css.developmentDiagnostics}><summary>技术诊断</summary><p>事项：{item.title}</p><p>Host 阶段：{item.developmentStage ?? '未提供'} · 核对状态：{item.reviewStatus ?? '未提供'} · 调度状态：{item.localDispatchState}</p>{item.commitId && <p>commitId：{item.commitId}</p>}</details>
        </article>
      </li>
    })}</ol>
    {error && <p role="alert" className={css.fileError}>{error}</p>}
    {!queue ? <p className={css.muted}>正在读取事项队列。</p> : !items.length && <p className={css.muted}>确认需求后会自动进入本地开发队列。</p>}
  </details>
}
