import type { ReactElement } from 'react'
import { cx } from './classnames.ts'
import css from './spinner.module.css'

/** Inline loading indicator; decorative unless the caller names the operation. */
export function Spinner({ size = 'md', label }: { size?: 'sm' | 'md' | undefined; label?: string | undefined }): ReactElement {
  return label === undefined
    ? <span className={cx(css.spinner)} data-size={size} aria-hidden="true" />
    : <span className={cx(css.spinner)} data-size={size} role="status" aria-label={label} />
}
