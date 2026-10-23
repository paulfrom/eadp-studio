import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { EntityView, MaterialMetadata } from '../../shared/studio.ts'
import type { DraftBuffer, DraftSnapshot } from '../scenarios/DraftBuffer.ts'
import css from '../studio.module.css'

const evidenceText = (metadata: MaterialMetadata): string => JSON.stringify(metadata.businessEvidence, null, 2)
const questionText = (metadata: MaterialMetadata): string => metadata.openQuestions.map(question => `${question.blocking ? '阻断' : '限制'} | ${question.limitation} | ${question.excludedScope}`).join('\n')
const fieldsJson = (metadata: MaterialMetadata): string => JSON.stringify([metadata.businessEvidence, metadata.openQuestions])
/** Parses the two text fields into saved metadata; throws before anything reaches the draft buffer. */
function parseFields(evidence: string, questions: string): Pick<MaterialMetadata, 'businessEvidence' | 'openQuestions'> {
  const businessEvidence: MaterialMetadata['businessEvidence'] = evidence.trim() ? JSON.parse(evidence) : []
  if (!Array.isArray(businessEvidence)) throw new Error('正式依据必须是 JSON 数组')
  const openQuestions = questions.split('\n').filter(line => line.trim()).map(line => {
    const [kind, limitation, ...scope] = line.split('|'), excludedScope = scope.join('|').trim()
    if (!limitation?.trim() || !excludedScope) throw new Error('待澄清项须填写问题或限制及不适用范围')
    return { blocking: kind?.trim() === '阻断', limitation: limitation.trim(), excludedScope }
  })
  return { businessEvidence, openQuestions }
}

export interface RequirementMetadataFormHandle {
  /** Parses the pending text input; a false result must block saving and confirmation. */
  validate(): boolean
}

/**
 * Requirement business fields driven by the parent's draft buffer: formal
 * evidence JSON, fixed scenario relations, prerequisites, open questions and
 * the two completeness flags. Unparseable text stays local and is never
 * written into the buffer, so saving and confirmation stay blocked until it
 * parses again.
 */
