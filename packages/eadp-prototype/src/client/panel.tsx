import { useEffect, useRef, useState } from 'react'
import type { EadpPrototypeSlotProps } from '@eadp/contracts'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { PrototypeApi } from './api.ts'
import { usePrototype } from './usePrototype.ts'
import { NS } from './locales.ts'
import css from './prototype.module.css'

type PrototypeProps = EadpPrototypeSlotProps & PropsLocale<typeof NS> & { api: PrototypeApi }
type Model = ReturnType<typeof usePrototype>
type Translator = PropsLocale<typeof NS>['t']

/** Project keys prevent the previous project's files appearing during a context change. */
export function PrototypePanel(props: PrototypeProps) { return <ProjectPanel key={props.projectId} {...props} /> }

function Directory({ path, model, t }: { path: string; model: Model; t: Translator }) {
  const snapshot = model.directories[path]
  return <>
    {snapshot?.stale && <p className={css.error}>{t('stale')} {snapshot.error}</p>}
    {!snapshot ? <p>{t('loading')}</p> : snapshot.value && <>
      {snapshot.value.hiddenCount > 0 && <p className={css.hint}>{t('hidden')}{snapshot.value.hiddenCount}</p>}
      {snapshot.value.entries.length === 0 && path !== '' && <p className={css.hint}>{t('emptyDirectory')}</p>}
      <ul className={css.entries}>{snapshot.value.entries.map(entry => <li key={entry.relativePath}>
        {entry.type === 'directory' ? <>
          <button disabled={model.busy} aria-expanded={model.expanded.has(entry.relativePath)} onClick={() => model.toggle(entry.relativePath)}>{model.expanded.has(entry.relativePath) ? '▾ ' : '▸ '}{entry.name}/</button>
          {model.expanded.has(entry.relativePath) && <Directory path={entry.relativePath} model={model} t={t} />}
        </> : <button disabled={model.busy} title={entry.relativePath} aria-current={model.file.value?.relativePath === entry.relativePath} onClick={() => { void model.read(entry.relativePath) }}>{entry.name}</button>}
      </li>)}</ul>
    </>}
  </>
}

function Diagnostics({ model, projectId, t }: { model: Model; projectId: string; t: Translator }) {
  return <details className={css.diagnostics} open={model.diagnostics} onToggle={event => model.setDiagnostics(event.currentTarget.open)}>
    <summary>{t('diagnostics')}</summary>
    {model.runtime.error && <p className={css.error}>{model.runtime.error}</p>}
    {model.runtime.value?.error && <p className={css.error}>{model.runtime.value.error}</p>}
    {model.runtime.value?.installationError && <p className={css.error}>{model.runtime.value.installationError}</p>}
    <p>{t('project')}: {projectId}</p>
    {model.runtime.value?.port !== undefined && <p>{t('port')}: {model.runtime.value.port}</p>}
    <h3>{t('backgroundRuns')}</h3>
    {model.runs.stale && <p className={css.error}>{t('stale')} {model.runs.error}</p>}
    {model.runs.value?.filter(run => run.projectId !== projectId).map(run => <div className={css.actions} key={run.projectId}>
      <span>{run.projectId} · {t(run.status)} · {t(run.installStatus)}</span>
      <button disabled={model.busy} onClick={() => { void model.act('stop', run.projectId) }}>{t('stop')}</button>
    </div>)}
    <h3>{t('logs')}</h3>
    {model.logs.stale && <p className={css.error}>{t('stale')} {model.logs.error}</p>}
    {model.logs.value?.truncated && <p className={css.hint}>{t('truncatedLogs')}</p>}
    <pre className={css.logs}>{model.logs.value?.items.length ? model.logs.value.items.map((item, index) => <span key={index} data-stream={item.stream}>{item.text}</span>) : t('noLogs')}</pre>
  </details>
}

