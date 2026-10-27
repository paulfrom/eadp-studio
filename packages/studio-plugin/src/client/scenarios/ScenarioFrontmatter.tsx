import { useState } from 'react'
import type { EntityView, MaterialMetadata, TemplateCatalogView } from '../../shared/studio.ts'
import type { DraftBuffer, DraftSnapshot } from './DraftBuffer.ts'
import css from '../studio.module.css'

/** Formats an audit timestamp for the frontmatter row; the raw value stays a wire format. */
const auditTime = (value: string | undefined) => value ? value.replace('T', ' ').slice(0, 19) : '—'

/**
 * Compact identity and template metadata for the scenario document.
 */
export function ScenarioFrontmatter({ entity, buffer, snapshot, readOnly, editingDisabled, templates, busy, onBindTemplate }: {
  entity: EntityView; buffer: DraftBuffer; snapshot: DraftSnapshot; readOnly: boolean; editingDisabled: boolean;
  templates?: TemplateCatalogView | undefined; busy: boolean; onBindTemplate(templateId: string): void;
}) {
  const [templateId, setTemplateId] = useState('')
  const metadata = snapshot.metadata
  const edit = (change: Partial<MaterialMetadata>) => buffer.edit({ body: snapshot.body, metadata: { ...metadata, ...change } as MaterialMetadata })
  const editable = !readOnly && !editingDisabled
  const template = templates?.templates.find(item => item.id === metadata.templateId)
  const scenarioCode = entity.code ?? (entity.sequence ? `#${entity.sequence}` : entity.id)
  return <section className={css.scenarioMeta} aria-label="场景身份与版本">
    <div className={css.scenarioMetaHeading}><strong>{scenarioCode} · {metadata.title || entity.title}</strong><span>{readOnly ? `固定版本 v${entity.materialVersion}` : '本地草稿'}</span></div>
    <dl className={css.frontmatterRows}>
      <div><dt>名称</dt><dd>{editable
        ? <input aria-label="场景名称" value={metadata.title} onChange={event => edit({ title: event.target.value })} />
        : <span>{metadata.title}</span>}</dd></div>
      <div><dt>模板</dt><dd>{template?.name ?? metadata.templateId}{metadata.templateRef && <small>固定版本 {metadata.templateRef.path} · {metadata.templateRef.commitSha.slice(0, 12)}</small>}</dd></div>
      <div><dt>审计时间</dt><dd>{auditTime(readOnly ? entity.current?.confirmedAt : entity.lastEditor?.at ?? entity.creator?.at)}</dd></div>
    </dl>
    {editable && templates && <details className={css.templateBinding}>
      <summary>模板绑定设置</summary>
        <label>切换固定模板<select value={templateId || metadata.templateId} onChange={event => setTemplateId(event.target.value)}>{templates.templates.map(item => <option key={item.id} value={item.id}>{item.name}{item.id === templates.defaultTemplateId ? '（项目默认）' : ''}</option>)}</select></label>
        <p className={css.muted}>切换仅更新模板绑定，正文保持原样。</p>
        <button disabled={busy || !(templateId && templateId !== metadata.templateId)} onClick={() => onBindTemplate(templateId)}>切换固定模板</button>
    </details>}
  </section>
}
