import { memo, useState, type ChangeEvent } from 'react'
import type { ScenarioSource } from '../../shared/scenarios.ts'
import { fileBase64 } from './document.ts'
import css from '../studio.module.css'

const statusNames = { reading: '正在读取', read: '已读取', partial: '部分读取', failed: '读取失败' }
export interface ScenarioEvidenceProps {
  sources: ScenarioSource[]; disabled: boolean; readOnly: boolean;
  onImport(name: string, base64: string): Promise<void>; onRetry(id: string): void;
  onSelect(source: ScenarioSource, selected: boolean, formal: boolean): void;
}

/** Shows only the reader's reported status and scope; importing alone does not attest a read. */
function EvidenceSource({ source, disabled, readOnly, onRetry, onSelect }: Omit<ScenarioEvidenceProps, 'sources' | 'onImport'> & { source: ScenarioSource }) {
  const locked = disabled || readOnly || source.status === 'reading'
  const image = ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(source.format)
  return <article className={css.sourceCard}>
    <strong>{source.name}</strong><span role="status">{source.format} · {statusNames[source.status]}</span>
    <small title={source.sha256}>SHA-256 {source.sha256.slice(0, 16)}</small>
    <p>实际读取范围：{source.ranges.join('、') || '无'}</p>
    {source.error && <p role="alert">{source.error}</p>}
    <label className={css.checkbox}><input type="checkbox" disabled={locked || (source.status === 'failed' && !image)} checked={source.selected} onChange={event => onSelect(source, event.target.checked, event.target.checked && source.formal)} />提供给当前材料 AI</label>
    <label className={css.checkbox}><input type="checkbox" disabled={locked || source.status === 'failed'} checked={source.formal} onChange={event => onSelect(source, source.selected || event.target.checked, event.target.checked)} />选为正式依据，随确认版本归档</label>
    {!readOnly && source.status !== 'read' && source.status !== 'reading' && <button type="button" disabled={disabled} onClick={() => onRetry(source.id)}>重试实际读取</button>}
  </article>
}

export const ScenarioEvidence = memo(function ScenarioEvidence({ sources, disabled, readOnly, onImport, onRetry, onSelect }: ScenarioEvidenceProps) {
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState('')
  const importFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''; setImporting(true); setError('')
    try { for (const file of files) await onImport(file.name, await fileBase64(file)) }
    catch (reason) { setError(reason instanceof Error ? reason.message : '导入资料失败') }
    finally { setImporting(false) }
  }
  return <section className={css.evidencePanel} aria-label="资料与正式依据">
    <p className={css.groupLabel}>资料与正式依据<small>{sources.length} 份</small></p>
    {!readOnly && <label>添加资料<input type="file" multiple disabled={disabled || importing} accept=".txt,.md,.pdf,.doc,.docx,.xls,.xlsx,.csv,.tsv,.ppt,.pptx,.png,.jpg,.jpeg,.gif,.webp" onChange={importFiles} /></label>}
    {importing && <p role="status">正在导入资料…</p>}
    {error && <p role="alert" className={css.error}>{error}</p>}
    {sources.length === 0 && <p className={css.muted}>还没有资料。文件上传后，以实际读取结果和范围为准。</p>}
    {sources.map(source => <EvidenceSource key={source.id} source={source} disabled={disabled} readOnly={readOnly} onRetry={onRetry} onSelect={onSelect} />)}
  </section>
})
