import { useState } from 'react'
import { Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import { PrototypeIcon as Icon } from './PrototypeIcon.tsx'
import css from './prototype.module.css'

/** Official menu handles focus and positioning; the marker suspends native preview overlays. */
export function WorkbenchMenu({ actions }: { actions: { id: string; label: string; disabled?: boolean; run(): void }[] }) {
  const [open, setOpen] = useState(false)
  return <span className={css.moreMenu} data-prototype-menu aria-expanded={open}>
    <Menu open={open} onClose={() => setOpen(false)} portal autoFocus dense align="end"
      anchor={<button type="button" aria-label="更多操作" title="更多操作" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)}><Icon name="more" /></button>}
      items={actions.map(({ id, label, disabled }) => ({ id, label, ...(disabled === undefined ? {} : { disabled }) }))}
      onSelect={id => { setOpen(false); actions.find(action => action.id === id)?.run() }} />
  </span>
}
