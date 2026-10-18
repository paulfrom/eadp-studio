import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Stage, StudioState } from '../../shared/studio.ts'
import type { ThemeFace } from '../theme.ts'
import css from '../studio.module.css'

/** Windows shares the official caption; web keeps the same toolbar in document flow. */
export function StudioTopbar({ state, busy, onRefresh, stage, stages, onSelectStage, theme, sidebarCollapsed, onToggleSidebar }: {
  state: StudioState
  busy: boolean
  onRefresh(): void
  stage: Stage
  stages: ReadonlyArray<{ id: Stage; name: string }>
  onSelectStage(stage: Stage): void
  theme: ThemeFace
  sidebarCollapsed: boolean
  onToggleSidebar(): void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const snapshot = useSyncExternalStore(theme.subscribe, theme.getSnapshot)
  useEffect(() => {
    if (!menuOpen) return
    const close = (event: MouseEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', escape) }
  }, [menuOpen])
  const pick = (run: () => void) => () => { run(); setMenuOpen(false) }
  const themeItems: Array<{ id: 'system' | 'light' | 'dark'; name: string }> = [
    { id: 'system', name: '主题：跟随系统' }, { id: 'light', name: '主题：浅色' }, { id: 'dark', name: '主题：深色' },
  ]
  const preference = snapshot.preference
  return <header className={css.topbar} aria-label="项目工作台工具栏">
    <div className={css.topbarIdentity}>
      <span className={css.topbarBrand}>EADP Studio</span>
      <span className={css.topbarProject} title={state.project?.name}>{state.project?.name ?? '项目工作台'}</span>
      <span className={css.topbarBranch}><span className={state.connected ? css.topbarConnected : css.topbarDisconnected} />{state.project?.stableBranch ?? '工作空间'}{state.connected ? '（已同步）' : ''}</span>
    </div>
    <div className={css.topbarActions}>
      {state.preview ? <a href={state.preview.url} target="_blank" rel="noreferrer">● 本地原型 ↗</a> : <span className={css.topbarPreview}>原型未运行</span>}
      <div className={css.viewMenuWrap} ref={menuRef}>
        <button type="button" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(open => !open)}>视图</button>
        {menuOpen && <div className={css.viewMenu} role="menu" aria-label="视图">
          <div className={css.viewMenuLabel}>工作区</div>
          {stages.map(item => <button key={item.id} role="menuitem" className={css.viewMenuItem} onClick={pick(() => onSelectStage(item.id))}><span className={css.check}>{stage === item.id ? '✓' : ''}</span><span className={css.label}>{item.name}</span></button>)}
          <div className={css.viewMenuSep} />
          <div className={css.viewMenuLabel}>主题</div>
          {themeItems.map(item => <button key={item.id} role="menuitem" className={css.viewMenuItem} onClick={pick(() => theme.setPreference(item.id))}><span className={css.check}>{preference === item.id ? '✓' : ''}</span><span className={css.label}>{item.name}</span></button>)}
          <div className={css.viewMenuSep} />
          <button role="menuitem" className={css.viewMenuItem} onClick={pick(onToggleSidebar)}><span className={css.check}>{sidebarCollapsed ? '✓' : ''}</span><span className={css.label}>折叠侧栏</span></button>
        </div>}
      </div>
      <button type="button" onClick={onRefresh} disabled={busy}>刷新</button>
    </div>
  </header>
}
