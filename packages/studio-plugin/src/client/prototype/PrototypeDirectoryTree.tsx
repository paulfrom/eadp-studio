import { useRef, useState } from 'react'
import type { StudioCommand, StudioReply } from '../../shared/studio.ts'
import type { PrototypeFileResult, PrototypeFileSource } from '../../shared/prototype.ts'
import css from './files.module.css'
import { PrototypeIcon } from './PrototypeIcon.tsx'
type Directory = Extract<PrototypeFileResult, { kind: 'directory' }>
interface Props { source: PrototypeFileSource; listing: Directory; call(command: StudioCommand): Promise<StudioReply | undefined>; selected?: string | undefined; onOpen(path: string): void; showHidden?: boolean }
/** Each lazy directory owns its loading and error state. */
export function PrototypeDirectoryTree({ listing, ...props }: Props) {
  return <div role="group">{listing.entries.filter(entry => props.showHidden || !entry.name.startsWith('.')).map(entry => entry.kind === 'directory' ? <Folder key={entry.path} path={entry.path} name={entry.name} {...props} /> : <button className={css.treeRow} title={`${entry.path}${entry.readOnly ? ' · 只读' : ''}`} key={entry.path} aria-current={props.selected === entry.path ? 'true' : undefined} onClick={() => props.onOpen(entry.path)}><span>{entry.name}</span>{entry.readOnly && <PrototypeIcon name="lock" />}</button>)}</div>
}
function Folder({ path, name, ...props }: Omit<Props, 'listing'> & { path: string; name: string }) {
  const [expanded, setExpanded] = useState(false)
  const [listing, setListing] = useState<Directory>()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const pending = useRef(false)
  const load = async (cursor?: string) => {
    if (pending.current) return
    pending.current = true; setLoading(true); setError('')
    try {
      const reply = await props.call({ action: 'listPrototypeDirectory', source: props.source, directory: path, ...(cursor ? { cursor } : {}) })
      if (!reply?.ok || reply.prototypeFiles?.kind !== 'directory') { setError(reply && !reply.ok ? reply.message : '无法读取目录'); return }
      const next = reply.prototypeFiles
      setListing(previous => cursor && previous?.observation === next.observation ? { ...next, entries: [...previous.entries, ...next.entries] } : next)
    } catch (reason) { setError(reason instanceof Error ? reason.message : '无法读取目录') }
    finally { pending.current = false; setLoading(false) }
  }
  return <div><button className={css.treeRow} aria-expanded={expanded} onClick={() => { setExpanded(!expanded); if (!expanded && !listing) void load() }}>{expanded ? '▾' : '▸'} {name}</button>{expanded && <div className={css.treeChildren}>{loading && <p role="status">正在读取…</p>}{error && <div role="alert">{error}<button onClick={() => void load()}>重试读取目录</button></div>}{listing && <><PrototypeDirectoryTree listing={listing} {...props} />{listing.nextCursor && <button disabled={loading} onClick={() => void load(listing.nextCursor)}>加载更多 {name}</button>}{listing.truncated && !listing.nextCursor && <p>{listing.truncationReason ?? '目录结果已截断'}</p>}{!listing.entries.length && !listing.truncated && <p>目录为空。</p>}</>}</div>}</div>
}
