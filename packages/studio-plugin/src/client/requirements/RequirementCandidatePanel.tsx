import { useRef, useState } from 'react'
import type { Candidate, EntityView, StudioReply } from '../../shared/studio.ts'
import css from '../studio.module.css'

type AdoptionResult = { entityId: string; error?: never } | { error: string; entityId?: never }

/** Candidate content stays reviewable before either an individual or a multiple adoption. */
function CandidateContent({ candidate }: { candidate: Candidate }) {
  return <details className={css.specSection}>
    <summary>查看完整候选</summary>
    <h4>业务规则</h4>{candidate.rules.length ? <ul>{candidate.rules.map((rule, index) => <li key={index}>{rule}</li>)}</ul> : <p className={css.muted}>未提供业务规则。</p>}
    <h4>验收条件</h4>{candidate.acceptanceCriteria.length ? <ul>{candidate.acceptanceCriteria.map((criterion, index) => <li key={index}>{criterion}</li>)}</ul> : <p className={css.muted}>未提供验收条件。</p>}
    <h4>待澄清项</h4>{candidate.quality.openQuestions.length ? <ul>{candidate.quality.openQuestions.map((question, index) => <li key={index}>{question.blocking ? '阻断' : '限制'} · {question.limitation} · 不适用范围：{question.excludedScope}</li>)}</ul> : <p className={css.muted}>没有待澄清项。</p>}
    <h4>固定来源原文</h4>{candidate.sources.map(source => <section key={source.entityId}>
      <strong>{source.title} · 固定版本 v{source.version}</strong>
      <p className={css.muted}>{source.fixed.path} · {source.fixed.commitSha.slice(0, 12)}</p>
      {source.excerpts.map((excerpt, index) => <blockquote key={index}><small>第 {excerpt.startLine}-{excerpt.endLine} 行</small><p>{excerpt.text}</p></blockquote>)}
    </section>)}
    <h4>完整需求正文</h4><pre className={css.candidateBody}>{candidate.body}</pre>
  </details>
}

/** Adopts selected candidates independently, retaining failures for an idempotent retry. */
export function RequirementCandidatePanel({ candidates, entities, busy, adopt, onOpen }: {
  candidates: Candidate[]; entities: EntityView[]; busy: boolean;
  adopt(candidate: Candidate): Promise<StudioReply | undefined>;
  onOpen(entityId: string): void;
}) {
  const [selection, setSelection] = useState<string[]>([])
  const [results, setResults] = useState<Record<string, AdoptionResult>>({})
  const outcomes = useRef(results)
  const [runningId, setRunningId] = useState<string>()
  const processing = useRef(false)
  const createdId = (candidate: Candidate) => candidate.selectedEntityId ?? outcomes.current[candidate.id]?.entityId
  const selected = candidates.filter(candidate => selection.includes(candidate.id) && !createdId(candidate))
  const adoptOne = async (candidate: Candidate): Promise<string | undefined> => {
    const existing = createdId(candidate)
    if (existing) return existing
    setRunningId(candidate.id)
    let outcome: AdoptionResult
    try {
      const reply = await adopt(candidate)
      const entityId = reply?.ok ? reply.state.candidates.find(item => item.id === candidate.id)?.selectedEntityId : undefined
      outcome = entityId ? { entityId } : { error: reply && !reply.ok ? reply.message : '采用结果尚待核对，请重试原候选。' }
    } catch (error) { outcome = { error: error instanceof Error ? error.message : '采用未完成，请重试原候选。' } }
    outcomes.current = { ...outcomes.current, [candidate.id]: outcome }; setResults(outcomes.current)
    if (outcome.entityId) setSelection(previous => previous.filter(id => id !== candidate.id))
    return outcome.entityId
  }
  const adoptSelection = async (items: Candidate[], open: boolean) => {
    if (processing.current) return
    processing.current = true
    try {
      for (const candidate of items) {
        const entityId = await adoptOne(candidate)
        if (open && entityId) onOpen(entityId)
      }
    } finally { processing.current = false; setRunningId(undefined) }
  }
  if (!candidates.length) return null
  const disabled = busy || !!runningId
  return <section className={css.dockCard} aria-label="需求拆分候选">
    <header className={css.cardHead}><strong>需求拆分候选</strong><small>{candidates.length} 条</small></header>
    <div className={css.dockActions}>
      <button disabled={disabled || !candidates.some(candidate => !createdId(candidate))} onClick={() => setSelection(candidates.filter(candidate => !createdId(candidate)).map(candidate => candidate.id))}>全选未采用候选</button>
      <button disabled={disabled || !selected.length} onClick={() => void adoptSelection(selected, false)}>采用所选候选（{selected.length}）</button>
      <button disabled={disabled || !selection.length} onClick={() => setSelection([])}>清空候选选择</button>
    </div>
    {candidates.map(candidate => {
      const entityId = candidate.selectedEntityId ?? results[candidate.id]?.entityId
      const error = entityId ? undefined : results[candidate.id]?.error
      return <article className={css.candidateRow} key={candidate.id} aria-label={`候选 · ${candidate.title}`}>
        <div>
          <label className={css.checkbox}><input type="checkbox" disabled={disabled || !!entityId} checked={selection.includes(candidate.id) && !entityId} onChange={event => setSelection(previous => event.target.checked ? [...previous, candidate.id] : previous.filter(id => id !== candidate.id))} />选择候选 · {candidate.title}</label>
          <strong>{candidate.title}</strong><p>{candidate.summary}</p><p className={css.muted}>目标 {candidate.goal} · 范围 {candidate.scope}</p>
          <span className={css.cardSources}>{candidate.sources.map(source => <span key={source.entityId} className={css.sourceChip}>{entities.find(entity => entity.id === source.entityId)?.code ?? source.entityId} · {source.title} · v{source.version} · {source.excerpts.length} 段原文</span>)}</span>
          <CandidateContent candidate={candidate} />
          {entityId && <p className={css.success}>已创建需求草稿</p>}
          {runningId === candidate.id && <p role="status">正在采用此候选…</p>}
          {error && <p role="alert" className={css.error}>{error}</p>}
        </div>
        <div className={css.dockActions}>
          <button disabled={disabled || !!entityId} onClick={() => void adoptSelection([candidate], true)}>{entityId ? '已创建草稿' : error ? '重试采用此候选' : '选用并创建需求草稿'}</button>
          {entityId && <button disabled={disabled} onClick={() => onOpen(entityId)}>打开需求草稿</button>}
        </div>
      </article>
    })}
  </section>
}
