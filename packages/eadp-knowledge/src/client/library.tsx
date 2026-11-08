import { useMemo } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import {
  KNOWLEDGE_CATEGORIES,
  type KnowledgeCatalog,
  type KnowledgeCategory,
  type KnowledgeDocumentSummary,
  type KnowledgeProposal,
} from '@eadp/contracts/knowledge'
import { Badge, Button, EmptyState, IconFile, IconPlus, IconSearch, Input, Spinner } from '@eadp/shell/client/ui'
import { NS } from './locales.ts'
import css from './panel.module.css'

/** Business source grouping: everything, the read-only built-in pack, or user documents. */
export type SourceFilter = 'all' | 'builtin' | 'mine'

/** Library filters owned by the panel so they survive opening a document and coming back. */
export interface LibraryFilters {
  category: KnowledgeCategory | null
  source: SourceFilter
  query: string
}

export interface LibraryViewProps extends PropsLocale<typeof NS> {
  catalog: KnowledgeCatalog | null
  loading: boolean
  filters: LibraryFilters
  onFiltersChange(filters: LibraryFilters): void
  proposals: KnowledgeProposal[]
  /** Proposals whose base content changed since the suggestion was generated. */
  outdatedProposalIds: ReadonlySet<string>
  busy: boolean
  onOpenDocument(document: KnowledgeDocumentSummary): void
  onNewDocument(): void
  onOpenImports(): void
  onApplyProposal(proposal: KnowledgeProposal): void
  onDiscardProposal(proposal: KnowledgeProposal): void
}

function documentsOf(catalog: KnowledgeCatalog | null): KnowledgeDocumentSummary[] {
  return catalog === null ? [] : catalog.packs.flatMap(pack => pack.documents)
}

/** Front-end filtering keeps the list responsive without a Host round trip. */
function filterDocuments(catalog: KnowledgeCatalog | null, filters: LibraryFilters): KnowledgeDocumentSummary[] {
  const query = filters.query.trim().toLocaleLowerCase()
  return documentsOf(catalog).filter(document => {
    if (filters.category !== null && document.category !== filters.category) return false
    if (filters.source === 'builtin' && document.packId !== 'builtin') return false
    if (filters.source === 'mine' && document.packId === 'builtin') return false
    if (query === '') return true
    return [document.title, document.excerpt, ...document.tags].some(value => value.toLocaleLowerCase().includes(query))
  })
}

function countByCategory(catalog: KnowledgeCatalog | null): ReadonlyMap<KnowledgeCategory, number> {
  const counts = new Map<KnowledgeCategory, number>()
  for (const document of documentsOf(catalog)) {
    counts.set(document.category, (counts.get(document.category) ?? 0) + 1)
  }
  return counts
}

function isSourceFilter(value: string): value is SourceFilter {
  return value === 'all' || value === 'builtin' || value === 'mine'
}

