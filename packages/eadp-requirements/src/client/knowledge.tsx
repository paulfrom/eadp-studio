import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { FixedKnowledgeCitation, RequirementKnowledgeBasis } from '@eadp/contracts'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import {
  Badge,
  Button,
  IconButton,
  IconChevronDown,
  IconChevronRight,
  IconRefresh,
  Notice,
  Spinner,
} from '@eadp/shell/client/ui'
import type { RequirementsApi } from './api.ts'
import { NS } from './locales.ts'
import css from './material-editor.module.css'

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

interface RequirementKnowledgeProps extends PropsLocale<typeof NS> {
  projectId: string
  sessionId: string | null
  relativePath: string | null
  api: RequirementsApi
  disabled: boolean
  /** 每次应用或丢弃提案后递增，用于重新读取需求依据。 */
  refreshKey: number
}

const messageOf = (reason: unknown): string | undefined => (reason instanceof Error && reason.message.trim() !== '' ? reason.message : undefined)

/** 需求面板顶部的两个独立区域：本次参考（对话中可回看）与已固定的需求依据。 */
export function RequirementKnowledge(props: RequirementKnowledgeProps): ReactElement {
  const { projectId, sessionId, relativePath, api, disabled, refreshKey, t } = props
  const [basis, setBasis] = useState<BasisState>({ status: 'loading' })
  const [auto, setAuto] = useState<AutoState>({ status: 'hidden', enabled: true })
  const basisEpoch = useRef(0)

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

  const citations = basis.value?.citations ?? []
  const problems = basis.value?.problems ?? []
  return <section className={css.knowledgeArea} aria-label={t('knowledge')}>
    <div className={css.knowledgeBlock}>
      <header className={css.knowledgeHeader}>
        <h2 className={css.knowledgeTitle}>{t('thisTurn')}</h2>
        <Badge tone="neutral">{t('referenceNotBasis')}</Badge>
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
  </section>
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
