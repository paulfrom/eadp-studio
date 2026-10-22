import { memo, useState } from 'react'
import type { MaterialMetadata } from '../../shared/studio.ts'
import type { ScenarioWorkspace } from '../../shared/scenarios.ts'
import type { DraftBuffer, DraftSnapshot } from './DraftBuffer.ts'
import css from '../studio.module.css'

const gateStates = { passed: '通过', blocked: '阻断', disabled: '关闭' }
/**
 * Gate footer of the spec panel: one status chip per check, the reasons behind
 * a blocked confirmation, and the confirmation and repair actions.
 */
export const ScenarioGates = memo(function ScenarioGates({ workspace, disabled, dirty, buffer, snapshot, onConfirm, onRepair, onResume, onCancel, onStructureCheck }: {
  workspace: ScenarioWorkspace; disabled: boolean; dirty: boolean;
  buffer: DraftBuffer; snapshot: DraftSnapshot;
  onConfirm(): void; onRepair(): void; onResume(answer: string): void; onCancel(): void; onStructureCheck(enabled: boolean): void;
}) {
  const [answer, setAnswer] = useState('')
  const repair = workspace.repair
  const conflict = !!workspace.conflict
  const paused = repair?.status === 'active' || repair?.status === 'paused'
  const blocked = workspace.gates.filter(gate => gate.status === 'blocked')
  const metadata = snapshot.metadata
  const edit = (change: Partial<MaterialMetadata>) => buffer.edit({ body: snapshot.body, metadata: { ...metadata, ...change } as MaterialMetadata })
  const editable = !workspace.readOnly && !disabled && !paused
  return <footer className={css.specFooter} aria-label="场景确认门禁">
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
      <label className={css.checkbox}><input type="checkbox" disabled={disabled || workspace.readOnly || dirty || paused} checked={workspace.structureCheck} onChange={event => onStructureCheck(event.target.checked)} />模板结构检查（仅本机偏好）</label>
    </details>
    <div className={css.gateStrip}>
      {workspace.gates.map(gate => <span key={gate.id} className={css.gateChip} data-state={gate.status}><i />{gate.label} · {gateStates[gate.status]}</span>)}
    </div>
    {blocked.length > 0 && <details className={css.gateReasons}>
      <summary>{blocked.length} 项门禁阻断</summary>
      {blocked.map(gate => <article key={gate.id}><strong>{gate.label}</strong>{gate.messages.map((message, index) => <p key={index}>{message}</p>)}</article>)}
    </details>}
    {dirty && <p role="status" className={css.muted}>内容有变化，保存后重新执行当前版本门禁。</p>}
    <div className={css.footerBar}>
      {workspace.git && <details className={css.gitDiagnostics}><summary>Git 诊断</summary><small className={css.gitState}>Working Tree：{workspace.git.dirty ? '包含本地变更' : '干净'} · {workspace.git.branch} · {workspace.git.head.slice(0, 12)}</small></details>}
      {workspace.settlement && <span className={css.settlementState} data-state={workspace.settlement.status}>{({ draft: '草稿', 'sync-pending': '已确认待同步', 'cleanup-pending': '已确认待清理', settled: '本机收整完成' } as const)[workspace.settlement.status]}</span>}
      {!workspace.readOnly && <div className={css.footerActions}>
        <button disabled={disabled || conflict || paused} onClick={onRepair} title="由 AI 修复门禁阻断的问题后再确认">AI 修复并确认</button>
        <button className={css.primary} disabled={disabled || conflict || paused} onClick={onConfirm} title="确认表示当前版本的核心规则、验收条件、正式依据和待澄清项已完整，后台接受后才形成固定版本。">确认当前场景</button>
      </div>}
    </div>
    {workspace.settlement?.status === 'sync-pending' && workspace.settlement.sync?.message && <p role="status" className={css.muted}>{workspace.settlement.sync.message}</p>}
    {workspace.settlement?.status === 'cleanup-pending' && workspace.settlement.cleanup?.message && <p role="status" className={css.muted}>{workspace.settlement.cleanup.message}</p>}
    {repair && <details className={css.repairPanel} open={paused}>
      <summary>修复任务 · {repair.status === 'paused' ? '等待补充' : repair.status === 'active' ? '进行中' : repair.status === 'completed' ? '已完成' : '已终止'} · {repair.roundsUsed} / 3 轮</summary>
      {repair.message && <p>{repair.message}</p>}
      {repair.terminationReason && <p>终止原因：{repair.terminationReason}</p>}
      {repair.question && <p>{repair.question}</p>}
      {repair.status === 'paused' && <form onSubmit={event => { event.preventDefault(); if (answer.trim()) onResume(answer) }}><label>补充业务答案<textarea value={answer} onChange={event => setAnswer(event.target.value)} /></label><button disabled={disabled || conflict || !answer.trim()}>补充并继续修复确认</button><small>普通聊天回复不会恢复本次授权任务；补答不重置轮数。</small></form>}
      {(repair.status === 'active' || repair.status === 'paused') && <button disabled={disabled} onClick={onCancel}>取消本次修复任务</button>}
    </details>}
  </footer>
})
