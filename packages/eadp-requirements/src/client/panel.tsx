import { useCallback, useEffect, useRef, useState } from 'react'
import type { EadpRequirementsSlotProps, RequirementDocument, RequirementEntry, RequirementProposal } from '@eadp/contracts'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Dialog, EmptyState, Field, IconFile, Input, Notice, Surface } from '@eadp/shell/client/ui'
import { DraftBuffer } from './DraftBuffer.ts'
import { MaterialTree } from './material/tree.tsx'
import { MaterialEditor } from './material/material-editor.tsx'
import { RequirementProposals } from './proposals.tsx'
import type { FlushResult, RequirementsClientService } from './service.ts'
import type { RequirementsApi } from './api.ts'
import { NS } from './locales.ts'
import css from './material-editor.module.css'

interface RequirementsFace {
  api: RequirementsApi
  editors: RequirementsClientService
  setActiveDocument(projectId: string, path: string | null): Promise<void>
}
export type RequirementsProps = EadpRequirementsSlotProps & PropsLocale<typeof NS> & RequirementsFace

interface Selection { projectId: string; path: string; buffer: DraftBuffer }
type FormState = { kind: 'create' } | { kind: 'folder' } | { kind: 'rename' | 'remove'; path: string }

/**
 * Map a name typed in the material dialog onto its requirement path.
 * Bare names land in the requirement directory (or the renamed document's directory);
 * explicit paths stay relative to the project. Files always carry the markdown suffix.
 * @param raw - the dialog input.
 * @param options - `directory` keeps a folder name; `base` places a bare rename next to its old document.
 * @returns the project-relative requirement path, or an empty string for empty input.
 */
function requirementInput(raw: string, options: { directory?: boolean; base?: string } = {}): string {
  let value = raw.trim().replace(/^(?:\.\/)+/, '').replace(/^\/+/, '')
  if (value === '') return ''
  if (value === '需求') value = '需求/需求'
  else if (!value.startsWith('需求/')) {
    value = options.base && !value.includes('/') ? `${options.base}/${value}` : `需求/${value}`
  }
  return !options.directory && !value.toLowerCase().endsWith('.md') ? `${value}.md` : value
}

