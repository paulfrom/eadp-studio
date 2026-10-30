import { useState, useSyncExternalStore } from 'react'
import { Menu as HostMenu, type MenuEntry as HostMenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { topbarItems, type MenuEntry, type TopbarContext, type TopbarFaces, type TopbarItem } from '../topbar/items.tsx'
import css from '../studio.module.css'

/**
 * Windows: identity AND actions share the official caption band (menus and
 * window controls stay native; the toolbar row disappears). Web keeps one
 * in-flow toolbar with the same declarative items.
 */
export function StudioTopbar({ faces, sidebarCollapsed, onToggleSidebar }: {
  faces: TopbarFaces
  sidebarCollapsed: boolean
  onToggleSidebar(): void
}) {
  // The desktop preload fixes the caption mode before the first paint.
  const [captioned] = useState(() => typeof document !== 'undefined' && document.documentElement.hasAttribute('data-windows-titlebar'))
  const snapshot = useSyncExternalStore(faces.theme.subscribe, faces.theme.getSnapshot)
  const context: TopbarContext = { captioned, preference: snapshot.preference, toggleSidebar: onToggleSidebar }
  const items = topbarItems(faces, context)
  const identity = <>
    <button type="button" className={css.captionToggle} aria-label={sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'} aria-expanded={!sidebarCollapsed} onClick={onToggleSidebar}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true" width={15} height={15}><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="9" x2="9" y1="3" y2="21" /></svg>
    </button>
    <span className={css.captionText}>
      <span className={css.captionBrand}>EADP Studio</span>
      <span className={css.captionSep}>/</span>
      <span className={css.captionProject} title={faces.state.project?.name}>{faces.state.project?.name ?? '项目工作台'}</span>
      <span className={css.captionBranch}><span className={faces.state.connected ? css.captionConnected : css.captionDisconnected} />{faces.state.project?.stableBranch ?? '工作空间'}{faces.state.connected ? '（已同步）' : ''}</span>
    </span>
  </>
  const actions = <ItemList items={items} />
  return <>
    {captioned && <div className={css.captionIdentity}>
      {identity}
      <div className={css.captionActions}>{actions}</div>
    </div>}
    {!captioned && <header className={css.topbar} aria-label="项目工作台工具栏">
      <div className={css.topbarIdentity}>{identity}</div>
      <div className={css.topbarActions}>{actions}</div>
    </header>}
  </>
}

function ItemList({ items }: { items: ReadonlyArray<TopbarItem> }) {
  return <>{items.filter(item => item.visible !== false).map(item => <TopbarEntry key={item.id} item={item} />)}</>
}

function TopbarEntry({ item }: { item: TopbarItem }) {
  if (item.href !== undefined) return <a href={item.href} target="_blank" rel="noreferrer" title={item.title}>{item.label}</a>
  if (item.items !== undefined) return <Menu item={item} />
  return <button type="button" className={item.primary ? css.primaryAction : undefined} disabled={item.disabled} title={item.title} onClick={item.run}>{item.label}</button>
}

/** Toolbar actions use the host menu for keyboard navigation and viewport placement. */
function Menu({ item }: { item: TopbarItem }) {
  const [open, setOpen] = useState(false)
  const entries: HostMenuEntry[] = (item.items ?? []).filter(entry => 'kind' in entry || entry.visible !== false).map(entry => {
    if ('kind' in entry) return entry.kind === 'sep' ? { type: 'separator', id: entry.id } : { type: 'label', id: entry.id, text: entry.label }
    return { id: entry.id, label: entry.label, ...(entry.disabled === undefined ? {} : { disabled: entry.disabled }) }
  })
  return <HostMenu open={open} onClose={() => setOpen(false)} portal autoFocus dense align="end"
    anchor={<button type="button" aria-label={item.label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)}>{item.label}</button>}
    items={entries} selectedIds={(item.items ?? []).filter((entry): entry is Exclude<MenuEntry, { kind: string }> => !('kind' in entry) && entry.checked === true).map(entry => entry.id)}
    onSelect={id => {
      setOpen(false)
      const entry = item.items?.find(entry => entry.id === id)
      if (entry && !('kind' in entry)) entry.run?.()
    }} />
}
