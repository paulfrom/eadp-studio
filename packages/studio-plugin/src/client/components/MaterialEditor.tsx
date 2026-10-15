import { useState } from 'react'
import type { EntityView, MaterialDraft, MaterialMetadata } from '../../shared/studio.ts'
import css from '../studio.module.css'

export function MaterialEditor({ draft, categories, entities, busy, onSave }: {
  draft: MaterialDraft; categories: Array<{ id: string; name: string }>; entities: EntityView[]; busy: boolean;
  onSave(body: string, metadata: MaterialMetadata): Promise<unknown>
}) {
  const [body, setBody] = useState(draft.body)
  const [metadata, setMetadata] = useState(draft.metadata)
  const [evidence, setEvidence] = useState(draft.metadata.businessEvidence.map(e => `${e.label} | ${e.reference}`).join('\n'))
  const [questions, setQuestions] = useState(draft.metadata.openQuestions.map(q => `${q.blocking ? '阻断' : '限制'} | ${q.limitation} | ${q.excludedScope}`).join('\n'))
  const save = async () => {
    const next: MaterialMetadata = { ...metadata,
      coreRulesPresent: /^## 核心业务规则\s*\n[^#]+/m.test(body), acceptanceCriteriaPresent: /^## 验收条件\s*\n[^#]+/m.test(body),
      businessEvidence: evidence.split('\n').filter(x => x.trim()).map(line => { const [label, ...rest] = line.split('|'); return { label: label!.trim(), reference: rest.join('|').trim() } }),
      openQuestions: questions.split('\n').filter(x => x.trim()).map(line => { const [kind, limitation, ...scope] = line.split('|'); return { blocking: kind?.trim() === '阻断', limitation: limitation?.trim() ?? '', excludedScope: scope.join('|').trim() } }),
    }
    await onSave(body, next)
  }
  return <div className={css.editor}>
    <div className={css.editorHeading}><span className={css.assetIcon}>MD</span><div><strong>当前材料</strong><small>{draft.path}</small></div><span className={css.muted}>草稿编辑</span></div>
    <label>标题<input value={metadata.title} onChange={e => setMetadata({ ...metadata, title: e.target.value })} /></label>
    <label>业务分类<select value={metadata.categoryId} onChange={e => setMetadata({ ...metadata, categoryId: e.target.value })}>{categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
    <label className={css.bodyLabel}>业务材料<textarea className={css.materialBody} value={body} onChange={e => setBody(e.target.value)} spellCheck={false} aria-label="材料 Markdown 正文" /></label>
    <details><summary>业务依据、关系与待澄清项</summary>
      <label>业务依据（每行：名称 | 引用）<textarea rows={3} value={evidence} onChange={e => setEvidence(e.target.value)} placeholder="业务访谈 | 采购流程访谈记录" /></label>
      {metadata.kind === 'requirement' && <><label>关联场景<select multiple value={metadata.scenarioIds} onChange={e => setMetadata({ ...metadata, scenarioIds: [...e.target.selectedOptions].map(o => o.value) })}>{entities.filter(e => e.kind === 'scenario').map(e => <option key={e.id} value={e.id}>{e.title}</option>)}</select></label><fieldset><legend>前置需求（固定已确认版本）</legend>{entities.filter(e => e.kind === 'requirement' && e.id !== draft.entityId && e.current).map(entity => <label className={css.checkbox} key={entity.id}><input type="checkbox" checked={metadata.prerequisites.some(p => p.requirementId === entity.id)} onChange={e => setMetadata({ ...metadata, prerequisites: e.target.checked ? [...metadata.prerequisites, { requirementId: entity.id, version: entity.materialVersion }] : metadata.prerequisites.filter(p => p.requirementId !== entity.id) })} />{entity.title} · v{entity.materialVersion}</label>)}</fieldset></>}
      <label>待澄清项（每行：阻断/限制 | 问题或限制 | 不适用范围）<textarea rows={3} value={questions} onChange={e => setQuestions(e.target.value)} /></label>
    </details><button className={css.primary} disabled={busy} onClick={() => void save()}>保存当前材料</button><small className={css.muted}>保存后再确认。未解决的核心问题会阻止确认。</small>
  </div>
}
