import { useRef } from 'react'
import type { MaterialMetadata } from '../../shared/studio.ts'
import type { ScenarioWorkspace } from '../../shared/scenarios.ts'
import type { DraftBuffer, DraftSnapshot } from '../scenarios/DraftBuffer.ts'
import css from './material-confirmation.module.css'

export interface MaterialConfirmationChecksProps {
  workspace: ScenarioWorkspace; disabled: boolean; dirty: boolean;
  buffer: DraftBuffer; snapshot: DraftSnapshot;
  onStructureCheck(enabled: boolean): void;
}

const gateStates = { passed: '通过', blocked: '阻断', disabled: '关闭' }

/** Displays current material checks and edits the author's business declarations. */
export function MaterialConfirmationChecks({ workspace, disabled, dirty, buffer, snapshot, onStructureCheck }: MaterialConfirmationChecksProps) {
  const questions = useRef<HTMLDetailsElement>(null)
  const metadata = snapshot.metadata
  const editable = !workspace.readOnly && !disabled
  const blocked = workspace.gates.filter(gate => gate.status === 'blocked')
  const edit = (change: Partial<MaterialMetadata>) => buffer.edit({ body: snapshot.body, metadata: { ...metadata, ...change } as MaterialMetadata })
  const revealQuestions = () => {
    if (!questions.current) return
    questions.current.open = true
    questions.current.querySelector<HTMLInputElement>('input:not([disabled])')?.focus()
  }
  return <div className={css.checks}>
    <div className={css.heading}><strong>确认检查</strong><span>{blocked.length ? `${blocked.length} 项门禁阻断` : '当前门禁已通过'}</span></div>
    {dirty && <p role="status" className={css.pending}>内容有变化，确认时将保存当前输入并重新执行检查。</p>}
    <div className={css.gateList}>
      {workspace.gates.map(gate => <section key={gate.id} className={css.gateRow} data-state={gate.status} aria-label={`${gate.label} · ${gateStates[gate.status]}`}>
        <span className={css.gateIcon} aria-hidden="true">{gate.status === 'passed' ? '✓' : gate.status === 'blocked' ? '!' : '—'}</span>
        <div className={css.gateMain}>
          <div className={css.gateTitle}><strong>{gate.label}</strong><span> · {gateStates[gate.status]}</span></div>
          {gate.messages.length ? gate.messages.map((message, index) => <p key={index}>{message}</p>) : <p>{gate.status === 'disabled' ? '仅影响本机检查，不影响后台接受。' : '当前检查通过。'}</p>}
        </div>
        {gate.id === 'business' && metadata.openQuestions.length > 0 && <button type="button" onClick={revealQuestions}>查看待澄清</button>}
        {gate.id === 'template' && <label className={css.structureToggle}><input type="checkbox" disabled={!editable || dirty} checked={workspace.structureCheck} onChange={event => onStructureCheck(event.target.checked)} />结构检查</label>}
      </section>)}
    </div>
    <div className={css.declarations}>
      <label><input type="checkbox" disabled={!editable} checked={metadata.coreRulesPresent} onChange={event => edit({ coreRulesPresent: event.target.checked })} />核心业务规则已由依据明确</label>
      <label><input type="checkbox" disabled={!editable} checked={metadata.acceptanceCriteriaPresent} onChange={event => edit({ acceptanceCriteriaPresent: event.target.checked })} />验收条件可以客观判断</label>
    </div>
    <details ref={questions} className={css.questions}>
      <summary>待澄清项 <span>{metadata.openQuestions.length} 条 · {metadata.openQuestions.filter(question => question.blocking).length} 条阻断确认</span></summary>
      {metadata.openQuestions.length === 0 && <p>没有待澄清项。</p>}
      {metadata.openQuestions.map((question, index) => <fieldset key={index}>
        <legend>待澄清项 {index + 1}</legend>
        <label className={css.questionBlocking}><input type="checkbox" disabled={!editable} checked={question.blocking} onChange={event => edit({ openQuestions: metadata.openQuestions.map((item, i) => i === index ? { ...item, blocking: event.target.checked } : item) })} />阻断确认</label>
        <label>问题或限制<input aria-label={`待澄清项 ${index + 1} 问题或限制`} readOnly={!editable} value={question.limitation} onChange={event => edit({ openQuestions: metadata.openQuestions.map((item, i) => i === index ? { ...item, limitation: event.target.value } : item) })} /></label>
        <label>不适用范围<input aria-label={`待澄清项 ${index + 1} 不适用范围`} readOnly={!editable} value={question.excludedScope} onChange={event => edit({ openQuestions: metadata.openQuestions.map((item, i) => i === index ? { ...item, excludedScope: event.target.value } : item) })} /></label>
        {editable && <button type="button" onClick={() => edit({ openQuestions: metadata.openQuestions.filter((_, i) => i !== index) })}>删除此项</button>}
      </fieldset>)}
      {editable && <button type="button" onClick={() => edit({ openQuestions: [...metadata.openQuestions, { blocking: true, limitation: '', excludedScope: '' }] })}>添加待澄清项</button>}
    </details>
    <p className={css.confirmNote}>确认后材料只读。确认表示当前版本的核心规则、验收条件、正式依据与待澄清项已完整；需要修改时请开始修订。</p>
  </div>
}
