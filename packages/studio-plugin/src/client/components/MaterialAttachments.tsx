import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ScenarioEvidence, type ScenarioEvidenceProps } from '../scenarios/ScenarioEvidence.tsx'
import css from '../studio.module.css'

export type MaterialAttachmentsFace = ScenarioEvidenceProps

interface AttachmentEntry {
  sessionId: string | undefined; count: number; dialogId: string; open: boolean;
  show(): void;
}
const AttachmentContext = createContext<AttachmentEntry | undefined>(undefined)

/** The native composer contribution only appears inside its material's conversation. */
export function MaterialAttachmentButton({ sessionId }: { sessionId?: string | undefined }) {
  const entry = useContext(AttachmentContext)
  if (!entry || entry.sessionId !== sessionId) return null
  return <button type="button" className={css.attachmentButton} aria-label="附件与正式依据" aria-haspopup="dialog" aria-expanded={entry.open} aria-controls={entry.dialogId} onClick={entry.show}>
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m21 11.5-8.5 8.5a6 6 0 0 1-8.5-8.5l9-9a4 4 0 0 1 5.7 5.7l-9 9a2 2 0 0 1-2.8-2.8l8.5-8.5" /></svg>
    <span>附件{entry.count ? ` ${entry.count}` : ''}</span>
  </button>
}

/** Shares one source panel between the composer entry and conversations without an active session. */
export function MaterialAttachments({ sessionId, children, ...face }: MaterialAttachmentsFace & { sessionId: string | undefined; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const dialogId = useId()
  const titleId = `${dialogId}-title`
  useEffect(() => {
    const element = dialog.current!
    if (open) element.showModal()
    else if (element.open) element.close()
    return () => { if (element.open) element.close() }
  }, [open])
  return <AttachmentContext.Provider value={{ sessionId, count: face.sources.length, dialogId, open, show: () => setOpen(true) }}>
    {children}
    <dialog ref={dialog} id={dialogId} className={`${css.dialog} ${css.attachmentDialog}`} aria-labelledby={titleId} onCancel={() => setOpen(false)} onClose={() => setOpen(false)}>
      <header><h2 id={titleId}>附件与正式依据</h2><button type="button" autoFocus onClick={() => setOpen(false)} aria-label="关闭附件面板">关闭</button></header>
      <p>导入后以实际读取结果和范围为准；选为正式依据的资料随确认版本归档。</p>
      <ScenarioEvidence {...face} />
    </dialog>
  </AttachmentContext.Provider>
}
