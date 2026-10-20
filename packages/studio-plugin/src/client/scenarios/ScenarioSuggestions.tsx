import { memo, useMemo, useState } from 'react'
import type { ScenarioSuggestionBatch } from '../../shared/scenarios.ts'
import css from '../studio.module.css'

export const ScenarioSuggestions = memo(function ScenarioSuggestions({ batches, hash, disabled, onAdopt }: { batches: ScenarioSuggestionBatch[]; hash: string; disabled: boolean; onAdopt(batchId: string, itemIds: string[]): Promise<void> }) {
  return <div className={css.suggestions}>{batches.map(batch => <SuggestionBatch key={batch.id} batch={batch} hash={hash} disabled={disabled} onAdopt={onAdopt} />)}</div>
})
function SuggestionBatch({ batch, hash, disabled, onAdopt }: { batch: ScenarioSuggestionBatch; hash: string; disabled: boolean; onAdopt(batchId: string, itemIds: string[]): Promise<void> }) {
  const [selection, setSelection] = useState<string[]>([])
  const ids = useMemo(() => batch.groups.flatMap(group => group.items.map(item => item.id)), [batch.groups])
  const current = batch.status === 'current' && batch.baseHash === hash
  const toggle = (targets: string[], checked: boolean) => setSelection(previous => checked ? [...new Set([...previous, ...targets])] : previous.filter(id => !targets.includes(id)))
  return <section className={css.suggestionBatch}><div className={css.sectionHeading}><h3>AI 建议</h3><span>{current ? '待选择采纳' : batch.status === 'applied' ? '已采纳' : '历史建议 · 已过期'}</span></div>{batch.error && <p role="alert">{batch.error}</p>}<label className={css.checkbox}><input type="checkbox" disabled={!current || disabled} checked={ids.length > 0 && ids.every(id => selection.includes(id))} onChange={event => toggle(ids, event.target.checked)} />选择全部建议</label>{batch.groups.map(group => <fieldset key={group.id}><legend><label className={css.checkbox}><input type="checkbox" disabled={!current || disabled} checked={group.items.length > 0 && group.items.every(item => selection.includes(item.id))} onChange={event => toggle(group.items.map(item => item.id), event.target.checked)} />{group.title}</label></legend>{group.items.map(item => <label key={item.id} className={css.suggestionItem}><span><input type="checkbox" disabled={!current || disabled} checked={selection.includes(item.id)} onChange={event => toggle([item.id], event.target.checked)} /> 选择此条</span>{item.original && <del>{item.original}</del>}<ins>{item.replacement}</ins></label>)}</fieldset>)}<button disabled={!current || disabled || !selection.length} onClick={() => void onAdopt(batch.id, selection)}>一次采纳所选 {selection.length} 条</button></section>
}
