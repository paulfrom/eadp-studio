import { useCallback, useEffect, useRef, useState } from 'react'
import type { EadpRequirementsSlotProps, RequirementDocument, RequirementEntry } from '@eadp/contracts'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { DraftBuffer } from './DraftBuffer.ts'
import type { RequirementsClientService } from './service.ts'
import type { RequirementsApi } from './api.ts'
import { RequirementEditor, type Selection } from './editor.tsx'
import { NS } from './locales.ts'
import css from './requirements.module.css'

interface RequirementsFace {
  api: RequirementsApi
  editors: RequirementsClientService
  setActiveDocument(projectId: string, path: string | null): Promise<void>
}
export type RequirementsProps = EadpRequirementsSlotProps & PropsLocale<typeof NS> & RequirementsFace

/** File navigation changes only after the editor has acknowledged all current input. */
export function RequirementsPanel({ projectId, active, api, editors, setActiveDocument, t }: RequirementsProps) {
  const [entries, setEntries] = useState<RequirementEntry[]>([])
  const [selection, setSelection] = useState<Selection>()
  const selected = selection?.projectId === projectId ? selection : undefined
  const [contextAbsent, setContextAbsent] = useState(false)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [form, setForm] = useState<'create' | 'folder' | 'rename' | 'remove'>()
  const [pathInput, setPathInput] = useState('')
  const epoch = useRef(0)
  const currentProject = useRef(projectId)
  currentProject.current = projectId
  const isCurrent = useCallback((operationEpoch: number) => operationEpoch === epoch.current && currentProject.current === projectId, [projectId])
  const key = (path: string) => `${projectId}\0${path}`
  const refresh = useCallback(async (current = epoch.current) => {
    if (!isCurrent(current)) return
    const rows = await api.list(projectId)
    if (isCurrent(current)) setEntries(rows)
  }, [api, projectId, isCurrent])
  useEffect(() => {
    epoch.current += 1
    setSelection(undefined); setContextAbsent(false); setEntries([]); setForm(undefined); setError(''); setBusy(false); setLoading(true)
    const current = epoch.current
    void refresh().catch((reason: unknown) => { if (isCurrent(current)) setError(reason instanceof Error ? reason.message : String(reason)) }).finally(() => { if (isCurrent(current)) setLoading(false) })
    return () => { epoch.current += 1 }
  }, [projectId, refresh])
  const run = (operation: () => Promise<void>) => {
    if (busy) return
    if (selected?.buffer.getSnapshot().composing) { setError(t('composing')); return }
    setBusy(true); setError('')
    const current = epoch.current
    void operation().catch((reason: unknown) => { if (isCurrent(current)) setError(reason instanceof Error ? reason.message : String(reason)) }).finally(() => { if (isCurrent(current)) setBusy(false) })
  }
  const flush = async () => {
    const result = await editors.flushActive()
    if (!result.ok) throw new Error(result.message ?? t('dirty'))
  }
  const readDocument = async (path: string): Promise<RequirementDocument | null> => {
    if (path === 'CONTEXT.md') {
      const context = await api.readContext(projectId)
      return context.kind === 'absent' ? null : { relativePath: path, text: context.text, version: context.version }
    }
    if (await api.statVersion(projectId, path) === null) return null
    return api.read(projectId, path)
  }
  const assertClean = () => { if (editors.hasUnsaved()) throw new Error(t('dirty')) }
  const open = async (path: string, current = epoch.current) => {
    if (!isCurrent(current)) return
    await flush()
    if (!isCurrent(current)) return
    const document = await readDocument(path)
    if (!isCurrent(current)) return
    assertClean()
    if (document === null) {
      if (path !== 'CONTEXT.md') throw new Error(t('missing'))
      setSelection(undefined); setContextAbsent(true)
      await setActiveDocument(projectId, path)
      return
    }
    let buffer = editors.get(key(path))
    if (buffer) buffer.receive(document)
    else {
      buffer = new DraftBuffer(document, async (text, version) => {
        if (path === 'CONTEXT.md') return api.saveContext(projectId, text, version)
        if (version === null) throw new Error(t('missing'))
        return api.save(projectId, path, text, version)
      }, () => readDocument(path))
      editors.register(key(path), buffer)
    }
    setSelection({ projectId, path, buffer }); setContextAbsent(false)
    await setActiveDocument(projectId, path)
  }
  const begin = async (kind: 'create' | 'folder' | 'rename' | 'remove') => {
    const current = epoch.current
    await flush()
    if (!isCurrent(current)) return
    setPathInput(kind === 'rename' ? selected?.path ?? '' : kind === 'folder' ? '需求/新目录' : '需求/新需求.md')
    setForm(kind)
  }
  const submit = async () => {
    const current = epoch.current
    await flush()
    if (!isCurrent(current)) return
    if (form === 'create') {
      const document = await api.create(projectId, pathInput)
      if (!isCurrent(current)) return
      await refresh(current)
      if (!isCurrent(current)) return
      await open(document.relativePath, current)
      if (!isCurrent(current)) return
    } else if (form === 'folder') await api.createDirectory(projectId, pathInput)
    else if (form === 'rename' && selected) {
      assertClean()
      const renamedPath = await api.rename(projectId, selected.path, pathInput)
      if (!isCurrent(current)) return
      assertClean()
      editors.forget(key(selected.path))
      await refresh(current)
      if (!isCurrent(current)) return
      await open(renamedPath, current)
      if (!isCurrent(current)) return
    } else if (form === 'remove' && selected) {
      assertClean()
      await api.remove(projectId, selected.path)
      if (!isCurrent(current)) return
      assertClean()
      editors.forget(key(selected.path)); setSelection(undefined)
      await setActiveDocument(projectId, null)
      if (!isCurrent(current)) return
    }
    if (isCurrent(current)) { setForm(undefined); await refresh(current) }
  }
  const createContext = async () => {
    const current = epoch.current
    await flush()
    if (!isCurrent(current)) return
    await api.saveContext(projectId, '', null)
    if (isCurrent(current)) await open('CONTEXT.md', current)
  }
  const discardDeleted = () => {
    if (!selected) return
    const current = epoch.current
    run(async () => {
      if (!isCurrent(current)) return
      editors.forget(key(selected.path)); setSelection(undefined); setContextAbsent(false)
      await setActiveDocument(projectId, null)
      if (!isCurrent(current)) return
      await refresh(current)
    })
  }
  if (!active) return null
  return <section className={css.workbench} aria-label={t('title')}>
    <aside className={css.tree}><h2>{t('title')}</h2><div className={css.actions}>
      <button disabled={busy} onClick={() => run(() => begin('create'))}>{t('create')}</button><button disabled={busy} onClick={() => run(() => begin('folder'))}>{t('folder')}</button><button disabled={busy} onClick={() => run(() => refresh())}>{t('refresh')}</button>
    </div><button disabled={busy} onClick={() => run(() => open('CONTEXT.md'))}>{t('context')}</button>
      {loading ? <p>{t('loading')}</p> : entries.length === 0 ? <p>{t('empty')}</p> : <ul className={css.entries}>{entries.map(entry => <li key={entry.relativePath}>{entry.type === 'directory' ? <div className={css.directory}>{entry.relativePath}/</div> : <button disabled={busy} aria-current={selected?.path === entry.relativePath} title={entry.relativePath} onClick={() => run(() => open(entry.relativePath))}>{entry.relativePath.replace(/^需求\//u, '')}</button>}</li>)}</ul>}
    </aside>
    <main className={css.main}>
      {error && <p role="alert" className={css.error}>{error}</p>}
      {selected && selected.path !== 'CONTEXT.md' && <div className={css.editorHeader}><button disabled={busy} onClick={() => run(() => begin('rename'))}>{t('rename')}</button><button disabled={busy} onClick={() => run(() => begin('remove'))}>{t('remove')}</button></div>}
      {form && <form className={css.form} onSubmit={event => { event.preventDefault(); run(submit) }}>{form === 'remove' ? <p>{t('confirmRemove')}</p> : <label>{t('name')} <input required value={pathInput} onChange={event => setPathInput(event.target.value)} /></label>}<button disabled={busy}>{t('confirm')}</button><button type="button" disabled={busy} onClick={() => setForm(undefined)}>{t('cancel')}</button></form>}
      {selected ? <RequirementEditor key={`${projectId}:${selected.path}`} selection={selected} api={api} t={t} locked={busy} discardMissing={discardDeleted} /> : <div className={css.empty}>{contextAbsent ? <><p>{t('contextAbsent')}</p><button disabled={busy} onClick={() => run(createContext)}>{t('createContext')}</button></> : <p>{t('select')}</p>}</div>}
    </main>
  </section>
}
