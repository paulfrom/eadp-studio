import { useState } from 'react'
import type { EntityView, MaterialMetadata, ScenarioTemplateCatalog } from '../../shared/studio.ts'
import { DraftBuffer, type DraftSnapshot } from './DraftBuffer.ts'
import css from '../studio.module.css'

/** Formats an audit timestamp for the frontmatter row; the raw value stays a wire format. */
const auditTime = (value: string | undefined) => value ? value.replace('T', ' ').slice(0, 19) : '—'

/**
 * Frontmatter card of the scenario spec panel: identity fields of the material
 * plus the completeness declarations that the confirmation gates read.
 */
export function ScenarioFrontmatter({ entity, buffer, snapshot, readOnly, editingDisabled, templates, busy, onBindTemplate }: {
  entity: EntityView; buffer: DraftBuffer; snapshot: DraftSnapshot; readOnly: boolean; editingDisabled: boolean;
  templates?: ScenarioTemplateCatalog | undefined; busy: boolean; onBindTemplate(templateId: string): void;
}) {
  const [templateId, setTemplateId] = useState('')
  const metadata = snapshot.metadata
  const edit = (change: Partial<MaterialMetadata>) => buffer.edit({ body: snapshot.body, metadata: { ...metadata, ...change } as MaterialMetadata })
  const editable = !readOnly && !editingDisabled
  const template = templates?.templates.find(item => item.id === metadata.templateId)
  return <details className={css.frontmatterCard} aria-label="材料前置信息" open>
    <summary className={css.cardHead}>
      <span className={css.assetIcon}>YML</span>
      <strong>Frontmatter Manifest</strong>
      <small>{metadata.kind} · {metadata.entityId}</small>
    </summary>
    <dl className={css.frontmatterRows}>
      <div><dt>title</dt><dd>{editable
        ? <input aria-label="场景名称" value={metadata.title} onChange={event => edit({ title: event.target.value })} />
        : <span>{metadata.title}</span>}</dd></div>
      <div><dt>author</dt><dd>{entity.creator?.name ?? `#${entity.authorId}`}</dd></div>
      <div><dt>updated</dt><dd>{auditTime(entity.lastEditor?.at ?? entity.creator?.at)}</dd></div>
      <div><dt>template</dt><dd>{template?.name ?? metadata.templateId}{metadata.templateRef && <small>{metadata.templateRef.path} · {metadata.templateRef.commitSha.slice(0, 12)}</small>}</dd></div>
      <div><dt>version</dt><dd>{readOnly ? `固定版本 v${entity.materialVersion}` : '本地草稿'}</dd></div>
      <div><dt>baseline</dt><dd>{entity.current ? entity.current.fixed.commitSha.slice(0, 12) : '尚未确认'}</dd></div>
    </dl>
    <details className={css.frontmatterExtra}>
      <summary>业务完整性与待澄清项</summary>
      <label className={css.checkbox}><input type="checkbox" disabled={!editable} checked={metadata.coreRulesPresent} onChange={event => edit({ coreRulesPresent: event.target.checked })} />核心业务规则已由依据明确</label>
      <label className={css.checkbox}><input type="checkbox" disabled={!editable} checked={metadata.acceptanceCriteriaPresent} onChange={event => edit({ acceptanceCriteriaPresent: event.target.checked })} />验收条件可以客观判断</label>
      {metadata.openQuestions.map((question, index) => <fieldset key={index}>
        <legend>待澄清项 {index + 1}</legend>
        <label className={css.checkbox}><input type="checkbox" disabled={!editable} checked={question.blocking} onChange={event => edit({ openQuestions: metadata.openQuestions.map((item, i) => i === index ? { ...item, blocking: event.target.checked } : item) })} />阻断确认</label>
        <label>问题或限制<input readOnly={!editable} value={question.limitation} onChange={event => edit({ openQuestions: metadata.openQuestions.map((item, i) => i === index ? { ...item, limitation: event.target.value } : item) })} /></label>
        <label>不适用范围<input readOnly={!editable} value={question.excludedScope} onChange={event => edit({ openQuestions: metadata.openQuestions.map((item, i) => i === index ? { ...item, excludedScope: event.target.value } : item) })} /></label>
        {editable && <button onClick={() => edit({ openQuestions: metadata.openQuestions.filter((_, i) => i !== index) })}>删除此项</button>}
      </fieldset>)}
      {editable && <button onClick={() => edit({ openQuestions: [...metadata.openQuestions, { blocking: true, limitation: '', excludedScope: '' }] })}>添加待澄清项</button>}
      {editable && templates && <>
        <label>切换固定模板<select value={templateId || metadata.templateId} onChange={event => setTemplateId(event.target.value)}>{templates.templates.map(item => <option key={item.id} value={item.id}>{item.name}{item.id === templates.defaultTemplateId ? '（项目默认）' : ''}</option>)}</select></label>
        <p className={css.muted}>切换仅更新模板绑定，正文保持原样，旧模板上下文的建议会过期。</p>
        <button disabled={busy || !(templateId && templateId !== metadata.templateId) || !!snapshot.conflict} onClick={() => onBindTemplate(templateId)}>切换固定模板</button>
      </>}
    </details>
  </details>
}
