import { useEffect, useId, useRef, type ReactNode } from 'react'
import css from './shell.module.css'

/** A modal form keeps keyboard focus inside the operation and restores its invoker. */
export function FormDialog({ title, busy, close, children }: { title: string; busy: boolean; close(): void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    const invoker = document.activeElement
    const element = dialog.current
    element?.showModal()
    return () => { element?.close(); if (invoker instanceof HTMLElement && invoker.isConnected) invoker.focus() }
  }, [])
  return <dialog ref={dialog} className={css.dialog} aria-labelledby={titleId} aria-busy={busy} onCancel={event => { event.preventDefault(); if (!busy) close() }}>
    <h2 id={titleId}>{title}</h2>{children}
  </dialog>
}
