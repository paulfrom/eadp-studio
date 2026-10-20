import { useDeferredValue, useMemo, useState } from 'react'
import { DiffBlock, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MaterialDraft, MaterialMetadata, ScenarioTemplateCatalog } from '../../shared/studio.ts'
import { DraftBuffer, type DraftSnapshot } from './DraftBuffer.ts'
import { diffLabels, exportMarkdown, markdownLabels } from './document.ts'
import css from '../studio.module.css'

export function ScenarioEditor({ draft, buffer, snapshot, readOnly, editingDisabled, templates, busy, onBindTemplate, onResolve }: {
  draft: MaterialDraft; buffer: DraftBuffer; snapshot: DraftSnapshot; readOnly: boolean; editingDisabled: boolean; templates?: ScenarioTemplateCatalog | undefined; busy: boolean;
  onBindTemplate(templateId: string): void; onResolve(body: string, metadata: MaterialMetadata, actualHash: string): void;
}) {
  const [preview, setPreview] = useState(readOnly)
  const [templateId, setTemplateId] = useState('')
  const deferredBody = useDeferredValue(snapshot.body)
  const conflict = snapshot.conflict
  const diffs = useMemo(() => conflict ? [
    { path: draft.path, oldText: conflict.body, newText: snapshot.body },
    ...(JSON.stringify(conflict.metadata) === JSON.stringify(snapshot.metadata) ? [] : [{ path: `${draft.path} · 业务字段`, oldText: JSON.stringify(conflict.metadata, null, 2), newText: JSON.stringify(snapshot.metadata, null, 2) }]),
  ] : [], [conflict, draft.path, snapshot.body, snapshot.metadata])
  const metadata = snapshot.metadata
  const editMetadata = (change: Partial<MaterialMetadata>) => buffer.edit({ body: snapshot.body, metadata: { ...metadata, ...change } as MaterialMetadata })
  return <div className={css.editor}>
    <div className={css.editorHeading}><span className={css.assetIcon}>MD</span><div><strong>{readOnly ? '已确认固定版本' : '当前本地草稿'}</strong><small>{draft.path}</small></div></div>
    <div className={css.actionBar}><button aria-pressed={!preview} onClick={() => setPreview(false)}>Markdown 源码</button><button aria-pressed={preview} onClick={() => setPreview(true)}>预览</button><button onClick={() => exportMarkdown(metadata.title, snapshot.body)}>导出 Markdown</button></div>
    <p role="status" className={snapshot.error ? css.error : css.muted}>{readOnly ? '只读查看 · 不领取设计占用' : snapshot.saving ? '正在保存本地草稿…' : snapshot.dirty ? '有未保存输入' : '本地草稿已保存'}{snapshot.error && ` · ${snapshot.error}`}</p>
    {conflict && <section className={css.conflictPanel} aria-label="外部文件冲突"><strong>文件已变化，确认已暂停</strong><p>外部版本与当前输入均已保留。选择一份，或在源码中合并后保存。</p><div className={css.conflictCopies}><label>外部文件<textarea readOnly rows={8} value={conflict.body} /></label><label>未保存输入<textarea readOnly rows={8} value={snapshot.body} /></label></div><DiffBlock diffs={diffs} labels={diffLabels} /><div className={css.actionBar}><button disabled={busy} onClick={() => onResolve(conflict.body, conflict.metadata, conflict.sha256)}>采用外部版本</button><button disabled={busy} onClick={() => onResolve(snapshot.body, metadata, conflict.sha256)}>保存当前合并结果</button></div></section>}
    <label>场景名称<input readOnly={readOnly || editingDisabled} value={metadata.title} onChange={event => editMetadata({ title: event.target.value })} /></label>
    {metadata.kind === 'scenario' && <details><summary>固定模板 · {metadata.templateId}</summary><small>{metadata.templateRef.path} · {metadata.templateRef.commitSha.slice(0, 12)}</small>{!readOnly && !editingDisabled && templates && <><label>切换模板<select value={templateId || metadata.templateId} onChange={event => setTemplateId(event.target.value)}>{templates.templates.map(template => <option key={template.id} value={template.id}>{template.name}{template.id === templates.defaultTemplateId ? '（项目默认）' : ''}</option>)}</select></label><p>切换仅更新模板绑定，正文保持原样，旧模板上下文的建议会过期。</p><button disabled={busy || !(templateId && templateId !== metadata.templateId) || !!conflict} onClick={() => onBindTemplate(templateId)}>切换固定模板</button></>}</details>}
    {preview ? <div className={css.markdownPreview}><MarkdownText text={deferredBody} labels={markdownLabels} /></div> : <label className={css.bodyLabel}>场景 Markdown<textarea className={css.materialBody} spellCheck={false} readOnly={readOnly || editingDisabled} aria-label="场景 Markdown 正文" value={snapshot.body} onChange={event => buffer.edit({ body: event.target.value, metadata })} /></label>}
    <details><summary>业务完整性与待澄清项</summary><label className={css.checkbox}><input type="checkbox" disabled={readOnly || editingDisabled} checked={metadata.coreRulesPresent} onChange={event => editMetadata({ coreRulesPresent: event.target.checked })} />核心业务规则已由依据明确</label><label className={css.checkbox}><input type="checkbox" disabled={readOnly || editingDisabled} checked={metadata.acceptanceCriteriaPresent} onChange={event => editMetadata({ acceptanceCriteriaPresent: event.target.checked })} />验收条件可以客观判断</label>{metadata.openQuestions.map((question, index) => <fieldset key={index}><legend>待澄清项 {index + 1}</legend><label className={css.checkbox}><input type="checkbox" disabled={readOnly || editingDisabled} checked={question.blocking} onChange={event => editMetadata({ openQuestions: metadata.openQuestions.map((item, i) => i === index ? { ...item, blocking: event.target.checked } : item) })} />阻断确认</label><label>问题或限制<input readOnly={readOnly || editingDisabled} value={question.limitation} onChange={event => editMetadata({ openQuestions: metadata.openQuestions.map((item, i) => i === index ? { ...item, limitation: event.target.value } : item) })} /></label><label>不适用范围<input readOnly={readOnly || editingDisabled} value={question.excludedScope} onChange={event => editMetadata({ openQuestions: metadata.openQuestions.map((item, i) => i === index ? { ...item, excludedScope: event.target.value } : item) })} /></label>{!readOnly && !editingDisabled && <button onClick={() => editMetadata({ openQuestions: metadata.openQuestions.filter((_, i) => i !== index) })}>删除此项</button>}</fieldset>)}{!readOnly && !editingDisabled && <button onClick={() => editMetadata({ openQuestions: [...metadata.openQuestions, { blocking: true, limitation: '', excludedScope: '' }] })}>添加待澄清项</button>}</details>
    {!readOnly && !editingDisabled && <button className={css.primary} disabled={snapshot.saving || !!conflict} onClick={() => void buffer.flush()}>{snapshot.error ? '重试本地保存' : '立即保存本地草稿'}</button>}
  </div>
}
