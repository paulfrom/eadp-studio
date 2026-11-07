import { forwardRef, type ComponentPropsWithoutRef, type ForwardRefExoticComponent, type ReactNode, type RefAttributes } from 'react'
import { cx } from './classnames.ts'
import { Spinner } from './spinner.tsx'
import { Tooltip } from './tooltip.tsx'
import buttonCss from './button.module.css'
import iconButtonCss from './icon-button.module.css'

/** Text button variants; sizes map to the 28/32px control heights. */
export interface ButtonProps extends Omit<ComponentPropsWithoutRef<'button'>, 'className'> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | undefined
  size?: 'sm' | 'md' | undefined
  loading?: boolean | undefined
  className?: string | undefined
}

/** Filled or outlined action; `loading` disables the button and shows a spinner. */
export const Button: ForwardRefExoticComponent<ButtonProps & RefAttributes<HTMLButtonElement>> = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(props, ref) {
    const { variant = 'primary', size = 'md', loading, className, children, disabled, type, ...rest } = props
    return (
      <button
        ref={ref}
        type={type ?? 'button'}
        className={cx(buttonCss.button, className)}
        data-variant={variant}
        data-size={size}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        {...rest}>
        {loading ? <Spinner size="sm" /> : null}
        {children}
      </button>
    )
  },
)

/** Icon-button props; the label is the accessible name and default tooltip. */
export interface IconButtonProps extends Omit<ButtonProps, 'children' | 'loading'> {
  label: string
  children: ReactNode
  /** Set false to suppress the native title tooltip. */
  tooltip?: boolean | undefined
}

/** Square icon action; `label` is required so the control always has a name. */
export const IconButton: ForwardRefExoticComponent<IconButtonProps & RefAttributes<HTMLButtonElement>> = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(props, ref) {
    const { label, tooltip = true, variant = 'ghost', size = 'md', className, children, type, ...rest } = props
    const button = (
      <button
        ref={ref}
        type={type ?? 'button'}
        className={cx(iconButtonCss.iconButton, className)}
        data-variant={variant}
        data-size={size}
        aria-label={label}
        {...rest}>
        {children}
      </button>
    )
    return tooltip ? <Tooltip label={label}>{button}</Tooltip> : button
  },
)
