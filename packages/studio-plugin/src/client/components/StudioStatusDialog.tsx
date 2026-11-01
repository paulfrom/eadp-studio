import type { ProjectProgress, StudioRecovery, StudioState } from '../../shared/studio.ts'
import { MaterialWorkspaceSheet } from './MaterialWorkspaceChrome.tsx'
import { ProjectProgressNotice } from './ProjectProgressNotice.tsx'
import css from '../studio.module.css'

/** Global operation feedback shares one modal instead of pushing workbench content around. */
export function StudioStatusDialog({ open, error, recovery, pending, operations, progress, busy, canAssist, onClose, onRetryOperation, onRetryProject, onAssist }: {
  open: boolean; error: string; recovery?: StudioRecovery | undefined;
  pending: StudioState['pending']; operations: StudioState['projectInitializations']; progress: ProjectProgress[];
  busy: boolean; canAssist: boolean; onClose(): void; onRetryOperation(id: string): void;
  onRetryProject(id: string): void; onAssist(prompt: string, entityId?: string): void;
}) {
  return <MaterialWorkspaceSheet open={open} title="操作状态" subtitle="查看结果、继续恢复，或把问题交给 AI" onClose={onClose}>
    <div className={css.statusDialog} role="status" aria-live="polite">
      {error && <section className={css.statusMessage} data-kind="error" role="alert"><strong>操作未完成</strong><p>{error}</p>{canAssist && <button disabled={busy} onClick={() => onAssist(`请分析并处理刚才的操作失败：${error}`)}>让 AI 处理</button>}</section>}
      {recovery && <section className={css.statusMessage}><strong>本地状态已恢复</strong><p>此前的恢复记录格式无效，原文件已保留，当前版本已重建。请重新打开项目。</p><code>{recovery.preservedPath}</code></section>}
      {operations.map(operation => <ProjectProgressNotice key={operation.id} operation={operation} progress={progress.find(item => item.operationId === operation.id)} busy={busy} onRetry={() => onRetryProject(operation.id)} />)}
      {pending.filter(item => item.phase !== 'accepted').map(item => <section className={css.statusMessage} key={item.id}>
        <strong>操作待核对</strong><p>{item.message ?? item.phase}</p>
        <div className={css.statusActions}><button disabled={busy} onClick={() => onRetryOperation(item.id)}>查询并恢复</button><button disabled={busy} onClick={() => onAssist(`请核对并处理这个待恢复操作：${item.message ?? item.phase}。操作编号：${item.id}`, item.entityId)}>让 AI 处理</button></div>
      </section>)}
      {!error && !recovery && operations.length === 0 && pending.filter(item => item.phase !== 'accepted').length === 0 && <p className={css.muted}>当前没有待处理的操作状态。</p>}
    </div>
  </MaterialWorkspaceSheet>
}
