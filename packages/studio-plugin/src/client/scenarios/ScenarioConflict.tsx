import { useMemo } from 'react'
import { DiffBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MaterialDraft, MaterialMetadata } from '../../shared/studio.ts'
import type { DraftSnapshot } from './DraftBuffer.ts'
import { diffLabels } from './document.ts'
import css from '../studio.module.css'

/**
 * Shows both copies of a material file that changed underneath the draft, and
 * lets the author choose either copy or merge before the caller continues.
 */
export function ScenarioConflict({ draft, snapshot, busy, onResolve, continueConfirmation = false, onEdit }: {
  draft: MaterialDraft; snapshot: DraftSnapshot; busy: boolean;
  onResolve(body: string, metadata: MaterialMetadata, actualHash: string, external?: boolean): void;
  continueConfirmation?: boolean; onEdit?(): void;
}) {
  const conflict = snapshot.conflict
  const diffs = useMemo(() => conflict ? [
    { path: draft.path, oldText: conflict.body, newText: snapshot.body },
    ...(JSON.stringify(conflict.metadata) === JSON.stringify(snapshot.metadata) ? [] : [{ path: `${draft.path} · 业务字段`, oldText: JSON.stringify(conflict.metadata, null, 2), newText: JSON.stringify(snapshot.metadata, null, 2) }]),
  ] : [], [conflict, draft.path, snapshot.body, snapshot.metadata])
  if (!conflict) return null
  return <section className={css.conflictPanel} aria-label="外部文件冲突">
    <strong>{continueConfirmation ? '选择恢复方案并继续确认' : '文件已变化，请选择保留的内容'}</strong>
    <p>外部版本与当前输入均已保留。选择一份，或在源码中合并后{continueConfirmation ? '保存并确认。' : '保存。'}</p>
    <div className={css.conflictCopies}>
      <label>外部文件<textarea readOnly rows={8} value={conflict.body} /></label>
      <label>未保存输入<textarea readOnly rows={8} value={snapshot.body} /></label>
    </div>
    <DiffBlock diffs={diffs} labels={diffLabels} />
    <div className={css.actionBar}>
      <button disabled={busy} onClick={() => onResolve(conflict.body, conflict.metadata, conflict.sha256, true)}>{continueConfirmation ? '采用外部版本并确认' : '采用外部版本'}</button>
      <button disabled={busy} onClick={() => onResolve(snapshot.body, snapshot.metadata, conflict.sha256, false)}>{continueConfirmation ? '保存当前内容并确认' : '保存当前合并结果'}</button>
      {onEdit && <button disabled={busy} onClick={onEdit}>编辑并合并内容</button>}
    </div>
  </section>
}