export const RequirementMetadataForm = forwardRef<RequirementMetadataFormHandle, {
  buffer: DraftBuffer; snapshot: DraftSnapshot; entities: EntityView[]; projectId: string; readOnly: boolean;
  hidden?: boolean; onValidityChange?(message: string): void;
}>(function RequirementMetadataForm({ buffer, snapshot, entities, projectId, readOnly, hidden, onValidityChange }, ref) {
  const metadata = snapshot.metadata
  const [evidence, setEvidence] = useState(() => evidenceText(snapshot.metadata))
  const [questions, setQuestions] = useState(() => questionText(snapshot.metadata))
  const [invalid, setInvalid] = useState(false)
  const [error, setError] = useState('')
  const values = useRef({ evidence, questions }); values.current = { evidence, questions }
  const synced = useRef(fieldsJson(snapshot.metadata))
  const validity = useRef(onValidityChange); validity.current = onValidityChange
  // External edits (gates checklist, conflict resolution, projection refresh)
  // replace the text only while the user's input still parses.
  useEffect(() => {
    const current = fieldsJson(snapshot.metadata)
    if (current === synced.current || invalid) return
    synced.current = current
    setEvidence(evidenceText(snapshot.metadata)); setQuestions(questionText(snapshot.metadata))
  }, [snapshot.metadata, invalid])
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (invalid) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [invalid])
  const fail = (reason: unknown) => {
    const message = reason instanceof Error ? reason.message : '业务字段格式无效'
    setInvalid(true); setError(message); validity.current?.(message)
  }
  const editFields = (next: { evidence: string; questions: string }) => {
    values.current = next; setEvidence(next.evidence); setQuestions(next.questions)
    try {
      const parsed = parseFields(next.evidence, next.questions)
      const current = buffer.getSnapshot()
      const merged = { ...current.metadata, ...parsed } as MaterialMetadata
      synced.current = fieldsJson(merged)
      buffer.edit({ body: current.body, metadata: merged })
      setInvalid(false); setError(''); validity.current?.('')
    } catch (reason) { fail(reason) }
  }
  useImperativeHandle(ref, () => ({ validate: () => {
    try { parseFields(values.current.evidence, values.current.questions); return true }
    catch (reason) { fail(reason); return false }
  } }), [])
  const edit = (change: Partial<MaterialMetadata>) => {
    const current = buffer.getSnapshot()
    buffer.edit({ body: current.body, metadata: { ...current.metadata, ...change } as MaterialMetadata })
  }
  const scenarios = entities.filter(entity => entity.kind === 'scenario' && entity.materialVersion > 0)
  const prerequisites = entities.filter(entity => entity.kind === 'requirement' && entity.id !== metadata.entityId && entity.current)
  return <section className={css.specSection} hidden={hidden} aria-label="需求业务字段">
    <header className={css.sectionHead}><h3>业务依据、关系与待澄清项</h3></header>
    <label>正式依据（JSON，须标明 `.eadp/evidence/` 归档文件、SHA-256 和行范围）<textarea rows={8} readOnly={readOnly} value={evidence} onChange={event => editFields({ evidence: event.target.value, questions })} placeholder='[{"label":"业务访谈","reference":"采购流程访谈记录","files":[{"path":".eadp/evidence/interview.md","sha256":"…"}],"ranges":[{"path":".eadp/evidence/interview.md","startLine":1,"endLine":8}] }' /></label>
    <label>关联场景（固定已确认版本）<select multiple disabled={readOnly} value={metadata.scenarioIds} onChange={event => {
      const scenarioIds = [...event.target.selectedOptions].map(option => option.value)
      edit({ scenarioIds, sources: scenarioIds.map(entityId => metadata.sources.find(source => source.entityId === entityId) ?? { projectId, entityId, version: entities.find(entity => entity.id === entityId)!.materialVersion }) })
    }}>{scenarios.map(scenario => <option key={scenario.id} value={scenario.id}>{scenario.code ?? scenario.id} · {scenario.title} · v{metadata.sources.find(source => source.entityId === scenario.id)?.version ?? scenario.materialVersion}{scenario.builtinKey === 'general' ? ' · 系统内置' : ''}</option>)}</select></label>
    <fieldset><legend>前置需求（固定已确认版本）</legend>{prerequisites.map(prerequisite => <label className={css.checkbox} key={prerequisite.id}><input type="checkbox" disabled={readOnly} checked={metadata.prerequisites.some(value => value.requirementId === prerequisite.id)} onChange={event => edit({ prerequisites: event.target.checked ? [...metadata.prerequisites, { requirementId: prerequisite.id, version: prerequisite.materialVersion }] : metadata.prerequisites.filter(value => value.requirementId !== prerequisite.id) })} />{prerequisite.title} · v{metadata.prerequisites.find(value => value.requirementId === prerequisite.id)?.version ?? prerequisite.materialVersion}</label>)}</fieldset>
    <label>待澄清项（每行：阻断/限制 | 问题或限制 | 不适用范围）<textarea rows={3} readOnly={readOnly} value={questions} onChange={event => editFields({ evidence, questions: event.target.value })} /></label>
    <label className={css.checkbox}><input type="checkbox" disabled={readOnly} checked={metadata.coreRulesPresent} onChange={event => edit({ coreRulesPresent: event.target.checked })} />核心业务规则已由业务依据明确</label>
    <label className={css.checkbox}><input type="checkbox" disabled={readOnly} checked={metadata.acceptanceCriteriaPresent} onChange={event => edit({ acceptanceCriteriaPresent: event.target.checked })} />验收条件可以客观判断</label>
    {error && <p role="alert" className={css.reviewError}>{error}</p>}
  </section>
})