/** File navigation changes only after the editor has acknowledged all current input. */
export function RequirementsPanel({ projectId, api, editors, setActiveDocument, t }: RequirementsProps) {
  const [entries, setEntries] = useState<RequirementEntry[]>([])
  const [selection, setSelection] = useState<Selection>()
  const selected = selection?.projectId === projectId ? selection : undefined
  const [contextPresent, setContextPresent] = useState(false)
  const [contextAbsent, setContextAbsent] = useState(false)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [applying, setApplying] = useState(false)
  const unavailable = busy || applying
  const [error, setError] = useState('')
  const [form, setForm] = useState<FormState>()
  const [pathInput, setPathInput] = useState('')
  const epoch = useRef(0)
  const currentProject = useRef(projectId)
  currentProject.current = projectId
  const isCurrent = useCallback((value: number) => value === epoch.current && currentProject.current === projectId, [projectId])
  const reportError = useCallback((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)), [])
  const flushMessage = useCallback((result: FlushResult): string => {
    switch (result.reason) {
      case 'composing': return t('flushComposing')
      case 'conflict': return t('flushConflict')
      case 'missing': return t('flushMissing')
      case 'failed': return result.message ?? t('flushFailed')
      default: return t('flushSaving')
    }
  }, [t])
  const refresh = useCallback(async (current = epoch.current) => {
    if (!isCurrent(current)) return
    const [rows, contextVersion] = await Promise.all([api.list(projectId), api.statVersion(projectId, 'CONTEXT.md')])
    if (!isCurrent(current)) return
    setEntries(rows)
    setContextPresent(contextVersion !== null)
  }, [api, projectId, isCurrent])
  useEffect(() => {
    epoch.current += 1
    const current = epoch.current
    setSelection(undefined); setEntries([]); setContextPresent(false); setContextAbsent(false)
    setForm(undefined); setPathInput(''); setError(''); setBusy(false); setApplying(false); setLoading(true)
    void refresh(current)
      .then(() => restore(current))
      .catch(reason => { if (isCurrent(current)) reportError(reason) })
      .finally(() => { if (isCurrent(current)) setLoading(false) })
    return () => { epoch.current += 1 }
  }, [projectId, refresh, isCurrent, reportError])
  const flush = async (current: number): Promise<void> => {
    const result = await editors.flushActive(projectId)
    if (!isCurrent(current)) return
    if (!result.ok) throw new Error(flushMessage(result))
  }
  const readDocument = useCallback(async (path: string): Promise<RequirementDocument | null> => {
    if (path === 'CONTEXT.md') {
      const context = await api.readContext(projectId)
      return context.kind === 'absent' ? null : { relativePath: path, text: context.text, version: context.version }
    }
    if (await api.statVersion(projectId, path) === null) return null
    return api.read(projectId, path)
  }, [api, projectId])
  const bufferFor = (path: string, document: RequirementDocument): DraftBuffer => {
    const existing = editors.get(projectId, path)
    if (existing) { existing.receive(document); return existing }
    const buffer = new DraftBuffer(document, (text, version) => {
      if (path === 'CONTEXT.md') return api.saveContext(projectId, text, version)
      if (version === null) throw new Error(t('flushFailed'))
      return api.save(projectId, path, text, version)
    }, () => readDocument(path))
    editors.register(projectId, path, buffer)
    return buffer
  }
  /* Activation never flushes: the navigation pipeline flushes exactly once before it. */
  const activate = async (path: string, current: number): Promise<void> => {
    if (!isCurrent(current)) return
    const document = await readDocument(path)
    if (!isCurrent(current)) return
    if (document === null) {
      if (path !== 'CONTEXT.md') throw new Error(t('missing'))
      setSelection(undefined)
      editors.remember(projectId, null)
      setContextAbsent(true)
      await setActiveDocument(projectId, null)
      return
    }
    if (editors.hasUnsaved(projectId)) throw new Error(t('flushFailed'))
    await setActiveDocument(projectId, path)
    if (!isCurrent(current)) return
    setSelection({ projectId, path, buffer: bufferFor(path, document) })
    editors.remember(projectId, path)
    setContextAbsent(false)
    setForm(undefined)
  }
  /** Reopens the document this project had open before the view was unmounted. */
  const restore = async (current: number): Promise<void> => {
    const path = editors.remembered(projectId)
    if (!path) return
    const document = await readDocument(path).catch(() => null)
    if (!isCurrent(current)) return
    if (document === null) { editors.remember(projectId, null); return }
    await setActiveDocument(projectId, path).catch(() => undefined)
    if (!isCurrent(current)) return
    setSelection({ projectId, path, buffer: bufferFor(path, document) })
  }
  const run = (operation: (current: number) => Promise<void>) => {
    if (unavailable) return
    setBusy(true); setError('')
    const current = epoch.current
    void operation(current)
      .catch(reason => { if (isCurrent(current)) reportError(reason) })
      .finally(() => { if (isCurrent(current)) setBusy(false) })
  }
  const open = (path: string) => run(async current => {
    await flush(current)
    if (!isCurrent(current)) return
    await activate(path, current)
  })
  const begin = (next: FormState) => {
    if (unavailable) return
    setError('')
    setForm(next)
    setPathInput(next.kind === 'rename' ? next.path : next.kind === 'folder' ? '新目录' : '新需求')
  }
  const createContext = () => run(async current => {
    await flush(current)
    if (!isCurrent(current)) return
    await api.saveContext(projectId, '', null)
    if (!isCurrent(current)) return
    setContextPresent(true)
    await activate('CONTEXT.md', current)
  })
  const submit = () => {
    if (!form || unavailable) return
    run(async current => {
      await flush(current)
      if (!isCurrent(current)) return
      if (form.kind === 'create') {
        const document = await api.create(projectId, requirementInput(pathInput))
        if (!isCurrent(current)) return
        await refresh(current)
        if (!isCurrent(current)) return
        await activate(document.relativePath, current)
        return
      }
      if (form.kind === 'folder') {
        await api.createDirectory(projectId, requirementInput(pathInput, { directory: true }))
        if (!isCurrent(current)) return
        await refresh(current)
        if (isCurrent(current)) setForm(undefined)
        return
      }
      if (form.kind === 'rename') {
        const oldPath = form.path
        const wasOpen = selected?.path === oldPath
        const renamedPath = await api.rename(projectId, oldPath, requirementInput(pathInput, { base: oldPath.slice(0, oldPath.lastIndexOf('/')) }))
        if (!isCurrent(current)) return
        /* The old path is gone after the rename; retire its draft and its editor, so the
           renamed document opens instead of being blocked by the vanished path. */
        editors.forget(projectId, oldPath)
        if (wasOpen) setSelection(undefined)
        try {
          await refresh(current)
          if (!isCurrent(current)) return
          if (wasOpen) await activate(renamedPath, current)
        } catch (reason) {
          /* The old path no longer exists; never leave the selection on its disposed buffer. */
          if (isCurrent(current)) {
            editors.forget(projectId, oldPath)
            if (wasOpen) {
              setSelection(undefined)
              editors.remember(projectId, null)
              await setActiveDocument(projectId, null).catch(reportError)
            }
          }
          throw reason
        }
        if (isCurrent(current)) setForm(undefined)
        return
      }
      const removedPath = form.path
      let removed = false
      try {
        await api.remove(projectId, removedPath)
        removed = true
      } finally {
        if (isCurrent(current)) {
          if (removed && selected?.path === removedPath) {
            /* Clear the native active-document hint before dropping the buffer it names. */
            await setActiveDocument(projectId, null).catch(reportError)
            if (isCurrent(current)) {
              setSelection(undefined)
              editors.remember(projectId, null)
              editors.forget(projectId, removedPath)
            }
          } else if (removed) editors.forget(projectId, removedPath)
          await refresh(current).catch(reason => { if (isCurrent(current)) reportError(reason) })
        }
      }
      if (isCurrent(current)) setForm(undefined)
    })
  }
  const discardMissing = () => run(async current => {
    if (!selected) return
    const path = selected.path
    await setActiveDocument(projectId, null)
    if (!isCurrent(current)) return
    editors.forget(projectId, path)
    editors.remember(projectId, null)
    setSelection(undefined)
    setContextAbsent(false)
    await refresh(current)
  })
  const recreated = async (): Promise<void> => {
    const current = epoch.current
    await refresh(current).catch(reason => { if (isCurrent(current)) reportError(reason) })
    if (!isCurrent(current) || !selected) return
    await setActiveDocument(projectId, selected.path).catch(reason => { if (isCurrent(current)) reportError(reason) })
  }
  const applyProposal = async (proposal: RequirementProposal): Promise<void> => {
    if (unavailable) throw new Error(t('prepareFailed'))
    setApplying(true); setError('')
    const current = epoch.current
    let buffer: DraftBuffer | undefined
    let prepared = false
    try {
      buffer = editors.get(projectId, proposal.relativePath)
      if (!buffer) {
        /* The target has no in-memory buffer: the Host applies atomically against the proposal's base version. */
        await api.applyProposal(projectId, proposal.proposalId, proposal.baseVersion)
        if (isCurrent(current)) await refresh(current)
        return
      }
      const input = await buffer.prepareWrite()
      if (!input) throw new Error(t('prepareFailed'))
      prepared = true
      if (!isCurrent(current)) return
      if (!buffer.matchesPrepared(input) || editors.hasUnsavedExcept(projectId, buffer)) throw new Error(t('prepareFailed'))
      const accepted = await api.applyProposal(projectId, proposal.proposalId, input.version)
      buffer.acknowledgeWrite(accepted, input)
    } finally {
      if (prepared) buffer?.finishWrite()
      if (isCurrent(current)) setApplying(false)
    }
  }
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return
      event.preventDefault()
      void editors.flushActive(projectId).then(result => {
        /* The open document renders its own conflict or failure notice; avoid a second alert. */
        if (!result.ok && !selected) setError(flushMessage(result))
      })
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [editors, projectId, flushMessage, selected])
  const dialogTitle = form === undefined ? '' : form.kind === 'create' ? t('create') : form.kind === 'folder' ? t('folder') : form.kind === 'rename' ? t('rename') : t('remove')
  return <Surface className={css.surface}>
    <div className={css.workbench}>
      <MaterialTree
        entries={entries}
        selectedPath={selected?.path}
        contextPresent={contextPresent}
        loading={loading}
        disabled={unavailable}
        onOpen={open}
        onCreate={() => begin({ kind: 'create' })}
        onCreateFolder={() => begin({ kind: 'folder' })}
        onRefresh={() => run(async current => { await refresh(current) })}
        onRename={path => begin({ kind: 'rename', path })}
        onRemove={path => begin({ kind: 'remove', path })}
        t={t} />
      <section className={css.documentArea} aria-label={t('title')}>
        {error ? <div className={css.panelError}><Notice tone="danger" title={t('operationFailed')}>{error}</Notice></div> : null}
        {selected
          ? <MaterialEditor
            projectId={projectId}
            path={selected.path}
            buffer={selected.buffer}
            api={api}
            locked={busy}
            onRecreated={recreated}
            onDiscardMissing={discardMissing}
            t={t} />
          : <div className={css.emptyDocument}>
            <EmptyState
              icon={<IconFile />}
              title={contextAbsent ? t('contextAbsent') : t('select')}
              action={contextAbsent
                ? <Button size="sm" variant="primary" disabled={unavailable} onClick={createContext}>{t('createContext')}</Button>
                : undefined} />
          </div>}
        <RequirementProposals projectId={projectId} api={api} disabled={unavailable} apply={applyProposal} t={t} />
      </section>
    </div>
    {form ? <Dialog
      title={dialogTitle}
      busy={busy}
      closeLabel={t('close')}
      description={form.kind === 'remove' ? t('confirmRemove') : undefined}
      onClose={() => { if (!busy) setForm(undefined) }}
      footer={<>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setForm(undefined)}>{t('cancel')}</Button>
        <Button
          size="sm"
          variant={form.kind === 'remove' ? 'danger' : 'primary'}
          loading={busy}
          disabled={form.kind !== 'remove' && pathInput.trim().length === 0}
          onClick={submit}>{t('confirm')}</Button>
      </>}>
      {form.kind === 'remove' ? null : <Field label={t('name')} htmlFor="eadp-requirements-path" hint={t('nameHint')}>
        <Input
          id="eadp-requirements-path"
          autoFocus
          value={pathInput}
          disabled={busy}
          onChange={event => setPathInput(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); submit() } }} />
      </Field>}
    </Dialog> : null}
  </Surface>
}
