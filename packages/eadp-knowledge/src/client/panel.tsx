import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { EadpKnowledgeSlotProps } from '@eadp/contracts'
import type {
  KnowledgeCatalog,
  KnowledgeDocument,
  KnowledgeDraft,
  KnowledgeImportFile,
  KnowledgeImportItem,
  KnowledgeImports,
  KnowledgePackId,
  KnowledgeProposal,
  KnowledgeSourceView,
} from '@eadp/contracts/knowledge'
import { Button, Dialog, Notice, Spinner, Surface } from '@eadp/shell/client/ui'
import type { KnowledgeApi } from './api.ts'
import { DetailView } from './detail.tsx'
import type { MarkdownEditorHandle } from './editor/index.ts'
import { EditorPage, type EditorSession } from './editor-page.tsx'
import { fileNameWithoutExtension, formatDateTime, formatFileSize } from './format.ts'
import { ImportsView } from './imports.tsx'
import { LibraryView, type LibraryFilters } from './library.tsx'
import { NS, type KnowledgeTranslate } from './locales.ts'
import css from './panel.module.css'

type Props = EadpKnowledgeSlotProps & PropsLocale<typeof NS> & { api: KnowledgeApi }
type View = 'library' | 'imports' | 'detail' | 'editor'
type DetailTab = 'body' | 'source'

interface DetailState {
  document: KnowledgeDocument
  /** Object URLs for the body resources; revoked when the detail is replaced. */
  assets: Record<string, string>
}

interface Announcement {
  tone: 'success' | 'info' | 'warning'
  text: string
}

interface OriginalState {
  title: string
  /** `null` while the original information is being read. */
  view: KnowledgeSourceView | null
}

const EMPTY_ASSETS: Record<string, string> = {}
/** The Host rejects larger files; the picker refuses them first so nothing is read. */
const IMPORT_MAX_BYTES = 100 * 1024 * 1024
const READ_FAILED = 'READ_FAILED'

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Identity of the imported documents currently listed; a change means the catalog needs a refresh. */
function importedKeyOf(imports: KnowledgeImports): string {
  const ids: string[] = []
  for (const item of imports.items) {
    if (item.status === 'imported' && item.documentId !== undefined) ids.push(item.documentId)
  }
  return ids.sort().join('|')
}

/** Reads a selected file as base64 for the JSON import call; FileReader stays async for large files. */
function readFileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      if (typeof result !== 'string') {
        reject(new Error(READ_FAILED))
        return
      }
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = () => reject(reader.error ?? new Error(READ_FAILED))
    reader.readAsDataURL(file)
  })
}

function OriginalDetails({ view, t }: { view: KnowledgeSourceView; t: KnowledgeTranslate }): ReactElement {
  const fileInfo = [view.fileType, formatFileSize(view.size)].filter(part => part !== '').join(' · ')
  return <>
    <dl className={css.dialogList}>
      <dt>{t('originalFileName')}</dt><dd>{view.fileName}</dd>
      <dt>{t('originalFileInfo')}</dt><dd>{fileInfo === '' ? '—' : fileInfo}</dd>
      <dt>{t('originalImportedAt')}</dt><dd>{formatDateTime(view.importedAt)}</dd>
      <dt>{t('originalLocations')}</dt><dd>{view.locations.length > 0 ? view.locations.join(t('listSeparator')) : t('locationsNone')}</dd>
      <dt>{t('originalWarnings')}</dt><dd>{view.warnings.length > 0 ? view.warnings.join(t('sentenceSeparator')) : t('warningsNone')}</dd>
    </dl>
    {view.available
      ? (view.textPreview !== null
        ? <pre className={css.dialogPreview}>{view.textPreview}</pre>
        : <p className={css.hint}>{t('sourceNoPreview')}</p>)
      : <Notice tone="warning">{t('originalUnavailable')}</Notice>}
  </>
}

/**
 * Knowledge workbench state owner: it keeps the current page, the loaded
 * catalog/imports, the open detail, and the editor draft, and passes plain
 * data plus callbacks down to the four pure views. Refreshes replace catalog
 * data only; an unsaved editor draft is never rebuilt from it.
 */
