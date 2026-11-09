import { useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { PropsLocale, PropsRenderFactories, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { EADP_SLOTS } from '@eadp/contracts'
import type { SessionRole } from '@eadp/contracts'
import type {} from '@eadp/contracts/client'
import type { ShellFace, WorkspaceView } from './types.ts'
import { Conversation } from './conversation.tsx'
import { cx } from './ui/classnames.ts'
import {
  Button, Dialog, EmptyState, Field, IconButton, Input, Notice, Spinner, Surface,
  IconChat, IconChevronRight, IconFolderOpen, IconPanelRight, IconPencil, IconPlus, IconRefresh, IconTrash,
} from './ui.ts'
import css from './shell.module.css'

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
  /* The knowledge view acts on the requirement the user is editing, owned by the Shell. */
  const activeDocuments = props.activeDocuments
  const subscribeActive = useMemo(() => (listener: () => void) => activeDocuments.subscribe(listener), [activeDocuments])
  const requirementPath = useSyncExternalStore(subscribeActive, () => projectId === undefined ? null : activeDocuments.get(projectId))
  const [tab, setTab] = useState<Tab>('requirements')
  const [chat, setChat] = useState(true)
  const [sessionId, setSessionId] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [form, setForm] = useState<{ kind: 'create' | 'rename'; path: string; id?: string }>()
  const [name, setName] = useState('')
  const nameId = useId()
  const epoch = useRef(0)
  const t = props.t
  const run = (operation: () => Promise<void>) => {
    if (busy) return
    setBusy(true); setError('')
    void operation().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => setBusy(false))
  }
  const flush = async (target: string | undefined) => {
    if (target === undefined) return
    const result = await props.requirements.flushActive(target)
    if (!result.ok) throw new Error(result.message ?? t('unsaved'))
  }
  const select = async (item?: WorkspaceView) => {
    await flush(projectId)
    if (item) await props.checkDirectory(item.path)
    /* A requirement path belongs to the project that opened it; never carry it across projects. */
    if (projectId !== undefined && projectId !== item?.workspaceId) activeDocuments.forget(projectId)
    epoch.current += 1
    setProjectId(item?.workspaceId); setSessionId(undefined)
  }
  const open = async () => {
    await flush(projectId)
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
      const created = await props.workspaces.create({ path })
      await select(created)
      setTab('requirements')
      await attachSession(created.workspaceId, 'requirements')
    } else {
      const item = snapshot.items.find(row => row.workspaceId === form.id)
      if (!item) throw new Error('PROJECT_NOT_FOUND')
      await props.workspaces.rename(item.workspaceId, name.trim())
    }
    setForm(undefined)
  }
  const remove = async (item: WorkspaceView) => {
    await flush(item.workspaceId)
    await props.stopProject(item.workspaceId)
    await props.assertRemovable(item.workspaceId)
    await props.workspaces.delete(item.workspaceId)
    activeDocuments.forget(item.workspaceId)
    if (projectId === item.workspaceId) await select()
  }
  const relocate = async (item: WorkspaceView) => {
    await flush(item.workspaceId)
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
    await flush(projectId)
    setSessionId(id || undefined)
  }
  /**
   * Create the project's next session and select it while that project is still current.
   * A project switched mid-creation keeps the session in its history but not in the view.
   * @param workspaceId - project that owns the new session.
   * @param role - native preset the session runs under.
   */
  const attachSession = async (workspaceId: string, role: SessionRole) => {
    const currentEpoch = epoch.current
    const id = await props.createSession(workspaceId, role)
    if (currentEpoch === epoch.current) setSessionId(id)
  }
  const createSession = async () => {
    if (!project) return
    await flush(project.workspaceId)
    await attachSession(project.workspaceId, tab === 'prototype' ? 'prototype' : 'requirements')
  }
  return <Surface className={css.scope}>
    <section className={css.shell}>
      <header className={css.header}>
        {project && <IconButton label={t('back')} size="sm" disabled={busy} onClick={() => run(() => select())}><span className={css.backIcon}><IconChevronRight /></span></IconButton>}
        <h1 className={css.title}>{project?.title ?? t('title')}</h1>
        {project && <nav className={css.tabs} aria-label={t('title')}>{(['requirements', 'prototype', 'knowledge'] as const).map(value => <button key={value} role="tab" aria-selected={value === tab} className={css.tab} disabled={busy} onClick={() => run(async () => { await flush(project.workspaceId); setTab(value) })}>{t(value)}</button>)}</nav>}
        <div className={css.headerActions}>
          {project && <IconButton label={t(chat ? 'hideChat' : 'chat')} aria-pressed={chat} onClick={() => setChat(value => !value)}>{chat ? <IconPanelRight /> : <IconChat />}</IconButton>}
        </div>
      </header>
      {error && !form && <div className={css.noticeBar}><Notice tone="danger" onDismiss={() => setError('')} dismissLabel={t('dismiss')}>{error}</Notice></div>}
      {!project ? <main className={css.home}>
        <div className={css.homeActions}>
          <Button variant="primary" disabled={busy} onClick={() => run(open)}><IconFolderOpen />{t('open')}</Button>
          <Button variant="secondary" disabled={busy} onClick={() => run(create)}><IconPlus />{t('create')}</Button>
        </div>
        {snapshot.error && <Notice tone="danger">{snapshot.error.message}</Notice>}
        {snapshot.phase !== 'ready'
          ? <div className={css.loading}><Spinner label={t('loading')} /><span>{t('loading')}</span></div>
          : snapshot.items.length === 0
            ? <EmptyState icon={<IconFolderOpen size={24} />} title={t('emptyTitle')} description={t('empty')} />
            : <ul className={css.projects} aria-label={t('projects')}>{snapshot.items.map(item => <li className={cx(css.project, projectId === item.workspaceId && css.projectActive)} key={item.workspaceId}>
              <div className={css.projectTitle}><strong>{item.title}</strong><span className={css.path} title={item.path}>{item.path}</span></div>
              <div className={css.projectActions}>
                <IconButton label={t('open')} size="sm" disabled={busy} onClick={() => run(() => select(item))}><IconFolderOpen /></IconButton>
                <IconButton label={t('rename')} size="sm" disabled={busy} onClick={() => { setName(item.title); setForm({ kind: 'rename', path: item.path, id: item.workspaceId }) }}><IconPencil /></IconButton>
                <IconButton label={t('relocate')} title={t('moved')} size="sm" disabled={busy} onClick={() => run(() => relocate(item))}><IconRefresh /></IconButton>
                <IconButton label={t('remove')} title={t('removeNote')} size="sm" variant="danger" disabled={busy} onClick={() => run(() => remove(item))}><IconTrash /></IconButton>
              </div>
            </li>)}</ul>}
      </main> : <div className={css.body}>
        <main className={css.content}>
          {tab === 'requirements' && props.renderSlot(EADP_SLOTS.requirements, { projectId: project.workspaceId, active: true, sessionId: sessionId ?? null }, { fallback: <div className={css.fallback}><EmptyState title={t('unavailable')} /></div> })}
          {tab === 'prototype' && props.renderSlot(EADP_SLOTS.prototype, { projectId: project.workspaceId, active: true }, { fallback: <div className={css.fallback}><EmptyState title={t('unavailable')} /></div> })}
          {tab === 'knowledge' && props.renderSlot(EADP_SLOTS.knowledge, { active: true, projectId: project.workspaceId, sessionId: sessionId ?? null, requirementPath }, { fallback: <div className={css.fallback}><EmptyState title={t('unavailable')} /></div> })}
        </main>
        {chat && <aside className={css.chat} aria-label={t('chat')}>
          <div className={css.chatHeader}>
            <select className={css.select} aria-label={t('selectSession')} value={sessionId ?? ''} disabled={busy} onChange={event => run(() => chooseSession(event.target.value))}><option value="">{t('selectSession')}</option>{project.sessionIds.map(id => <option key={id} value={id}>{id}</option>)}</select>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => run(createSession)}>{t('newSession')}</Button>
          </div>
          <div className={css.chatBody}><Conversation projectId={project.workspaceId} sessionId={sessionId} restoreSession={props.restoreSession} retainSession={props.retainSession} SessionProvider={props.SessionProvider} renderFactorySlot={props.renderFactorySlot} loading={t('sessionLoading')} empty={t('noSession')} /></div>
        </aside>}
      </div>}
      {form && <Dialog
        title={t(form.kind === 'create' ? 'create' : 'rename')}
        busy={busy}
        closeLabel={t('dismiss')}
        onClose={() => setForm(undefined)}
        footer={<>
          <Button variant="ghost" disabled={busy} onClick={() => setForm(undefined)}>{t('cancel')}</Button>
          <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={() => run(saveName)}>{t('save')}</Button>
        </>}>
        <form className={css.form} onSubmit={event => { event.preventDefault(); run(saveName) }}>
          <Field label={t('name')} htmlFor={nameId}>
            <Input id={nameId} autoFocus required disabled={busy} value={name} onChange={event => setName(event.target.value)} />
          </Field>
          <span className={css.formPath}>{form.path}</span>
          {error && <Notice tone="danger">{error}</Notice>}
        </form>
      </Dialog>}
    </section>
  </Surface>
}
