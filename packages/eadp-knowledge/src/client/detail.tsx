import { useMemo, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { EadpRequirementsClient } from '@eadp/contracts'
import type { KnowledgeDocument, KnowledgeSourceSummary, KnowledgeSourceView } from '@eadp/contracts/knowledge'
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Field,
  IconChevronRight,
  IconFile,
  IconPencil,
  IconRefresh,
  IconSparkles,
  IconTrash,
  Notice,
  Spinner,
} from '@eadp/shell/client/ui'
import { MarkdownEditor } from '@eadp/shell/client/document-editor'
import { formatDateTime, formatFileSize } from './format.ts'
import { NS, type KnowledgeTranslate } from './locales.ts'
import layout from './panel.module.css'
import css from './detail.module.css'

/** Adoption explanation limit shared with the Host validation. */
const NOTE_LIMIT = 500

/** A selectable paragraph or section of the saved body, measured in Unicode code points. */
interface TextSegment {
  start: number
  end: number
  text: string
  heading: boolean
}

interface DetailNotice {
  tone: 'success' | 'warning'
  text: string
}

export interface DetailViewProps extends PropsLocale<typeof NS> {
  document: KnowledgeDocument | null
  /** Reading assets keyed by the document-relative path used in the body. */
  assets: Record<string, string>
  loading: boolean
  tab: 'body' | 'source'
  sourceView: KnowledgeSourceView | null
  sourceLoading: boolean
  busy: boolean
  /** Current project from the Shell; null when no project is open. */
  projectId: string | null
  /** Current requirement conversation from the Shell; null when none is selected. */
  sessionId: string | null
  /** Requirement the Shell is editing; null when no requirement is open. */
  requirementPath: string | null
  /** Requirement client service call; the only path from this view to a pending proposal. */
  adoptKnowledge: EadpRequirementsClient['adoptKnowledge']
  onBack(): void
  onTab(tab: 'body' | 'source'): void
  onEdit(): void
  onCopy(): void
  onDelete(): void
  onToggleAutoReference(value: boolean): void
  onRetag(): void
}

/** File type and size line of the source section; falls back when the original carries neither. */
function sourceFileInfo(source: KnowledgeSourceSummary, fallback: string): string {
  const parts: string[] = []
  if (source.fileType) parts.push(source.fileType)
  if (typeof source.size === 'number' && source.size >= 0) parts.push(formatFileSize(source.size))
  return parts.length > 0 ? parts.join(' · ') : fallback
}

const isWhitespace = (char: string): boolean => /\s/u.test(char)

/**
 * Split the already-read saved body into paragraph and section ranges. Offsets count
 * Unicode code points so the Host can validate them against the same saved content;
 * no extra read is issued for the adoption selection.
 * @param text - canonical body already loaded by the detail view.
 * @returns contiguous, non-empty segments in document order.
 */
