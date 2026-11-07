import { useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { PropsLocale, PropsRenderFactories, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { EADP_SLOTS } from '@eadp/contracts'
import type {} from '@eadp/contracts/client'
import type { ShellFace, WorkspaceView } from './types.ts'
import { Conversation } from './conversation.tsx'
import css from './shell.module.css'
import { FormDialog } from './form-dialog.tsx'

type Tab = 'requirements' | 'prototype' | 'knowledge'
type ChildSlot = typeof EADP_SLOTS[keyof typeof EADP_SLOTS] | 'eadp.shell.session'
export type PanelProps = PropsRuntime<'main'> & PropsRenderFactories & PropsRenderSlots<ChildSlot> & PropsLocale<'eadpShell'> & ShellFace

/** Project navigation owns only local selection; Workspace remains authoritative. */
export function ShellPanel(props: PanelProps) {
  const list = props.workspaces.list
  const store = useMemo(() => ({
    subscribe: (listener: () => void) => list.subscribe(listener),
    getSnapshot: () => list.getSnapshot(),
  }), [list])
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [projectId, setProjectId] = useState<string>()
  const project = snapshot.items.find(item => item.workspaceId === projectId)
  const [tab, setTab] = useState<Tab>('requirements')
  const [chat, setChat] = useState(true)
  const [sessionId, setSessionId] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [form, setForm] = useState<{ kind: 'create' | 'rename'; path: string; id?: string }>()
  const [name, setName] = useState('')
  const epoch = useRef(0)
  const t = props.t
  const run = (operation: () => Promise<void>) => {
    if (busy) return
    setBusy(true); setError('')
    void operation().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => setBusy(false))
  }
  const flush = async () => {
    const result = await props.requirements.flushActive()
    if (!result.ok) throw new Error(result.message ?? t('unsaved'))
  }
  const select = async (item?: WorkspaceView) => {
    await flush()
    if (item) await props.checkDirectory(item.path)
    epoch.current += 1
    setProjectId(item?.workspaceId); setSessionId(undefined)
  }
  const open = async () => {
    await flush()
    const path = await props.pickDirectory()
    if (!path) return
    await select(await props.workspaces.create({ path }))
  }
  const create = async () => {
    const path = await props.pickDirectory()
    if (path) { setName(''); setForm({ kind: 'create', path }) }
  }
  const saveName = async () => {
    if (!form || !name.trim()) return
    if (form.kind === 'create') {
      const path = await props.createDirectory(form.path, name.trim())
      await select(await props.workspaces.create({ path }))
    } else {
      const item = snapshot.items.find(row => row.workspaceId === form.id)
      if (!item) throw new Error('PROJECT_NOT_FOUND')
      await props.workspaces.rename(item.workspaceId, name.trim())
    }
    setForm(undefined)
  }
  const remove = async (item: WorkspaceView) => {
    await flush()
    await props.stopProject(item.workspaceId)
    await props.assertRemovable(item.workspaceId)
    await props.workspaces.delete(item.workspaceId)
    if (projectId === item.workspaceId) await select()
  }
  const relocate = async (item: WorkspaceView) => {
    await flush()
    const path = await props.pickDirectory()
    if (!path) return
    await props.stopProject(item.workspaceId)
    await props.assertRemovable(item.workspaceId)
    await props.validateRelocation(path)
    const replacement = await props.workspaces.create({ path })
    if (replacement.workspaceId !== item.workspaceId) {
      await props.stopProject(item.workspaceId)
    await props.assertRemovable(item.workspaceId)
      await props.workspaces.delete(item.workspaceId)
    }
    await select(replacement)
  }
  const chooseSession = async (id: string) => {
    await flush()
    setSessionId(id || undefined)
  }
  const createSession = async () => {
    if (!project) return
    await flush()
    const currentEpoch = epoch.current
    const id = await props.createSession(project.workspaceId, tab === 'prototype' ? 'prototype' : 'requirements')
    if (currentEpoch === epoch.current) setSessionId(id)
  }
  return <section className={css.shell}>
    <header className={css.header}>
      {project && <button disabled={busy} onClick={() => run(() => select())}>{t('back')}</button>}
      <h1>{project?.title ?? t('title')}</h1>
      {project && <nav aria-label={t('title')}>{(['requirements', 'prototype', 'knowledge'] as const).map(value => <button key={value} role="tab" aria-selected={value === tab} disabled={busy} onClick={() => run(async () => { await flush(); setTab(value) })}>{t(value)}</button>)}</nav>}
      {project && <button onClick={() => setChat(value => !value)}>{t(chat ? 'hideChat' : 'chat')}</button>}
    </header>
    {error && <p role="alert" className={css.notice}>{error}</p>}
    {!project ? <main className={css.home}>
      <button disabled={busy} onClick={() => run(open)}>{t('open')}</button>{' '}
      <button disabled={busy} onClick={() => run(create)}>{t('create')}</button>
      {snapshot.error && <p role="alert">{snapshot.error.message}</p>}
      {snapshot.phase !== 'ready' ? <p>{t('loading')}</p> : snapshot.items.length === 0 ? <p>{t('empty')}</p> : <ul className={css.projects}>{snapshot.items.map(item => <li className={css.project} key={item.workspaceId}>
        <div className={css.projectTitle}><strong>{item.title}</strong><span className={css.path}>{item.path}</span></div>
        <button disabled={busy} onClick={() => run(() => select(item))}>{t('open')}</button>
        <button disabled={busy} onClick={() => { setName(item.title); setForm({ kind: 'rename', path: item.path, id: item.workspaceId }) }}>{t('rename')}</button>
        <button disabled={busy} title={t('moved')} onClick={() => run(() => relocate(item))}>{t('relocate')}</button>
        <button disabled={busy} title={t('removeNote')} onClick={() => run(() => remove(item))}>{t('remove')}</button>
      </li>)}</ul>}
      {form && <FormDialog title={t(form.kind === 'create' ? 'create' : 'rename')} busy={busy} close={() => setForm(undefined)}><form className={css.form} onSubmit={event => { event.preventDefault(); run(saveName) }}>
        {error && <p role="alert" className={css.notice}>{error}</p>}<label>{t('name')} <input autoFocus required disabled={busy} value={name} onChange={event => setName(event.target.value)} /></label>
        <span className={css.path}>{form.path}</span><button disabled={busy || !name.trim()}>{t('save')}</button><button type="button" disabled={busy} onClick={() => setForm(undefined)}>{t('cancel')}</button>
      </form></FormDialog>}
    </main> : <div className={css.body}>
      <main className={css.content}>
        {tab === 'requirements' && props.renderSlot(EADP_SLOTS.requirements, { projectId: project.workspaceId, active: true }, { fallback: <p>{t('unavailable')}</p> })}
        {tab === 'prototype' && props.renderSlot(EADP_SLOTS.prototype, { projectId: project.workspaceId, active: true }, { fallback: <p>{t('unavailable')}</p> })}
        {tab === 'knowledge' && props.renderSlot(EADP_SLOTS.knowledge, { active: true }, { fallback: <p>{t('unavailable')}</p> })}
      </main>
      {chat && <aside className={css.chat} aria-label={t('chat')}>
        <div className={css.chatHeader}><select aria-label={t('selectSession')} value={sessionId ?? ''} disabled={busy} onChange={event => run(() => chooseSession(event.target.value))}><option value="">{t('selectSession')}</option>{project.sessionIds.map(id => <option key={id} value={id}>{id}</option>)}</select><button disabled={busy} onClick={() => run(createSession)}>{t('newSession')}</button></div>
        <div className={css.chatBody}><Conversation projectId={project.workspaceId} sessionId={sessionId} restoreSession={props.restoreSession} retainSession={props.retainSession} SessionProvider={props.SessionProvider} renderFactorySlot={props.renderFactorySlot} loading={t('sessionLoading')} empty={t('noSession')} /></div>
      </aside>}
    </div>}
  </section>
}
