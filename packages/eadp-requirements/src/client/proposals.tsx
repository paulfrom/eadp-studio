import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { RequirementProposal } from '@eadp/contracts'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import {
  Badge,
  Button,
  EmptyState,
  Dialog,
  IconButton,
  IconChevronDown,
  IconChevronRight,
  IconRefresh,
  IconSparkles,
  Notice,
} from '@eadp/shell/client/ui'
import type { RequirementsApi } from './api.ts'
import { failureCode, versionTail } from './material/document-state.ts'
import { NS } from './locales.ts'
import css from './material-editor.module.css'

/** How often the Host proposal list is re-read while the panel is open. */
const POLL_INTERVAL_MS = 2000

/** Jump between contiguous changes rather than through unchanged context lines. */
function DiffNavigation({ id, previous, next }: { id: string; previous: string; next: string }) {
  const cursor = useRef(-1)
  const jump = (direction: number) => {
    const lines = Array.from(document.getElementById(id)?.children ?? [])
    const changes = lines.filter((line, index) => line.getAttribute('data-kind') !== 'context' && (index === 0 || lines[index - 1]?.getAttribute('data-kind') === 'context'))
    if (!changes.length) return
    cursor.current = cursor.current < 0 ? (direction < 0 ? changes.length - 1 : 0) : (cursor.current + direction + changes.length) % changes.length
    changes[cursor.current]?.scrollIntoView({ block: 'center' })
  }
  return <div className={css.proposalActions}><Button size="sm" variant="ghost" onClick={() => jump(-1)}>{previous}</Button><Button size="sm" variant="ghost" onClick={() => jump(1)}>{next}</Button></div>
}

interface ProposalProps extends PropsLocale<typeof NS> {
  relativePath: string | null
  projectId: string
  api: RequirementsApi
  disabled: boolean
  /** 采用资料后递增，立即重新读取待审提案，而非等待下一次轮询。 */
  refreshKey: number
  apply(proposal: RequirementProposal): Promise<void>
}

