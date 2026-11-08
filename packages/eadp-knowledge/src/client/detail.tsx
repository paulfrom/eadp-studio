import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { KnowledgeDocument, KnowledgeSourceSummary, KnowledgeSourceView } from '@eadp/contracts/knowledge'
import {
  Badge,
  Button,
  EmptyState,
  IconChevronRight,
  IconFile,
  IconPencil,
  IconRefresh,
  IconTrash,
  Notice,
  Spinner,
} from '@eadp/shell/client/ui'
import { MarkdownEditor } from './editor/index.ts'
import { formatDateTime, formatFileSize } from './format.ts'
import { NS } from './locales.ts'
import layout from './panel.module.css'
import css from './detail.module.css'

export interface DetailViewProps extends PropsLocale<typeof NS> {
  document: KnowledgeDocument | null
  /** Reading assets keyed by the document-relative path used in the body. */
  assets: Record<string, string>
  loading: boolean
  tab: 'body' | 'source'
  sourceView: KnowledgeSourceView | null
  sourceLoading: boolean
  busy: boolean
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

/** Full-page document detail: identity, real actions, read-only body, and source/original tab. */
export function DetailView(props: DetailViewProps) {
  const { document, assets, loading, tab, sourceView, sourceLoading, busy, t } = props
  /* Reachable only through the source tab, which loads the source view before it renders details. */
  const diagnostic = sourceView === null ? null : sourceView.diagnostic
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
  </div>
}
