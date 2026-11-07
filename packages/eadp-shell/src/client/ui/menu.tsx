import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import type { ReactElement, ReactNode } from 'react'
import { cx } from './classnames.ts'
import tokens from '../design/tokens.module.css'
import css from './menu.module.css'

/** One selectable menu row; the caller owns the label and the action. */
export interface MenuItem {
  id: string
  label: string
  icon?: ReactNode
  danger?: boolean | undefined
  disabled?: boolean | undefined
  onSelect(): void
}

/** Dropdown menu; `trigger` must be a single ref-able element for `asChild`. */
export function Menu(props: { items: MenuItem[]; trigger: ReactNode; align?: 'start' | 'end' | undefined; label: string }): ReactElement {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{props.trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className={cx(tokens.popup, css.menu)}
          align={props.align ?? 'start'}
          sideOffset={4}
          collisionPadding={8}
          aria-label={props.label}>
          {props.items.map(item => (
            <DropdownMenu.Item
              key={item.id}
              className={css.item}
              data-danger={item.danger ? 'true' : undefined}
              disabled={item.disabled}
              onSelect={item.onSelect}>
              {item.icon ? <span className={css.icon}>{item.icon}</span> : null}
              <span className={css.label}>{item.label}</span>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
