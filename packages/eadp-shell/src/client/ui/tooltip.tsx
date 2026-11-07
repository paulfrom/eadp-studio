import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react'

/**
 * Native tooltip for a single focusable child. No portal, wrapper element or
 * extra Radix package: the title attribute is the platform behaviour.
 */
export function Tooltip({ label, children }: { label: string; children: ReactNode }): ReactElement {
  if (!isValidElement<{ title?: string }>(children)) return <>{children}</>
  return cloneElement(children, { title: children.props.title ?? label })
}
