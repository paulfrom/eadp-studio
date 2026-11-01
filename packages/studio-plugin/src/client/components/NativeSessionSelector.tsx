import { useState } from 'react'
import { Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './native-session-selector.module.css'

export interface NativeConversationSelection {
  items: Array<{ id: string; title: string; status: string; disabled?: boolean }>
  selectedId?: string
  busy: boolean
  onSelect(id: string): void
  onOpenMaterial(id: string): void
}

/** Select a requirement's retained conversation using the host's menu and focus behavior. */
export function NativeSessionSelector({ items, selectedId, busy, onSelect, onOpenMaterial }: NativeConversationSelection) {
  const [open, setOpen] = useState(false)
  const selected = items.find(item => item.id === selectedId)
  return <header className={css.header} data-prototype-menu aria-expanded={open}>
    <Menu open={open} onClose={() => setOpen(false)} portal autoFocus dense align="start"
      anchor={<button type="button" className={css.trigger} aria-label={selected ? `选择需求会话，当前 ${selected.title}，${selected.status}` : '选择需求会话'} aria-haspopup="menu" aria-expanded={open} disabled={busy || !items.length} onClick={() => setOpen(value => !value)}>
        <span className={css.title}>{selected?.title ?? '选择需求进入 AI 会话'}</span>
        {selected && <span className={css.status}>{selected.status}</span>}
        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
      </button>}
      items={items.map(item => ({ id: item.id, label: `${item.id === selectedId ? '✓ ' : ''}${item.title} · ${item.status}`, ...(item.disabled ? { disabled: true } : {}) }))}
      onSelect={id => { setOpen(false); onSelect(id) }} />
    {selected && <button type="button" className={css.material} disabled={busy} onClick={() => onOpenMaterial(selected.id)}>查看材料</button>}
  </header>
}
