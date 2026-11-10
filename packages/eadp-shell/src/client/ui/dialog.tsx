import { useEffect, useId, useRef, type ReactElement, type ReactNode } from 'react'
import { cx } from './classnames.ts'
import { IconButton } from './button.tsx'
import { IconClose } from './icons.tsx'
import tokens from '../design/tokens.module.css'
import css from './dialog.module.css'

/** Modal dialog; mounting it opens the native modal and unmounting closes it. */
export interface DialogProps {
  title: string
  busy?: boolean | undefined
  description?: string | undefined
  closeLabel: string
  onClose(): void
  footer?: ReactNode
  children?: ReactNode
  width?: 'sm' | 'md' | 'lg' | undefined
}

/**
 * Native `<dialog>` modal: the platform owns the top layer and focus trap, so
 * Escape is intercepted only to keep a busy operation open.
 */
export function Dialog(props: DialogProps): ReactElement {
  const element = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const descriptionId = useId()
  useEffect(() => {
    const invoker = document.activeElement
    const dialog = element.current
    if (dialog && !dialog.open) dialog.showModal()
    return () => {
      if (dialog?.open) dialog.close()
      if (invoker instanceof HTMLElement && invoker.isConnected) invoker.focus()
    }
  }, [])
  return (
    <dialog
      ref={element}
      className={cx(tokens.popup, css.dialog)}
      data-width={props.width ?? 'md'}
      aria-labelledby={titleId}
      aria-describedby={props.description ? descriptionId : undefined}
      aria-busy={props.busy || undefined}
      onCancel={event => {
        event.preventDefault()
        if (!props.busy) props.onClose()
      }}>
      <header className={css.header}>
        <h2 id={titleId} className={css.title}>{props.title}</h2>
        <IconButton label={props.closeLabel} size="sm" disabled={props.busy} onClick={props.onClose}><IconClose /></IconButton>
      </header>
      {props.description ? <p id={descriptionId} className={css.description}>{props.description}</p> : null}
      <div className={css.body}>{props.children}</div>
      {props.footer ? <footer className={css.footer}>{props.footer}</footer> : null}
    </dialog>
  )
}