function textSegments(text: string): TextSegment[] {
  const chars = Array.from(text)
  const segments: TextSegment[] = []
  let index = 0
  while (index < chars.length) {
    while (index < chars.length && isWhitespace(chars[index]!)) index += 1
    if (index >= chars.length) break
    const start = index
    let end = index
    while (end < chars.length) {
      if (chars[end] === '\n') {
        let look = end + 1
        while (look < chars.length && chars[look] !== '\n' && isWhitespace(chars[look]!)) look += 1
        if (look < chars.length && chars[look] === '\n') break
      }
      end += 1
    }
    let trimmed = end
    while (trimmed > start && isWhitespace(chars[trimmed - 1]!)) trimmed -= 1
    if (trimmed > start) {
      const body = chars.slice(start, trimmed).join('')
      segments.push({ start, end: trimmed, text: body, heading: /^#{1,6}\s/u.test(body) })
    }
    index = Math.max(end, index + 1)
  }
  return segments
}

/** Render a heading without its Markdown marker; adopted ranges keep the original text. */
const segmentLabel = (segment: TextSegment): string => segment.heading ? segment.text.replace(/^#{1,6}\s+/u, '') : segment.text

/** Remote failures carry machine codes in `details`; plain errors have none. */
const failureCode = (reason: unknown): string | undefined => {
  const details = (reason as { details?: { code?: unknown } } | null | undefined)?.details
  return typeof details?.code === 'string' ? details.code : undefined
}

/** Explain an adoption refusal in the user's words; Host business messages pass through. */
function adoptionFailureMessage(reason: unknown, t: KnowledgeTranslate): string {
  const failure = (reason as { failure?: { kind?: unknown } } | null | undefined)?.failure
  if (failure !== undefined && typeof failure === 'object') {
    if (failure.kind === 'draft') return t('adoptNeedsSaved')
    if (failure.kind === 'missingRequirement') return t('adoptMissingRequirement')
  }
  const code = failureCode(reason)
  if (code === 'STALE_VERSION' || code === 'VERSION_MISMATCH' || code === 'EVIDENCE_INVALID') return t('adoptStale')
  return reason instanceof Error && reason.message.trim() !== '' ? reason.message : t('adoptFailed')
}

/** Full-page document detail: identity, real actions, read-only body, and source/original tab. */
export function DetailView(props: DetailViewProps) {
  const { document, assets, loading, tab, sourceView, sourceLoading, busy, projectId, sessionId, requirementPath, adoptKnowledge, t } = props
  const [adoptOpen, setAdoptOpen] = useState(false)
  const [notice, setNotice] = useState<DetailNotice | null>(null)
  /* Reachable only through the source tab, which loads the source view before it renders details. */
  const diagnostic = sourceView === null ? null : sourceView.diagnostic
  const adoptionReady = projectId !== null && sessionId !== null && requirementPath !== null
  return <div className={layout.page}>
    <div className={layout.backRow}>
      <Button variant="ghost" size="sm" onClick={props.onBack}>
        <span className={layout.backIcon}><IconChevronRight /></span>
        {t('backToLibrary')}
      </Button>
    </div>
    {document === null
      ? (loading
        ? <div className={layout.loading}><Spinner /><span>{t('detailLoading')}</span></div>
        : <EmptyState
          title={t('detailUnavailable')}
          description={t('detailMissing')}
          action={<Button variant="secondary" size="sm" onClick={props.onBack}>{t('backToLibrary')}</Button>} />)
      : <article className={css.article} aria-label={t('detailEyebrow')}>
        <header className={css.head}>
          <div className={css.identity}>
            <div className={layout.eyebrow}>{t('detailEyebrow')}</div>
            <h1 className={css.title}>{document.title || t('untitled')}</h1>
            <div className={css.metaRow}>
              <Badge tone={document.readOnly ? 'neutral' : 'accent'}>
                {document.readOnly ? t('builtinBadge') : t('mineBadge')}
              </Badge>
              <span className={css.metaText}>{document.category}</span>
              <span className={css.metaText}>{document.source.label}</span>
              <span className={css.metaText}>{t('updatedAt')} {formatDateTime(document.updatedAt)}</span>
            </div>
          </div>
          <div className={css.actions}>
            <Button variant="secondary" size="sm" disabled={busy || !adoptionReady} onClick={() => setAdoptOpen(true)}><IconSparkles />{t('adoptAsBasis')}</Button>
            {document.readOnly
              ? <Button variant="secondary" size="sm" disabled={busy} onClick={props.onCopy}><IconFile />{t('copyToMine')}</Button>
              : <Button variant="primary" size="sm" disabled={busy} onClick={props.onEdit}><IconPencil />{t('editDocument')}</Button>}
            {document.readOnly
              ? null
              : <Button variant="ghost" size="sm" disabled={busy} onClick={props.onDelete}><IconTrash />{t('deleteDocument')}</Button>}
            <label className={css.switch} title={t('autoReferenceHint')}>
              <input
                type="checkbox"
                checked={document.autoReference}
                disabled={busy}
                onChange={event => props.onToggleAutoReference(event.target.checked)} />
              {t('autoReferenceLabel')}
            </label>
          </div>
        </header>
        {adoptionReady ? null : <p className={layout.hint}>{t('adoptNeedsContext')}</p>}
        {notice === null ? null : <Notice
          tone={notice.tone}
          onDismiss={() => setNotice(null)}
          dismissLabel={t('dismiss')}>{notice.text}</Notice>}
        <div className={css.tabs} role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'body'} className={css.tab} onClick={() => props.onTab('body')}>
            {t('detailTabBody')}
          </button>
          <button type="button" role="tab" aria-selected={tab === 'source'} className={css.tab} onClick={() => props.onTab('source')}>
            {t('detailTabSource')}
          </button>
        </div>
        {tab === 'body'
          ? <div className={css.bodyPane}>
            {document.organize === 'failed'
              ? <Notice
                tone="warning"
                title={t('organizeFailedTitle')}
                actions={<Button size="sm" variant="secondary" disabled={busy} onClick={props.onRetag}><IconRefresh />{t('retag')}</Button>}>
                {t('organizeFailedBody')}
              </Notice>
              : null}
            {document.organize === 'pending' ? <Notice tone="info">{t('organizePendingNotice')}</Notice> : null}
            <MarkdownEditor markdown={document.text} assets={assets} readOnly ariaLabel={document.title || t('untitled')} />
          </div>
          : <div className={css.sourcePane}>
            <h2 className={layout.sectionTitle}>{t('sourceSectionTitle')}</h2>
            <dl className={css.sourceList}>
              <dt>{t('sourceLabel')}</dt><dd>{document.source.label}</dd>
              {document.source.detail !== undefined && document.source.detail !== ''
                ? <><dt>{t('sourceDetail')}</dt><dd>{document.source.detail}</dd></>
                : null}
              <dt>{t('categoryField')}</dt><dd>{document.category}</dd>
              <dt>{t('scopeField')}</dt><dd>{document.scope.trim() === '' ? t('scopeNone') : document.scope}</dd>
              <dt>{t('sourceFile')}</dt><dd>{document.source.fileName ?? t('sourceFileNone')}</dd>
              <dt>{t('sourceFileInfo')}</dt><dd>{sourceFileInfo(document.source, document.source.hasOriginal ? t('sourceFileInfoNone') : t('sourceFileNone'))}</dd>
              <dt>{t('locationsLabel')}</dt><dd>{document.locations.length > 0 ? document.locations.join(t('listSeparator')) : t('locationsNone')}</dd>
              <dt>{t('warningsLabel')}</dt><dd>{document.warnings.length > 0 ? document.warnings.join(t('sentenceSeparator')) : t('warningsNone')}</dd>
            </dl>
            {document.source.hasOriginal
              ? <section className={css.preview}>
                <h3 className={layout.sectionTitle}>{t('sourcePreview')}</h3>
                {sourceLoading
                  ? <Spinner />
                  : sourceView?.textPreview
                    ? <pre className={css.previewText}>{sourceView.textPreview}</pre>
                    : <p className={layout.hint}>{t('sourceNoPreview')}</p>}
              </section>
              : <p className={layout.hint}>{t('sourceFileNone')}</p>}
            {diagnostic
              ? <details className={css.details}>
                <summary>{t('processingDetails')}</summary>
                <pre className={css.diagnostic}>{diagnostic}</pre>
              </details>
              : null}
            <p className={layout.hint}>{t('sourceHint')}</p>
          </div>}
      </article>}
    {adoptOpen && document !== null && adoptionReady
      ? <AdoptionDialog
        document={document}
        projectId={projectId}
        sessionId={sessionId}
        requirementPath={requirementPath}
        adoptKnowledge={adoptKnowledge}
        t={t}
        onClose={() => setAdoptOpen(false)}
        onAdopted={() => {
          setAdoptOpen(false)
          setNotice({ tone: 'success', text: t('adoptSuccess') })
        }} />
      : null}
  </div>
}

interface AdoptionDialogProps extends PropsLocale<typeof NS> {
  document: KnowledgeDocument
  projectId: string
  sessionId: string
  requirementPath: string
  adoptKnowledge: EadpRequirementsClient['adoptKnowledge']
  onClose(): void
  onAdopted(): void
}

/** Select actual saved ranges and explain why they become a requirement ground. */
function AdoptionDialog({ document, projectId, sessionId, requirementPath, adoptKnowledge, onClose, onAdopted, t }: AdoptionDialogProps) {
  const segments = useMemo(() => textSegments(document.text), [document.text])
  const [selected, setSelected] = useState<ReadonlySet<number>>(() => new Set<number>())
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const noteLength = Array.from(note.trim()).length
  const toggle = (index: number): void => {
    setSelected(previous => {
      const next = new Set(previous)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }
  const submit = async (): Promise<void> => {
    if (submitting) return
    if (selected.size === 0) { setError(t('adoptNoSelection')); return }
    if (noteLength === 0) { setError(t('adoptNoteRequired')); return }
    if (noteLength > NOTE_LIMIT) { setError(t('adoptNoteTooLong')); return }
    const ranges = segments.filter((_, index) => selected.has(index)).map(segment => ({ start: segment.start, end: segment.end }))
    setSubmitting(true)
    setError('')
    try {
      await adoptKnowledge({
        projectId,
        sessionId,
        adoption: {
          relativePath: requirementPath,
          /* The client service resolves the loaded requirement version this adoption must match. */
          baseVersion: null,
          note: note.trim(),
          source: {
            kind: 'document',
            packId: document.packId,
            documentId: document.documentId,
            contentRevisionId: document.contentRevisionId,
            ranges,
          },
        },
      })
      onAdopted()
    } catch (reason) {
      setError(adoptionFailureMessage(reason, t))
    } finally {
      setSubmitting(false)
    }
  }
  return <Dialog
    title={t('adoptTitle')}
    description={t('adoptIntro')}
    busy={submitting}
    closeLabel={t('dismiss')}
    onClose={() => { if (!submitting) onClose() }}
    footer={<>
      <Button size="sm" variant="ghost" disabled={submitting} onClick={onClose}>{t('cancel')}</Button>
      <Button
        size="sm"
        variant="primary"
        loading={submitting}
        disabled={selected.size === 0 || noteLength === 0 || noteLength > NOTE_LIMIT}
        onClick={() => { void submit() }}>{t('adoptSubmit')}</Button>
    </>}>
    <div className={css.adoptSections}>
      <h3 className={layout.sectionTitle}>{t('adoptSection')}</h3>
      <p className={layout.hint}>{t('adoptSectionHint')}</p>
      <ul className={css.segments}>
        {segments.map((segment, index) => <li key={index} className={css.segment}>
          <label className={css.segmentCheck}>
            <input
              type="checkbox"
              checked={selected.has(index)}
              disabled={submitting}
              onChange={() => toggle(index)} />
            <span className={css.segmentTag}>
              {segment.heading ? t('segmentHeading') : `${t('segmentParagraph')} ${index + 1}`}
            </span>
          </label>
          <p className={css.segmentText} data-heading={segment.heading || undefined}>{segmentLabel(segment)}</p>
        </li>)}
      </ul>
      <p className={layout.hint}>{selected.size === 0 ? t('adoptNoSelection') : `${t('adoptSelected')}${selected.size}`}</p>
    </div>
    <Field
      label={t('adoptNoteLabel')}
      htmlFor="eadp-adopt-document-note"
      hint={t('adoptNoteHint')}>
      <textarea
        id="eadp-adopt-document-note"
        className={css.adoptTextarea}
        value={note}
        rows={4}
        disabled={submitting}
        onChange={event => setNote(event.target.value)} />
      <span className={layout.hint}>{noteLength}/{NOTE_LIMIT}</span>
    </Field>
    {error === '' ? null : <Notice tone="danger">{error}</Notice>}
  </Dialog>
}
