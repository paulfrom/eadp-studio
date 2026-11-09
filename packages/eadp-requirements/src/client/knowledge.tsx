import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type {
  EadpRequirementsClient,
  FixedKnowledgeCitation,
  KnowledgeTurnReference,
  KnowledgeTurnReferenceView,
  RequirementKnowledgeBasis,
} from '@eadp/contracts'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import {
  Badge,
  Button,
  Dialog,
  Field,
  IconButton,
  IconChevronDown,
  IconChevronRight,
  IconRefresh,
  Notice,
  Spinner,
} from '@eadp/shell/client/ui'
import type { RequirementsApi } from './api.ts'
import { NS, type RequirementsTranslate } from './locales.ts'
import { KnowledgeAdoptionError } from './service.ts'
import css from './material-editor.module.css'

/** How often a still-running search is re-read until the Host settles the turn. */
const SEARCH_POLL_MS = 1200
/** How often a finished turn is re-read so the next conversation turn replaces it. */
const TURN_POLL_MS = 3000
/** Adoption explanations are part of the confirmed business grounds. */
const NOTE_LIMIT = 500
/** Excerpts beyond this many code points get an explicit expand control. */
const EXCERPT_TOGGLE_LENGTH = 160

/** 需求依据区的加载状态；`failed` 保留错误文案供用户重试。 */
interface BasisState {
  status: 'loading' | 'ready' | 'failed'
  value?: RequirementKnowledgeBasis
  error?: string
}

/** 自动参考开关状态；`hidden` 表示当前没有需求会话。 */
interface AutoState {
  status: 'hidden' | 'loading' | 'ready' | 'saving' | 'failed'
  enabled: boolean
  error?: string
}

/** 最近一轮自动参考的读取状态；每次切换项目或会话都从零开始。 */
type TurnState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; view: KnowledgeTurnReferenceView | null }
  | { status: 'failed'; message: string }

interface RequirementKnowledgeProps extends PropsLocale<typeof NS> {
  projectId: string
  sessionId: string | null
  relativePath: string | null
  api: RequirementsApi
  editors: EadpRequirementsClient
  disabled: boolean
  /** 每次应用提案或采用资料后递增，用于重新读取需求依据与待审提案。 */
  refreshKey: number
  /** 采用成功后通知面板刷新待审提案列表。 */
  onAdopted(): void
}

const messageOf = (reason: unknown): string | undefined => (reason instanceof Error && reason.message.trim() !== '' ? reason.message : undefined)

/** Remote failures carry machine codes in `details`; plain errors have none. */
const failureCode = (reason: unknown): string | undefined => {
  const details = (reason as { details?: { code?: unknown } } | null | undefined)?.details
  return typeof details?.code === 'string' ? details.code : undefined
}

/** Why an adoption failed, in the words the current view can show. */
function adoptionMessage(reason: unknown, t: RequirementsTranslate): string {
  if (reason instanceof KnowledgeAdoptionError) {
    if (reason.failure.kind === 'missingRequirement') return t('adoptMissingRequirement')
    switch (reason.failure.reason) {
      case 'composing': return t('flushComposing')
      case 'conflict': return t('flushConflict')
      case 'missing': return t('flushMissing')
      case 'failed': return reason.failure.message ?? t('flushFailed')
      default: return t('adoptNeedsSaved')
    }
  }
  const code = failureCode(reason)
  if (code === 'STALE_VERSION' || code === 'VERSION_MISMATCH') return t('adoptStale')
  return messageOf(reason) ?? t('adoptFailed')
}

