import { memo } from 'react'
import type { MaterialMetadata } from '../../shared/studio.ts'
import type { ScenarioWorkspace } from '../../shared/scenarios.ts'
import type { DraftBuffer, DraftSnapshot } from '../scenarios/DraftBuffer.ts'
import css from '../studio.module.css'

const gateStates = { passed: '通过', blocked: '阻断', disabled: '关闭' }
/**
 * Gate footer of the requirement spec panel: one status chip per check, the
 * reasons behind a blocked confirmation, the open-question editor and the
 * confirmation action. Requirements have no AI repair flow.
 */
export const RequirementGates = memo(function RequirementGates({ workspace, disabled, dirty, buffer, snapshot, onConfirm, onStructureCheck }: {
  workspace: ScenarioWorkspace; disabled: boolean; dirty: boolean;
  buffer: DraftBuffer; snapshot: DraftSnapshot;
  onConfirm(): void; onStructureCheck(enabled: boolean): void;
}) {
  const blocked = workspace.gates.filter(gate => gate.status === 'blocked')
  const metadata = snapshot.metadata
  const edit = (change: Partial<MaterialMetadata>) => buffer.edit({ body: snapshot.body, metadata: { ...metadata, ...change } as MaterialMetadata })
  const editable = !workspace.readOnly && !disabled
  return <footer className={css.specFooter} aria-label="需求确认门禁">
    <details className={css.confirmChecklist}>
      <summary>确认检查 · 业务完整性、待澄清项与模板结构</summary>
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
      <label className={css.checkbox}><input type="checkbox" disabled={disabled || workspace.readOnly || dirty} checked={workspace.structureCheck} onChange={event => onStructureCheck(event.target.checked)} />模板结构检查（仅本机偏好）</label>
    </details>
    <div className={css.gateStrip}>
      {workspace.gates.map(gate => <span key={gate.id} className={css.gateChip} data-state={gate.status}><i />{gate.label} · {gateStates[gate.status]}</span>)}
    </div>
    {blocked.length > 0 && <details className={css.gateReasons}>
      <summary>{blocked.length} 项门禁阻断</summary>
      {blocked.map(gate => <article key={gate.id}><strong>{gate.label}</strong>{gate.messages.map((message, index) => <p key={index}>{message}</p>)}</article>)}
    </details>}
    {dirty && <p role="status" className={css.muted}>内容有变化，确认时将保存当前输入并重新执行检查。</p>}
    {!workspace.readOnly && <div className={css.footerBar}>
      <div className={css.footerActions}>
        <button className={css.primary} disabled={disabled} onClick={onConfirm} title="确认表示当前版本的核心规则、验收条件、正式依据和待澄清项已完整，后台接受后才形成固定版本。">确认当前需求</button>
      </div>
    </div>}
  </footer>
})
