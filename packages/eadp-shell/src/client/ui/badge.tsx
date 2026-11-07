import type { ReactElement, ReactNode } from 'react'
import css from './badge.module.css'

/** Compact status label; tone carries meaning, text stays caller-owned. */
export function Badge(props: { tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | undefined; children: ReactNode }): ReactElement {
  return <span className={css.badge} data-tone={props.tone ?? 'neutral'}>{props.children}</span>
}
