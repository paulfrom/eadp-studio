import { useEffect, useRef, useState, type ReactNode } from 'react'
import css from '../studio.module.css'

/** Preserve desktop collapse preference while narrow windows start with navigation closed. */
export function useStudioSidebar() {
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 1024px)').matches)
  const [collapsed, setCollapsed] = useState(false)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const media = window.matchMedia('(max-width: 1024px)')
    const change = () => { setNarrow(media.matches); setOpen(false) }
    media.addEventListener('change', change)
    return () => media.removeEventListener('change', change)
  }, [])
  return { narrow, collapsed: narrow ? !open : collapsed, close: () => setOpen(false), toggle: () => narrow ? setOpen(value => !value) : setCollapsed(value => !value) }
}

/** Native modal navigation supplies focus containment, Escape and focus return on small windows. */
export function StudioSidebar({ narrow, collapsed, onClose, children }: {
  narrow: boolean; collapsed: boolean; onClose(): void; children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const element = dialog.current
    if (narrow && !collapsed && element && !element.open) element.showModal()
    else if (element?.open) element.close()
  }, [narrow, collapsed])
  const content = <aside className={`${css.rail} ${!narrow && collapsed ? css.collapsed : ''}`} aria-label="工作台导航">{narrow && <button className={css.closeNavigation} onClick={onClose} aria-label="关闭工作台导航">×</button>}{children}</aside>
  return narrow ? <dialog ref={dialog} className={css.sidebarDialog} aria-label="工作台导航" onCancel={event => { event.preventDefault(); onClose() }} onClick={event => { if (event.target === event.currentTarget) onClose() }}>{content}</dialog> : content
}