/** Collapsible Host proposal review area; conversation text is never a write authority. */
export function RequirementProposals({ relativePath, projectId, api, apply, disabled, refreshKey, t }: ProposalProps) {
  const [proposals, setProposals] = useState<RequirementProposal[]>([])
  const [error, setError] = useState('')
  const [stale, setStale] = useState<ReadonlySet<string>>(() => new Set<string>())
  const [working, setWorking] = useState(false)
  const [open, setOpen] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set<string>())
  const [candidateOpen, setCandidateOpen] = useState<ReadonlySet<string>>(() => new Set<string>())
  const listId = useId()
  const generation = useRef(0)
  const request = useRef(0)
  const currentProject = useRef(projectId)
  currentProject.current = projectId
  const current = useCallback((value: number) => value === generation.current && currentProject.current === projectId, [projectId])
  const reload = useCallback(async (value = generation.current) => {
    const sequence = ++request.current
    const result = await api.listProposals(projectId)
    /* The newest response owns the list; a slower earlier request must not overwrite it. */
    if (current(value) && sequence === request.current) setProposals(result)
  }, [api, projectId, current])
  useEffect(() => {
    generation.current += 1
    const value = generation.current
    let reading = false
    setOpen(false); setProposals([]); setError(''); setStale(new Set<string>()); setWorking(false); setExpanded(new Set<string>()); setCandidateOpen(new Set<string>())
    const refresh = async () => {
      if (reading) return
      reading = true
      try { await reload(value) } catch (reason) { if (current(value)) setError(reason instanceof Error ? reason.message : String(reason)) }
      finally { reading = false }
    }
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, POLL_INTERVAL_MS)
    const focus = () => { void refresh() }
    window.addEventListener('focus', focus)
    return () => {
      generation.current += 1
      window.clearInterval(timer)
      window.removeEventListener('focus', focus)
    }
  }, [reload, current])
  /* An adoption already asked the Host for a proposal; read it without waiting for the poll. */
  const adoptedRefresh = useRef(refreshKey)
  useEffect(() => {
    if (refreshKey === adoptedRefresh.current) return
    adoptedRefresh.current = refreshKey
    void reload().catch((reason: unknown) => {
      if (current(generation.current)) setError(reason instanceof Error ? reason.message : String(reason))
    })
  }, [refreshKey, reload, current])
  useEffect(() => { setOpen(false) }, [relativePath])
  const act = (proposal: RequirementProposal, discard: boolean) => {
    if (disabled || working) return
    const value = generation.current
    setWorking(true); setError('')
    void (discard ? api.discardProposal(projectId, proposal.proposalId) : apply(proposal)).then(async () => {
      if (current(value)) await reload(value)
    }).catch((reason: unknown) => {
      if (!current(value)) return
      if (failureCode(reason) === 'STALE_VERSION') setStale(previous => new Set([...previous, proposal.proposalId]))
      setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => { if (current(value)) setWorking(false) })
  }
  /* Disclosure state replaces native disclosure elements so hidden content keeps no layout box. */
  const toggle = (setter: Dispatch<SetStateAction<ReadonlySet<string>>>, proposalId: string): void => {
    setter(previous => {
      const next = new Set(previous)
      if (next.has(proposalId)) next.delete(proposalId)
      else next.add(proposalId)
      return next
    })
  }
  const visible = proposals.filter(p => showAll || relativePath === null || p.relativePath === relativePath)
  return <section className={css.proposals} aria-label={t('proposals')}>
    <header className={css.proposalsHeader}>
      <IconButton label={open ? t('collapse') : t('expand')} size="sm" aria-expanded={open} onClick={() => setOpen(value => !value)}>
        {open ? <IconChevronDown /> : <IconChevronRight />}
      </IconButton>
      <strong className={css.proposalsTitle}>{t('proposals')}</strong>
      <Button size="sm" variant="ghost" onClick={() => { setShowAll(value => !value); setOpen(true) }}>{t(showAll ? 'currentDocumentProposals' : 'allProposals')}</Button>
      {visible.length > 0 ? <Badge tone="accent">{visible.length}</Badge> : null}
      <span className={css.proposalsMemory} title={t('proposalStorage')}>{t('proposalStorage')}</span>
      <IconButton label={t('refresh')} size="sm" disabled={working} onClick={() => { void reload().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason))) }}><IconRefresh /></IconButton>
    </header>
    {open ? <Dialog width="lg" title={t("proposals")} closeLabel={t("close")} busy={working} onClose={() => { if (!working) setOpen(false) }} footer={<Button size="sm" variant="secondary" disabled={working} onClick={() => setOpen(false)}>{t("returnToEditing")}</Button>}><div className={css.reviewBody}>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {visible.length === 0 ? <EmptyState icon={<IconSparkles />} title={t('noProposals')} /> : visible.map((proposal, index) => {
        const isStale = stale.has(proposal.proposalId)
        const isExpanded = !expanded.has(proposal.proposalId)
        const isCandidateOpen = candidateOpen.has(proposal.proposalId)
        const diffId = `${listId}-diff-${index}`
        const candidateId = `${listId}-candidate-${index}`
        return <article key={proposal.proposalId} className={css.proposalCard} data-stale={isStale || undefined}>
          <header className={css.proposalHeader}>
            <strong className={css.proposalPath} title={proposal.relativePath}>{proposal.relativePath}</strong>
            <Badge tone={isStale ? 'danger' : proposal.baseVersion ? 'neutral' : 'accent'}>
              {isStale ? t('staleProposal') : proposal.baseVersion ? `${t('basedOn')} ${versionTail(proposal.baseVersion)}` : t('newFile')}
            </Badge>
            {proposal.citations.length > 0 ? <Badge tone="neutral">{`${t('basis')} ${proposal.citations.length}`}</Badge> : null}
            {proposal.persisted ? null : <Badge tone="warning">{t('proposalEphemeral')}</Badge>}

          </header>
          <p className={css.proposalSummary}>{proposal.summary}</p>
          {proposal.citations.length ? <details><summary>{t('basis')}</summary>{proposal.citations.map(citation => <section key={citation.snapshotId}><strong>{citation.title}</strong><p>{citation.sourceLabel} · {citation.locations.join(' / ')}</p><p>{citation.note}</p>{citation.warnings.map(warning => <Notice key={warning} tone="warning">{warning}</Notice>)}</section>)}</details> : null}
          <button type="button" className={css.diffToggle} aria-expanded={isExpanded} aria-controls={diffId} onClick={() => toggle(setExpanded, proposal.proposalId)}>
            {isExpanded ? <IconChevronDown /> : <IconChevronRight />}{t('reviewDiff')}
          </button>
          {isExpanded ? <>
            <DiffNavigation id={diffId} previous={t('previousChange')} next={t('nextChange')} />
            <div id={diffId} className={css.diff} role="group" aria-label={t('reviewDiff')}>
              {proposal.diff.map((line, index) => <div key={index} className={css.diffLine} data-kind={line.kind}>
                <span className={css.diffSign} aria-hidden="true">{line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '}</span>
                <span>{line.text || ' '}</span>
              </div>)}
            </div>
            {proposal.diffTruncated ? <p className={css.diffNote}>{t('diffTruncated')}</p> : null}
          </> : null}
          <button type="button" className={css.diffToggle} aria-expanded={isCandidateOpen} aria-controls={candidateId} onClick={() => toggle(setCandidateOpen, proposal.proposalId)}>
            {isCandidateOpen ? <IconChevronDown /> : <IconChevronRight />}{t('candidateText')}
          </button>
          {isCandidateOpen ? <pre id={candidateId} className={css.diff}>{proposal.text || ' '}</pre> : null}
            <div className={css.proposalActions}>
              <Button size="sm" variant="primary" disabled={disabled || working || isStale} onClick={() => act(proposal, false)}>{t('applyProposal')}</Button>
              <Button size="sm" variant="ghost" disabled={disabled || working} onClick={() => act(proposal, true)}>{t('discardProposal')}</Button>
            </div>
        </article>
      })}
    </div></Dialog> : null}
  </section>
}