/** Library page: heading actions, category directory, source and search filters, document cards, suggestions. */
export function LibraryView(props: LibraryViewProps) {
  const { catalog, loading, filters, proposals, outdatedProposalIds, busy, t } = props
  const documents = useMemo(() => filterDocuments(catalog, filters), [catalog, filters])
  const counts = useMemo(() => countByCategory(catalog), [catalog])
  const total = useMemo(() => documentsOf(catalog).length, [catalog])
  const update = (changes: Partial<LibraryFilters>): void => props.onFiltersChange({ ...filters, ...changes })

  return <div className={css.page}>
    <header className={css.heading}>
      <div className={css.headingText}>
        <div className={css.eyebrow}>{t('libraryEyebrow')}</div>
        <h1 className={css.pageTitle}>{t('libraryTitle')}</h1>
        <p className={css.intro}>{t('libraryIntro')}</p>
      </div>
      <div className={css.headingActions}>
        <Button variant="primary" onClick={props.onOpenImports}><IconFile />{t('importFiles')}</Button>
        <Button variant="secondary" onClick={props.onNewDocument}><IconPlus />{t('newDocument')}</Button>
      </div>
    </header>
    <p className={css.callout}>{t('libraryNote')}</p>
    <div className={css.workspace}>
      <aside className={css.directory} aria-label={t('directoryTitle')}>
        <h2 className={css.sectionTitle}>{t('directoryTitle')}</h2>
        <p className={css.hint}>{t('directoryHint')}</p>
        <ul className={css.categoryList}>
          <li>
            <button
              type="button"
              className={css.categoryButton}
              data-active={filters.category === null ? '' : undefined}
              aria-pressed={filters.category === null}
              onClick={() => update({ category: null })}>
              <span>{t('categoryAll')}</span>
              <span className={css.categoryCount}>{total}</span>
            </button>
          </li>
          {KNOWLEDGE_CATEGORIES.map(category => <li key={category}>
            <button
              type="button"
              className={css.categoryButton}
              data-active={filters.category === category ? '' : undefined}
              aria-pressed={filters.category === category}
              onClick={() => update({ category })}>
              <span>{category}</span>
              <span className={css.categoryCount}>{counts.get(category) ?? 0}</span>
            </button>
          </li>)}
        </ul>
        <label className={css.fieldBlock}>
          <span className={css.fieldLabel}>{t('sourceFilterLabel')}</span>
          <select className={css.select} value={filters.source} onChange={event => {
            const next = event.target.value
            if (isSourceFilter(next)) update({ source: next })
          }}>
            <option value="all">{t('sourceAll')}</option>
            <option value="builtin">{t('sourceBuiltin')}</option>
            <option value="mine">{t('sourceMine')}</option>
          </select>
        </label>
        <p className={css.hint}>{t('sourceFilterHint')}</p>
      </aside>
      <section className={css.listPanel} aria-label={t('tabLibrary')}>
        <div className={css.searchWrap}>
          <span className={css.searchIcon}><IconSearch /></span>
          <Input
            style={{ paddingLeft: 32 }}
            value={filters.query}
            onChange={event => update({ query: event.target.value })}
            placeholder={t('searchPlaceholder')}
            aria-label={t('searchLabel')} />
        </div>
        <p className={css.listMeta}>{documents.length} {t('listCount')} · {t('listHint')}</p>
        {loading && catalog === null
          ? <div className={css.loading}><Spinner /><span>{t('loading')}</span></div>
          : documents.length === 0
            ? <EmptyState icon={<IconSearch />} title={t('listEmptyTitle')} description={t('listEmptyDescription')} />
            : <ul className={css.list}>{documents.map(document => <li key={`${document.packId}/${document.documentId}`}>
              <article className={css.card}>
                <button type="button" className={css.cardTitle} onClick={() => props.onOpenDocument(document)}>
                  {document.title || t('untitled')}
                </button>
                <div className={css.cardMeta}>
                  <Badge tone={document.packId === 'builtin' ? 'neutral' : 'accent'}>
                    {document.packId === 'builtin' ? t('builtinBadge') : t('mineBadge')}
                  </Badge>
                  <span className={css.cardMetaText}>{document.category}</span>
                  <span className={css.cardMetaText}>{document.source.label}</span>
                </div>
                {document.excerpt ? <p className={css.excerpt}>{document.excerpt}</p> : null}
                <div className={css.tags}>
                  {document.tags.length > 0
                    ? document.tags.map(tag => <span key={tag} className={css.tag}>{tag}</span>)
                    : <span className={css.tagsEmpty}>{t('tagsPending')}</span>}
                </div>
                {document.organize === 'failed'
                  ? <p className={css.inlineStatus}>{t('organizeFailed')}</p>
                  : document.organize === 'pending'
                    ? <p className={css.inlineStatus}>{t('organizePending')}</p>
                    : null}
              </article>
            </li>)}</ul>}
      </section>
    </div>
    {proposals.length > 0 ? <section className={css.suggestions} aria-label={t('proposalsTitle')}>
      <details>
        <summary className={css.suggestionsSummary}>
          <span>{t('proposalsTitle')}</span>
          <Badge tone="warning">{proposals.length}</Badge>
        </summary>
        <p className={css.hint}>{t('proposalsHint')}</p>
        <ul className={css.proposalList}>
          {proposals.map(proposal => {
            const outdated = outdatedProposalIds.has(proposal.proposalId)
            return <li className={css.proposal} key={proposal.proposalId}>
              <div className={css.proposalHead}>
                <h3 className={css.proposalTitle}>{proposal.draft.title || t('untitled')}</h3>
                <Badge tone="accent">{t(proposal.action === 'create' ? 'proposalCreate' : 'proposalUpdate')}</Badge>
              </div>
              <p className={css.proposalSummary}>{proposal.summary}</p>
              {outdated ? <p className={css.proposalOutdated}>{t('proposalOutdated')}</p> : null}
              <div className={css.proposalActions}>
                <Button size="sm" variant="secondary" disabled={busy || outdated} onClick={() => props.onApplyProposal(proposal)}>
                  {t('proposalApply')}
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => props.onDiscardProposal(proposal)}>
                  {t('proposalDiscard')}
                </Button>
              </div>
            </li>
          })}
        </ul>
      </details>
    </section> : null}
  </div>
}
