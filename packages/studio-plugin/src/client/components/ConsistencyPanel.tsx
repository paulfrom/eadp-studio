import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ConsistencyComparisonView } from '@eadp/contracts'
import type { EntityView, StudioCommand, StudioReply } from '../../shared/studio.ts'
import type { ConsistencyTaskView } from '../../shared/consistency.ts'
import css from '../studio.module.css'

const PAGE = 20
const resultLabel: Record<ConsistencyComparisonView['result'], string> = { completed: '对比完成', failed: '对比失败', cancelled: '已取消' }
/** Audit timestamps stay readable wire values; the panel never reinterprets them. */
const formatTime = (value: string) => value.replace('T', ' ').slice(0, 19)

/**
 * Project or material comparisons: the latest conclusion, its conflict digests
 * and the archived history kept one record per comparison.
 * Conflicts carry no processing state, and a failed or cancelled comparison
 * never reads as consistent.
 */
export function ConsistencyPanel({ entityId, entities, tasks, busy, call, onOpenMaterial, onStatusChange }: {
  entityId?: string; entities: EntityView[]; tasks: ConsistencyTaskView[]; busy: boolean;
  call(command: StudioCommand): Promise<StudioReply | undefined>;
  onOpenMaterial?: ((entity: EntityView) => void) | undefined;
  onStatusChange?: ((status: string) => void) | undefined;
}) {
  const [history, setHistory] = useState<ConsistencyComparisonView[]>([])
  const [offset, setOffset] = useState(0)
  const [exhausted, setExhausted] = useState(false)
  const [loading, setLoading] = useState(false)
  const [readError, setReadError] = useState('')
  const [selectedId, setSelectedId] = useState<string>()
  const callRef = useRef(call); callRef.current = call
  const scope = useRef(entityId); scope.current = entityId
  const requestId = useRef(0)
  const readOffset = useRef(0)
  useEffect(() => {
    requestId.current += 1; readOffset.current = 0
    setHistory([]); setOffset(0); setExhausted(false); setSelectedId(undefined)
  }, [entityId])
  const load = useCallback(async (next: number) => {
    const request = ++requestId.current
    setLoading(true); setReadError('')
    try {
      const reply = await callRef.current({ action: 'listConsistencyComparisons', ...(entityId ? { entityId } : {}), limit: PAGE, offset: next })
      if (request !== requestId.current || scope.current !== entityId) return
      if (!reply?.ok) { setReadError(reply && !reply.ok ? reply.message : '对比记录读取失败，请重试。'); return }
      const items = reply.comparisons ?? []
      setHistory(previous => [...items, ...previous.filter(item => !items.some(value => value.id === item.id))].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)))
      if (next > 0 || readOffset.current <= PAGE) { readOffset.current = next + PAGE; setOffset(next + PAGE); setExhausted(items.length < PAGE) }
    } catch (error) { if (request === requestId.current) setReadError(error instanceof Error ? error.message : '对比记录读取失败，请重试。') }
    finally { if (request === requestId.current) setLoading(false) }
  }, [entityId])
  const own = useMemo(() => tasks.filter(task => !entityId || task.entityId === entityId), [tasks, entityId])
  const shared = own.filter(task => task.phase === 'shared').map(task => task.id).sort().join(':')
  // A newly shared result is observable immediately, including comparisons started after confirmation.
  useEffect(() => { void load(0); return () => { requestId.current += 1 } }, [load, shared])
  const running = own.findLast(task => task.phase === 'running')
  const pendingSync = own.findLast(task => task.phase === 'pending-sync')
  const stale = own.findLast(task => task.freshness === 'stale')
  const messages = useMemo(() => [...new Set(own.map(task => task.message).filter((message): message is string => !!message))], [own])
  const latest = history[0]
  const status = running ? '进行中' : pendingSync ? '待同步' : stale ? '已过期' : readError ? '读取失败' : loading && !latest ? '读取中' : !latest ? '未发起' : latest.result === 'failed' ? '失败' : latest.result === 'cancelled' ? '已取消' : latest.coverage === 'partial' ? '范围不足' : latest.conflictCount ? `${latest.conflictCount} 项冲突` : '未发现冲突'
  useEffect(() => { onStatusChange?.(status) }, [status, onStatusChange])
  const selected = history.find(item => item.id === selectedId) ?? latest
  const materialLabel = (id: string) => {
    const entity = entities.find(value => value.id === id)
    return entity ? `${entity.code ?? entity.id} · ${entity.title}` : id
  }
  return <section className={css.dockCard} aria-label={entityId ? '一致性对比' : '项目对比记录'}>
    <header className={css.cardHead}><strong>{entityId ? '一致性对比' : '项目对比记录'}</strong><small>{history.length ? `已读取 ${history.length} 次` : loading ? '正在读取对比记录…' : readError ? '对比记录未读取' : '尚无对比记录'}</small><button disabled={loading} onClick={() => void load(0)}>刷新对比记录</button></header>
    {readError && <p role="alert" className={css.error}>{readError}<button disabled={loading} onClick={() => void load(0)}>重试读取对比记录</button></p>}
    <div className={css.consistencyActions}>
      {entityId && <button className={css.primary} disabled={busy || !!running} onClick={() => void call({ action: 'compareConsistency', entityId })}>发起对比</button>}
      {running && <>
        <span className={css.muted}>对比进行中</span>
        <button disabled={busy} onClick={() => void call({ action: 'cancelConsistencyComparison', comparisonId: running.id })}>取消本次对比</button>
      </>}
      {pendingSync && <>
        <span className={css.reminder}>结果待同步</span>
        <button disabled={busy} onClick={() => void call({ action: 'retryConsistencySubmission', comparisonId: pendingSync.id })}>重试共享</button>
      </>}
      {stale && <>
        <span className={css.reminder}>相对本机内容已过期</span>
        <button disabled={busy} onClick={() => void call({ action: 'checkConsistencyFreshness', comparisonId: stale.id })}>核对本机内容</button>
      </>}
    </div>
    {messages.map(message => <p className={css.reminder} key={message}>{message}</p>)}
    {selected ? <>
      <dl className={css.frontmatterRows}>
        <div><dt>记录</dt><dd>{selected.id === latest?.id ? '最近一次对比' : '历史对比'}{!entityId && ` · ${materialLabel(selected.entityId)}`}</dd></div>
        <div><dt>时间</dt><dd>{formatTime(selected.createdAt)}</dd></div>
        <div><dt>结果</dt><dd>{resultLabel[selected.result]}</dd></div>
        <div><dt>覆盖</dt><dd>{selected.coverage === 'partial' ? <span className={css.reminder}>范围不足</span> : '范围完整'}</dd></div>
        <div><dt>冲突</dt><dd>{selected.conflictCount} 项</dd></div>
      </dl>
      <p className={css.consistencyConclusion}>{selected.result === 'completed' && selected.coverage === 'complete' && selected.conflictCount === 0 ? '本次已读范围未发现冲突' : selected.summary}</p>
      {selected.conflicts.length > 0 && <section className={css.consistencyConflicts} aria-label="冲突摘要">
        <strong>冲突摘要 · {selected.conflicts.length} 项</strong>
        <ul>
          {selected.conflicts.map(conflict => <li key={conflict.id}>
            <span className={css.muted}>#{conflict.ordinal}</span>
            <span className={conflict.relation === 'potential' ? css.potentialTag : css.sourceChip}>{conflict.relation === 'potential' ? '潜在关联' : '正式关系'}</span>
            <p>{conflict.summary}</p>
            <small className={css.muted}>涉及材料：{conflict.entities.map(materialLabel).join('、')}</small>
            {onOpenMaterial && <div>{conflict.entities.map(id => entities.find(entity => entity.id === id)).filter((entity): entity is EntityView => !!entity && !entity.builtinKey).map(entity => <button key={entity.id} disabled={busy} onClick={() => onOpenMaterial(entity)}>查看{entity.kind === 'scenario' ? '场景' : '需求'} · {entity.title}</button>)}</div>}
          </li>)}
        </ul>
      </section>}
    </> : !loading && !readError && <p className={css.muted}>尚无对比记录，发起对比后在这里显示最近一次结论。</p>}
    {history.length > 0 && <section className={css.consistencyHistory} aria-label="历史对比">
      <strong>历史对比</strong>
      {history.map(item => <div className={css.candidateRow} key={item.id}>
        <div><strong>{formatTime(item.createdAt)}</strong><p>{resultLabel[item.result]} · {item.coverage === 'partial' ? '范围不足' : '范围完整'} · 冲突 {item.conflictCount} 项</p></div>
        <button aria-pressed={selected?.id === item.id} onClick={() => setSelectedId(item.id)}>查看本次结论</button>
      </div>)}
      {!exhausted && <button disabled={loading} onClick={() => void load(offset)}>更早记录</button>}
    </section>}
  </section>
}