export function KnowledgePanel({ active, api, t }: Props) {
  const [view, setView] = useState<View>('library')
  const [catalog, setCatalog] = useState<KnowledgeCatalog | null>(null)
  const [imports, setImports] = useState<KnowledgeImports | null>(null)
  const [proposals, setProposals] = useState<KnowledgeProposal[]>([])
  const [filters, setFilters] = useState<LibraryFilters>({ category: null, source: 'all', query: '' })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [announce, setAnnounce] = useState<Announcement | null>(null)

  const [detail, setDetail] = useState<DetailState | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailTab, setDetailTab] = useState<DetailTab>('body')
  const [sourceView, setSourceView] = useState<KnowledgeSourceView | null>(null)
  const [sourceLoading, setSourceLoading] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const [original, setOriginal] = useState<OriginalState | null>(null)
  const [originalLoading, setOriginalLoading] = useState(false)

  const [editor, setEditor] = useState<EditorSession | null>(null)
  const [editorSaving, setEditorSaving] = useState(false)
  const [editorError, setEditorError] = useState('')

  const [busy, setBusy] = useState(false)
  const [importing, setImporting] = useState(false)

  const editorRef = useRef<MarkdownEditorHandle>(null)
  const editorKey = useRef(0)
  const detailEpoch = useRef(0)
  const refreshEpoch = useRef(0)
  const importedKey = useRef('')
  const liveAssets = useRef<Record<string, string> | null>(null)
  const activeRef = useRef(active)
  activeRef.current = active

  /** Catalog, import records and suggestions are refreshed together after every write. */
  const refreshAll = useCallback(async (): Promise<void> => {
    const token = ++refreshEpoch.current
    try {
      const [nextCatalog, nextImports, nextProposals] = await Promise.all([api.catalog(), api.imports(), api.proposals()])
      if (token !== refreshEpoch.current) return
      setCatalog(nextCatalog)
      setImports(nextImports)
      setProposals(nextProposals)
      importedKey.current = importedKeyOf(nextImports)
    } catch (reason) {
      if (token === refreshEpoch.current) setError(messageOf(reason))
    }
  }, [api])

  useEffect(() => {
    if (!active) return
    let cancelled = false
    setLoading(true)
    void refreshAll().finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => {
      cancelled = true
      refreshEpoch.current += 1
    }
  }, [active, refreshAll])

  /* Release the body-resource object URLs when the surface goes away. */
  useEffect(() => () => {
    if (liveAssets.current === null) return
    for (const url of Object.values(liveAssets.current)) URL.revokeObjectURL(url)
    liveAssets.current = null
  }, [])

  const pendingImports = imports !== null && imports.items.some(item => item.status === 'received' || item.status === 'converting')

  /* Conversion keeps running on the Host; poll only while records are unfinished. */
  useEffect(() => {
    if (!active || !pendingImports) return
    const timer = window.setInterval(() => {
      void api.imports().then(next => {
        if (!activeRef.current) return
        setImports(next)
        const key = importedKeyOf(next)
        if (key === importedKey.current) return
        importedKey.current = key
        void api.catalog().then(nextCatalog => {
          if (activeRef.current) setCatalog(nextCatalog)
        }).catch(() => {
          /* The next poll or a user action refreshes the catalog again. */
        })
      }).catch(() => {
        /* Keep the current records; the next tick polls again. */
      })
    }, 1200)
    return () => window.clearInterval(timer)
  }, [active, pendingImports, api])

  const replaceLiveAssets = (assets: Record<string, string>): void => {
    if (liveAssets.current !== null) {
      for (const url of Object.values(liveAssets.current)) URL.revokeObjectURL(url)
    }
    liveAssets.current = assets
  }

  const readAssets = async (document: KnowledgeDocument): Promise<Record<string, string>> => {
    const entries = await Promise.all(document.resources.map(async (resource): Promise<[string, string] | null> => {
      try {
        return [resource.path, await api.readResource(document.packId, document.documentId, document.contentRevisionId, resource.path)]
      } catch {
        /* One unreadable image must not block the rest of the document. */
        return null
      }
    }))
    const assets: Record<string, string> = {}
    for (const entry of entries) {
      if (entry !== null) assets[entry[0]] = entry[1]
    }
    return assets
  }

  const openDocument = async (packId: KnowledgePackId, documentId: string, expectedRevisionId: string | null): Promise<void> => {
    const token = ++detailEpoch.current
    setView('detail')
    setDetail(null)
    setDetailTab('body')
    setSourceView(null)
    setSourceLoading(false)
    setDetailLoading(true)
    setError('')
    replaceLiveAssets(EMPTY_ASSETS)
    try {
      const document = await api.readDocument(packId, documentId, expectedRevisionId)
      if (token !== detailEpoch.current) return
      const assets = await readAssets(document)
      if (token !== detailEpoch.current) {
        for (const url of Object.values(assets)) URL.revokeObjectURL(url)
        return
      }
      replaceLiveAssets(assets)
      setDetail({ document, assets })
    } catch (reason) {
      if (token === detailEpoch.current) setError(messageOf(reason))
    } finally {
      if (token === detailEpoch.current) setDetailLoading(false)
    }
  }

  const backToLibrary = (): void => {
    detailEpoch.current += 1
    setView('library')
    setDetail(null)
    setDetailTab('body')
    setSourceView(null)
    setSourceLoading(false)
    setConfirmDelete(false)
    replaceLiveAssets(EMPTY_ASSETS)
  }

  const loadSource = async (document: KnowledgeDocument): Promise<void> => {
    const importId = document.source.importId
    if (importId === undefined) return
    if (sourceView !== null && sourceView.importId === importId) return
    const token = detailEpoch.current
    setSourceLoading(true)
    try {
      const next = await api.sourceView(importId)
      if (token !== detailEpoch.current) return
      setSourceView(next)
    } catch (reason) {
      if (token === detailEpoch.current) setError(messageOf(reason))
    } finally {
      if (token === detailEpoch.current) setSourceLoading(false)
    }
  }

  const changeDetailTab = (tab: DetailTab): void => {
    setDetailTab(tab)
    if (tab === 'source' && detail !== null) void loadSource(detail.document)
  }

  const toggleAutoReference = async (value: boolean): Promise<void> => {
    if (detail === null || busy) return
    const document = detail.document
    setBusy(true)
    setError('')
    try {
      await api.setAutoReference(document.packId, document.documentId, document.contentRevisionId, value)
      setDetail(current => current !== null && current.document.documentId === document.documentId
        ? { ...current, document: { ...current.document, autoReference: value } }
        : current)
      await refreshAll()
    } catch (reason) {
      setError(messageOf(reason))
    } finally {
      setBusy(false)
    }
  }

  const copyDocument = async (): Promise<void> => {
    if (detail === null || busy) return
    const document = detail.document
    setBusy(true)
    setError('')
    try {
      const copy = await api.copyBuiltin(document.documentId, document.contentRevisionId)
      setAnnounce({ tone: 'success', text: t('copied') })
      await refreshAll()
      await openDocument(copy.packId, copy.documentId, copy.contentRevisionId)
    } catch (reason) {
      setError(messageOf(reason))
    } finally {
      setBusy(false)
    }
  }

  const removeDocument = async (): Promise<void> => {
    if (detail === null || busy) return
    const document = detail.document
    setConfirmDelete(false)
    setBusy(true)
    setError('')
    try {
      await api.removeDocument(document.documentId, document.contentRevisionId)
      backToLibrary()
      setAnnounce({ tone: 'success', text: t('deleted') })
      await refreshAll()
    } catch (reason) {
      setError(messageOf(reason))
    } finally {
      setBusy(false)
    }
  }

  const retagDocument = async (): Promise<void> => {
    if (detail === null || busy) return
    const document = detail.document
    setBusy(true)
    setError('')
    try {
      await api.retagDocument(document.documentId, document.contentRevisionId)
      setDetail(current => current !== null && current.document.documentId === document.documentId
        ? { ...current, document: { ...current.document, organize: 'pending' } }
        : current)
      setAnnounce({ tone: 'info', text: t('retagRequested') })
      await refreshAll()
    } catch (reason) {
      setError(messageOf(reason))
    } finally {
      setBusy(false)
    }
  }

  const applyProposal = async (proposal: KnowledgeProposal): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await api.applyProposal(proposal.proposalId, proposal.action === 'update' ? proposal.baseRevisionId : null)
      setAnnounce({ tone: 'success', text: t('proposalApplied') })
      await refreshAll()
    } catch (reason) {
      setError(messageOf(reason))
      /* Refresh so the suggestion shows as outdated when its base content changed. */
      await refreshAll()
    } finally {
      setBusy(false)
    }
  }

  const discardProposal = async (proposal: KnowledgeProposal): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await api.discardProposal(proposal.proposalId)
      setAnnounce({ tone: 'info', text: t('proposalDiscarded') })
      await refreshAll()
    } catch (reason) {
      setError(messageOf(reason))
    } finally {
      setBusy(false)
    }
  }

  const startCreate = (): void => {
    editorKey.current += 1
    setEditorError('')
    setEditor({
      key: editorKey.current,
      mode: 'create',
      returnTo: 'library',
      documentId: null,
      expectedRevisionId: null,
      importId: null,
      fileName: '',
      markdown: '',
      assets: {},
      autoReference: true,
      title: '',
      category: '未分类',
      scope: '',
    })
    setView('editor')
  }

  const startEdit = (): void => {
    if (detail === null) return
    const { document, assets } = detail
    editorKey.current += 1
    setEditorError('')
    setEditor({
      key: editorKey.current,
      mode: 'edit',
      returnTo: 'detail',
      documentId: document.documentId,
      expectedRevisionId: document.contentRevisionId,
      importId: null,
      fileName: document.source.fileName ?? '',
      markdown: document.text,
      assets,
      autoReference: document.autoReference,
      title: document.title,
      category: document.category,
      scope: document.scope,
    })
    setView('editor')
  }

  const startManual = (item: KnowledgeImportItem): void => {
    editorKey.current += 1
    setEditorError('')
    setEditor({
      key: editorKey.current,
      mode: 'manual',
      returnTo: 'imports',
      documentId: null,
      expectedRevisionId: null,
      importId: item.importId,
      fileName: item.fileName,
      markdown: '',
      assets: {},
      autoReference: true,
      title: fileNameWithoutExtension(item.fileName),
      category: '未分类',
      scope: '',
    })
    setView('editor')
  }

  const cancelEditor = (): void => {
    const returnTo = editor === null ? 'library' : editor.returnTo
    setEditor(null)
    setEditorError('')
    setView(returnTo)
  }

  const updateEditor = (changes: Partial<Pick<EditorSession, 'title' | 'category' | 'scope'>>): void => {
    setEditor(current => current === null ? current : { ...current, ...changes })
  }

  const saveEditor = async (): Promise<void> => {
    if (editor === null || editorSaving) return
    const payload = editorRef.current?.getPayload()
    if (payload === undefined) {
      setEditorError(t('editorBodyMissing'))
      return
    }
    const title = editor.title.trim()
    if (title === '') {
      setEditorError(t('titleRequired'))
      return
    }
    const draft: KnowledgeDraft = {
      title,
      category: editor.category,
      scope: editor.scope.trim(),
      text: payload.text,
      autoReference: editor.autoReference,
    }
    setEditorSaving(true)
    setEditorError('')
    try {
      const saved = editor.mode === 'manual' && editor.importId !== null
        ? await api.saveManualDocument(editor.importId, draft, payload.resources)
        : await api.saveDocument(editor.documentId, editor.expectedRevisionId, draft, payload.resources)
      await refreshAll()
      /* Keep the editor mounted until the saved document is on screen. */
      await openDocument(saved.packId, saved.documentId, saved.contentRevisionId)
      setEditor(null)
      setAnnounce({ tone: 'success', text: t('saved') })
    } catch (reason) {
      setEditorError(messageOf(reason))
    } finally {
      setEditorSaving(false)
    }
  }

  const handleImportFiles = async (files: File[]): Promise<void> => {
    if (importing || files.length === 0) return
    const accepted: File[] = []
    const rejected: string[] = []
    for (const file of files) {
      if (file.size > IMPORT_MAX_BYTES) rejected.push(file.name)
      else accepted.push(file)
    }
    setError(rejected.length > 0 ? `${t('importTooLarge')}${rejected.join(t('listSeparator'))}` : '')
    if (accepted.length === 0) return
    setImporting(true)
    try {
      const payloads: KnowledgeImportFile[] = []
      for (const file of accepted) {
        payloads.push({ fileName: file.name, dataBase64: await readFileBase64(file) })
      }
      await api.importFiles(payloads)
      setAnnounce({ tone: 'success', text: t('importReceived') })
      await refreshAll()
    } catch (reason) {
      setError(reason instanceof Error && reason.message === READ_FAILED ? t('importReadFailed') : messageOf(reason))
    } finally {
      setImporting(false)
    }
  }

  const openImportDocument = async (item: KnowledgeImportItem): Promise<void> => {
    if (item.documentId === undefined) return
    await openDocument('user', item.documentId, null)
  }

  const openOriginal = async (item: KnowledgeImportItem): Promise<void> => {
    setOriginal({ title: item.fileName, view: null })
    setOriginalLoading(true)
    try {
      const view = await api.sourceView(item.importId)
      setOriginal({ title: item.fileName, view })
    } catch (reason) {
      setOriginal(null)
      setError(messageOf(reason))
    } finally {
      setOriginalLoading(false)
    }
  }

  const retryImport = async (item: KnowledgeImportItem): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await api.retryImport(item.importId)
      await refreshAll()
    } catch (reason) {
      setError(messageOf(reason))
    } finally {
      setBusy(false)
    }
  }

  const cancelImport = async (item: KnowledgeImportItem): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await api.cancelImport(item.importId)
      await refreshAll()
    } catch (reason) {
      setError(messageOf(reason))
    } finally {
      setBusy(false)
    }
  }

  const retryAllImports = async (): Promise<void> => {
    const waiting = imports === null ? [] : imports.items.filter(item => item.status === 'needs_handling')
    if (busy || waiting.length === 0) return
    setBusy(true)
    setError('')
    try {
      for (const item of waiting) await api.retryImport(item.importId)
      await refreshAll()
    } catch (reason) {
      setError(messageOf(reason))
    } finally {
      setBusy(false)
    }
  }

  const clearFinishedImports = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await api.clearFinishedImports()
      setAnnounce({ tone: 'info', text: t('importCleared') })
      await refreshAll()
    } catch (reason) {
      setError(messageOf(reason))
    } finally {
      setBusy(false)
    }
  }

  const switchView = (next: 'library' | 'imports'): void => {
    setView(next)
    setError('')
    setAnnounce(null)
  }

  const outdatedProposalIds = useMemo(() => {
    const revisions = new Map<string, string>()
    for (const pack of catalog === null ? [] : catalog.packs) {
      for (const document of pack.documents) revisions.set(document.documentId, document.contentRevisionId)
    }
    const outdated = new Set<string>()
    for (const proposal of proposals) {
      const current = revisions.get(proposal.documentId)
      const changed = proposal.action === 'create' ? current !== undefined : current !== proposal.baseRevisionId
      if (changed) outdated.add(proposal.proposalId)
    }
    return outdated
  }, [catalog, proposals])

  if (!active) return null

  return <Surface className={css.scope}>
    <section className={css.shell} aria-label={t('title')}>
      {view === 'library' || view === 'imports'
        ? <nav className={css.tabs} role="tablist" aria-label={t('title')}>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'library'}
            className={css.tab}
            onClick={() => switchView('library')}>{t('tabLibrary')}</button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'imports'}
            className={css.tab}
            onClick={() => switchView('imports')}>{t('tabImports')}</button>
        </nav>
        : null}
      {error !== '' || announce !== null
        ? <div className={css.noticeBar}>
          {error !== '' ? <Notice tone="danger" onDismiss={() => setError('')} dismissLabel={t('dismiss')}>{error}</Notice> : null}
          {announce !== null
            ? <Notice tone={announce.tone} onDismiss={() => setAnnounce(null)} dismissLabel={t('dismiss')}>{announce.text}</Notice>
            : null}
        </div>
        : null}
      <div className={css.body}>
        {view === 'library'
          ? <LibraryView
            catalog={catalog}
            loading={loading}
            filters={filters}
            onFiltersChange={setFilters}
            proposals={proposals}
            outdatedProposalIds={outdatedProposalIds}
            busy={busy}
            onOpenDocument={document => void openDocument(document.packId, document.documentId, null)}
            onNewDocument={startCreate}
            onOpenImports={() => switchView('imports')}
            onApplyProposal={proposal => void applyProposal(proposal)}
            onDiscardProposal={proposal => void discardProposal(proposal)}
            t={t} />
          : null}
        {view === 'imports'
          ? <ImportsView
            imports={imports}
            importing={importing}
            busy={busy}
            onFiles={files => void handleImportFiles(files)}
            onViewDocument={item => void openImportDocument(item)}
            onViewOriginal={item => void openOriginal(item)}
            onRetry={item => void retryImport(item)}
            onCancel={item => void cancelImport(item)}
            onManual={startManual}
            onClearFinished={() => void clearFinishedImports()}
            onRetryAll={() => void retryAllImports()}
            t={t} />
          : null}
        {view === 'detail'
          ? <DetailView
            document={detail === null ? null : detail.document}
            assets={detail === null ? EMPTY_ASSETS : detail.assets}
            loading={detailLoading}
            tab={detailTab}
            sourceView={sourceView}
            sourceLoading={sourceLoading}
            busy={busy}
            onBack={backToLibrary}
            onTab={changeDetailTab}
            onEdit={startEdit}
            onCopy={() => void copyDocument()}
            onDelete={() => setConfirmDelete(true)}
            onToggleAutoReference={value => void toggleAutoReference(value)}
            onRetag={() => void retagDocument()}
            t={t} />
          : null}
        {view === 'editor' && editor !== null
          ? <EditorPage
            session={editor}
            saving={editorSaving}
            error={editorError}
            editorRef={editorRef}
            onChange={updateEditor}
            onSave={() => void saveEditor()}
            onCancel={cancelEditor}
            t={t} />
          : null}
      </div>
    </section>
    {confirmDelete && detail !== null
      ? <Dialog
        title={t('deleteConfirmTitle')}
        description={t('deleteConfirm')}
        busy={busy}
        closeLabel={t('dismiss')}
        onClose={() => { if (!busy) setConfirmDelete(false) }}
        footer={<>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmDelete(false)}>{t('cancel')}</Button>
          <Button variant="danger" size="sm" loading={busy} onClick={() => void removeDocument()}>{t('deleteConfirmAction')}</Button>
        </>}>
        {null}
      </Dialog>
      : null}
    {original !== null
      ? <Dialog
        title={t('originalTitle')}
        description={original.title}
        busy={originalLoading}
        closeLabel={t('originalClose')}
        onClose={() => setOriginal(null)}
        footer={<Button variant="primary" size="sm" disabled={originalLoading} onClick={() => setOriginal(null)}>{t('originalConfirm')}</Button>}>
        {originalLoading
          ? <div className={css.dialogLoading}><Spinner /><span className={css.hint}>{t('sourceInfoLoading')}</span></div>
          : original.view === null
            ? <p className={css.hint}>{t('originalUnavailable')}</p>
            : <OriginalDetails view={original.view} t={t} />}
      </Dialog>
      : null}
  </Surface>
}
