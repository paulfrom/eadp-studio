import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { RequirementDocument } from '@eadp/contracts'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, IconButton, IconChevronDown, IconChevronRight, IconSave, IconSearch, Kbd, Notice, Spinner } from '@eadp/shell/client/ui'
import { createEditor, type EditorMount } from './code-mirror.ts'
import { countLines, countWords, displayName, saveStatusKey, versionTail } from './document-state.ts'
import type { DraftBuffer } from '../DraftBuffer.ts'
import type { RequirementsApi } from '../api.ts'
import { NS } from '../locales.ts'
import css from '../material-editor.module.css'

/** How often the open file is re-checked for changes made outside the editor. */
const POLL_INTERVAL_MS = 2000

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
  const host = useRef<HTMLDivElement | null>(null)
  const mount = useRef<EditorMount | null>(null)
  const diskId = useId()
  const [diskOpen, setDiskOpen] = useState(false)

  /* A new disk state starts collapsed so a stale panel never shows the wrong file text. */
  const externalVersion = external?.version ?? null
  useEffect(() => { setDiskOpen(false) }, [externalVersion])

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
  const lockedRef = useRef(locked)
  lockedRef.current = locked

  useEffect(() => {
    const parent = host.current
    if (!parent) return
    const instance = createEditor({
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
  }, [])

  useEffect(() => { mount.current?.syncDocument(snapshot.text) }, [snapshot.text])
  useEffect(() => { mount.current?.setReadOnly(locked) }, [locked])
  useEffect(() => {
    mount.current?.setLabel(path)
    mount.current?.resetHistory()
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
        if (active) buffer.reportError(error instanceof Error ? error.message : String(error))
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
  const lines = useMemo(() => countLines(snapshot.text), [snapshot.text])
  return <div className={css.documentPane}>
    <header className={css.documentHeader}>
      <div className={css.documentIdentity}>
        <strong className={css.documentTitle} title={path}>{path === 'CONTEXT.md' ? t('context') : displayName(path)}</strong>
        <span className={css.documentPath} title={path}>{path}</span>
      </div>
      <span className={css.documentStatus} role="status">
        {snapshot.saving || snapshot.applying ? <Spinner size="sm" /> : null}
        {t(saveStatusKey(snapshot))}
      </span>
      <div className={css.documentActions}>
        <IconButton label={t('find')} onClick={() => { mount.current?.openFind() }}><IconSearch /></IconButton>
        <Button size="sm" variant="secondary" disabled={locked || snapshot.applying || snapshot.composing} onClick={() => { void buffer.flush() }}>
          <IconSave />{t('save')}
        </Button>
      </div>
    </header>
    {external !== undefined ? <div className={css.notices}>
      {external ? <Notice
        tone="warning"
        title={t('conflict')}
        actions={<>
          <Button size="sm" variant="secondary" onClick={() => { buffer.loadExternal() }}>{t('loadDisk')}</Button>
          <Button size="sm" variant="secondary" onClick={() => { buffer.keepDraft() }}>{t('keepDraft')}</Button>
        </>}>
        {error ? <p className={css.noticeDetail}>{error.code === 'failed' ? error.message : t('draftRetained')}</p> : null}
        <button type="button" className={css.diffToggle} aria-expanded={diskOpen} aria-controls={diskId} onClick={() => setDiskOpen(value => !value)}>
          {diskOpen ? <IconChevronDown /> : <IconChevronRight />}{t('disk')}
        </button>
        {diskOpen ? <pre id={diskId} className={css.diskBody}>{external.text}</pre> : null}
      </Notice> : <Notice
        tone="danger"
        title={t('missing')}
        actions={<>
          <Button size="sm" variant="secondary" onClick={recreate}>{t('recreate')}</Button>
          <Button size="sm" variant="danger" onClick={onDiscardMissing}>{t('discardMissing')}</Button>
        </>}>
        {error?.code === 'failed' ? <p className={css.noticeDetail}>{error.message}</p> : null}
      </Notice>}
    </div> : error ? <div className={css.notices}>
      <Notice tone={error.code === 'retained' ? 'info' : 'danger'}>{error.code === 'retained' ? t('draftRetained') : error.message}</Notice>
    </div> : null}
    <div className={css.paperArea}>
      <div className={css.paper}>
        <div className={css.editorHost} ref={host} />
      </div>
    </div>
    <footer className={css.statusBar}>
      <span>{words} {t('words')}</span>
      <span aria-hidden="true">·</span>
      <span>{lines} {t('lines')}</span>
      <span aria-hidden="true">·</span>
      <span className={css.version} title={snapshot.version ?? undefined}>{snapshot.version ? `${t('version')} ${versionTail(snapshot.version)}` : t('newFile')}</span>
      <span className={css.shortcut} title={t('save')}><Kbd>Ctrl+S</Kbd></span>
    </footer>
  </div>
}
