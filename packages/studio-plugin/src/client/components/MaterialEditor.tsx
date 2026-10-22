import { useEffect, useState } from 'react'
import type { EntityView, MaterialDraft, MaterialMetadata, StudioReply } from '../../shared/studio.ts'
import type { ScenarioTemplateCatalog } from '../../shared/studio.ts'
import css from '../studio.module.css'

export function MaterialEditor({ draft, categories, entities, projectId, scenarioTemplates, busy, onSave, onBindTemplate, registerFlush }: {
  draft: MaterialDraft; categories: Array<{ id: string; name: string }>; entities: EntityView[]; projectId: string; busy: boolean;
  scenarioTemplates?: ScenarioTemplateCatalog | undefined;
  onSave(body: string, metadata: MaterialMetadata): Promise<StudioReply | undefined>
  onBindTemplate(templateId: string): Promise<unknown>
  registerFlush?: ((flush?: () => Promise<boolean>) => void) | undefined;
}) {
  const relationsFrozen = !!entities.find(entity => entity.id === draft.entityId)?.frozenBy.length
  const [body, setBody] = useState(draft.body)
  const [metadata, setMetadata] = useState(draft.metadata)
  const [templateId, setTemplateId] = useState(draft.metadata.kind === 'scenario' ? draft.metadata.templateId : '')
  const [evidence, setEvidence] = useState(JSON.stringify(draft.metadata.businessEvidence, null, 2))
  const [questions, setQuestions] = useState(draft.metadata.openQuestions.map(q => `${q.blocking ? '阻断' : '限制'} | ${q.limitation} | ${q.excludedScope}`).join('\n'))
  const [error, setError] = useState('')
  const save = async (): Promise<boolean> => {
    try {
      const businessEvidence: MaterialMetadata['businessEvidence'] = evidence.trim() ? JSON.parse(evidence) : []
      if (!Array.isArray(businessEvidence)) throw new Error('正式依据必须是 JSON 数组')
      const next: MaterialMetadata = { ...metadata,
        businessEvidence,
        openQuestions: questions.split('\n').filter(x => x.trim()).map(line => { const [kind, limitation, ...scope] = line.split('|'); return { blocking: kind?.trim() === '阻断', limitation: limitation?.trim() ?? '', excludedScope: scope.join('|').trim() } }),
      }
      const result = await onSave(body, next)
      if (!result?.ok) { setError(result && !result.ok ? result.message : '保存失败，当前输入已保留。'); return false }
      setError(''); return true
    } catch (reason) { setError(reason instanceof Error ? reason.message : '正式依据格式无效'); return false }
  }
  const dirty = body !== draft.body || JSON.stringify(metadata) !== JSON.stringify(draft.metadata)
    || evidence !== JSON.stringify(draft.metadata.businessEvidence, null, 2)
    || questions !== draft.metadata.openQuestions.map(q => `${q.blocking ? '阻断' : '限制'} | ${q.limitation} | ${q.excludedScope}`).join('\n')
  // Source selection can update metadata, so hand edits must reach the Host first.
  useEffect(() => {
    registerFlush?.(async () => !dirty || await save())
    return () => registerFlush?.()
  }, [registerFlush, dirty, save])
  return <div className={css.editor}>
    <div className={css.editorHeading}><span className={css.assetIcon}>MD</span><div><strong>当前材料</strong><small>{draft.path}</small></div><span className={css.muted}>草稿编辑</span></div>
    <label>标题<input value={metadata.title} onChange={e => setMetadata({ ...metadata, title: e.target.value })} /></label>
    {metadata.kind === 'scenario' && scenarioTemplates && <fieldset><legend>场景模板绑定</legend><select aria-label="场景模板" value={templateId} onChange={e => setTemplateId(e.target.value)}>{scenarioTemplates.templates.map(template => <option key={template.id} value={template.id}>{template.name}{template.id === scenarioTemplates.defaultTemplateId ? '（项目默认）' : ''}</option>)}</select><small>当前固定模板：{metadata.templateId} · {metadata.templateRef.path}</small><button type="button" disabled={busy || !templateId || templateId === metadata.templateId} onClick={() => void onBindTemplate(templateId)}>切换模板绑定</button></fieldset>}
    {metadata.kind !== 'scenario' && <label>业务分类<select value={metadata.categoryId} onChange={e => setMetadata({ ...metadata, categoryId: e.target.value })}>{categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>}
    <label className={css.bodyLabel}>业务材料<textarea className={css.materialBody} value={body} onChange={e => setBody(e.target.value)} spellCheck={false} aria-label="材料 Markdown 正文" /></label>
    <details><summary>业务依据、关系与待澄清项</summary>
      <label>正式依据（JSON，须标明 `.eadp/evidence/` 归档文件、SHA-256 和行范围）<textarea rows={8} value={evidence} onChange={e => setEvidence(e.target.value)} placeholder='[{"label":"业务访谈","reference":"采购流程访谈记录","files":[{"path":".eadp/evidence/interview.md","sha256":"…"}],"ranges":[{"path":".eadp/evidence/interview.md","startLine":1,"endLine":8}] }' /></label>
      {metadata.kind === 'requirement' && <>{relationsFrozen && <p className={css.muted}>关联场景与前置需求由当前场景修订批次固定，业务内容仍可编辑。</p>}<label>关联场景（固定已确认版本）<select multiple required disabled={relationsFrozen} value={metadata.scenarioIds} onChange={e => { const scenarioIds = [...e.target.selectedOptions].map(o => o.value); setMetadata({ ...metadata, scenarioIds, sources: scenarioIds.map(entityId => { const scenario = entities.find(entity => entity.id === entityId)!; return { projectId, entityId, version: scenario.materialVersion } }) }) }}>{entities.filter(e => e.kind === 'scenario' && e.materialVersion > 0).map(e => <option key={e.id} value={e.id}>{e.code ?? e.id} · {e.title} · v{e.materialVersion}</option>)}</select></label><fieldset><legend>前置需求（固定已确认版本）</legend>{entities.filter(e => e.kind === 'requirement' && e.id !== draft.entityId && e.current).map(entity => <label className={css.checkbox} key={entity.id}><input type="checkbox" disabled={relationsFrozen} checked={metadata.prerequisites.some(p => p.requirementId === entity.id)} onChange={e => setMetadata({ ...metadata, prerequisites: e.target.checked ? [...metadata.prerequisites, { requirementId: entity.id, version: entity.materialVersion }] : metadata.prerequisites.filter(p => p.requirementId !== entity.id) })} />{entity.title} · v{entity.materialVersion}</label>)}</fieldset></>}
      <label>待澄清项（每行：阻断/限制 | 问题或限制 | 不适用范围）<textarea rows={3} value={questions} onChange={e => setQuestions(e.target.value)} /></label>
      <label className={css.checkbox}><input type="checkbox" checked={metadata.coreRulesPresent} onChange={e => setMetadata({ ...metadata, coreRulesPresent: e.target.checked })} />核心业务规则已由业务依据明确</label>
      <label className={css.checkbox}><input type="checkbox" checked={metadata.acceptanceCriteriaPresent} onChange={e => setMetadata({ ...metadata, acceptanceCriteriaPresent: e.target.checked })} />验收条件可以客观判断</label>
    </details><button className={css.primary} disabled={busy} onClick={() => void save()}>保存当前材料</button><small className={css.muted}>保存后再确认。未解决的核心问题会阻止确认。{error && <span role="alert">{error}</span>}</small>
  </div>
}
