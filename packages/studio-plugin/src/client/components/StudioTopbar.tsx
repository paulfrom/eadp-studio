import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Stage, StudioState } from '../../shared/studio.ts'
import type { ThemeFace } from '../theme.ts'
import css from '../studio.module.css'

/**
 * Windows: the studio identity and sidebar toggle join the official caption
 * (menus and window controls stay native); web keeps one in-flow toolbar.
 */
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
  // The desktop preload fixes the caption mode before the first paint.
  const [captioned] = useState(() => typeof document !== 'undefined' && document.documentElement.hasAttribute('data-windows-titlebar'))
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
  const identity = <>
    <button type="button" className={css.captionToggle} aria-label={sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'} aria-expanded={!sidebarCollapsed} onClick={onToggleSidebar}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true" width={15} height={15}><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="9" x2="9" y1="3" y2="21" /></svg>
    </button>
    <span className={css.captionText}>
      <span className={css.captionBrand}>EADP Studio</span>
      <span className={css.captionSep}>/</span>
      <span className={css.captionProject} title={state.project?.name}>{state.project?.name ?? '项目工作台'}</span>
      <span className={css.captionBranch}><span className={state.connected ? css.captionConnected : css.captionDisconnected} />{state.project?.stableBranch ?? '工作空间'}{state.connected ? '（已同步）' : ''}</span>
    </span>
  </>
  return <>
    {captioned && <div className={css.captionIdentity}>{identity}</div>}
    <header className={css.topbar} aria-label="项目工作台工具栏">
      {!captioned && <div className={css.topbarIdentity}>{identity}</div>}
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
            {!captioned && <><div className={css.viewMenuSep} />
              <button role="menuitem" className={css.viewMenuItem} onClick={pick(onToggleSidebar)}><span className={css.check}>{sidebarCollapsed ? '✓' : ''}</span><span className={css.label}>折叠侧栏</span></button></>}
          </div>}
        </div>
        <button type="button" onClick={onRefresh} disabled={busy}>刷新</button>
      </div>
    </header>
  </>
}
