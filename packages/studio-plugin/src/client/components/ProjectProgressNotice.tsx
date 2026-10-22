import type { ProjectProgress, StudioState } from '../../shared/studio.ts'
import css from '../studio.module.css'

/** What a recorded initialization is doing before the Host reports a finer step. */
const phases: Record<string, string> = { creating: '后台正在创建仓库', initializing: '正在写入项目资产', pushing: '正在推送首次提交', verifying: '正在核对后台接受' }

/**
 * One recorded project operation. The bar follows the background work while it
 * runs; once it stopped, the notice states the reason and offers the retry the
 * record needs. The record, not this view, is the authority on the outcome.
 */
export function ProjectProgressNotice({ operation, progress, busy, onRetry }: { operation: StudioState['projectInitializations'][number]; progress: ProjectProgress | undefined; busy: boolean; onRetry(): void }) {
  const failed = progress?.phase === 'failed'
  const running = progress !== undefined && !failed
  const percent = Math.round(progress?.percent ?? 0)
  const detail = progress?.label ?? operation.message ?? phases[operation.phase] ?? '正在处理'
  // Without a live progress record nothing is being reported, so only a stopped
  // operation the record calls unknown offers the retry.
  const retry = failed || (progress === undefined && operation.phase === 'unknown')
  return <div className={css.notice} role="status">
    <div className={css.progressBody}>
      <div className={css.progressMeta}><strong>项目「{operation.name}」</strong><span>{running ? `${detail} · ${percent}%` : detail}</span></div>
      {running && <div className={css.progressTrack} role="progressbar" aria-label={`项目「${operation.name}」初始化进度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <div className={css.progressFill} style={{ width: `${Math.max(2, percent)}%` }} />
      </div>}
    </div>
    {retry && <button disabled={busy} onClick={onRetry}>继续初始化</button>}
  </div>
}
