import type { StudioState } from '../../shared/studio.ts'
import css from '../studio.module.css'

/** Windows shares the official caption; web keeps the same toolbar in document flow. */
export function StudioTopbar({ state, busy, onRefresh }: {
  state: StudioState
  busy: boolean
  onRefresh(): void
}) {
  return <header className={css.topbar} aria-label="项目工作台工具栏">
    <div className={css.topbarIdentity}>
      <span className={css.topbarBrand}>EADP Studio</span>
      <span className={css.topbarProject} title={state.project?.name}>{state.project?.name ?? '项目工作台'}</span>
      <span className={css.topbarBranch}>
        <span className={state.connected ? css.topbarConnected : css.topbarDisconnected} />
        {state.project?.stableBranch ?? '工作空间'}{state.connected ? '（已同步）' : ''}
      </span>
    </div>
    <div className={css.topbarActions}>
      {state.preview ? <a href={state.preview.url} target="_blank" rel="noreferrer">● 本地原型 ↗</a> : <span className={css.topbarPreview}>原型未运行</span>}
      <button type="button" onClick={onRefresh} disabled={busy}>刷新</button>
    </div>
  </header>
}
