import { useEffect, useRef, type ReactNode } from 'react'
import css from './prototype.module.css'

/** Modal details keep diagnostics out of the business workspace and return focus on close. */
export function WorkbenchDrawer({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => element?.close()
  }, [])
  return <dialog ref={dialog} className={css.drawer} aria-label={title} onCancel={event => { event.preventDefault(); onClose() }} onClick={event => { if (event.target === event.currentTarget) onClose() }}>
    <div className={css.drawerInner}><header><h2>{title}</h2><button aria-label="关闭面板" onClick={onClose}>×</button></header><div className={css.drawerBody}>{children}</div></div>
  </dialog>
}