/** 需求面板顶部的两个独立区域：本次参考（对话中可回看）与已固定的需求依据。 */
export function RequirementKnowledge(props: RequirementKnowledgeProps): ReactElement {
  const { projectId, sessionId, relativePath, api, editors, disabled, refreshKey, onAdopted, t } = props
  const [basis, setBasis] = useState<BasisState>({ status: 'loading' })
  const [auto, setAuto] = useState<AutoState>({ status: 'hidden', enabled: true })
  const [turn, setTurn] = useState<TurnState>({ status: 'idle' })
  const [turnNonce, setTurnNonce] = useState(0)
  const [adoption, setAdoption] = useState<KnowledgeTurnReference | null>(null)
  const [announce, setAnnounce] = useState('')
  const basisEpoch = useRef(0)
  const turnEpoch = useRef(0)

  const loadBasis = useCallback(async (): Promise<void> => {
    const epoch = ++basisEpoch.current
    if (relativePath === null) {
      setBasis({ status: 'ready', value: { citations: [] } })
      return
    }
    setBasis(previous => previous.value === undefined ? { status: 'loading' } : { status: 'loading', value: previous.value })
    try {
      const value = await api.knowledgeBasis(projectId, relativePath)
      if (epoch === basisEpoch.current) setBasis({ status: 'ready', value })
    } catch (reason) {
      if (epoch === basisEpoch.current) setBasis({ status: 'failed', error: messageOf(reason) ?? t('basisLoadFailed') })
    }
  }, [api, projectId, relativePath, t])

  /* Selection, project switches and applied proposals all re-read the stored grounds. */
  useEffect(() => {
    void loadBasis()
    return () => { basisEpoch.current += 1 }
  }, [loadBasis, refreshKey])

  /* Returning to the window picks up grounds applied from another view. */
  useEffect(() => {
    const focus = (): void => { void loadBasis() }
    window.addEventListener('focus', focus)
    return () => window.removeEventListener('focus', focus)
  }, [loadBasis])

  useEffect(() => {
    if (sessionId === null) {
      setAuto({ status: 'hidden', enabled: true })
      return
    }
    let active = true
    setAuto({ status: 'loading', enabled: true })
    api.knowledgeAutoReference(sessionId).then(enabled => {
      if (active) setAuto({ status: 'ready', enabled })
    }).catch((reason: unknown) => {
      if (active) setAuto({ status: 'failed', enabled: true, error: messageOf(reason) ?? t('autoReferenceFailed') })
    })
    return () => { active = false }
  }, [api, sessionId, t])

  /*
   * Read the latest completed turn and keep it current: conversation turns happen in
   * the chat column without a dedicated event channel reaching this slot, so a slow
   * re-read (only while the window is visible) is what makes a finished turn replace
   * the previous one. The epoch keeps a switched project or session from publishing
   * an older response, so an old turn is never presented as the current one.
   */
  useEffect(() => {
    const epoch = ++turnEpoch.current
    if (sessionId === null) {
      setTurn({ status: 'idle' })
      return
    }
    setTurn({ status: 'loading' })
    let timer: number | undefined
    let searching = false
    function schedule(): void {
      if (epoch !== turnEpoch.current) return
      timer = window.setTimeout(() => {
        if (document.visibilityState === 'visible') void read()
        else schedule()
      }, searching ? SEARCH_POLL_MS : TURN_POLL_MS)
    }
    async function read(): Promise<void> {
      try {
        const view = await editors.turnReferences(projectId, sessionId)
        if (epoch !== turnEpoch.current) return
        searching = view !== null && view.state === 'searching'
        setTurn({ status: 'ready', view })
      } catch (reason) {
        if (epoch !== turnEpoch.current) return
        setTurn({ status: 'failed', message: messageOf(reason) ?? t('turnFailed') })
      }
      schedule()
    }
    void read()
    return () => {
      turnEpoch.current += 1
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [editors, projectId, sessionId, turnNonce, t])

  const toggleAuto = async (enabled: boolean): Promise<void> => {
    if (sessionId === null || auto.status === 'saving' || auto.status === 'loading') return
    const previous = auto.enabled
    setAuto({ status: 'saving', enabled })
    try {
      await api.setKnowledgeAutoReference(sessionId, enabled)
      setAuto({ status: 'ready', enabled })
    } catch (reason) {
      setAuto({ status: 'failed', enabled: previous, error: messageOf(reason) ?? t('autoReferenceFailed') })
    }
  }

  const view = turn.status === 'ready' ? turn.view : null
  /* A Host response binds its own project/session/requirement; anything else is not this turn. */
  const contextMismatch = view !== null && (view.projectId !== projectId || view.sessionId !== sessionId)
  const requirementMismatch = view !== null && !contextMismatch && view.requirementPath !== relativePath
  const references = view === null || contextMismatch ? [] : view.references
  const canAdopt = !contextMismatch && !requirementMismatch && relativePath !== null && sessionId !== null && !disabled
  const supplementFailed = view !== null && view.supplement.status === 'failed'

  const turnBody = (): ReactElement => {
    if (sessionId === null) return <p className={css.knowledgeHint}>{t('thisTurnNoSession')}</p>
    if (turn.status === 'loading') return <p className={css.knowledgeHint}>{t('turnLoading')}</p>
    if (turn.status === 'failed') {
      return <div className={css.basisFailure}>
        <Notice tone="danger">{turn.message}</Notice>
        <Button size="sm" variant="ghost" onClick={() => setTurnNonce(value => value + 1)}>{t('turnRefresh')}</Button>
      </div>
    }
    if (view === null) {
      return <p className={css.knowledgeHint}>{turn.status === 'idle' ? t('thisTurnNoSession') : t('turnNoTurn')}</p>
    }
    if (contextMismatch) return <Notice tone="warning">{t('turnOutdated')}</Notice>
    return <>
      {view.state === 'disabled' ? <p className={css.knowledgeHint}>{view.message ?? t('turnDisabled')}</p> : null}
      {view.state === 'searching'
        ? <div className={css.referenceStatus}><Spinner size="sm" /><span className={css.knowledgeHint}>{t('turnSearching')}</span></div>
        : null}
      {view.state === 'empty' ? <p className={css.knowledgeHint}>{view.message ?? t('turnEmpty')}</p> : null}
      {view.state === 'partial' ? <p className={css.knowledgeHint}>{view.message ?? t('turnPartial')}</p> : null}
      {view.state === 'failed' ? <Notice tone="warning">{view.message ?? t('turnFailed')}</Notice> : null}
      {supplementFailed ? <Notice tone="warning">{view.supplement.message ?? t('turnSupplementFailed')}</Notice> : null}
      {requirementMismatch ? <Notice tone="warning">{t('turnOtherRequirement')}</Notice> : null}
      {references.length === 0 ? null : <ul className={css.referenceList}>
        {references.map(reference => <TurnReferenceItem
          key={reference.evidenceId}
          reference={reference}
          canAdopt={canAdopt}
          t={t}
          onAdopt={() => setAdoption(reference)} />)}
      </ul>}
      {references.length === 0 && (view.state === 'ready') ? <p className={css.knowledgeHint}>{t('turnEmpty')}</p> : null}
    </>
  }

  const citations = basis.value?.citations ?? []
  const problems = basis.value?.problems ?? []
  return <section className={css.knowledgeArea} aria-label={t('knowledge')}>
    <div className={css.knowledgeBlock}>
      <header className={css.knowledgeHeader}>
        <h2 className={css.knowledgeTitle}>{t('thisTurn')}</h2>
        <Badge tone="neutral">{t('referenceNotBasis')}</Badge>
        {references.length > 0 ? <Badge tone="accent">{String(references.length)}</Badge> : null}
        <span className={css.knowledgeSpacer} />
        <IconButton
          label={t('turnRefresh')}
          size="sm"
          disabled={sessionId === null || turn.status === 'loading'}
          onClick={() => setTurnNonce(value => value + 1)}><IconRefresh /></IconButton>
      </header>
      <p className={css.knowledgeHint}>{sessionId === null ? t('thisTurnNoSession') : t('thisTurnHint')}</p>
      {sessionId === null ? null : <div className={css.autoRow}>
        <label className={css.autoLabel}>
          <input
            type="checkbox"
            className={css.autoInput}
            checked={auto.enabled}
            disabled={disabled || auto.status === 'loading' || auto.status === 'saving' || auto.status === 'hidden'}
            onChange={event => { void toggleAuto(event.target.checked) }} />
          <span>{t('autoReference')}</span>
        </label>
        <span className={css.knowledgeHint}>{t('autoReferenceHint')}</span>
        {auto.status === 'loading' ? <Spinner size="sm" /> : null}
        {auto.status === 'loading' ? <span className={css.knowledgeHint}>{t('autoReferenceLoading')}</span> : null}
      </div>}
      {auto.error ? <Notice tone="danger">{auto.error}</Notice> : null}
      {announce !== '' ? <Notice tone="success" onDismiss={() => setAnnounce('')} dismissLabel={t('close')}>{announce}</Notice> : null}
      {turnBody()}
      {sessionId !== null && relativePath === null ? <p className={css.knowledgeHint}>{t('turnAdoptNoFile')}</p> : null}
    </div>
    <div className={css.knowledgeBlock}>
      <header className={css.knowledgeHeader}>
        <h2 className={css.knowledgeTitle}>{t('basis')}</h2>
        {citations.length > 0 ? <Badge tone="accent">{String(citations.length)}</Badge> : null}
        <span className={css.knowledgeSpacer} />
        <IconButton label={t('basisRetry')} size="sm" disabled={relativePath === null} onClick={() => { void loadBasis() }}><IconRefresh /></IconButton>
      </header>
      {relativePath === null
        ? <p className={css.knowledgeHint}>{t('basisNoFile')}</p>
        : basis.status === 'loading'
          ? <p className={css.knowledgeHint}>{t('basisLoading')}</p>
          : basis.status === 'failed'
            ? <BasisFailure error={basis.error ?? t('basisLoadFailed')} retry={t('basisRetry')} onRetry={() => { void loadBasis() }} />
            : citations.length === 0
              ? <p className={css.knowledgeHint}>{t('basisEmpty')}</p>
              : <>
                <p className={css.knowledgeHint}>{t('basisHint')}</p>
                {problems.length > 0 ? <Notice tone="warning" title={t('basisProblems')}>{problems.join(' ')}</Notice> : null}
                <ul className={css.basisList}>
                  {citations.map(citation => <BasisItem key={citation.snapshotId} citation={citation} t={t} />)}
                </ul>
              </>}
    </div>
    {adoption !== null && sessionId !== null && relativePath !== null
      ? <AdoptionDialog
        projectId={projectId}
        sessionId={sessionId}
        relativePath={relativePath}
        reference={adoption}
        editors={editors}
        t={t}
        onClose={() => setAdoption(null)}
        onAdopted={() => {
          setAdoption(null)
          setAnnounce(t('adoptSuccess'))
          onAdopted()
        }} />
      : null}
  </section>
}

interface TurnReferenceItemProps extends PropsLocale<typeof NS> {
  reference: KnowledgeTurnReference
  canAdopt: boolean
  onAdopt(): void
}

/** 一条本轮参考：标题、出处、实际片段、位置与整理提示；技术通道不显示。 */
function TurnReferenceItem({ reference, canAdopt, onAdopt, t }: TurnReferenceItemProps): ReactElement {
  const [expanded, setExpanded] = useState(false)
  const excerptLength = Array.from(reference.excerpt).length
  return <li className={css.referenceItem}>
    <div className={css.referenceHead}>
      <h3 className={css.referenceTitle}>{reference.title}</h3>
      <Button size="sm" variant="secondary" disabled={!canAdopt} onClick={onAdopt}>{t('adoptAction')}</Button>
    </div>
    <p className={css.knowledgeHint}>
      {reference.source.label}
      {reference.locations.length > 0 ? ` · ${t('referenceLocation')}：${reference.locations.join('、')}` : ''}
      {reference.headingPath.length > 0 ? ` · ${t('referenceSection')}：${reference.headingPath.join(' › ')}` : ''}
    </p>
    <p className={css.referenceExcerpt} data-expanded={expanded || undefined}>{reference.excerpt}</p>
    {excerptLength > EXCERPT_TOGGLE_LENGTH
      ? <button type="button" className={css.diffToggle} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
        {expanded ? <IconChevronDown /> : <IconChevronRight />}
        {expanded ? t('referenceCollapse') : t('referenceExpand')}
      </button>
      : null}
    {reference.warnings.length > 0 ? <p className={css.referenceWarning}>{t('referenceWarnings')}：{reference.warnings.join('；')}</p> : null}
  </li>
}

interface AdoptionDialogProps extends PropsLocale<typeof NS> {
  projectId: string
  sessionId: string
  relativePath: string
  reference: KnowledgeTurnReference
  editors: EadpRequirementsClient
  onClose(): void
  onAdopted(): void
}

/** 采用说明与应用范围确认；提交只加入待审提案，不写需求正文。 */
function AdoptionDialog({ projectId, sessionId, relativePath, reference, editors, onClose, onAdopted, t }: AdoptionDialogProps): ReactElement {
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const noteLength = Array.from(note.trim()).length
  const submit = async (): Promise<void> => {
    if (submitting) return
    if (noteLength === 0) { setError(t('adoptNoteRequired')); return }
    if (noteLength > NOTE_LIMIT) { setError(t('adoptNoteTooLong')); return }
    setSubmitting(true)
    setError('')
    try {
      await editors.adoptKnowledge({
        projectId,
        sessionId,
        adoption: {
          relativePath,
          /* The client service resolves the loaded requirement version this adoption must match. */
          baseVersion: null,
          note: note.trim(),
          source: { kind: 'reference', evidenceId: reference.evidenceId, ranges: reference.ranges },
        },
      })
      onAdopted()
    } catch (reason) {
      setError(adoptionMessage(reason, t))
    } finally {
      setSubmitting(false)
    }
  }
  return <Dialog
    title={t('adoptTitle')}
    description={t('adoptIntro')}
    busy={submitting}
    closeLabel={t('close')}
    onClose={() => { if (!submitting) onClose() }}
    footer={<>
      <Button size="sm" variant="ghost" disabled={submitting} onClick={onClose}>{t('cancel')}</Button>
      <Button size="sm" variant="primary" loading={submitting} disabled={noteLength === 0 || noteLength > NOTE_LIMIT} onClick={() => { void submit() }}>{t('adoptSubmit')}</Button>
    </>}>
    <div className={css.adoptSummary}>
      <strong className={css.referenceTitle}>{reference.title}</strong>
      <p className={css.knowledgeHint}>{reference.source.label}</p>
      <p className={css.knowledgeHint}>{t('adoptExcerpt')}</p>
      <pre className={css.adoptExcerpt}>{reference.excerpt}</pre>
    </div>
    <Field
      label={t('adoptNoteLabel')}
      htmlFor="eadp-adopt-reference-note"
      hint={t('adoptNoteHint')}
      error={error === '' ? undefined : error}>
      <textarea
        id="eadp-adopt-reference-note"
        className={css.adoptTextarea}
        value={note}
        rows={4}
        disabled={submitting}
        onChange={event => setNote(event.target.value)} />
      <span className={css.knowledgeHint}>{noteLength}/{NOTE_LIMIT}</span>
    </Field>
  </Dialog>
}

/** 读取失败的恢复入口；不隐藏已有可恢复性。 */
function BasisFailure(props: { error: string; retry: string; onRetry: () => void }): ReactElement {
  return <div className={css.basisFailure}>
    <p className={css.knowledgeHint}>{props.error}</p>
    <Button size="sm" variant="ghost" onClick={props.onRetry}>{props.retry}</Button>
  </div>
}

interface BasisItemProps extends PropsLocale<typeof NS> {
  citation: FixedKnowledgeCitation
}

/** 一条已固定依据：资料标题、来源、位置、采用说明，以及可展开的当时内容。 */
function BasisItem({ citation, t }: BasisItemProps): ReactElement {
  const [open, setOpen] = useState(false)
  const changed = citation.state === 'updated' || citation.state === 'removed'
  return <li className={css.basisItem}>
    <div className={css.basisHead}>
      <div className={css.basisHeadText}>
        <h3 className={css.basisTitle}>{citation.title}</h3>
        <p className={css.knowledgeHint}>
          {t('basisSource')}：{citation.source.label}
          {citation.locations.length > 0 ? ` · ${t('basisLocation')}：${citation.locations.join('、')}` : ''}
        </p>
      </div>
    </div>
    {changed ? <p className={css.basisNotice} data-state={citation.state}>
      {citation.state === 'updated' ? t('basisUpdated') : t('basisRemoved')}
    </p> : null}
    {citation.note.trim() === '' ? null : <p className={css.basisNote}>{t('basisNote')}：{citation.note}</p>}
    <button
      type="button"
      className={css.diffToggle}
      aria-expanded={open}
      onClick={() => { setOpen(value => !value) }}>
      {open ? <IconChevronDown /> : <IconChevronRight />}
      {open ? t('hideFixed') : t('viewFixed')}
    </button>
    {open ? <div className={css.fixedContent}>
      <pre className={css.fixedBody}>{citation.body}</pre>
      {citation.resources.map(resource => <img
        key={resource.path}
        className={css.fixedImage}
        src={asDataUrl(resource.fileName, resource.dataBase64)}
        alt={resource.fileName} />)}
      {citation.original === null ? null : <a
        className={css.fixedOriginal}
        href={asDataUrl(citation.original.fileName, citation.original.dataBase64)}
        download={citation.original.fileName}>
        {t('viewOriginal')} · {citation.original.fileName}
      </a>}
    </div> : null}
  </li>
}

/** 按扩展名推断可显示的 MIME；未知类型交给浏览器下载。 */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/plain',
}

function asDataUrl(fileName: string, dataBase64: string): string {
  const dot = fileName.lastIndexOf('.')
  const extension = dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : ''
  return `data:${MIME_BY_EXTENSION[extension] ?? 'application/octet-stream'};base64,${dataBase64}`
}