function ProjectPanel({ projectId, active, api, t }: PrototypeProps) {
  const model = usePrototype(projectId, active, api)
  const [browserMessage, setBrowserMessage] = useState<'browserHint' | 'browserFailed'>()
  const [opening, setOpening] = useState(false)
  const browserEpoch = useRef(0)
  useEffect(() => { browserEpoch.current += 1; setOpening(false); return () => { browserEpoch.current += 1 } }, [active])
  const open = async () => {
    if (opening) return
    const token = browserEpoch.current
    setOpening(true); setBrowserMessage(undefined)
    try {
      const url = await api.openBrowser(projectId)
      if (token !== browserEpoch.current) return
      // noopener may return null even when successful; it is not failure evidence.
      window.open(url, '_blank', 'noopener,noreferrer')
      setBrowserMessage('browserHint')
    } catch {
      if (token === browserEpoch.current) setBrowserMessage('browserFailed')
    } finally { if (token === browserEpoch.current) setOpening(false) }
  }
  if (!active) return null
  const root = model.directories['']?.value
  const state = model.runtime.value
  const installing = state?.installStatus === 'installing'
  const executing = state && ['starting', 'running', 'stopping'].includes(state.status)
  const empty = root && (!root.exists || (root.entries.length === 0 && root.hiddenCount === 0))
  const content = model.file.value
  return <section className={css.workbench} aria-label={t('title')}>
    <aside className={css.tree} aria-label={t('files')}>
      <div className={css.actions}><h2>{t('files')}</h2><button disabled={model.busy} onClick={() => { void model.refresh() }}>{t('refresh')}</button></div>
      <Directory path="" model={model} t={t} />
    </aside>
    <main className={css.main}>
      <header className={css.toolbar}>
        <h2>{t('title')}</h2>
        {state && <div className={css.status} role="status"><span>{t('runStatus')}: {t(state.status)}</span><span>{t('installStatus')}: {t(state.installStatus)}</span></div>}
        {model.runtime.stale && <p className={css.error}>{t('stale')}</p>}
        <div className={css.actions}>
          {empty && <button disabled={model.busy || !!executing || installing} onClick={() => { void model.act('createProject') }}>{t('create')}</button>}
          <button disabled={model.busy || !root?.exists || !!empty || !!executing || installing} onClick={() => { void model.act('install') }}>{t('install')}</button>
          <button disabled={model.busy || !root?.exists || !!empty || !!executing || installing} onClick={() => { void model.act('start') }}>{t('start')}</button>
          <button disabled={model.busy || !state || (state.status === 'stopped' && !installing)} onClick={() => { void model.act('stop') }}>{t('stop')}</button>
          <button disabled={model.busy || opening || model.runtime.stale || state?.status !== 'running'} onClick={() => { void open() }}>{t('open')}</button>
        </div>
        <p className={css.hint}>{t('installHint')}</p>
        {state?.url && <p className={css.address}>{t('url')}: <code>{state.url}</code></p>}
        {browserMessage && <p role="status">{t(browserMessage)}</p>}
        {state?.status === 'running' && <p className={css.hint}>{t('runtimeHint')}</p>}
        {model.error && <p className={css.error} role="alert">{t('error')}: {model.error}</p>}
      </header>
      {empty && <div className={css.empty}><p>{t('empty')}</p><p>{t('createHint')}</p></div>}
      <section className={css.viewer} aria-label={t('readOnly')}>
        {model.file.stale && <p className={css.error}>{t('stale')} {model.file.error}</p>}
        {content ? <>
          <div className={css.fileHeader}><strong>{content.relativePath}</strong><span>{content.size} {t('bytes')} · {t('readOnly')}</span></div>
          {content.truncated && <p className={css.hint}>{t('truncatedFile')}</p>}
          {content.kind === 'text' ? <pre className={css.code}>{content.text}</pre> : <p className={css.empty}>{t(content.kind === 'binary' ? 'binary' : 'tooLarge')}</p>}
        </> : <p className={css.empty}>{t('select')}</p>}
      </section>
      <Diagnostics model={model} projectId={projectId} t={t} />
    </main>
  </section>
}
