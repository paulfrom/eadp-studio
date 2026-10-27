import { useCallback, useEffect, useRef, useState } from 'react'
import type { EntityView, StudioCommand, StudioReply, StudioState } from '../../shared/studio.ts'
import type { PrototypeConversationMessage, PrototypeInstructionDraft as StoredDraft } from '../../shared/prototype.ts'
import { PrototypeFiles } from './PrototypeFiles.tsx'
import css from './prototype.module.css'

const dispatchLabels: Record<string, string> = { queued: '等待继续', running: '正在执行', 'awaiting-user': '等待核对', paused: '已暂停', 'recovery-required': '待恢复' }
export interface PrototypeInstructionDraft { title: string; instruction: string; developmentIds: string[] }

/** Project prototype, its requirements, and this account's local collaboration queue. */
export function PrototypeWorkbench({ state, entities, busy, call, registerFlush, flushBeforeLeave, onOpenRequirement, initialDraft, onDraftChange }: {
  state: StudioState; entities: EntityView[]; busy: boolean
  call(command: StudioCommand): Promise<StudioReply | undefined>
  registerFlush(flush?: () => Promise<boolean>): void
  flushBeforeLeave(): Promise<boolean>
  onOpenRequirement(id: string): void
  initialDraft?: PrototypeInstructionDraft
  onDraftChange(projectId: string, draft: PrototypeInstructionDraft): void
}) {
  const projectId = state.project!.id
  const [tab, setTab] = useState<'preview' | 'code'>('preview')
  const showCode = useCallback(() => setTab('code'), [])
  const [mode, setMode] = useState<'new' | 'continue'>('new')
  const initial = (state.prototypeInstructionDrafts ?? []).filter(item => item.projectId === projectId)
  const [drafts, setDrafts] = useState<Record<string, StoredDraft>>(() => {
    const values = Object.fromEntries(initial.map(item => [item.prototypeTaskId ?? '', item]))
    if (initialDraft) values[''] = { projectId, title: initialDraft.title, instruction: initialDraft.instruction, developmentRequirementIds: initialDraft.developmentIds }
    return values
  })
  const draftsRef = useRef(drafts); draftsRef.current = drafts
  const saveQueue = useRef<Promise<void>>(Promise.resolve())
  const [draftError, setDraftError] = useState('')
  const [sendError, setSendError] = useState('')
  const [lastAction, setLastAction] = useState<{ taskId: string; message: string }>()
  const [conversation, setConversation] = useState<{ taskId: string; messages: PrototypeConversationMessage[]; error?: string }>()
  const operation = useRef<{ fingerprint: string; id: string }>()
  const runs = useRef(new Map<string, string>())
  const queue = state.prototypeQueue
  const tasks = (queue?.items ?? []).filter(item => item.projectId === projectId)
  const selected = tasks.find(item => item.prototypeTaskId === queue?.selectedTaskId)
  const draftKey = mode === 'continue' && selected ? selected.prototypeTaskId : ''
  const draft = drafts[draftKey] ?? { projectId, ...(draftKey ? { prototypeTaskId: draftKey } : {}), title: '', instruction: '', developmentRequirementIds: [] }
  const { title, instruction, developmentRequirementIds: developmentIds } = draft
  const preview = state.prototypePreviews?.find(item => item.prototypeTaskId === selected?.prototypeTaskId)
  const requirements = entities.filter(entity => entity.kind === 'requirement' && !entity.builtinKey)
  useEffect(() => { void call({ action: 'readPrototypeQueue' }) }, [call, projectId])
  const selectedTaskId = selected?.prototypeTaskId
  useEffect(() => {
    if (!selectedTaskId) { setConversation(undefined); return }
    let cancelled = false, inFlight = false
    setConversation(undefined)
    const refresh = async () => {
      if (inFlight) return
      inFlight = true
      const reply = await call({ action: 'readPrototypeConversation', prototypeTaskId: selectedTaskId })
      inFlight = false
      if (cancelled) return
      if (reply?.ok && reply.prototypeConversation) setConversation({ taskId: selectedTaskId, messages: reply.prototypeConversation })
      else setConversation(previous => ({ taskId: selectedTaskId, messages: previous?.taskId === selectedTaskId ? previous.messages : [], error: reply && !reply.ok ? reply.message : '无法读取会话记录' }))
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 4000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [call, selectedTaskId])
  useEffect(() => {
    if (!state.prototypeInstructionDrafts) return
    setDrafts(previous => {
      const merged = { ...previous }
      for (const item of state.prototypeInstructionDrafts!) if (item.projectId === projectId && !merged[item.prototypeTaskId ?? '']) merged[item.prototypeTaskId ?? ''] = item
      return merged
    })
  }, [projectId, state.prototypeInstructionDrafts])

  const updateDraft = (next: StoredDraft) => {
    const key = next.prototypeTaskId ?? ''
    draftsRef.current = { ...draftsRef.current, [key]: next }
    setDrafts(draftsRef.current)
    if (!key) onDraftChange(projectId, { title: next.title, instruction: next.instruction, developmentIds: next.developmentRequirementIds })
    const operationId = crypto.randomUUID()
    saveQueue.current = saveQueue.current.then(async () => {
      const reply = await call({ action: 'savePrototypeInstructionDraft', operationId, draft: next })
      if (!reply?.ok) setDraftError(reply && !reply.ok ? `指令草稿保存失败：${reply.message}` : '指令草稿保存失败，当前输入仍在页面中。')
      else setDraftError('')
    }).catch(error => { setDraftError(error instanceof Error ? error.message : '指令草稿保存失败，当前输入仍在页面中。') })
  }

  const send = async () => {
    setSendError('')
    await saveQueue.current
    const text = instruction.trim()
    const additionalIds = selected ? developmentIds.filter(id => !selected.developmentRequirementIds.includes(id)) : []
    const command: Omit<Extract<StudioCommand, { action: 'startPrototypeCollaboration' }>, 'operationId'> | Omit<Extract<StudioCommand, { action: 'continuePrototypeCollaboration' }>, 'operationId'> | Omit<Extract<StudioCommand, { action: 'extendPrototypeDevelopment' }>, 'operationId'> = mode === 'continue' && selected
      ? additionalIds.length ? { action: 'extendPrototypeDevelopment', prototypeTaskId: selected.prototypeTaskId, instruction: text, developmentRequirementIds: [...selected.developmentRequirementIds, ...additionalIds], writeScope: [] } : { action: 'continuePrototypeCollaboration', prototypeTaskId: selected.prototypeTaskId, instruction: text }
      : { action: 'startPrototypeCollaboration', projectId, title: title.trim() || '原型协作事项', instruction: text, developmentRequirementIds: developmentIds, referenceRequirementIds: [], writeScope: [] }
    const fingerprint = JSON.stringify(command)
    if (operation.current?.fingerprint !== fingerprint) operation.current = { fingerprint, id: crypto.randomUUID() }
    const reply = await call({ ...command, operationId: operation.current.id })
    if (!reply?.ok) { setSendError(reply && !reply.ok ? reply.message : '指令未能提交，输入已保留。'); return }
    if (draftsRef.current[draftKey] === draft) updateDraft({ ...draft, title: '', instruction: '', developmentRequirementIds: [] })
    operation.current = undefined
  }
  const selectTask = async (id: string) => {
    if (id === selected?.prototypeTaskId || !await flushBeforeLeave()) return
    const reply = await call({ action: 'selectPrototypeQueueItem', prototypeTaskId: id, operationId: crypto.randomUUID() })
    if (reply?.ok) setMode('continue')
  }
  const run = async (action: 'checkProjectPrototype' | 'startProjectPrototypePreview' | 'stopProjectPrototypePreview') => {
    if (!selected) return
    if (action === 'stopProjectPrototypePreview') { await call({ action, prototypeTaskId: selected.prototypeTaskId }); return }
    const key = `${selected.prototypeTaskId}:${action}`
    let operationId = runs.current.get(key)
    if (!operationId) { operationId = crypto.randomUUID(); runs.current.set(key, operationId) }
    const reply = await call({ action, prototypeTaskId: selected.prototypeTaskId, operationId })
    if (reply?.ok) {
      runs.current.delete(key)
      if (action === 'checkProjectPrototype') setLastAction({ taskId: selected.prototypeTaskId, message: '工程检查命令已处理；详细步骤与日志尚未提供。' })
    }
  }
  return <div className={css.workbench}>
    <section className={css.conversation} aria-label="原型协作">
      <header className={css.heading}><strong>项目原型</strong><small>{state.project?.name}</small></header>
      <details className={css.requirements}>
        <summary>需求集合 · {requirements.length} 项</summary>
        <ul>{requirements.map(entity => <li key={entity.id}><button onClick={() => onOpenRequirement(entity.id)}>{entity.code ?? entity.id} · {entity.title}</button><span>{entity.confirmationStatus === 'confirmed' ? '材料已确认' : '草稿'}</span></li>)}</ul>
        {!requirements.length && <p className={css.muted}>项目中还没有需求材料。</p>}
      </details>
      <details className={css.tasks} open>
        <summary>我的协作事项 · {tasks.length} 项</summary>
        <ul>{tasks.map(task => <li key={task.prototypeTaskId}><button aria-current={selected?.prototypeTaskId === task.prototypeTaskId ? 'true' : undefined} onClick={() => void selectTask(task.prototypeTaskId)}>{task.title}</button><span>{dispatchLabels[task.localDispatchState] ?? task.localDispatchState}</span></li>)}</ul>
        {!queue ? <p className={css.muted}>正在读取事项队列。</p> : !tasks.length && <p className={css.muted}>当前项目没有本机事项。</p>}
      </details>
      <div className={css.content}>
        {selected && <><div className={css.taskInfo}><strong>{selected.title}</strong><p>{dispatchLabels[selected.localDispatchState] ?? selected.localDispatchState}{selected.nextAction ? ` · ${selected.nextAction}` : ''}</p>{selected.localDispatchState === 'queued' && <button type="button" disabled={busy} onClick={() => void call({ action: 'resumePrototypeQueueItem', prototypeTaskId: selected.prototypeTaskId, operationId: crypto.randomUUID() })}>继续已保存的指令</button>}{selected.localDispatchState === 'recovery-required' && <button type="button" disabled={busy} onClick={() => void call({ action: 'queryPrototypeMessage', prototypeTaskId: selected.prototypeTaskId })}>核对消息记录</button>}</div><div className={css.messages} aria-label="对话记录">{conversation?.taskId === selected.prototypeTaskId ? <>{conversation.messages.map(message => <article key={`${message.role}:${message.sequence}`}><small>{message.role === 'user' ? '你' : 'AI'}{message.interrupted ? ' · 已中断' : ''}</small><p>{message.text}</p></article>)}{conversation.error && <p role="alert">{conversation.error}</p>}{!conversation.error && !conversation.messages.length && <p className={css.muted}>暂无会话消息。</p>}</> : <p className={css.muted}>正在读取会话记录…</p>}</div></>}
        <form className={css.instruction} onSubmit={event => { event.preventDefault(); void send() }}>
          <div className={css.toolbar}><button type="button" aria-selected={mode === 'new'} onClick={() => setMode('new')}>新事项</button>{selected && <button type="button" aria-selected={mode === 'continue'} onClick={() => setMode('continue')}>继续当前事项</button>}</div>
          <strong>{mode === 'continue' && selected ? `继续 ${selected.title}` : '开始协作事项'}</strong><p>描述希望实现的内容。发送后才会开始处理。</p>
          {mode === 'new' && <label>事项名称（可选）<input value={title} onChange={event => updateDraft({ ...draft, title: event.target.value })} maxLength={150} /></label>}
          <label>实现指令<textarea value={instruction} onChange={event => updateDraft({ ...draft, instruction: event.target.value })} rows={5} /></label>
          {requirements.length > 0 && <details><summary>本次涉及的需求（可选）</summary><div className={css.requirementChoices}>{requirements.map(entity => <label key={entity.id}><input type="checkbox" checked={developmentIds.includes(entity.id)} onChange={event => updateDraft({ ...draft, developmentRequirementIds: event.target.checked ? [...developmentIds, entity.id] : developmentIds.filter(id => id !== entity.id) })} />{entity.code ?? entity.id} · {entity.title}</label>)}</div></details>}
          {draftError && <p role="alert" className={css.fileError}>{draftError}</p>}
          {sendError && <p role="alert" className={css.fileError}>{sendError}</p>}
          <button disabled={busy || !instruction.trim()}>发送实现指令</button>
        </form>
      </div>
    </section>
    <section className={css.result} aria-label="原型成果">
      <div className={css.toolbar}><div role="tablist" aria-label="成果视图"><button role="tab" aria-selected={tab === 'preview'} onClick={() => setTab('preview')}>预览</button><button role="tab" aria-selected={tab === 'code'} onClick={() => setTab('code')}>代码</button></div>{selected && <><button disabled={busy} onClick={() => void run('checkProjectPrototype')}>工程检查</button><button disabled={busy} onClick={() => void run('startProjectPrototypePreview')}>运行预览</button>{preview && <button disabled={busy} onClick={() => void run('stopProjectPrototypePreview')}>停止预览</button>}</>}</div>
      {lastAction?.taskId === selected?.prototypeTaskId && <p className={css.muted} role="status">{lastAction.message}</p>}
      {tab === 'preview' && <div className={css.empty}>{preview ? <><p>当前事项的预览已启动。</p><a href={preview.url} target="_blank" rel="noreferrer">在新窗口打开预览 ↗</a><p>内嵌预览尚未接入。</p></> : state.prototypePreviews ? '当前事项没有正在运行的预览。' : '尚未读取预览状态。'}</div>}
      <div className={css.content} hidden={tab !== 'code'}>{selected ? <PrototypeFiles key={selected.prototypeTaskId} taskId={selected.prototypeTaskId} call={call} registerFlush={registerFlush} onNeedsAttention={showCode} /> : <div className={css.empty}>选择一个已有事项，查看它的工程文件。</div>}</div>
    </section>
  </div>
}
