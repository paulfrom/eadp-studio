import { memo } from 'react'
import type { ScenarioSuggestionBatch } from '../../shared/scenarios.ts'
import css from '../studio.module.css'

const batchStates = { current: '待采纳', applied: '已采纳', stale: '已过期', invalid: '已失效' }
/**
 * Adoptable suggestion groups produced against the current material hash.
 * Each group and item can be adopted alone, and the footer adopts the batch.
 */
export const ScenarioSuggestions = memo(function ScenarioSuggestions({ batches, hash, disabled, onAdopt }: {
  batches: ScenarioSuggestionBatch[]; hash: string; disabled: boolean; onAdopt(batchId: string, itemIds: string[]): Promise<void>;
}) {
  if (!batches.length) return null
  return <div className={css.suggestionList}>{batches.map(batch => <SuggestionBatch key={batch.id} batch={batch} hash={hash} disabled={disabled} onAdopt={onAdopt} />)}</div>
})
function SuggestionBatch({ batch, hash, disabled, onAdopt }: { batch: ScenarioSuggestionBatch; hash: string; disabled: boolean; onAdopt(batchId: string, itemIds: string[]): Promise<void> }) {
  const current = batch.status === 'current' && batch.baseHash === hash
  const ids = batch.groups.flatMap(group => group.items.map(item => item.id))
  if (!ids.length) return <p className={css.dockNotice} data-state={batch.status}>
    <span>AI 建议 · {batchStates[batch.status]}</span>
    <span role={batch.error ? 'alert' : 'status'}>{batch.error ?? '此批建议不属于当前版本，需要重新生成。'}</span>
  </p>
  return <section className={css.suggestionBatch} aria-label="AI 建议">
    <header className={css.groupLabel}><strong>AI 建议</strong><span className={css.cardCount} data-state={current ? 'current' : batch.status}>{batchStates[batch.status]}</span><small>{batch.groups.length} 组 · {ids.length} 条</small></header>
    {batch.error && <p role="alert">{batch.error}</p>}
    {batch.groups.map((group, index) => <article className={css.suggestionGroup} key={group.id}>
      <header className={css.suggestionGroupHead}>
        <span className={css.sectionIndex}>{String(index + 1).padStart(2, '0')}</span>
        <strong>{group.title}</strong>
        <small>{group.items.length} 条</small>
        <button disabled={!current || disabled || !group.items.length} onClick={() => void onAdopt(batch.id, group.items.map(item => item.id))}>采纳至契约</button>
      </header>
      <ul className={css.suggestionItems}>{group.items.map(item => <li key={item.id}>
        <div className={css.suggestionText}>{item.original && <del>{item.original}</del>}<ins>{item.replacement}</ins></div>
        <button disabled={!current || disabled} onClick={() => void onAdopt(batch.id, [item.id])}>采纳</button>
      </li>)}</ul>
    </article>)}
    <footer className={css.dockActions}><small>{current ? '采纳后写入右侧契约，未采纳的建议不会进入材料。' : '此批建议不属于当前版本，需要重新生成。'}</small><button className={css.primary} disabled={!current || disabled || !ids.length} onClick={() => void onAdopt(batch.id, ids)}>一键全部采纳至契约</button></footer>
  </section>
}
