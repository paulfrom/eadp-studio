import { memo, useState } from 'react'
import type { ScenarioWorkspace } from '../../shared/scenarios.ts'
import css from '../studio.module.css'

export const ScenarioGates = memo(function ScenarioGates({ workspace, disabled, dirty, onConfirm, onRepair, onResume, onCancel, onStructureCheck }: {
  workspace: ScenarioWorkspace; disabled: boolean; dirty: boolean;
  onConfirm(): void; onRepair(): void; onResume(answer: string): void; onCancel(): void; onStructureCheck(enabled: boolean): void;
}) {
  const [answer, setAnswer] = useState('')
  const repair = workspace.repair
  const conflict = !!workspace.conflict
  return <section className={css.gatePanel} aria-label="场景确认门禁"><h3>确认当前材料</h3><p>确认表示当前版本的核心规则、验收条件、正式依据和待澄清项已完整。后台接受后才形成固定版本。</p><label className={css.checkbox}><input type="checkbox" disabled={disabled || workspace.readOnly || dirty || repair?.status === 'active' || repair?.status === 'paused'} checked={workspace.structureCheck} onChange={event => onStructureCheck(event.target.checked)} />模板结构检查（仅本机偏好）</label>{dirty && <p role="status">内容有变化，保存后重新执行当前版本门禁。</p>}<div className={css.gateGroups}>{workspace.gates.map(gate => <article key={gate.id} className={gate.status === 'blocked' ? css.blockedGate : undefined}><strong>{gate.label}</strong><span>{gate.status === 'disabled' ? '关闭' : gate.status === 'passed' ? '通过' : '阻断'}</span>{gate.messages.map((message, index) => <p key={index}>{message}</p>)}</article>)}</div>{workspace.git && <small>Working Tree：{workspace.git.dirty ? '包含本地变更' : '干净'} · {workspace.git.branch} · {workspace.git.head.slice(0, 12)}</small>}
    {!workspace.readOnly && <div className={css.actionBar}><button className={css.primary} disabled={disabled || conflict || repair?.status === 'active' || repair?.status === 'paused'} onClick={onConfirm}>确认当前场景</button><button disabled={disabled || conflict || repair?.status === 'active' || repair?.status === 'paused'} onClick={onRepair}>AI 修复并确认</button></div>}
    {repair && <div className={css.repairPanel}><strong>修复任务 · {repair.status === 'paused' ? '等待补充' : repair.status === 'active' ? '进行中' : repair.status === 'completed' ? '已完成' : '已终止'} · {repair.roundsUsed} / 3 轮</strong>{repair.message && <p>{repair.message}</p>}{repair.terminationReason && <p>终止原因：{repair.terminationReason}</p>}{repair.question && <p>{repair.question}</p>}{repair.status === 'paused' && <form onSubmit={event => { event.preventDefault(); if (answer.trim()) onResume(answer) }}><label>补充业务答案<textarea value={answer} onChange={event => setAnswer(event.target.value)} /></label><button disabled={disabled || conflict || !answer.trim()}>补充并继续修复确认</button><small>普通聊天回复不会恢复本次授权任务；补答不重置轮数。</small></form>}{(repair.status === 'active' || repair.status === 'paused') && <button disabled={disabled} onClick={onCancel}>取消本次修复任务</button>}</div>}
  </section>
})
