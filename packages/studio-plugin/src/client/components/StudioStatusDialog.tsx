import type { ProjectProgress, StudioState } from '../../shared/studio.ts'
import { MaterialWorkspaceSheet } from './MaterialWorkspaceChrome.tsx'
import { ProjectProgressNotice } from './ProjectProgressNotice.tsx'
import css from '../studio.module.css'

const operationStatus = (phase: string) => {
  if (phase === 'accepted') return { title: '操作已完成', description: '协同服务已接受处理结果。' }
  if (phase === 'delivery-recovery') return { title: '业务操作已接受，后续处理未完成', description: '协同服务已接受结果；本地同步或后续交付仍需恢复。' }
  if (phase === 'rejected') return { title: '操作未成功', description: '协同服务未接受本次操作，请查看原因后处理。' }
  if (phase === 'unknown' || phase === 'recovery') return { title: '处理结果尚未确认', description: '尚未取得最终结果。请查询原操作，避免重复提交。' }
  return { title: '操作处理中', description: '尚未完成，请查询最新进度。' }
}

/** Global operation feedback shares one modal instead of pushing workbench content around. */
export function StudioStatusDialog({ open, error, feedback, pending, operations, progress, busy, canAssist, onClose, onRetryOperation, onRetryProject, onAssist }: {
  open: boolean; error: string; feedback: string;
  pending: StudioState['pending']; operations: StudioState['projectInitializations']; progress: ProjectProgress[];
  busy: boolean; canAssist: boolean; onClose(): void; onRetryOperation(id: string): void;
  onRetryProject(id: string): void; onAssist(prompt: string, entityId?: string): void;
}) {
  return <MaterialWorkspaceSheet open={open} title="操作状态" subtitle="查看结果、继续恢复，或把问题交给 AI" onClose={onClose}>
    <div className={css.statusDialog} role="status" aria-live="polite">
      {feedback && <p>{feedback}</p>}
      {error && <section className={css.statusMessage} data-kind="error" role="alert"><strong>操作遇到问题</strong><p>本次请求未正常结束，请核对下方操作结果。</p><details><summary>诊断详情</summary><p>{error}</p></details>{canAssist && <button disabled={busy} onClick={() => onAssist(`请分析并处理刚才的操作失败：${error}`)}>让 AI 处理</button>}</section>}
      {operations.map(operation => <ProjectProgressNotice key={operation.id} operation={operation} progress={progress.find(item => item.operationId === operation.id)} busy={busy} onRetry={() => onRetryProject(operation.id)} />)}
      {pending.map(item => <section className={css.statusMessage} key={item.id}>
        <strong>{operationStatus(item.phase).title}</strong>
        <p>操作对象：{item.entityId}</p>
        <p>{operationStatus(item.phase).description}</p>
        
        <details><summary>诊断详情</summary><p>操作编号：{item.id}</p><p>处理阶段：{item.phase}</p>{item.message && <p>{item.message}</p>}</details>
        {item.phase !== 'accepted' && <div className={css.statusActions}><button disabled={busy} onClick={() => onRetryOperation(item.id)}>{busy ? '正在处理…' : '查询结果并恢复'}</button><button disabled={busy || !canAssist} onClick={() => onAssist(`请核对并处理这个待恢复操作：${item.message ?? item.phase}。操作编号：${item.id}`, item.entityId)}>让 AI 处理</button></div>}
      </section>)}
      {!error && operations.length === 0 && pending.length === 0 && <p className={css.muted}>当前没有待处理的操作状态。</p>}
    </div>
  </MaterialWorkspaceSheet>
}
