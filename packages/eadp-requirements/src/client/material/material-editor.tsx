import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { RequirementDocument } from '@eadp/contracts'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Dialog, IconButton, IconChevronDown, IconChevronRight, IconSave, IconSearch, Kbd, Notice, Spinner } from '@eadp/shell/client/ui'
import { MarkdownEditor, supportsRichEditing, type MarkdownEditorHandle } from '@eadp/shell/client/document-editor'
import extra from './document.module.css'
import { createEditor, documentHeadings, type EditorMount } from './code-mirror.ts'
import { countLines, countWords, displayName, saveStatusKey } from './document-state.ts'
import type { DraftBuffer } from '../DraftBuffer.ts'
import type { RequirementsApi } from '../api.ts'
import { NS } from '../locales.ts'
import css from '../material-editor.module.css'

/** How often the open file is re-checked for changes made outside the editor. */
const POLL_INTERVAL_MS = 2000

/** Editing preference belongs to the document buffer and disappears when it is retired. */
const sourcePreferences = new WeakMap<DraftBuffer, boolean>()

export interface MaterialEditorProps extends PropsLocale<typeof NS> {
  projectId: string
  path: string
  buffer: DraftBuffer
  api: RequirementsApi
  /** Panel-level operation in progress; the document is temporarily read-only. */
  locked: boolean
  onRecreated(): Promise<void>
  onDiscardMissing(): void
}

