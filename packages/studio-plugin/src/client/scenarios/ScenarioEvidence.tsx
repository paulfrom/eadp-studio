import { memo, useState } from 'react'
import type { ScenarioSource } from '../../shared/scenarios.ts'
import { fileBase64 } from './document.ts'
import css from '../studio.module.css'

const statusNames = { reading: '正在读取', read: '已读取', partial: '部分读取', failed: '读取失败' }
export const ScenarioEvidence = memo(function ScenarioEvidence({ sources, disabled, readOnly, onImport, onRetry, onSelect }: {
  sources: ScenarioSource[]; disabled: boolean; readOnly: boolean;
  onImport(name: string, base64: string): Promise<void>; onRetry(id: string): void;
  onSelect(source: ScenarioSource, selected: boolean, formal: boolean): void;
}) {
  const [reading, setReading] = useState(false)
  const [error, setError] = useState('')
  return <section className={css.evidencePanel} aria-label="资料与正式依据">
    <p className={css.groupLabel}>资料与正式依据<small>{sources.length} 份</small></p>
    {!readOnly && <label>添加资料<input type="file" multiple disabled={disabled || reading} accept=".txt,.md,.pdf,.doc,.docx,.xls,.xlsx,.csv,.tsv,.ppt,.pptx,.png,.jpg,.jpeg,.gif,.webp" onChange={async event => {
    const files = Array.from(event.target.files ?? []); event.target.value = ''; setReading(true); setError('')
    try { for (const file of files) await onImport(file.name, await fileBase64(file)) }
    catch (reason) { setError(reason instanceof Error ? reason.message : '导入资料失败') }
    finally { setReading(false) }
  }} /></label>}{reading && <p role="status">正在读取资料…</p>}{error && <p role="alert" className={css.error}>{error}</p>}{sources.length === 0 && <p className={css.muted}>还没有资料。文件上传后，以实际读取结果和范围为准。</p>}{sources.map(source => <article className={css.sourceCard} key={source.id}><strong>{source.name}</strong><span>{source.format} · {statusNames[source.status]}</span><small title={source.sha256}>SHA-256 {source.sha256.slice(0, 16)}</small><p>实际读取范围：{source.ranges.join('、') || '无'}</p>{source.error && <p role="alert">{source.error}</p>}<label className={css.checkbox}><input type="checkbox" disabled={disabled || readOnly || source.status === 'reading' || (source.status === 'failed' && !['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(source.format))} checked={source.selected} onChange={event => onSelect(source, event.target.checked, event.target.checked && source.formal)} />提供给当前场景 AI</label><label className={css.checkbox}><input type="checkbox" disabled={disabled || readOnly || source.status === 'reading' || source.status === 'failed'} checked={source.formal} onChange={event => onSelect(source, source.selected || event.target.checked, event.target.checked)} />选为正式依据，随确认版本归档</label>{!readOnly && source.status !== 'read' && source.status !== 'reading' && <button disabled={disabled} onClick={() => onRetry(source.id)}>重试实际读取</button>}</article>)}</section>
})
