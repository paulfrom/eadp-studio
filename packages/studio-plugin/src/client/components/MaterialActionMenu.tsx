import { useState } from 'react'
import { Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import layout from './materialWorkspace.module.css'

/** Anchored material actions share host menu focus and viewport handling. */
export function MaterialActionMenu({ label, actions }: {
  label: string;
  actions: { id: string; label: string; disabled?: boolean; run(): void }[];
}) {
  const [open, setOpen] = useState(false)
  return <Menu open={open} onClose={() => setOpen(false)} portal autoFocus dense align="end"
    anchor={<button className={layout.menuTrigger} type="button" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)}>···</button>}
    items={actions.map(({ id, label, disabled }) => ({ id, label, ...(disabled === undefined ? {} : { disabled }) }))}
    onSelect={id => { setOpen(false); actions.find(action => action.id === id)?.run() }} />
}
