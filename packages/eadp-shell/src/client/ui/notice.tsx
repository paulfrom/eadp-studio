import type { ReactElement, ReactNode } from 'react'
import { IconAlert, IconCheck, IconClose, IconInfo } from './icons.tsx'
import { IconButton } from './button.tsx'
import { cx } from './classnames.ts'
import css from './notice.module.css'

/** Inline status message tones; danger and warning announce as alerts. */
export interface NoticeProps {
  tone?: 'info' | 'success' | 'warning' | 'danger' | undefined
  title?: string | undefined
  children?: ReactNode
  actions?: ReactNode
  onDismiss?: (() => void) | undefined
  /** Accessible name for the dismiss control; required when `onDismiss` is set. */
  dismissLabel?: string | undefined
}

type NoticeTone = NonNullable<NoticeProps['tone']>

const GLYPHS: Record<NoticeTone, ReactNode> = {
  info: <IconInfo />,
  success: <IconCheck />,
  warning: <IconAlert />,
  danger: <IconAlert />,
}

/** Inline message tied to the surface that produced it. */
export function Notice(props: NoticeProps): ReactElement {
  const tone = props.tone ?? 'info'
  return (
    <div className={cx(css.notice)} data-tone={tone} role={tone === 'danger' || tone === 'warning' ? 'alert' : 'status'}>
      <span className={css.glyph}>{GLYPHS[tone]}</span>
      <div className={css.body}>
        {props.title ? <p className={css.title}>{props.title}</p> : null}
        {props.children ? <div className={css.text}>{props.children}</div> : null}
      </div>
      {props.actions ? <div className={css.actions}>{props.actions}</div> : null}
      {props.onDismiss && props.dismissLabel
        ? <IconButton label={props.dismissLabel} size="sm" onClick={props.onDismiss}><IconClose /></IconButton>
        : null}
    </div>
  )
}
