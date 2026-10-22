import { memo, useState } from 'react'
import type { ScenarioWorkspace } from '../../shared/scenarios.ts'
import css from '../studio.module.css'

const gateStates = { passed: '通过', blocked: '阻断', disabled: '关闭' }
/**
 * Gate footer of the spec panel: one status chip per check, the reasons behind
 * a blocked confirmation, and the confirmation and repair actions.
 */
export const ScenarioGates = memo(function ScenarioGates({ workspace, disabled, dirty, onConfirm, onRepair, onResume, onCancel, onStructureCheck }: {
  workspace: ScenarioWorkspace; disabled: boolean; dirty: boolean;
  onConfirm(): void; onRepair(): void; onResume(answer: string): void; onCancel(): void; onStructureCheck(enabled: boolean): void;
}) {
  const [answer, setAnswer] = useState('')
  const repair = workspace.repair
  const conflict = !!workspace.conflict
  const paused = repair?.status === 'active' || repair?.status === 'paused'
  const blocked = workspace.gates.filter(gate => gate.status === 'blocked')
  return <footer className={css.specFooter} aria-label="场景确认门禁">
    <div className={css.gateStrip}>
      {workspace.gates.map(gate => <span key={gate.id} className={css.gateChip} data-state={gate.status}><i />{gate.label} · {gateStates[gate.status]}</span>)}
    </div>
    {blocked.length > 0 && <details className={css.gateReasons}>
      <summary>{blocked.length} 项门禁阻断</summary>
      {blocked.map(gate => <article key={gate.id}><strong>{gate.label}</strong>{gate.messages.map((message, index) => <p key={index}>{message}</p>)}</article>)}
    </details>}
    {dirty && <p role="status" className={css.muted}>内容有变化，保存后重新执行当前版本门禁。</p>}
    <div className={css.footerBar}>
      <label className={css.checkbox}><input type="checkbox" disabled={disabled || workspace.readOnly || dirty || paused} checked={workspace.structureCheck} onChange={event => onStructureCheck(event.target.checked)} />模板结构检查（仅本机偏好）</label>
      {workspace.git && <small className={css.gitState}>Working Tree：{workspace.git.dirty ? '包含本地变更' : '干净'} · {workspace.git.branch} · {workspace.git.head.slice(0, 12)}</small>}
      {!workspace.readOnly && <div className={css.footerActions}>
        <button disabled={disabled || conflict || paused} onClick={onRepair} title="由 AI 修复门禁阻断的问题后再确认">AI 修复并确认</button>
        <button className={css.primary} disabled={disabled || conflict || paused} onClick={onConfirm} title="确认表示当前版本的核心规则、验收条件、正式依据和待澄清项已完整，后台接受后才形成固定版本。">确认当前场景</button>
      </div>}
    </div>
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