/** Document pane: header, disk-conflict notices, the CodeMirror paper card and the status bar. */
export function MaterialEditor(props: MaterialEditorProps) {
  const { projectId, path, buffer, api, locked, onRecreated, onDiscardMissing, t } = props
  const snapshot = useSyncExternalStore(buffer.subscribe, buffer.getSnapshot)
  const external = snapshot.external
  const editingLocked = locked || snapshot.recoveryLoading || snapshot.recovery !== null
  const [mode, setMode] = useState({ buffer, source: sourcePreferences.get(buffer) ?? false })
  const sourcePreference = mode.buffer === buffer ? mode.source : sourcePreferences.get(buffer) ?? false
  const toggleSource = () => {
    const next = !sourcePreference
    sourcePreferences.set(buffer, next)
    setMode({ buffer, source: next })
  }
  const richSupported = useMemo(() => supportsRichEditing(snapshot.text), [snapshot.text])
  const source = sourcePreference || !richSupported
  const [inspectionError, setInspectionError] = useState('')
  const [confirmation, setConfirmation] = useState<'load' | 'discard' | 'recovery'>()
  const [outlineOpen, setOutlineOpen] = useState(false)
  const pane = useRef<HTMLDivElement | null>(null)
  const rich = useRef<MarkdownEditorHandle | null>(null)
  const host = useRef<HTMLDivElement | null>(null)
  const mount = useRef<EditorMount | null>(null)
  const diskId = useId()
  const [diskOpen, setDiskOpen] = useState(false)

  /* A new disk state starts collapsed so a stale panel never shows the wrong file text. */
  const externalVersion = external?.version ?? null
  useEffect(() => { setDiskOpen(false) }, [externalVersion])
  useEffect(() => { setConfirmation(undefined); setInspectionError(''); setOutlineOpen(false) }, [buffer])

  /* Callbacks and copy for the single mounted view; the view itself never remounts. */
  const bufferRef = useRef(buffer)
  bufferRef.current = buffer
  const labels = useMemo(() => ({
    ariaLabel: path,
    placeholder: t('placeholder'),
    search: { find: t('find'), previous: t('findPrevious'), next: t('findNext'), close: t('close') },
  }), [path, t])
  const labelsRef = useRef(labels)
  labelsRef.current = labels
  const lockedRef = useRef(editingLocked)
  lockedRef.current = editingLocked

  useEffect(() => {
    const parent = host.current
    if (!parent) return
    const instance = createEditor({
      sessionKey: buffer,
      parent,
      text: bufferRef.current.getSnapshot().text,
      readOnly: lockedRef.current,
      ariaLabel: labelsRef.current.ariaLabel,
      placeholder: labelsRef.current.placeholder,
      labels: labelsRef.current.search,
      onEdit: text => bufferRef.current.edit(text),
      onCompose: composing => bufferRef.current.compose(composing),
      onSave: () => { void bufferRef.current.flush() },
      onBlur: () => { void bufferRef.current.flush() },
    })
    mount.current = instance
    return () => {
      mount.current = null
      instance.destroy()
    }
  }, [source, buffer])

  useEffect(() => { mount.current?.syncDocument(snapshot.text) }, [snapshot.text])
  useEffect(() => { mount.current?.setReadOnly(editingLocked) }, [editingLocked])
  useEffect(() => {
    mount.current?.setLabel(path)
    mount.current?.focus()
  }, [path])

  /* A pending timer is the only place that notices external changes for the open file. */
  useEffect(() => {
    let active = true
    let reading = false
    const refresh = async () => {
      if (reading) return
      const value = buffer.getSnapshot()
      if (value.saving || value.applying || value.external !== undefined) return
      reading = true
      try {
        setInspectionError('')
        const version = await api.statVersion(projectId, path)
        if (!active || version === buffer.getSnapshot().version) return
        let document: RequirementDocument | null = null
        if (version !== null) {
          if (path === 'CONTEXT.md') {
            const context = await api.readContext(projectId)
            if (context.kind === 'present') document = { relativePath: path, text: context.text, version: context.version }
          } else document = await api.read(projectId, path)
        }
        if (active) buffer.receive(document)
      } catch (error) {
        if (active) setInspectionError(error instanceof Error ? error.message : String(error))
      } finally {
        reading = false
      }
    }
    const timer = window.setInterval(() => { void refresh() }, POLL_INTERVAL_MS)
    const focus = () => { void refresh() }
    window.addEventListener('focus', focus)
    return () => {
      active = false
      window.clearInterval(timer)
      window.removeEventListener('focus', focus)
    }
  }, [api, projectId, path, buffer])

  const recreate = () => {
    void buffer.recreate(text => path === 'CONTEXT.md' ? api.saveContext(projectId, text, null) : api.create(projectId, path, text))
      .then(ok => { if (ok) void onRecreated() })
  }

  const error = snapshot.error
  const words = useMemo(() => countWords(snapshot.text), [snapshot.text])
  const headings = useMemo(() => documentHeadings(snapshot.text), [snapshot.text])
  const jump = (index: number) => {
    const heading = headings[index]
    if (!heading) return
    if (source && mount.current) {
      const position = mount.current.view.state.doc.line(heading.line).from
      mount.current.view.dispatch({ selection: { anchor: position }, scrollIntoView: true })
      mount.current.focus()
    } else pane.current?.querySelectorAll('h1,h2,h3,h4,h5,h6')[index]?.scrollIntoView({ block: 'center' })
    setOutlineOpen(false)
  }
  const lines = useMemo(() => countLines(snapshot.text), [snapshot.text])
  return <div className={css.documentPane} ref={pane}>
    <header className={css.documentHeader}>
      <div className={css.documentIdentity}>
        <strong className={css.documentTitle} title={path}>{path === 'CONTEXT.md' ? t('context') : displayName(path)}</strong>
        <span className={css.documentPath} title={path}>{path}</span>
      </div>
      <span className={css.documentStatus} role="status">
        {snapshot.saving || snapshot.applying ? <Spinner size="sm" /> : null}
        {snapshot.recoveryLoading ? t('recoveryLoading') : snapshot.recovery ? t('recoveryTitle') : external === null ? t('missing') : external ? t('conflict') : error?.code === 'failed' ? t('flushFailed') : t(saveStatusKey(snapshot))}
      </span>
      <div className={css.documentActions}>
        <Button size="sm" variant="ghost" aria-expanded={outlineOpen} onClick={() => setOutlineOpen(value => !value)}>{t('outline')}</Button>
        <Button size="sm" variant="ghost" disabled={snapshot.composing || !richSupported} onClick={toggleSource}>{source ? t('richEdit') : t('sourceEdit')}</Button>
        <IconButton label={t('find')} onClick={() => { source ? mount.current?.openFind() : rich.current?.openFind() }}><IconSearch /></IconButton>
        <Button size="sm" variant="secondary" disabled={editingLocked || snapshot.applying || snapshot.composing} onClick={() => { void buffer.flush() }}>
          <IconSave />{t('save')}
        </Button>
      </div>
    </header>
    {external !== undefined ? <div className={css.notices}>
      {external ? <Notice
        tone="warning"
        title={t('conflict')}
        actions={<>
          <Button size="sm" variant="secondary" onClick={() => { setConfirmation('load') }}>{t('loadDisk')}</Button>
          <Button size="sm" variant="secondary" onClick={() => { buffer.keepDraft() }}>{t('keepDraft')}</Button>
        </>}>
        {error ? <p className={css.noticeDetail}>{error.code === 'failed' ? error.message : t('draftRetained')}</p> : null}
        <button type="button" className={css.diffToggle} aria-expanded={diskOpen} aria-controls={diskId} onClick={() => setDiskOpen(value => !value)}>
          {diskOpen ? <IconChevronDown /> : <IconChevronRight />}{t('compareContents')}
        </button>
        {diskOpen ? <div id={diskId} className={extra.compare}><section><strong>{t('currentInput')}</strong><pre>{snapshot.text}</pre></section><section><strong>{t('diskInput')}</strong><pre>{external.text}</pre></section></div> : null}
      </Notice> : <Notice
        tone="danger"
        title={t('missing')}
        actions={<>
          <Button size="sm" variant="secondary" onClick={recreate}>{t('recreate')}</Button>
          <Button size="sm" variant="danger" onClick={() => { setConfirmation('discard') }}>{t('discardMissing')}</Button>
        </>}>
        {error?.code === 'failed' ? <p className={css.noticeDetail}>{error.message}</p> : null}
      </Notice>}
    </div> : error ? <div className={css.notices}>
      <Notice tone={error.code === 'retained' ? 'info' : 'danger'}>{error.code === 'retained' ? t('draftRetained') : error.message}</Notice>
    </div> : null}
    {snapshot.recoveryLoading ? <Notice tone="info">{t('recoveryLoading')}</Notice> : snapshot.recovery ? <Notice tone="warning" title={t('recoveryTitle')} actions={<>
      <Button size="sm" variant="primary" onClick={() => buffer.recoverDraft()}>{t('recoverDraft')}</Button>
      <Button size="sm" variant="ghost" onClick={() => { setConfirmation('recovery') }}>{t('discardRecovery')}</Button>
    </>}><p>{t('recoveryHint')}</p><div className={extra.compare}><section><strong>{t('currentInput')}</strong><pre>{snapshot.text}</pre></section><section><strong>{t('recoverDraft')}</strong><pre>{snapshot.recovery.text}</pre></section></div></Notice> : null}
    {/!\[[^\]]*\]\((?!https?:|data:)[^)]+\)/.test(snapshot.text) ? <Notice tone="info">{t('imageUnavailableHint')}</Notice> : null}
    {!richSupported ? <Notice tone="info">{t('sourceRequired')}</Notice> : null}
    {outlineOpen ? <nav className={extra.outline} aria-label={t('outline')}>{headings.length === 0 ? <p>{t('outlineEmpty')}</p> : headings.map((heading, index) => <button type="button" key={heading.line} style={{ paddingInlineStart: `${heading.depth * 12}px` }} onClick={() => jump(index)}>{heading.title}</button>)}</nav> : null}
    {inspectionError ? <Notice tone="warning" title={t('inspectFailed')}>{inspectionError}</Notice> : null}
    {snapshot.persistenceError ? <Notice tone="warning" title={t('draftPersistenceFailed')}>{snapshot.persistenceError}</Notice> : null}
    <div className={css.paperArea} data-editor-scroll>
      <div className={css.paper}>
        {source ? <div className={css.editorHost} ref={host} /> : <MarkdownEditor key={`${projectId}:${path}`} sessionKey={buffer} allowImages={false} ref={rich} markdown={snapshot.text} assets={{}} readOnly={editingLocked} ariaLabel={path} onTextChange={text => buffer.edit(text)} onCompose={value => buffer.compose(value)} onSave={() => { void buffer.flush() }} onBlur={() => { void buffer.flush() }} />}
      </div>
    </div>
    {confirmation ? <Dialog title={t('confirm')} closeLabel={t('close')} onClose={() => setConfirmation(undefined)} footer={<>
      <Button size="sm" variant="ghost" onClick={() => setConfirmation(undefined)}>{t('cancel')}</Button>
      <Button size="sm" variant="danger" onClick={() => {
        if (confirmation === 'load') buffer.loadExternal()
        else if (confirmation === 'discard') onDiscardMissing()
        else buffer.discardRecovery()
        setConfirmation(undefined)
      }}>{t('confirm')}</Button>
    </>}><p>{t(confirmation === 'load' ? 'loadDiskConfirm' : confirmation === 'discard' ? 'discardInputConfirm' : 'discardRecoveryConfirm')}</p></Dialog> : null}
    <footer className={css.statusBar}>
      <span>{words} {t('words')}</span>
      <span aria-hidden="true">·</span>
      <span>{lines} {t('lines')}</span>
      <span className={css.shortcut} title={t('save')}><Kbd>Ctrl+S</Kbd></span>
    </footer>
  </div>
}
