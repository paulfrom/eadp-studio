import { useEffect, useRef, useState } from 'react'
import type { ScenarioWriteProposalView } from '../../shared/scenarios.ts'
import { MaterialWorkspaceSheet } from '../components/MaterialWorkspaceChrome.tsx'
import type { ScenarioSource } from '../../shared/scenarios.ts'
import css from '../studio.module.css'
import reviewCss from './write-review.module.css'

/** Explains why the latest answer could not create an actionable write proposal. */
export function ScenarioWriteProposalError({ message }: { message: string }) {
  return <section className={css.dockCard} role="alert" aria-label="写入提议未生成">
    <header className={css.cardHead}><strong>写入提议未生成</strong></header>
    <p>{message}</p>
    <p className={css.muted}>请让 AI 重新整理本轮结论并提出写入提议，生成后可以逐章审阅。</p>
  </section>
}

/** Explicit chapter review is the only gesture that authorizes a proposed document write. */
export function ScenarioWriteProposalCard({ proposal, sources = [], disabled, onResolve, materialLabel = '场景', reviewRequested = 0, hideReviewAction = false }: {
  proposal: ScenarioWriteProposalView; disabled: boolean;
  sources?: ScenarioSource[];
  onResolve(decision: 'write' | 'reject', selectedChangeIds?: string[]): void;
  materialLabel?: string; reviewRequested?: number; hideReviewAction?: boolean;
}) {
  const all = useRef<HTMLInputElement>(null)
  const lastReviewRequest = useRef(reviewRequested)
  const [reviewing, setReviewing] = useState(false)
  const [selected, setSelected] = useState(() => new Set(proposal.changes.map(change => change.id)))
  const [deferred, setDeferred] = useState(false)
  const pending = proposal.status === 'pending'
  const failed = pending && !!proposal.error
  const state = failed ? '失败，可重试' : pending ? '待审阅' : proposal.status === 'consumed' ? '已写入' : '已拒绝'
  const added = proposal.changes.reduce((count, change) => count + change.addedLines, 0)
  const removed = proposal.changes.reduce((count, change) => count + change.removedLines, 0)
  const evidence = proposal.evidenceIds.map(id => sources.find(source => source.id === id) ?? { id, name: id, status: 'failed' as const, ranges: [] })
  useEffect(() => { setSelected(new Set(proposal.changes.map(change => change.id))); setDeferred(false); setReviewing(false) }, [proposal.id])
  useEffect(() => { if (all.current) all.current.indeterminate = selected.size > 0 && selected.size < proposal.changes.length }, [selected, proposal.changes.length])
  useEffect(() => {
    if (lastReviewRequest.current === reviewRequested) return
    lastReviewRequest.current = reviewRequested
    if (reviewRequested > 0 && pending && !disabled) { setDeferred(false); setReviewing(true) }
  }, [reviewRequested])
  useEffect(() => { if (!pending) setReviewing(false) }, [pending])
  const open = () => { setDeferred(false); setReviewing(true) }
  return <section className={`${css.dockCard} ${reviewCss.proposal}`} aria-label="写入提议" data-state={proposal.status}>
    <header className={css.cardHead}><strong>写入提议 · {state}</strong><small>{proposal.target === 'context' ? 'CONTEXT.md' : `${materialLabel}正文`}</small></header>
    <div className={reviewCss.stats}><span>{proposal.changes.length} 处章节变更</span><span className={reviewCss.added}>+{added}</span><span className={reviewCss.removed}>−{removed}</span><span>引用 {evidence.length} 份资料</span></div>
    <details className={reviewCss.conclusions}><summary>查看本轮结论 · {proposal.conclusions.length} 项</summary><ul>{proposal.conclusions.map((text, index) => <li key={index}>{text}</li>)}</ul></details>
    {evidence.length > 0 && <details className={reviewCss.evidence}><summary>查看本提议实际引用的资料 · {evidence.length} 份</summary><ul>{evidence.map(source => <li key={source.id}><span>{source.name}{source.status === 'partial' ? ' · 部分读取' : ''}</span>{source.ranges.length > 0 ? <small> · {source.ranges.join(' · ')}</small> : source.status === 'failed' ? <small> · 当前不可读取</small> : null}</li>)}</ul></details>}
    {proposal.error && <p className={css.notice} role="alert">{proposal.error}</p>}
    {pending && <div className={css.dockActions}>
      <span className={css.muted}>{deferred ? '已暂存，随时可以继续审阅' : '写入前可逐章核对'}</span>
      <button disabled={disabled} onClick={() => setDeferred(true)}>稍后</button>
      {!hideReviewAction && <button className={css.primary} disabled={disabled || !proposal.changes.length} onClick={open}>{failed ? '重新审阅' : `审阅 ${proposal.changes.length} 处变更`}</button>}
    </div>}
    <MaterialWorkspaceSheet open={reviewing} title="审阅写入变更" subtitle={`${proposal.target === 'context' ? '项目 CONTEXT.md' : `${materialLabel}文档`} · 勾选要保留的变更`} size="wide" onClose={() => setReviewing(false)}>
      <div className={reviewCss.selection}><label><input ref={all} type="checkbox" checked={selected.size === proposal.changes.length && selected.size > 0} onChange={event => setSelected(new Set(event.target.checked ? proposal.changes.map(change => change.id) : []))} />全选</label><span>已选 {selected.size} / {proposal.changes.length} 处</span><span className={reviewCss.added}>+{added}</span><span className={reviewCss.removed}>−{removed}</span></div>
      <div className={reviewCss.diffBody}>{proposal.changes.map(change => <section className={reviewCss.change} key={change.id}>
        <label className={reviewCss.changeHead}><input type="checkbox" checked={selected.has(change.id)} onChange={event => setSelected(current => { const next = new Set(current); if (event.target.checked) next.add(change.id); else next.delete(change.id); return next })} /><strong>{change.title}</strong><span>{({ added: '新增', changed: '修改', removed: '删除' } as const)[change.kind]}</span><small className={reviewCss.added}>+{change.addedLines}</small><small className={reviewCss.removed}>−{change.removedLines}</small></label>
        <div className={reviewCss.comparison}><div data-side="before"><small>写入前</small><pre>{change.before || '（无内容）'}</pre></div><div data-side="after"><small>写入后</small><pre>{change.after || '（删除本章）'}</pre></div></div>
      </section>)}</div>
      <footer className={reviewCss.sheetFoot}><span>未勾选的章节保留原文</span><button disabled={disabled} onClick={() => { onResolve('reject'); setReviewing(false) }}>不写入</button><button onClick={() => setReviewing(false)}>取消</button><button className={`${css.primary} ${reviewCss.writeButton}`} disabled={disabled || !selected.size} onClick={() => { onResolve('write', [...selected]); setReviewing(false) }}>写入所选的 {selected.size} 处</button></footer>
    </MaterialWorkspaceSheet>
  </section>
}
