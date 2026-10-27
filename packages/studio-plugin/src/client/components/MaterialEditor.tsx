import { useCallback, useEffect, useRef, useState } from 'react'
import type { EntityView, MaterialDraft, MaterialMetadata, StudioReply, TemplateCatalogView } from '../../shared/studio.ts'
import type { RequirementSaveView } from '../../shared/requirement-workspace.ts'
import { sameDraftInput, type SaveDraft } from '../scenarios/DraftBuffer.ts'
import { ExternalFileNotice } from '../scenarios/ExternalFileNotice.tsx'
import { useDraftBuffer } from '../scenarios/useDraftBuffer.ts'
import { ordinaryScenarioSources, removeScenarioSource, updateScenarioSources } from '../requirements/scenario-sources.ts'
import css from '../studio.module.css'

export type MaterialEditorInput = Parameters<SaveDraft>[0]
const leaveFlush = () => {}
const evidenceText = (metadata: MaterialMetadata): string => JSON.stringify(metadata.businessEvidence, null, 2)
const questionText = (metadata: MaterialMetadata): string => metadata.openQuestions.map(q => `${q.blocking ? '阻断' : '限制'} | ${q.limitation} | ${q.excludedScope}`).join('\n')
function fields(evidence: string, questions: string): Pick<MaterialMetadata, 'businessEvidence' | 'openQuestions'> {
  const businessEvidence: MaterialMetadata['businessEvidence'] = evidence.trim() ? JSON.parse(evidence) : []
  if (!Array.isArray(businessEvidence)) throw new Error('正式依据必须是 JSON 数组')
  const openQuestions = questions.split('\n').filter(line => line.trim()).map(line => {
    const [kind, limitation, ...scope] = line.split('|'), excludedScope = scope.join('|').trim()
    if (!limitation?.trim() || !excludedScope) throw new Error('待澄清项须填写问题或限制及不适用范围')
    return { blocking: kind?.trim() === '阻断', limitation: limitation.trim(), excludedScope }
  })
  return { businessEvidence, openQuestions }
}
function savedDraft(reply: StudioReply | undefined, entityId: string): MaterialDraft {
  if (!reply?.ok) throw new Error(reply && !reply.ok ? reply.message : '保存失败，当前输入已保留。')
  const workspace = reply.state.requirement
  if (workspace?.entityId === entityId && workspace.requirementSave && !workspace.requirementSave.documentSaved) throw new Error(workspace.requirementSave.message)
  const value = workspace?.entityId === entityId ? workspace.draft : reply.state.drafts.find(value => value.entityId === entityId)
  if (!value) throw new Error('保存回执缺少当前材料，当前输入已保留。')
  return value
}

