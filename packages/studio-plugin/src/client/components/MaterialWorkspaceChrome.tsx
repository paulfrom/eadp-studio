import { useEffect, useId, useRef, type ReactNode } from 'react'
import type { EntityView, TaskView } from '../../shared/studio.ts'
import type { ScenarioWorkspace } from '../../shared/scenarios.ts'
import type { DraftSnapshot } from '../scenarios/DraftBuffer.ts'
import css from '../studio.module.css'
import layout from './materialWorkspace.module.css'

/** Keeps keyboard navigation on the document controls when either pane is folded. */
export function useMaterialDocumentFocus(collapsed: boolean) {
  const panes = useRef<HTMLDivElement>(null)
  const restore = useRef<HTMLButtonElement>(null)
  const previous = useRef(collapsed)
  useEffect(() => {
    if (previous.current === collapsed) return
    previous.current = collapsed
    if (collapsed) restore.current?.focus()
    else panes.current?.querySelector<HTMLButtonElement>('[aria-label="收起文档预览"]')?.focus()
  }, [collapsed])
  return { panes, restore }
}

/** Session controls and the next material action share one compact toolbar. */
export function MaterialWorkspaceHeader({ entity, sessions, activeSessionId, locked, readOnly, reviewCount, onReview, onConfirm, onRefresh, onNewSession, onSelectSession, onTemplates }: {
  entity: EntityView; sessions: TaskView[]; activeSessionId?: string | undefined;
  locked: boolean; readOnly: boolean; reviewCount: number;
  onReview(): void; onConfirm(): void; onRefresh(): void; onNewSession(): void;
  onSelectSession(sessionId: string): void; onTemplates(): void;
}) {
  return <header className={`${css.panelBar} ${layout.toolbar}`}>
    <div className={css.panelIdentity}><span className={css.codeChip}>{entity.code ?? entity.id}</span><strong title={entity.title}>{entity.title}</strong></div>
    <div className={layout.toolbarActions}>
      <select className={layout.session} aria-label="历史会话" disabled={locked} value={activeSessionId ?? ''} onChange={event => onSelectSession(event.target.value)}>
        <option value="" disabled>选择会话</option>
        {sessions.map((session, index) => <option key={session.sessionId} value={session.sessionId}>会话 {index + 1}</option>)}
      </select>
      <details className={layout.tools}>
        <summary aria-label="会话与模板操作" title="会话与模板操作">···</summary>
        <div className={layout.toolMenu} onClick={event => { if ((event.target as HTMLElement).closest('button')) event.currentTarget.parentElement?.removeAttribute('open') }}>
          <button disabled={locked} onClick={onNewSession}>新会话</button>
          <button disabled={locked} onClick={onRefresh}>重新读取草稿</button>
          <button onClick={onTemplates}>{entity.kind === 'scenario' ? '场景' : '需求'}模板</button>
        </div>
      </details>
      {!readOnly && <button className={css.primary} disabled={locked} onClick={reviewCount > 0 ? onReview : onConfirm}>{reviewCount > 0 ? `审阅 ${reviewCount} 处变更` : `确认${entity.kind === 'scenario' ? '场景' : '需求'}`}<span aria-hidden="true"> ›</span></button>}
    </div>
  </header>
}

/** Native dialogs keep keyboard focus inside a review surface and restore it on close. */
export function MaterialWorkspaceSheet({ open, title, subtitle, drawer = false, size, onClose, children }: {
  open: boolean; title: string; subtitle?: string; drawer?: boolean; size?: 'wide';
  onClose(): void; children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    const element = dialog.current
    if (open && !element?.open) element?.showModal()
    if (!open && element?.open) element.close()
  }, [open])
  return <dialog ref={dialog} className={`${layout.sheet} ${drawer ? layout.drawer : ''} ${size === 'wide' ? layout.wide : ''}`} aria-labelledby={titleId} onClose={onClose} onCancel={event => { event.preventDefault(); onClose() }} onClick={event => { if (event.target === event.currentTarget) onClose() }}>
    <header className={layout.sheetHeading}><div><strong id={titleId}>{title}</strong>{subtitle && <p>{subtitle}</p>}</div><button onClick={onClose} aria-label={`关闭${title}`} title="关闭">×</button></header>
    <div className={layout.sheetBody}>{children}</div>
  </dialog>
}

/** A single material status bar exposes detailed checks without occupying either pane. */
export function MaterialWorkspaceStatus({ entity, workspace, snapshot, task, consistency, onConfirmation, onConsistency }: {
  entity: EntityView; workspace: ScenarioWorkspace; snapshot: DraftSnapshot; task?: TaskView | undefined;
  consistency: string; onConfirmation(): void; onConsistency(): void;
}) {
  const blocked = workspace.gates.filter(gate => gate.status === 'blocked').length
  const questions = snapshot.metadata.openQuestions
  const blockingQuestions = questions.filter(question => question.blocking).length
  return <footer className={layout.status} aria-label="材料状态">
    <div className={layout.statusItems}>
      <button data-state={snapshot.dirty ? 'pending' : blocked ? 'blocked' : 'passed'} onClick={onConfirmation}>门禁 <b>{snapshot.dirty ? '待检查' : blocked ? `${blocked} 项阻断` : '通过'}</b></button>
      <button onClick={onConfirmation}>待澄清 <b>{questions.length} 项{blockingQuestions > 0 ? ` · ${blockingQuestions} 项阻断` : ''}</b></button>
      <button onClick={onConsistency}>一致性 <b>{consistency}</b></button>
    </div>
    <details className={layout.runDetails}>
      <summary>运行详情</summary>
      <dl>
        <div><dt>编辑人</dt><dd>{entity.occupation ? `#${entity.occupation.ownerId}` : '无设计占用'}</dd></div>
        <div><dt>本地文件</dt><dd>{snapshot.conflict ? '存在冲突' : snapshot.saving ? '正在保存' : snapshot.error ? '保存失败' : snapshot.dirty ? '未保存' : '已保存'}</dd></div>
        <div><dt>当前会话</dt><dd>{task ? task.sessionId.slice(0, 12) : '尚未创建'}</dd></div>
        {workspace.repair && <div><dt>修复轮次</dt><dd>{workspace.repair.roundsUsed} / 3 · {workspace.repair.status}</dd></div>}
        {workspace.git && <div><dt>Git</dt><dd>{workspace.git.branch} · {workspace.git.head.slice(0, 8)}</dd></div>}
        {workspace.settlement && <div><dt>收整状态</dt><dd>{({ draft: '草稿', 'sync-pending': '待同步', 'cleanup-pending': '待清理', settled: '已完成' } as const)[workspace.settlement.status]}</dd></div>}
        {task?.error && <div><dt>运行提示</dt><dd>{task.error}</dd></div>}
      </dl>
    </details>
  </footer>
}
