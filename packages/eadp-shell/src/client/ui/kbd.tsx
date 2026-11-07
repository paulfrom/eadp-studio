import type { ReactElement, ReactNode } from 'react'
import css from './kbd.module.css'

/** Keyboard hint chip; the caller owns the key name. */
export function Kbd(props: { children: ReactNode }): ReactElement {
  return <kbd className={css.kbd}>{props.children}</kbd>
}
