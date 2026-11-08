import { useRef, useState, type ChangeEvent, type DragEvent, type KeyboardEvent } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { KnowledgeImportItem, KnowledgeImportStatus, KnowledgeImports } from '@eadp/contracts/knowledge'
import { Badge, Button, EmptyState, IconFile, IconPlus, IconRefresh, Notice, Spinner } from '@eadp/shell/client/ui'
import { formatFileSize } from './format.ts'
import { NS } from './locales.ts'
import layout from './panel.module.css'
import css from './imports.module.css'

type StatusKey =
  | 'statusReceived'
  | 'statusConverting'
  | 'statusImported'
  | 'statusNeedsHandling'
  | 'statusDuplicate'
  | 'statusCancelled'

const STATUS_PRESENTATION: Record<KnowledgeImportStatus, { key: StatusKey; tone: 'neutral' | 'accent' | 'success' | 'warning' | 'danger' }> = {
  received: { key: 'statusReceived', tone: 'neutral' },
  converting: { key: 'statusConverting', tone: 'accent' },
  imported: { key: 'statusImported', tone: 'success' },
  needs_handling: { key: 'statusNeedsHandling', tone: 'danger' },
  duplicate: { key: 'statusDuplicate', tone: 'warning' },
  cancelled: { key: 'statusCancelled', tone: 'neutral' },
}

export interface ImportsViewProps extends PropsLocale<typeof NS> {
  imports: KnowledgeImports | null
  importing: boolean
  busy: boolean
  onFiles(files: File[]): void
  onViewDocument(item: KnowledgeImportItem): void
  onViewOriginal(item: KnowledgeImportItem): void
  onRetry(item: KnowledgeImportItem): void
  onCancel(item: KnowledgeImportItem): void
  onManual(item: KnowledgeImportItem): void
  onClearFinished(): void
  onRetryAll(): void
}

/** Import records page: drop zone, per-file status, and the recoverable actions of each record. */
export function ImportsView(props: ImportsViewProps) {
  const { imports, importing, busy, t } = props
  const input = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const items = imports?.items ?? []
  const hasNeedsHandling = items.some(item => item.status === 'needs_handling')
  const hasFinished = items.some(item => item.status === 'imported' || item.status === 'duplicate' || item.status === 'cancelled')

  const choose = (): void => {
    input.current?.click()
  }
  const acceptFiles = (files: File[]): void => {
    if (files.length > 0) props.onFiles(files)
  }
  const onInputChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const files = event.target.files === null ? [] : Array.from(event.target.files)
    event.target.value = ''
    acceptFiles(files)
  }
  const onDragEnter = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    setDragging(true)
  }
  const onDragOver = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    setDragging(true)
  }
  const onDragLeave = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    setDragging(false)
  }
  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    setDragging(false)
    acceptFiles(Array.from(event.dataTransfer.files))
  }
  const onDropzoneKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    choose()
  }

  return <div className={layout.page}>
    <header className={layout.heading}>
      <div className={layout.headingText}>
        <div className={layout.eyebrow}>{t('importsEyebrow')}</div>
        <h1 className={layout.pageTitle}>{t('importsTitle')}</h1>
        <p className={layout.intro}>{t('importsIntro')}</p>
      </div>
      <div className={layout.headingActions}>
        <Button variant="primary" disabled={importing} onClick={choose}><IconPlus />{t('addFiles')}</Button>
      </div>
    </header>
    {importing ? <Notice tone="info">{t('importReading')}</Notice> : null}
    <div
      className={css.dropzone}
      role="button"
      tabIndex={0}
      aria-label={t('dropLabel')}
      data-dragging={dragging ? '' : undefined}
      onClick={choose}
      onKeyDown={onDropzoneKeyDown}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}>
      <span className={css.dropIcon}><IconFile size={24} /></span>
      <div className={css.dropText}>
        <h2 className={css.dropTitle}>{t('dropTitle')}</h2>
        <p className={css.dropHint}>{t('dropHint')}</p>
      </div>
    </div>
    <input ref={input} type="file" multiple hidden onChange={onInputChange} />
    <div className={css.principle}>
      <p className={css.principleTitle}>{t('importPrincipleTitle')}</p>
      <p>{t('importPrinciple')}</p>
    </div>
    <div className={css.toolbar}>
      <h2 className={css.toolbarTitle}>
        {t('importQueueTitle')}
        <span className={css.toolbarCount}>{items.length} {t('itemCount')}</span>
      </h2>
      <div className={css.toolbarActions}>
        <Button size="sm" variant="secondary" disabled={busy || !hasNeedsHandling} onClick={props.onRetryAll}>
          <IconRefresh />{t('retryFailed')}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy || !hasFinished} onClick={props.onClearFinished}>
          {t('clearFinished')}
        </Button>
      </div>
    </div>
    {imports === null
      ? <div className={layout.loading}><Spinner /><span>{t('loading')}</span></div>
      : items.length === 0
        ? <EmptyState icon={<IconFile />} title={t('importEmpty')} />
        : <ul className={css.queue}>{items.map(item => {
          const status = STATUS_PRESENTATION[item.status]
          return <li key={item.importId}>
            <article className={css.item} data-status={item.status}>
              <div className={css.fileCell}>
                <span className={css.fileIcon}><IconFile /></span>
                <div className={css.fileText}>
                  <span className={css.fileName}>{item.fileName}</span>
                  <span className={css.fileMeta}>{item.fileType ?? t('fileTypeUnknown')} · {formatFileSize(item.size)}</span>
                  <span className={css.statusRow}>
                    <Badge tone={status.tone}>{t(status.key)}</Badge>
                    {item.manual ? <Badge tone="neutral">{t('statusManual')}</Badge> : null}
                  </span>
                </div>
              </div>
              <div className={css.messageCell}>
                {item.message ? <p className={css.message}>{item.message}</p> : null}
                {item.problem ? <p className={css.problem}>{item.problem}</p> : null}
                {item.diagnostic
                  ? <details className={css.details}>
                    <summary>{t('processingDetails')}</summary>
                    <pre className={css.diagnostic}>{item.diagnostic}</pre>
                  </details>
                  : null}
              </div>
              <div className={css.itemActions}>
                {item.documentId && (item.status === 'imported' || item.status === 'duplicate')
                  ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => props.onViewDocument(item)}>{t('itemViewDocument')}</Button>
                  : null}
                {item.status === 'imported' || item.status === 'needs_handling' || item.status === 'duplicate'
                  ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => props.onViewOriginal(item)}>{t('itemViewOriginal')}</Button>
                  : null}
                {item.status === 'needs_handling'
                  ? <>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => props.onManual(item)}>{t('itemManual')}</Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => props.onRetry(item)}>{t('itemRetry')}</Button>
                  </>
                  : null}
                {item.status === 'received' || item.status === 'converting'
                  ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => props.onCancel(item)}>{t('itemCancel')}</Button>
                  : null}
              </div>
            </article>
          </li>
        })}</ul>}
  </div>
}
