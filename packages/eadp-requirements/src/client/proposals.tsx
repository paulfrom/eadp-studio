import { useCallback, useEffect, useRef, useState } from 'react'
import type { RequirementProposal } from '@eadp/contracts'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { RequirementsApi } from './api.ts'
import { NS } from './locales.ts'
import css from './requirements.module.css'

interface ProposalProps extends PropsLocale<typeof NS> {
  projectId: string
  api: RequirementsApi
  disabled: boolean
  apply(proposal: RequirementProposal): Promise<void>
}
/** Only Host-generated proposals are reviewable; conversation text is never interpreted. */
export function RequirementProposals({ projectId, api, apply, disabled, t }: ProposalProps) {
  const [proposals, setProposals] = useState<RequirementProposal[]>([])
  const [error, setError] = useState('')
  const [stale, setStale] = useState<Set<string>>(new Set())
  const [working, setWorking] = useState(false)
  const generation = useRef(0)
  const currentProject = useRef(projectId)
  currentProject.current = projectId
  const current = useCallback((value: number) => value === generation.current && currentProject.current === projectId, [projectId])
  const reload = useCallback(async (value = generation.current) => {
    const result = await api.listProposals(projectId)
    if (current(value)) setProposals(result)
  }, [api, projectId, current])
  useEffect(() => {
    generation.current += 1
    const value = generation.current
    let reading = false
    setProposals([]); setError(''); setStale(new Set()); setWorking(false)
    const refresh = async () => {
      if (reading) return
      reading = true
      try { await reload(value) } catch (reason) { if (current(value)) setError(reason instanceof Error ? reason.message : String(reason)) }
      finally { reading = false }
    }
    void refresh()
    const interval = setInterval(() => { void refresh() }, 2000)
    const focus = () => { void refresh() }
    window.addEventListener('focus', focus)
    return () => { generation.current += 1; clearInterval(interval); window.removeEventListener('focus', focus) }
  }, [reload, current])
  const act = (proposal: RequirementProposal, discard: boolean) => {
    if (disabled || working) return
    const value = generation.current
    setWorking(true); setError('')
    void (discard ? api.discardProposal(projectId, proposal.proposalId) : apply(proposal)).then(async () => {
      if (current(value)) await reload(value)
    }).catch((reason: unknown) => {
      if (!current(value)) return
      const failure = reason as { details?: { code?: string } }
      if (failure.details?.code === 'STALE_VERSION') setStale(previous => new Set([...previous, proposal.proposalId]))
      setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => { if (current(value)) setWorking(false) })
  }
  return <section className={css.proposals} aria-label={t('proposals')}>
    <header className={css.editorHeader}><strong>{t('proposals')}</strong><span>{t('proposalMemory')}</span></header>
    {error && <p role="alert" className={css.error}>{error}</p>}
    {proposals.length === 0 ? <p>{t('noProposals')}</p> : proposals.map(proposal => <article key={proposal.proposalId} className={css.proposal}>
      <header><strong>{proposal.relativePath}</strong>{stale.has(proposal.proposalId) && <span role="status"> {t('staleProposal')}</span>}</header>
      <p>{proposal.summary}</p><p className={css.version}>{t('basedOn')} {proposal.baseVersion ?? t('newFile')}</p>
      <details><summary>{t('reviewDiff')}</summary><pre className={css.diff}>{proposal.diff.map((line, index) => <span className={line.kind === 'added' ? css.added : line.kind === 'removed' ? css.removed : undefined} key={index}>{line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '- ' : '  '}{line.text}{'\n'}</span>)}</pre>{proposal.diffTruncated && <p>{t('diffTruncated')}</p>}</details>
      <details><summary>{t('candidateText')}</summary><pre className={css.diff}>{proposal.text}</pre></details>
      <div className={css.actions}><button disabled={disabled || working} onClick={() => act(proposal, false)}>{t('applyProposal')}</button><button disabled={disabled || working} onClick={() => act(proposal, true)}>{t('discardProposal')}</button></div>
    </article>)}
  </section>
}
