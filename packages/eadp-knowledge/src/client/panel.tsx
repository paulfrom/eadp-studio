import { useEffect, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { EadpKnowledgeSlotProps } from '@eadp/contracts'
import type {
  KnowledgeCatalog,
  KnowledgeDraft,
  KnowledgeRead,
  KnowledgeReference,
  KnowledgeSearchResult,
  KnowledgeProposal,
} from '@eadp/contracts/knowledge'
import type { KnowledgeApi } from './api.ts'
import { NS } from './locales.ts'

type Props = EadpKnowledgeSlotProps & PropsLocale<typeof NS> & { api: KnowledgeApi }
type Edit = { id: string | null; version: string; draft: KnowledgeDraft; tagsText: string }
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
const blank = (): KnowledgeDraft => ({ title: '', source: '', scope: '', tags: [], text: '' })

/** Keeps browsing and editor buffers independent so refreshes cannot replace unsaved input. */
export function KnowledgePanel({ active, api, t }: Props) {
  const [catalog, setCatalog] = useState<KnowledgeCatalog | null>(null)
  const [proposals, setProposals] = useState<KnowledgeProposal[]>([])
  const [result, setResult] = useState<KnowledgeSearchResult | null>(null)
  const [query, setQuery] = useState('')
  const [card, setCard] = useState<KnowledgeRead | null>(null)
  const [edit, setEdit] = useState<Edit | null>(null)
  const [error, setError] = useState('')
  const [stale, setStale] = useState(false)
  const [busy, setBusy] = useState(false)
  const [outdated, setOutdated] = useState<Set<string>>(new Set())
  const epoch = useRef(0),
    selection = useRef(0),
    searchEpoch = useRef(0),
    refreshEpoch = useRef(0)
  const displayed = useRef({ card, result })
  displayed.current = { card, result }
  const user = catalog?.packs.find((pack) => pack.packId === 'user')
  const valid = (value: number) => value === epoch.current
  const refresh = async (value = epoch.current) => {
    const request = ++refreshEpoch.current
    try {
      const [next, pending] = await Promise.all([api.catalog(), api.proposals()])
      if (!valid(value) || request !== refreshEpoch.current) return
      setCatalog(next)
      setProposals(pending)
      const shown = displayed.current
      const references = [
        ...(shown.card ? [shown.card.reference] : []),
        ...(shown.result?.hits.map((hit) => hit.reference) ?? []),
      ]
      setStale(
        references.some(
          (reference) =>
            next.packs.find((pack) => pack.packId === reference.packId)?.packVersion !==
            reference.packVersion,
        ),
      )
    } catch (reason) {
      if (valid(value) && request === refreshEpoch.current) {
        setError(message(reason))
        setStale(true)
      }
    }
  }
  useEffect(() => {
    const value = ++epoch.current
    setBusy(false)
    if (active) void refresh(value)
    const focus = () => {
      if (active) void refresh(value)
    }
    window.addEventListener('focus', focus)
    return () => {
      epoch.current++
      selection.current++
      searchEpoch.current++
      window.removeEventListener('focus', focus)
    }
  }, [active, api])
  const open = async (reference: KnowledgeReference, append = false) => {
    if (busy) return
    const value = epoch.current,
      request = ++selection.current
    const previous = card
    try {
      const next = await api.read(
        reference.packId,
        reference.documentId,
        reference.packVersion,
        append ? (previous?.nextOffset ?? 0) : 0,
        8000,
      )
      if (!valid(value) || request !== selection.current) return
      setCard(
        append && previous
          ? {
              ...next,
              offset: 0,
              length: previous.length + next.length,
              text: previous.text + next.text,
            }
          : next,
      )
      setError('')
    } catch (reason) {
      if (valid(value) && request === selection.current) {
        setError(message(reason))
        setStale(true)
      }
    }
  }
  const search = async () => {
    if (busy) return
    const value = epoch.current,
      request = ++searchEpoch.current
    try {
      const next = await api.search(query, 20, 'all')
      if (valid(value) && request === searchEpoch.current) {
        setResult(next)
        setError('')
      }
    } catch (reason) {
      if (valid(value) && request === searchEpoch.current) {
        setError(message(reason))
        setStale(true)
      }
    }
  }
  const act = async (work: () => Promise<void>) => {
    if (busy) return
    const value = epoch.current
    setBusy(true)
    setError('')
    selection.current++
    searchEpoch.current++
    try {
      await work()
      if (valid(value)) await refresh(value)
    } catch (reason) {
      if (valid(value)) {
        setError(message(reason))
        setStale(true)
      }
    } finally {
      if (valid(value)) setBusy(false)
    }
  }
  const save = () => {
    if (!edit) return
    const buffer = edit,
      value = epoch.current
    void act(async () => {
      const saved = await api.save(buffer.id, buffer.version, buffer.draft)
      if (valid(value)) {
        setEdit(null)
        setCard(saved)
        setResult(null)
      }
    })
  }
  const apply = (proposal: KnowledgeProposal) => {
    const value = epoch.current
    void act(async () => {
      try {
        const saved = await api.apply(proposal.proposalId, proposal.baseVersion)
        if (valid(value)) {
          setCard(saved)
          setResult(null)
        }
      } catch (reason) {
        if (
          valid(value) &&
          (reason as { details?: { code?: string } })?.details?.code === 'VERSION_MISMATCH'
        )
          setOutdated((previous) => new Set([...previous, proposal.proposalId]))
        throw reason
      }
    })
  }
  if (!active) return null
  const fields: Array<keyof Omit<KnowledgeDraft, 'tags'>> = ['title', 'source', 'scope', 'text']
  return (
    <section
      aria-label={t('title')}
      style={{ padding: '1.25rem', overflow: 'auto', height: '100%', boxSizing: 'border-box' }}
    >
      <h2>{t('title')}</h2>
      <p>{t('reference')}</p>
      <div>
        <button disabled={busy} onClick={() => void refresh()}>
          {t('refresh')}
        </button>{' '}
        <button
          disabled={busy || !!edit || !user}
          onClick={() =>
            setEdit({ id: null, version: user!.packVersion, draft: blank(), tagsText: '' })
          }
        >
          {t('newCard')}
        </button>
      </div>
      {busy && <p role="status">{t('loading')}</p>}
      {error && <p role="alert">{error}</p>}
      {stale && <p role="status">{t('stale')}</p>}
      {!catalog && <p>{t('unavailable')}</p>}
      {catalog?.issues.map((issue, i) => (
        <p role="alert" key={i}>
          {t('issue')} · {issue.packId} · {issue.documentId} · {issue.code}: {issue.message}
        </p>
      ))}
      {catalog?.issues.some(
        (issue) => issue.packId === 'user' && issue.code === 'RESOURCE_INVALID',
      ) && (
        <button
          disabled={busy || !!edit}
          onClick={() => {
            const value = epoch.current
            void act(async () => {
              const next = await api.repair()
              if (valid(value)) {
                setCatalog(next)
                setResult(null)
              }
            })
          }}
        >
          {t('repair')}
        </button>
      )}
      {user && !user.exists && <p>{t('missing')}</p>}
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void search()
        }}
      >
        <label>
          {t('query')}{' '}
          <input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              searchEpoch.current++
            }}
          />
        </label>{' '}
        <button disabled={busy}>{t('search')}</button>
      </form>
      {result && (
        <section aria-label={t('search')}>
          {result.issues.map((issue, i) => (
            <p role="alert" key={i}>
              {issue.packId} · {issue.code}: {issue.message}
            </p>
          ))}
          {!result.hits.length && !result.issues.length && <p>{t('searchEmpty')}</p>}
          {result.hits.map((hit) => (
            <article key={`${hit.reference.packId}/${hit.reference.documentId}`}>
              <button disabled={busy} onClick={() => void open(hit.reference)}>
                {hit.title}
              </button>
              <p>
                {hit.reference.packId} · {t('version')} {hit.reference.packVersion} · {t('source')}:{' '}
                {hit.source} · {t('scope')}: {hit.scope}
              </p>
              <p>{hit.excerpt}</p>
            </article>
          ))}
        </section>
      )}
      {catalog?.packs.map((pack) => (
        <section key={pack.packId}>
          <h3>
            {t(pack.packId === 'builtin' ? 'builtin' : 'user')} · {t('version')} {pack.packVersion}
          </h3>
          {!pack.cards.length && !catalog.issues.some((issue) => issue.packId === pack.packId) && (
            <p>{t('empty')}</p>
          )}
          {pack.cards.map((item) => (
            <article key={item.documentId}>
              <button disabled={busy} onClick={() => void open(item)}>
                {item.title}
              </button>
              <p>
                {t('source')}: {item.source} · {t('scope')}: {item.scope} · {item.tags.join(', ')}
              </p>
            </article>
          ))}
        </section>
      ))}
      {card && (
        <section aria-label={t('load')}>
          <h3>{card.title}</h3>
          <p>
            {card.reference.packId} · {t('version')} {card.reference.packVersion} · {t('source')}:{' '}
            {card.source} · {t('scope')}: {card.scope} · {card.tags.join(', ')}
          </p>
          <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{card.text}</pre>
          {card.truncated && (
            <button disabled={busy} onClick={() => void open(card.reference, true)}>
              {t('more')}
            </button>
          )}
          {card.reference.packId === 'user' && (
            <div>
              <button
                disabled={busy || !!edit || card.truncated}
                onClick={() =>
                  setEdit({
                    id: card.reference.documentId,
                    version: card.reference.packVersion,
                    tagsText: card.tags.join(', '),
                    draft: {
                      title: card.title,
                      source: card.source,
                      scope: card.scope,
                      tags: [...card.tags],
                      text: card.text,
                    },
                  })
                }
              >
                {t('edit')}
              </button>{' '}
              <button
                disabled={busy || !!edit}
                onClick={() => {
                  if (window.confirm(t('deleteConfirm'))) {
                    const value = epoch.current
                    void act(async () => {
                      await api.remove(card.reference.documentId, card.reference.packVersion)
                      if (valid(value)) {
                        setCard(null)
                        setResult(null)
                      }
                    })
                  }
                }}
              >
                {t('remove')}
              </button>
            </div>
          )}
        </section>
      )}
      {edit && (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            save()
          }}
        >
          <h3>{t(edit.id ? 'edit' : 'newCard')}</h3>
          <p>
            {t('version')} {edit.version}
          </p>
          {fields.map((field) => (
            <label style={{ display: 'block' }} key={field}>
              {t(field === 'title' ? 'titleField' : field)}
              {field === 'text' ? (
                <textarea
                  required
                  rows={16}
                  style={{ width: '100%' }}
                  disabled={busy}
                  value={edit.draft[field]}
                  onChange={(event) =>
                    setEdit({ ...edit, draft: { ...edit.draft, [field]: event.target.value } })
                  }
                />
              ) : (
                <input
                  required
                  disabled={busy}
                  value={edit.draft[field]}
                  onChange={(event) =>
                    setEdit({ ...edit, draft: { ...edit.draft, [field]: event.target.value } })
                  }
                />
              )}
            </label>
          ))}
          <label>
            {t('tags')}{' '}
            <input
              disabled={busy}
              value={edit.tagsText}
              onChange={(event) =>
                setEdit({
                  ...edit,
                  tagsText: event.target.value,
                  draft: {
                    ...edit.draft,
                    tags: event.target.value
                      .split(/[,，]/)
                      .map((tag) => tag.trim())
                      .filter(Boolean),
                  },
                })
              }
            />
          </label>
          <button disabled={busy}>{t('save')}</button>
          <button type="button" disabled={busy} onClick={() => setEdit(null)}>
            {t('cancel')}
          </button>
        </form>
      )}
      <section>
        <h3>{t('proposals')}</h3>
        {!proposals.length && catalog && <p>{t('noProposals')}</p>}
        {proposals.map((proposal) => {
          const old =
            outdated.has(proposal.proposalId) ||
            (!!user && proposal.baseVersion !== user.packVersion)
          return (
            <article key={proposal.proposalId}>
              <h4>{proposal.draft.title}</h4>
              <p>{proposal.summary}</p>
              <p>
                {t('action')}: {t(proposal.action)} · {t('based')}: {proposal.baseVersion} ·{' '}
                {t('created')}: {proposal.createdAt} · {t('session')}: {proposal.sessionId}
              </p>
              <p>
                {t('source')}: {proposal.draft.source} · {t('scope')}: {proposal.draft.scope} ·{' '}
                {proposal.draft.tags.join(', ')}
              </p>
              {old && <p role="status">{t('outdated')}</p>}
              <details>
                <summary>{t('diff')}</summary>
                <pre style={{ whiteSpace: 'pre-wrap' }}>
                  {proposal.diff.map((line, i) => (
                    <span key={i}>
                      {line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '- ' : '  '}
                      {line.text}
                      {'\n'}
                    </span>
                  ))}
                </pre>
                {proposal.diffTruncated && <p>{t('truncated')}</p>}
              </details>
              <details>
                <summary>{t('original')}</summary>
                <pre style={{ whiteSpace: 'pre-wrap' }}>{proposal.baseText}</pre>
              </details>
              <details>
                <summary>{t('full')}</summary>
                <pre style={{ whiteSpace: 'pre-wrap' }}>{proposal.draft.text}</pre>
              </details>
              <button disabled={busy || !!edit || old} onClick={() => apply(proposal)}>
                {t('apply')}
              </button>{' '}
              <button
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await api.discard(proposal.proposalId)
                  })
                }
              >
                {t('discard')}
              </button>
            </article>
          )
        })}
      </section>
    </section>
  )
}
