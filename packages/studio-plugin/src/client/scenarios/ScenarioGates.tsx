import { memo, useState } from 'react'
import { MaterialConfirmationChecks, type MaterialConfirmationChecksProps } from '../components/MaterialConfirmationChecks.tsx'
import css from '../studio.module.css'
import checks from '../components/material-confirmation.module.css'

/** Scenario confirmation includes bounded repair and local settlement diagnostics. */
export const ScenarioGates = memo(function ScenarioGates({ onConfirm, onRepair, onResume, onCancel, ...props }: MaterialConfirmationChecksProps & {
  onConfirm(): void; onRepair(): void; onResume(answer: string): void; onCancel(): void;
}) {
  const [answer, setAnswer] = useState('')
  const { workspace, disabled } = props
  const repair = workspace.repair
  const conflict = !!workspace.conflict || !!props.snapshot.conflict
  const paused = repair?.status === 'active' || repair?.status === 'paused'
  return <footer className={checks.footer} aria-label="场景确认门禁">
    <MaterialConfirmationChecks {...props} disabled={disabled || paused} />
    <div className={checks.diagnostics}>
      {workspace.git && <details><summary>Git 诊断</summary><small>Working Tree：{workspace.git.dirty ? '包含本地变更' : '干净'} · {workspace.git.branch} · {workspace.git.head.slice(0, 12)}</small></details>}
      {workspace.settlement && <span className={checks.settlement} data-state={workspace.settlement.status}>{({ draft: '草稿', 'sync-pending': '已确认待同步', 'cleanup-pending': '已确认待清理', settled: '本机收整完成' } as const)[workspace.settlement.status]}</span>}
    </div>
    {workspace.settlement?.status === 'sync-pending' && workspace.settlement.sync?.message && <p role="status" className={checks.pending}>{workspace.settlement.sync.message}</p>}
    {workspace.settlement?.status === 'cleanup-pending' && workspace.settlement.cleanup?.message && <p role="status" className={checks.pending}>{workspace.settlement.cleanup.message}</p>}
    {repair && <details className={checks.repair} open={paused}>
      <summary>修复任务 · {repair.status === 'paused' ? '等待补充' : repair.status === 'active' ? '进行中' : repair.status === 'completed' ? '已完成' : '已终止'} · {repair.roundsUsed} / 3 轮</summary>
      {repair.message && <p>{repair.message}</p>}
      {repair.terminationReason && <p>终止原因：{repair.terminationReason}</p>}
      {repair.question && <p>{repair.question}</p>}
      {repair.status === 'paused' && <form onSubmit={event => { event.preventDefault(); if (answer.trim()) onResume(answer.trim()) }}><label>补充业务答案<textarea value={answer} onChange={event => setAnswer(event.target.value)} /></label><button disabled={disabled || conflict || !answer.trim()}>补充并继续修复确认</button><small>普通聊天回复不会恢复本次授权任务；补答不重置轮数。</small></form>}
      {(repair.status === 'active' || repair.status === 'paused') && <button type="button" disabled={disabled} onClick={onCancel}>取消本次修复任务</button>}
    </details>}
    {!workspace.readOnly && <div className={checks.actions}>
      <button type="button" disabled={disabled || conflict || paused} onClick={onRepair} title="由 AI 修复门禁阻断的问题后再确认">AI 修复并确认</button>
      <button type="button" className={css.primary} disabled={disabled || conflict || paused} onClick={onConfirm}>确认当前场景</button>
    </div>}
  </footer>
})
