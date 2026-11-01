import { useRef, useState } from 'react'
import type { StudioCommand, StudioReply } from '../../shared/studio.ts'
import type { PrototypeQueueItem } from '../../shared/prototype.ts'
import css from './prototype.module.css'

const stages: Record<string, string> = {
  queued: '等待开发', claiming: '准备开发', sending: '准备开发', developing: '开发中', fixing: '调整中',
  'commit-known': '同步成果中', pushing: '同步成果中', pushed: '同步成果中', synchronizing: '同步成果中',
  'awaiting-review': '待核对', confirming: '确认并同步', reviewed: '已完成', blocked: '需要处理',
}

/** Present material-independent development progress beside the requirement's native session title. */
export function requirementDevelopmentStatus(item: PrototypeQueueItem | undefined): string {
  if (!item) return '待开发'
  if (item.taskStatus === 'accepted') return '已接受'
  if (item.localDispatchState === 'paused') return '已暂停'
  if (item.localDispatchState === 'recovery-required') return '需要恢复'
  if (item.reviewStatus === 'reviewed') return '已确认完成'
  return item.developmentStage ? stages[item.developmentStage] ?? '处理中' : '补充协作'
}

/** Final requirement confirmation retains the Host operation across failure and remount. */
export function RequirementReviewAction({ item, busy, call }: {
  item: PrototypeQueueItem
  busy: boolean
  call(command: StudioCommand): Promise<StudioReply | undefined>
}) {
  const operation = useRef<string>()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const awaiting = item.developmentStage === 'awaiting-review' || item.reviewStatus === 'awaiting-review'
  if (!awaiting && !item.pendingConfirmationOperationId) return null
  const confirm = async () => {
    if (pending) return
    const operationId = item.pendingConfirmationOperationId ?? operation.current ?? crypto.randomUUID()
    operation.current = operationId
    setPending(true); setError('')
    try {
      const reply = await call({ action: 'confirmPrototypeRequirement', prototypeTaskId: item.prototypeTaskId, operationId })
      if (!reply?.ok) setError(reply && !reply.ok ? reply.message : '确认结果待核对，原操作已保留。')
    } finally { setPending(false) }
  }
  return <div className={css.requirementReviewAction}>
    <span>{item.pendingConfirmationOperationId ? '本项确认结果待核对' : '本项成果待核对'}</span>
    <button type="button" disabled={busy || pending} onClick={() => void confirm()}>{pending ? '正在确认…' : item.pendingConfirmationOperationId ? '核对确认结果' : '确认需求完成'}</button>
    {error && <p role="alert">{error}</p>}
  </div>
}