/** Shared material form keeps unsaved input and the last acknowledged hash across projection polling. */
export function MaterialEditor({ draft, entities, projectId, templates, busy, onSave, onBindTemplate, registerFlush, saveRecovery, onRetrySave }: {
  draft: MaterialDraft; entities: EntityView[]; projectId: string; busy: boolean;
  templates?: TemplateCatalogView | undefined;
  onSave(input: MaterialEditorInput): Promise<StudioReply | undefined>
  onBindTemplate?: ((templateId: string, expectedHash: string) => Promise<StudioReply | undefined>) | undefined;
  registerFlush?: ((flush?: () => Promise<boolean>) => void) | undefined;
  saveRecovery?: RequirementSaveView | undefined;
  onRetrySave?: ((operationId: string) => Promise<StudioReply | undefined>) | undefined;
}) {
  const [templateId, setTemplateId] = useState(draft.metadata.kind === 'scenario' || draft.metadata.kind === 'requirement' ? draft.metadata.templateId : '')
  const [evidence, setEvidence] = useState(evidenceText(draft.metadata)), [questions, setQuestions] = useState(questionText(draft.metadata))
  const [error, setError] = useState(''), [invalid, setInvalid] = useState(false)
  const [recovery, setRecovery] = useState(saveRecovery)
  useEffect(() => { setRecovery(saveRecovery) }, [saveRecovery])
  const values = useRef({ evidence, questions }); values.current = { evidence, questions }
  const { buffer, snapshot } = useDraftBuffer(draft, async input => {
    fields(values.current.evidence, values.current.questions)
    const result = await onSave(input)
    if (result?.ok && result.state.requirement?.entityId === draft.entityId) setRecovery(result.state.requirement.requirementSave)
    return savedDraft(result, draft.entityId)
  }, leaveFlush)
  const restoredOperations = useRef(new Set<string>())
  useEffect(() => {
    if (!recovery?.input || restoredOperations.current.has(recovery.operationId)) return
    restoredOperations.current.add(recovery.operationId)
    const current = buffer.getSnapshot()
    if (!current.dirty && !current.saving) buffer.restoreInput(recovery.input)
  }, [buffer, recovery])
  const refreshFields = (value: MaterialDraft) => { setEvidence(evidenceText(value.metadata)); setQuestions(questionText(value.metadata)); setTemplateId(value.metadata.kind === 'scenario' || value.metadata.kind === 'requirement' ? value.metadata.templateId : ''); setInvalid(false); setError('') }
  useEffect(() => { if (!invalid) refreshFields({ ...draft, metadata: snapshot.metadata }) }, [snapshot.sha256])
  const editFields = (next: { evidence: string; questions: string }) => {
    values.current = next; setEvidence(next.evidence); setQuestions(next.questions)
    try { const parsed = fields(next.evidence, next.questions); const current = buffer.getSnapshot(); buffer.edit({ body: current.body, metadata: { ...current.metadata, ...parsed } }); setInvalid(false); setError('') }
    catch (reason) { setInvalid(true); setError(reason instanceof Error ? reason.message : '业务字段格式无效') }
  }
  const flush = useCallback(async (): Promise<boolean> => {
    try { fields(values.current.evidence, values.current.questions) }
    catch (reason) { setError(reason instanceof Error ? reason.message : '业务字段格式无效'); return false }
    return buffer.flush()
  }, [buffer])
  useEffect(() => { registerFlush?.(flush); return () => registerFlush?.() }, [registerFlush, flush])
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (invalid) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [invalid])
  const bind = async () => {
    if (!onBindTemplate || !await flush()) return
    try { const value = savedDraft(await onBindTemplate(templateId, buffer.getSnapshot().sha256), draft.entityId); buffer.accept(value); refreshFields(value) }
    catch (reason) { setError(reason instanceof Error ? reason.message : '模板切换失败') }
  }
  const retry = async () => {
    if (!recovery || !onRetrySave || buffer.getSnapshot().dirty && (!recovery.input || !sameDraftInput(buffer.getSnapshot(), recovery.input))) { await flush(); return }
    try {
      await buffer.prepareWrite()
      const input = buffer.getSnapshot()
      const result = await onRetrySave(recovery.operationId)
      if (result?.ok && result.state.requirement?.entityId === draft.entityId) setRecovery(result.state.requirement.requirementSave)
      buffer.acknowledge(savedDraft(result, draft.entityId), input)
    } catch (reason) { setError(reason instanceof Error ? reason.message : '保存仍需恢复，请重试或保留输入。') }
    finally { buffer.finishWrite() }
  }
  const metadata = snapshot.metadata
  return <div className={css.editor}>
    <div className={css.editorHeading}><span className={css.assetIcon}>MD</span><div><strong>当前材料</strong><small>{draft.path}</small></div><span className={css.muted}>{snapshot.saving ? '正在保存' : snapshot.dirty || invalid ? '有未保存输入' : '本地草稿已保存'}</span></div>
    {recovery && <section className={css.panelNotice} aria-label="需求保存恢复"><strong>保存未完成</strong><p role="alert">{recovery.message}</p>{recovery.documentSaved && <p>正文已保存，剩余更新仍待完成。</p>}<button disabled={busy} onClick={() => void retry()}>核对并重试保存</button></section>}
    <ExternalFileNotice buffer={buffer} snapshot={snapshot} readOnly={false} />
    <label>标题<input value={metadata.title} onChange={e => buffer.edit({ body: snapshot.body, metadata: { ...metadata, title: e.target.value } })} /></label>
    {metadata.kind === 'scenario' && templates && onBindTemplate && <fieldset><legend>场景模板绑定</legend><select aria-label="场景模板" value={templateId} onChange={e => setTemplateId(e.target.value)}>{templates.templates.map(template => <option key={template.id} value={template.id}>{template.name}{template.id === templates.defaultTemplateId ? '（项目默认）' : ''}</option>)}</select><small>当前固定模板：{metadata.templateId} · {metadata.templateRef.path}</small><button type="button" disabled={busy || !templateId || templateId === metadata.templateId} onClick={() => void bind()}>切换模板绑定</button></fieldset>}
    {metadata.kind === 'requirement' && <p className={css.muted}>固定需求模板：{templates?.templates.find(template => template.id === metadata.templateId)?.name ?? metadata.templateId} · 编辑期间保持绑定</p>}
    <label className={css.bodyLabel}>业务材料<textarea className={css.materialBody} value={snapshot.body} onChange={e => buffer.edit({ body: e.target.value, metadata })} spellCheck={false} aria-label="材料 Markdown 正文" /></label>
    <details><summary>业务依据、关系与待澄清项</summary>
      <label>正式依据（JSON，须标明 `.eadp/evidence/` 归档文件、SHA-256 和行范围）<textarea rows={8} value={evidence} onChange={e => editFields({ evidence: e.target.value, questions })} placeholder='[{"label":"业务访谈","reference":"采购流程访谈记录","files":[{"path":".eadp/evidence/interview.md","sha256":"…"}],"ranges":[{"path":".eadp/evidence/interview.md","startLine":1,"endLine":8}] }' /></label>
      {metadata.kind === 'requirement' && <>{entities.filter(entity => entity.builtinKey && metadata.scenarioIds.includes(entity.id)).map(source => <p key={source.id} className={css.sourceChip}>{source.title} · 系统内置<button type="button" disabled={busy} onClick={() => buffer.edit({ body: snapshot.body, metadata: { ...metadata, ...removeScenarioSource(metadata, source.id) } })}>移除通用场景关联</button></p>)}<label>关联场景（固定已确认版本）<select multiple required={!metadata.scenarioIds.some(id => entities.some(entity => entity.id === id && entity.builtinKey))} value={metadata.scenarioIds.filter(id => ordinaryScenarioSources(entities).some(source => source.id === id))} onChange={e => { const scenarioIds = [...e.target.selectedOptions].map(o => o.value); buffer.edit({ body: snapshot.body, metadata: { ...metadata, ...updateScenarioSources(metadata, scenarioIds, entities, projectId) } }) }}>{ordinaryScenarioSources(entities).map(e => <option key={e.id} value={e.id}>{e.code ?? e.id} · {e.title} · v{metadata.sources.find(source => source.entityId === e.id)?.version ?? e.materialVersion}</option>)}</select></label><fieldset><legend>前置需求（固定已确认版本）</legend>{entities.filter(e => e.kind === 'requirement' && e.id !== draft.entityId && e.current).map(entity => <label className={css.checkbox} key={entity.id}><input type="checkbox" checked={metadata.prerequisites.some(p => p.requirementId === entity.id)} onChange={e => buffer.edit({ body: snapshot.body, metadata: { ...metadata, prerequisites: e.target.checked ? [...metadata.prerequisites, { requirementId: entity.id, version: entity.materialVersion }] : metadata.prerequisites.filter(p => p.requirementId !== entity.id) } })} />{entity.title} · v{metadata.prerequisites.find(value => value.requirementId === entity.id)?.version ?? entity.materialVersion}</label>)}</fieldset></>}
      <label>待澄清项（每行：阻断/限制 | 问题或限制 | 不适用范围）<textarea rows={3} value={questions} onChange={e => editFields({ evidence, questions: e.target.value })} /></label>
      {metadata.kind === 'scenario' ? <label className={css.checkbox}><input type="checkbox" checked={metadata.flowComplete} onChange={e => buffer.edit({ body: snapshot.body, metadata: { ...metadata, flowComplete: e.target.checked } })} />业务流程完整（具体规则留到需求确认）</label> : <>
        <label className={css.checkbox}><input type="checkbox" checked={metadata.coreRulesPresent} onChange={e => buffer.edit({ body: snapshot.body, metadata: { ...metadata, coreRulesPresent: e.target.checked } })} />核心业务规则已由业务依据明确</label>
        <label className={css.checkbox}><input type="checkbox" checked={metadata.acceptanceCriteriaPresent} onChange={e => buffer.edit({ body: snapshot.body, metadata: { ...metadata, acceptanceCriteriaPresent: e.target.checked } })} />验收条件可以客观判断</label>
      </>}
    </details><button className={css.primary} disabled={busy} onClick={() => void flush()}>保存当前材料</button><small className={css.muted}>保存后再确认。{metadata.kind === 'scenario' ? '仅使业务流程无法确定的问题阻断场景确认，资料与引用只作提醒。' : '未解决的核心问题会阻止确认。'}{(error || snapshot.error) && <span role="alert">{error || snapshot.error}</span>}</small>
  </div>
}
