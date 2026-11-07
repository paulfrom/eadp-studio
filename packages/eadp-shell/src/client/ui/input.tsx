import { forwardRef, type ForwardRefExoticComponent, type InputHTMLAttributes, type ReactElement, type ReactNode, type RefAttributes } from 'react'
import { cx } from './classnames.ts'
import css from './input.module.css'

/** Single-line text input; `invalid` mirrors the field validation state. */
export const Input: ForwardRefExoticComponent<InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean | undefined } & RefAttributes<HTMLInputElement>> = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean | undefined }>(
  function Input(props, ref) {
    const { invalid, className, ...rest } = props
    return <input ref={ref} className={cx(css.input, className)} data-invalid={invalid || undefined} aria-invalid={invalid || undefined} {...rest} />
  },
)

/** Labelled form row with optional hint and validation message. */
export function Field(props: { label: string; htmlFor?: string | undefined; hint?: string | undefined; error?: string | undefined; children: ReactNode }): ReactElement {
  return (
    <div className={css.field}>
      <label className={css.label} htmlFor={props.htmlFor}>{props.label}</label>
      {props.hint ? <span className={css.hint}>{props.hint}</span> : null}
      {props.children}
      {props.error ? <span className={css.error} role="alert">{props.error}</span> : null}
    </div>
  )
}
