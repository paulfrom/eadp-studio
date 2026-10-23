import { useCallback, useEffect, useRef, useState } from 'react'
import type { EntityView, MaterialDraft, MaterialMetadata, StudioReply, TemplateCatalogView } from '../../shared/studio.ts'
import type { SaveDraft } from '../scenarios/DraftBuffer.ts'
import { useDraftBuffer } from '../scenarios/useDraftBuffer.ts'
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
  if (workspace?.entityId === entityId && workspace.conflict) throw new Error('文件出现并发修改，请先合并两份内容。')
  const value = workspace?.entityId === entityId ? workspace.draft : reply.state.drafts.find(value => value.entityId === entityId)
  if (!value) throw new Error('保存回执缺少当前材料，当前输入已保留。')
  return value
}

/** Shared material form keeps unsaved input and the last acknowledged hash across projection polling. */
export function MaterialEditor({ draft, entities, projectId, templates, busy, onSave, onBindTemplate, onResolveConflict, registerFlush }: {
  draft: MaterialDraft; entities: EntityView[]; projectId: string; busy: boolean;
  templates?: TemplateCatalogView | undefined;
  onSave(input: MaterialEditorInput): Promise<StudioReply | undefined>
  onBindTemplate(templateId: string, expectedHash: string): Promise<StudioReply | undefined>
  onResolveConflict?: ((input: MaterialEditorInput) => Promise<StudioReply | undefined>) | undefined;
  registerFlush?: ((flush?: () => Promise<boolean>) => void) | undefined;
}) {
  const [templateId, setTemplateId] = useState(draft.metadata.kind === 'scenario' || draft.metadata.kind === 'requirement' ? draft.metadata.templateId : '')
  const [evidence, setEvidence] = useState(evidenceText(draft.metadata)), [questions, setQuestions] = useState(questionText(draft.metadata))
  const [error, setError] = useState(''), [invalid, setInvalid] = useState(false)
  const [invalidConflict, setInvalidConflict] = useState<MaterialDraft>()
  const values = useRef({ evidence, questions }); values.current = { evidence, questions }
  const received = useRef(draft)
  // An invalid JSON field is still unsaved user input; keep its original base until it is corrected.
  if (!invalid) received.current = draft
  const operations = useRef(new Map<string, { fingerprint: string; id: string }>())
  const operationId = (action: string, input: unknown): string => {
    const fingerprint = JSON.stringify(input), prior = operations.current.get(action)
    if (prior?.fingerprint === fingerprint) return prior.id
    const id = crypto.randomUUID(); operations.current.set(action, { fingerprint, id }); return id
  }
  const { buffer, snapshot } = useDraftBuffer(received.current, async input => {
    fields(values.current.evidence, values.current.questions)
    return savedDraft(await onSave(input), draft.entityId)
  }, leaveFlush)
  const refreshFields = (value: MaterialDraft) => { setEvidence(evidenceText(value.metadata)); setQuestions(questionText(value.metadata)); setTemplateId(value.metadata.kind === 'scenario' || value.metadata.kind === 'requirement' ? value.metadata.templateId : ''); setInvalid(false); setError('') }
  useEffect(() => {
    if (invalid && draft.sha256 !== received.current.sha256) setInvalidConflict(draft)
  }, [draft, invalid])
  useEffect(() => { if (!invalid) refreshFields({ ...draft, metadata: snapshot.metadata }) }, [snapshot.sha256])
  const editFields = (next: { evidence: string; questions: string }) => {
    values.current = next; setEvidence(next.evidence); setQuestions(next.questions)
    try { const parsed = fields(next.evidence, next.questions); const current = buffer.getSnapshot(); buffer.edit({ body: current.body, metadata: { ...current.metadata, ...parsed } }); setInvalid(false); setError('') }
    catch (reason) { setInvalid(true); setError(reason instanceof Error ? reason.message : '业务字段格式无效') }
  }
  const flush = useCallback(async (): Promise<boolean> => {
    try { fields(values.current.evidence, values.current.questions) }
    catch (reason) { setError(reason instanceof Error ? reason.message : '业务字段格式无效'); return false }
    if (invalidConflict) return false
    return buffer.flush()
  }, [buffer, invalidConflict])
  useEffect(() => { registerFlush?.(flush); return () => registerFlush?.() }, [registerFlush, flush])
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (invalid) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [invalid])
  const bind = async () => {
    if (!await flush()) return
    try { const value = savedDraft(await onBindTemplate(templateId, buffer.getSnapshot().sha256), draft.entityId); buffer.accept(value); refreshFields(value) }
    catch (reason) { setError(reason instanceof Error ? reason.message : '模板切换失败') }
  }
  const conflict = snapshot.conflict ?? invalidConflict
  const resolve = async (external: boolean) => {
    if (!conflict) return
    try {
      const input = external ? { body: conflict.body, metadata: conflict.metadata } : { body: snapshot.body, metadata: { ...snapshot.metadata, ...fields(values.current.evidence, values.current.questions) } }
      const value = onResolveConflict ? savedDraft(await onResolveConflict({ ...input, expectedHash: conflict.sha256, operationId: operationId('resolve', { ...input, expectedHash: conflict.sha256 }) }), draft.entityId) : external ? conflict : undefined
      if (!value) return
      buffer.accept(value); received.current = value; setInvalidConflict(undefined); refreshFields(value)
    } catch (reason) { setError(reason instanceof Error ? reason.message : '冲突尚未解决') }
  }
  const metadata = snapshot.metadata
  return <div className={css.editor}>
    <div className={css.editorHeading}><span className={css.assetIcon}>MD</span><div><strong>当前材料</strong><small>{draft.path}</small></div><span className={css.muted}>{snapshot.saving ? '正在保存' : snapshot.dirty || invalid ? '有未保存输入' : '本地草稿已保存'}</span></div>
    {conflict && <section className={css.conflictPanel} aria-label="外部文件冲突"><strong>外部版本与当前输入均已保留</strong><div className={css.conflictCopies}><label>外部文件<textarea readOnly rows={8} value={conflict.body} /></label><label>外部业务字段<textarea readOnly rows={5} value={JSON.stringify(conflict.metadata, null, 2)} /></label></div><p>在下方编辑器中合并内容后保存，或明确采用外部版本。</p><button disabled={busy} onClick={() => void resolve(true)}>采用外部版本</button>{onResolveConflict && <button disabled={busy || invalid} onClick={() => void resolve(false)}>保存当前合并结果</button>}</section>}
    <label>标题<input value={metadata.title} onChange={e => buffer.edit({ body: snapshot.body, metadata: { ...metadata, title: e.target.value } })} /></label>
    {(metadata.kind === 'scenario' || metadata.kind === 'requirement') && templates && <fieldset><legend>{metadata.kind === 'scenario' ? '场景' : '需求'}模板绑定</legend><select aria-label={`${metadata.kind === 'scenario' ? '场景' : '需求'}模板`} value={templateId} onChange={e => setTemplateId(e.target.value)}>{templates.templates.map(template => <option key={template.id} value={template.id}>{template.name}{template.id === templates.defaultTemplateId ? '（项目默认）' : ''}</option>)}</select><small>当前固定模板：{metadata.templateId} · {metadata.templateRef.path}</small><button type="button" disabled={busy || !!conflict || !templateId || templateId === metadata.templateId} onClick={() => void bind()}>切换模板绑定</button></fieldset>}
    <label className={css.bodyLabel}>业务材料<textarea className={css.materialBody} value={snapshot.body} onChange={e => buffer.edit({ body: e.target.value, metadata })} spellCheck={false} aria-label="材料 Markdown 正文" /></label>
    <details><summary>业务依据、关系与待澄清项</summary>
      <label>正式依据（JSON，须标明 `.eadp/evidence/` 归档文件、SHA-256 和行范围）<textarea rows={8} value={evidence} onChange={e => editFields({ evidence: e.target.value, questions })} placeholder='[{"label":"业务访谈","reference":"采购流程访谈记录","files":[{"path":".eadp/evidence/interview.md","sha256":"…"}],"ranges":[{"path":".eadp/evidence/interview.md","startLine":1,"endLine":8}] }' /></label>
      {metadata.kind === 'requirement' && <><label>关联场景（固定已确认版本）<select multiple required value={metadata.scenarioIds} onChange={e => { const scenarioIds = [...e.target.selectedOptions].map(o => o.value); buffer.edit({ body: snapshot.body, metadata: { ...metadata, scenarioIds, sources: scenarioIds.map(entityId => metadata.sources.find(source => source.entityId === entityId) ?? { projectId, entityId, version: entities.find(entity => entity.id === entityId)!.materialVersion }) } }) }}>{entities.filter(e => e.kind === 'scenario' && e.materialVersion > 0).map(e => <option key={e.id} value={e.id}>{e.code ?? e.id} · {e.title} · v{metadata.sources.find(source => source.entityId === e.id)?.version ?? e.materialVersion}{e.builtinKey === 'general' ? ' · 系统内置' : ''}</option>)}</select></label><fieldset><legend>前置需求（固定已确认版本）</legend>{entities.filter(e => e.kind === 'requirement' && e.id !== draft.entityId && e.current).map(entity => <label className={css.checkbox} key={entity.id}><input type="checkbox" checked={metadata.prerequisites.some(p => p.requirementId === entity.id)} onChange={e => buffer.edit({ body: snapshot.body, metadata: { ...metadata, prerequisites: e.target.checked ? [...metadata.prerequisites, { requirementId: entity.id, version: entity.materialVersion }] : metadata.prerequisites.filter(p => p.requirementId !== entity.id) } })} />{entity.title} · v{metadata.prerequisites.find(value => value.requirementId === entity.id)?.version ?? entity.materialVersion}</label>)}</fieldset></>}
      <label>待澄清项（每行：阻断/限制 | 问题或限制 | 不适用范围）<textarea rows={3} value={questions} onChange={e => editFields({ evidence, questions: e.target.value })} /></label>
      <label className={css.checkbox}><input type="checkbox" checked={metadata.coreRulesPresent} onChange={e => buffer.edit({ body: snapshot.body, metadata: { ...metadata, coreRulesPresent: e.target.checked } })} />核心业务规则已由业务依据明确</label>
      <label className={css.checkbox}><input type="checkbox" checked={metadata.acceptanceCriteriaPresent} onChange={e => buffer.edit({ body: snapshot.body, metadata: { ...metadata, acceptanceCriteriaPresent: e.target.checked } })} />验收条件可以客观判断</label>
    </details><button className={css.primary} disabled={busy || !!conflict} onClick={() => void flush()}>保存当前材料</button><small className={css.muted}>保存后再确认。未解决的核心问题会阻止确认。{(error || snapshot.error) && <span role="alert">{error || snapshot.error}</span>}</small>
  </div>
}
