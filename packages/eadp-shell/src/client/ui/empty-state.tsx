import type { ReactElement, ReactNode } from 'react'
import css from './empty-state.module.css'

/** Centered zero-content state with an optional leading glyph and action. */
export function EmptyState(props: { icon?: ReactNode; title: string; description?: string | undefined; action?: ReactNode }): ReactElement {
  return (
    <div className={css.empty}>
      {props.icon ? <span className={css.icon}>{props.icon}</span> : null}
      <p className={css.title}>{props.title}</p>
      {props.description ? <p className={css.description}>{props.description}</p> : null}
      {props.action ? <div className={css.action}>{props.action}</div> : null}
    </div>
  )
}
