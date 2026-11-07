import type { ReactElement, ReactNode } from 'react'
import { cx } from './classnames.ts'
import tokens from '../design/tokens.module.css'

/** Token scope for one EADP surface; every panel root renders inside it. */
export function Surface(props: { className?: string | undefined; children: ReactNode }): ReactElement {
  return <div className={cx(tokens.surface, props.className)} data-eadp-surface>{props.children}</div>
}
