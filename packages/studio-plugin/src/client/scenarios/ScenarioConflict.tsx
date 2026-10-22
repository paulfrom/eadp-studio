import { useMemo } from 'react'
import { DiffBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MaterialDraft, MaterialMetadata } from '../../shared/studio.ts'
import type { DraftSnapshot } from './DraftBuffer.ts'
import { diffLabels } from './document.ts'
import css from '../studio.module.css'

/**
 * Shows both copies of a material file that changed underneath the draft, and
 * lets the author resolve it with either copy; confirmation stays paused.
 */
export function ScenarioConflict({ draft, snapshot, busy, onResolve }: {
  draft: MaterialDraft; snapshot: DraftSnapshot; busy: boolean;
  onResolve(body: string, metadata: MaterialMetadata, actualHash: string): void;
}) {
  const conflict = snapshot.conflict
  const diffs = useMemo(() => conflict ? [
    { path: draft.path, oldText: conflict.body, newText: snapshot.body },
    ...(JSON.stringify(conflict.metadata) === JSON.stringify(snapshot.metadata) ? [] : [{ path: `${draft.path} · 业务字段`, oldText: JSON.stringify(conflict.metadata, null, 2), newText: JSON.stringify(snapshot.metadata, null, 2) }]),
  ] : [], [conflict, draft.path, snapshot.body, snapshot.metadata])
  if (!conflict) return null
  return <section className={css.conflictPanel} aria-label="外部文件冲突">
    <strong>文件已变化，确认已暂停</strong>
    <p>外部版本与当前输入均已保留。选择一份，或在源码中合并后保存。</p>
    <div className={css.conflictCopies}>
      <label>外部文件<textarea readOnly rows={8} value={conflict.body} /></label>
      <label>未保存输入<textarea readOnly rows={8} value={snapshot.body} /></label>
    </div>
    <DiffBlock diffs={diffs} labels={diffLabels} />
    <div className={css.actionBar}>
      <button disabled={busy} onClick={() => onResolve(conflict.body, conflict.metadata, conflict.sha256)}>采用外部版本</button>
      <button disabled={busy} onClick={() => onResolve(snapshot.body, snapshot.metadata, conflict.sha256)}>保存当前合并结果</button>
    </div>
  </section>
}
