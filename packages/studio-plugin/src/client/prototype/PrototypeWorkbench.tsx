import { useCallback, useEffect, useRef, useState } from 'react'
import type { EntityView, StudioCommand, StudioReply, StudioState } from '../../shared/studio.ts'
import type { PrototypeCandidateFile, PrototypeConversationMessage, PrototypeInstructionAttachment, PrototypeInstructionDraft as StoredDraft } from '../../shared/prototype.ts'
import { PrototypeFiles } from './PrototypeFiles.tsx'
import { PrototypeCanvas } from './PrototypeCanvas.tsx'
import { PrototypeComparison } from './PrototypeEditor.tsx'
import css from './prototype.module.css'

const dispatchLabels: Record<string, string> = { queued: '等待继续', running: '正在执行', 'awaiting-user': '等待核对', paused: '已暂停', 'recovery-required': '待恢复' }
export interface PrototypeInstructionDraft { title: string; instruction: string; developmentIds: string[]; attachments?: PrototypeInstructionAttachment[] }

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
  const [baselineId, setBaselineId] = useState<string>()
  const showCode = useCallback(() => setTab('code'), [])
  const [mode, setMode] = useState<'new' | 'continue'>('new')
  const initial = (state.prototypeInstructionDrafts ?? []).filter(item => item.projectId === projectId)
  const [drafts, setDrafts] = useState<Record<string, StoredDraft>>(() => {
    const values = Object.fromEntries(initial.map(item => [item.prototypeTaskId ?? '', item]))
    if (initialDraft) values[''] = { projectId, title: initialDraft.title, instruction: initialDraft.instruction, developmentRequirementIds: initialDraft.developmentIds, ...(initialDraft.attachments ? { attachments: initialDraft.attachments } : {}) }
    return values
  })
  const draftsRef = useRef(drafts); draftsRef.current = drafts
  const saveQueue = useRef<Promise<void>>(Promise.resolve())
  const [draftError, setDraftError] = useState('')
  const [sendError, setSendError] = useState('')
  const [queueError, setQueueError] = useState('')
  const [runError, setRunError] = useState('')
  const [candidateError, setCandidateError] = useState('')
  const [candidateFile, setCandidateFile] = useState<PrototypeCandidateFile>()
  const [conversation, setConversation] = useState<{ taskId: string; messages: PrototypeConversationMessage[]; error?: string }>()
  const operation = useRef<{ fingerprint: string; id: string }>()
  const candidateOperation = useRef<{ taskId: string; id: string }>()
  const candidateCheckOperation = useRef<{ candidateId: string; id: string }>()
  const adoptionOperation = useRef<{ fingerprint: string; id: string }>()
  const runs = useRef(new Map<string, string>())
  const queue = state.prototypeQueue
  const tasks = (queue?.items ?? []).filter(item => item.projectId === projectId)
  const selected = tasks.find(item => item.prototypeTaskId === queue?.selectedTaskId)
  const baseline = state.prototypeBaselines?.find(item => item.id === baselineId)
  const fileSource = baseline ? { kind: 'baseline' as const, projectId, baselineId: baseline.id, commitSha: baseline.commitSha } : !baselineId && selected ? { kind: 'task' as const, projectId, prototypeTaskId: selected.prototypeTaskId } : undefined
  const draftKey = mode === 'continue' && selected ? selected.prototypeTaskId : ''
  const draft = drafts[draftKey] ?? { projectId, ...(draftKey ? { prototypeTaskId: draftKey } : {}), title: '', instruction: '', developmentRequirementIds: [] }
  const { title, instruction, developmentRequirementIds: developmentIds, attachments = [] } = draft
  const preview = state.prototypePreviews?.find(item => baseline ? item.baselineId === baseline.id : item.prototypeTaskId === selected?.prototypeTaskId)
  const checkReport = state.prototypeCheckReports?.find(item => baseline ? item.baselineId === baseline.id && item.projectId === projectId : item.prototypeTaskId === selected?.prototypeTaskId && item.projectId === projectId)
  const candidate = state.prototypeCandidates?.find(item => item.prototypeTaskId === selected?.prototypeTaskId && item.projectId === projectId)
  const adoption = state.prototypeAdoptions?.findLast(item => item.source.projectId === projectId && item.source.baselineId === baseline?.id && item.targetTaskId === selected?.prototypeTaskId)
  const materialReads = (state.prototypeMaterialReads ?? []).filter(item => item.projectId === projectId && item.prototypeTaskId === selected?.prototypeTaskId)
  const requirements = entities.filter(entity => entity.kind === 'requirement' && !entity.builtinKey)
  useEffect(() => { void call({ action: 'readPrototypeQueue' }) }, [call, projectId])
  const selectedTaskId = selected?.prototypeTaskId
  useEffect(() => { setCandidateFile(undefined); setCandidateError('') }, [selectedTaskId, candidate?.operationId])
  useEffect(() => { if (selected && selected.taskStatus !== 'active' && mode === 'continue') setMode('new') }, [selected?.taskStatus, mode])
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
    if (!key) onDraftChange(projectId, { title: next.title, instruction: next.instruction, developmentIds: next.developmentRequirementIds, ...(next.attachments ? { attachments: next.attachments } : {}) })
    const operationId = crypto.randomUUID()
    saveQueue.current = saveQueue.current.then(async () => {
      const reply = await call({ action: 'savePrototypeInstructionDraft', operationId, draft: next })
      if (!reply?.ok) setDraftError(reply && !reply.ok ? `指令草稿保存失败：${reply.message}` : '指令草稿保存失败，当前输入仍在页面中。')
      else setDraftError('')
    }).catch(error => { setDraftError(error instanceof Error ? error.message : '指令草稿保存失败，当前输入仍在页面中。') })
  }
  const attachFiles = async (files: FileList | null) => {
    if (!files) return
    const additions: PrototypeInstructionAttachment[] = []
    let total = attachments.reduce((sum, item) => sum + Math.floor(item.data.length * 3 / 4), 0)
    try {
      for (const file of Array.from(files)) {
        if (attachments.length + additions.length >= 8) throw new Error('每条指令最多附带 8 个文件')
        if (file.size < 1 || file.size > 8 * 1024 * 1024) throw new Error(`附件 ${file.name} 为空或超过 8 MiB`)
        total += file.size
        if (total > 16 * 1024 * 1024) throw new Error('每条指令的附件总大小不能超过 16 MiB')
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
          reader.onerror = () => reject(new Error(`无法读取附件 ${file.name}`))
          reader.readAsDataURL(file)
        })
        additions.push({ kind: file.type.startsWith('image/') ? 'image' : 'file', name: file.name, mediaType: file.type || 'application/octet-stream', data })
      }
      updateDraft({ ...draft, attachments: [...attachments, ...additions] }); setDraftError('')
    } catch (error) { setDraftError(error instanceof Error ? error.message : '附件读取失败') }
  }

  const send = async () => {
    setSendError('')
    await saveQueue.current
    const text = instruction.trim()
    const additionalIds = selected ? developmentIds.filter(id => !selected.developmentRequirementIds.includes(id)) : []
    const command: Omit<Extract<StudioCommand, { action: 'startPrototypeCollaboration' }>, 'operationId'> | Omit<Extract<StudioCommand, { action: 'continuePrototypeCollaboration' }>, 'operationId'> | Omit<Extract<StudioCommand, { action: 'extendPrototypeDevelopment' }>, 'operationId'> = mode === 'continue' && selected
      ? additionalIds.length ? { action: 'extendPrototypeDevelopment', prototypeTaskId: selected.prototypeTaskId, instruction: text, developmentRequirementIds: [...selected.developmentRequirementIds, ...additionalIds], writeScope: [], attachments } : { action: 'continuePrototypeCollaboration', prototypeTaskId: selected.prototypeTaskId, instruction: text, attachments }
      : { action: 'startPrototypeCollaboration', projectId, title: title.trim() || '原型协作事项', instruction: text, developmentRequirementIds: developmentIds, referenceRequirementIds: [], writeScope: [], attachments }
    const fingerprint = JSON.stringify(command)
    if (operation.current?.fingerprint !== fingerprint) operation.current = { fingerprint, id: crypto.randomUUID() }
    const reply = await call({ ...command, operationId: operation.current.id })
    if (!reply?.ok) { setSendError(reply && !reply.ok ? reply.message : '指令未能提交，输入已保留。'); return }
    if (draftsRef.current[draftKey] === draft) updateDraft({ ...draft, title: '', instruction: '', developmentRequirementIds: [], attachments: [] })
    operation.current = undefined
  }
  const selectTask = async (id: string) => {
    if (id === selected?.prototypeTaskId || !await flushBeforeLeave()) return
    const reply = await call({ action: 'selectPrototypeQueueItem', prototypeTaskId: id, operationId: crypto.randomUUID() })
    if (reply?.ok) { setBaselineId(undefined); setMode('continue') }
  }
  const moveTask = async (id: string, direction: -1 | 1) => {
    if (!queue) return
    const index = tasks.findIndex(item => item.prototypeTaskId === id), neighbor = tasks[index + direction]
    if (index < 0 || !neighbor) return
    const ids = queue.items.map(item => item.prototypeTaskId)
    const from = ids.indexOf(id), to = ids.indexOf(neighbor.prototypeTaskId)
    ;[ids[from], ids[to]] = [ids[to], ids[from]]
    const reply = await call({ action: 'reorderPrototypeQueue', operationId: crypto.randomUUID(), expectedRevision: queue.revision, prototypeTaskIds: ids })
    if (!reply?.ok) setQueueError(reply && !reply.ok ? reply.message : '队列排序未能保存，请刷新后重试。')
    else setQueueError('')
  }
  const pauseTask = async () => {
    if (!selected) return
    const reply = await call({ action: 'pausePrototypeQueueItem', prototypeTaskId: selected.prototypeTaskId, operationId: selected.pauseOperationId ?? crypto.randomUUID() })
    if (!reply?.ok) { setSendError(reply && !reply.ok ? reply.message : '暂停结果待核对'); await call({ action: 'readPrototypeQueue' }) }
    else setSendError('')
  }
  const endTask = async () => {
    if (!selected) return
    const operationId = selected.endOperationId ?? crypto.randomUUID()
    const reply = await call({ action: 'endPrototypeTask', prototypeTaskId: selected.prototypeTaskId, operationId })
    setSendError(reply?.ok ? '' : reply && !reply.ok ? reply.message : '结束事项结果待核对，原操作和现场已保留')
    if (!reply?.ok) await call({ action: 'readPrototypeQueue' })
  }
  const run = async (action: 'checkProjectPrototype' | 'startProjectPrototypePreview' | 'stopProjectPrototypePreview') => {
    if (!selected) return
    if (action === 'stopProjectPrototypePreview') { await call({ action, prototypeTaskId: selected.prototypeTaskId }); return }
    const key = `${selected.prototypeTaskId}:${action}`
    let operationId = runs.current.get(key)
    if (!operationId) { operationId = crypto.randomUUID(); runs.current.set(key, operationId) }
    const reply = await call({ action, prototypeTaskId: selected.prototypeTaskId, operationId })
    if (reply) {
      runs.current.delete(key)
      setRunError(reply.ok ? '' : reply.message)
      if (!reply.ok) await call({ action: 'readPrototypeQueue' })
    }
  }
  const runBaseline = async (action: 'checkPrototypeBaseline' | 'startPrototypeBaselinePreview' | 'stopPrototypeBaselinePreview') => {
    if (!baseline || !fileSource || fileSource.kind !== 'baseline') return
    if (action === 'stopPrototypeBaselinePreview') {
      const reply = await call({ action, baselineId: baseline.id })
      setRunError(reply?.ok ? '' : reply && !reply.ok ? reply.message : '停止基线预览失败')
      return
    }
    const key = `${baseline.id}:${action}`
    let operationId = runs.current.get(key)
    if (!operationId) { operationId = crypto.randomUUID(); runs.current.set(key, operationId) }
    const reply = await call({ action, source: fileSource, operationId })
    if (reply) { runs.current.delete(key); setRunError(reply.ok ? '' : reply.message) }
  }
  const adoptBaseline = async () => {
    if (!baseline || !selected || adoption) return
    const adjustmentSummary = `复用原型基线 ${baseline.sequence}，后续调整在当前事项中完成`
    const fingerprint = JSON.stringify([baseline.id, selected.prototypeTaskId, adjustmentSummary])
    if (adoptionOperation.current?.fingerprint !== fingerprint) adoptionOperation.current = { fingerprint, id: crypto.randomUUID() }
    const reply = await call({ action: 'adoptPrototypeBaseline', operationId: adoptionOperation.current.id, source: { projectId, baselineId: baseline.id }, targetTaskId: selected.prototypeTaskId, adjustmentSummary })
    if (reply) adoptionOperation.current = undefined
    setRunError(reply?.ok ? '' : reply && !reply.ok ? reply.message : '原型复用登记结果待核对')
  }
  const selectBaseline = async (id: string) => {
    if (!await flushBeforeLeave()) return
    setBaselineId(id || undefined)
    const source = id ? { kind: 'baseline' as const, baselineId: id, commitSha: state.prototypeBaselines?.find(item => item.id === id)?.commitSha ?? '' } : selected ? { kind: 'task' as const, prototypeTaskId: selected.prototypeTaskId } : undefined
    await call({ action: 'selectPrototypePreview', ...(source ? { source } : {}) })
  }
  const prepareCandidate = async () => {
    if (!selected || !await flushBeforeLeave()) return
    setCandidateFile(undefined)
    if (candidateOperation.current?.taskId !== selected.prototypeTaskId) candidateOperation.current = { taskId: selected.prototypeTaskId, id: crypto.randomUUID() }
    const reply = await call({ action: 'preparePrototypeConfirmation', prototypeTaskId: selected.prototypeTaskId, operationId: candidateOperation.current.id })
    if (reply) candidateOperation.current = undefined
    setCandidateError(reply?.ok ? '' : reply && !reply.ok ? reply.message : '无法固定原型成果')
  }
  const readCandidate = async (file: string) => {
    if (!candidate) return
    const reply = await call({ action: 'readPrototypeCandidateFile', operationId: candidate.operationId, path: file })
    if (reply?.ok && reply.prototypeCandidateFile) { setCandidateFile(reply.prototypeCandidateFile); setCandidateError('') }
    else setCandidateError(reply && !reply.ok ? reply.message : '无法读取候选文件')
  }
  const confirmCandidate = async () => {
    if (!candidate) return
    const reply = await call({ action: 'confirmPrototype', operationId: candidate.operationId, expectedSummaryHash: candidate.summaryHash })
    setCandidateError(reply?.ok ? '' : reply && !reply.ok ? reply.message : '无法确认原型成果')
  }
  const processCandidate = async (submit: boolean) => {
    if (!candidate) return
    if (candidateCheckOperation.current?.candidateId !== candidate.operationId) candidateCheckOperation.current = { candidateId: candidate.operationId, id: crypto.randomUUID() }
    const action = submit ? 'submitPrototypeCandidate' as const : 'checkPrototypeCandidate' as const
    const reply = await call({ action, operationId: candidate.operationId, checkOperationId: candidateCheckOperation.current.id })
    if (reply) candidateCheckOperation.current = undefined
    setCandidateError(reply?.ok ? '' : reply && !reply.ok ? reply.message : '结果待核对，请保留原操作')
    if (!reply?.ok) await call({ action: 'readPrototypeQueue' })
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
        <ul>{tasks.map((task, index) => <li key={task.prototypeTaskId}><button aria-current={selected?.prototypeTaskId === task.prototypeTaskId ? 'true' : undefined} onClick={() => void selectTask(task.prototypeTaskId)}>{task.title}</button><span>{dispatchLabels[task.localDispatchState] ?? task.localDispatchState}</span><button type="button" disabled={busy || index === 0} aria-label={`上移${task.title}`} onClick={() => void moveTask(task.prototypeTaskId, -1)}>↑</button><button type="button" disabled={busy || index === tasks.length - 1} aria-label={`下移${task.title}`} onClick={() => void moveTask(task.prototypeTaskId, 1)}>↓</button></li>)}</ul>
        {queueError && <p role="alert" className={css.fileError}>{queueError}</p>}
        {!queue ? <p className={css.muted}>正在读取事项队列。</p> : !tasks.length && <p className={css.muted}>当前项目没有本机事项。</p>}
      </details>
      <div className={css.content}>
        {selected && materialReads.length > 0 && <details><summary>已读取的需求材料 · {materialReads.length} 次</summary><ul>{materialReads.map((item, index) => <li key={`${item.sessionId}:${item.readAt}:${index}`}>{item.title} · {item.source === 'draft' ? '本人草稿' : `已确认版本 ${item.version}`} · 正文第 {item.startLine}–{item.endLine} 行 · {item.readAt}{item.stale ? ' · 材料已更新，仅提醒，不重绑工程' : ''}</li>)}</ul></details>}
        {selected && <><div className={css.taskInfo}><strong>{selected.title}</strong><p>{dispatchLabels[selected.localDispatchState] ?? selected.localDispatchState}{selected.nextAction ? ` · ${selected.nextAction}` : ''}</p>{selected.localDispatchState === 'running' && <button type="button" disabled={busy} onClick={() => void pauseTask()}>暂停</button>}{selected.pauseOperationId && <button type="button" disabled={busy} onClick={() => void pauseTask()}>核对暂停结果</button>}{selected.localDispatchState === 'queued' && <button type="button" disabled={busy} onClick={() => void call({ action: 'resumePrototypeQueueItem', prototypeTaskId: selected.prototypeTaskId, operationId: crypto.randomUUID() })}>继续已保存的指令</button>}{selected.localDispatchState === 'recovery-required' && !selected.pauseOperationId && <button type="button" disabled={busy} onClick={() => void call({ action: 'queryPrototypeMessage', prototypeTaskId: selected.prototypeTaskId })}>核对消息记录</button>}{selected.taskStatus === 'active' && <button type="button" disabled={busy} onClick={() => void endTask()}>{selected.endOperationId ? '核对结束事项结果' : '结束事项'}</button>}</div><div className={css.messages} aria-label="对话记录">{conversation?.taskId === selected.prototypeTaskId ? <>{conversation.messages.map(message => <article key={`${message.kind ?? 'message'}:${message.sequence}`}><small>{message.kind === 'tool' ? `工具 · ${message.tool?.name ?? '未命名'} · ${message.tool?.status === 'running' ? '执行中' : message.tool?.status === 'failed' ? '失败' : '完成'}` : message.role === 'user' ? '你' : 'AI'}{message.interrupted ? ' · 已中断' : ''}{message.operationId ? ` · 操作 ${message.operationId}` : ''}</small>{message.text && <p>{message.text}{message.truncated ? '…' : ''}</p>}{message.attachments?.map(attachment => <span key={attachment.id}>{attachment.kind === 'image' ? '图片' : '附件'} {attachment.name ?? attachment.id} · {attachment.bytes} 字节{attachment.width && attachment.height ? ` · ${attachment.width}×${attachment.height}` : ''}</span>)}</article>)}{conversation.error && <p role="alert">{conversation.error}</p>}{!conversation.error && !conversation.messages.length && <p className={css.muted}>暂无会话消息。</p>}</> : <p className={css.muted}>正在读取会话记录…</p>}</div></>}
        <form className={css.instruction} onSubmit={event => { event.preventDefault(); void send() }}>
          <div className={css.toolbar}><button type="button" aria-selected={mode === 'new'} onClick={() => setMode('new')}>新事项</button>{selected?.taskStatus === 'active' && <button type="button" aria-selected={mode === 'continue'} onClick={() => setMode('continue')}>继续当前事项</button>}</div>
          <strong>{mode === 'continue' && selected ? `继续 ${selected.title}` : '开始协作事项'}</strong><p>描述希望实现的内容。发送后才会开始处理。</p>
          {mode === 'new' && <label>事项名称（可选）<input value={title} onChange={event => updateDraft({ ...draft, title: event.target.value })} maxLength={150} /></label>}
          <label>实现指令<textarea value={instruction} onChange={event => updateDraft({ ...draft, instruction: event.target.value })} rows={5} /></label>
          <label>附件（可选，最多 8 个，共 16 MiB）<input type="file" multiple accept="image/*,.md,.txt,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx" onChange={event => { const files = event.target.files; event.target.value = ''; void attachFiles(files) }} /></label>
          {attachments.length > 0 && <ul>{attachments.map((attachment, index) => <li key={`${attachment.name}:${index}`}>{attachment.kind === 'image' ? '图片' : '文件'} · {attachment.name}<button type="button" onClick={() => updateDraft({ ...draft, attachments: attachments.filter((_item, current) => current !== index) })}>移除</button></li>)}</ul>}
          {requirements.length > 0 && <details><summary>本次涉及的需求（可选）</summary><div className={css.requirementChoices}>{requirements.map(entity => <label key={entity.id}><input type="checkbox" checked={developmentIds.includes(entity.id)} onChange={event => updateDraft({ ...draft, developmentRequirementIds: event.target.checked ? [...developmentIds, entity.id] : developmentIds.filter(id => id !== entity.id) })} />{entity.code ?? entity.id} · {entity.title}</label>)}</div></details>}
          {draftError && <p role="alert" className={css.fileError}>{draftError}</p>}
          {sendError && <p role="alert" className={css.fileError}>{sendError}</p>}
          <button disabled={busy || !instruction.trim()}>发送实现指令</button>
        </form>
      </div>
    </section>
    <section className={css.result} aria-label="原型成果">
      <div className={css.toolbar}><div role="tablist" aria-label="成果视图"><button role="tab" aria-selected={tab === 'preview'} onClick={() => setTab('preview')}>预览</button><button role="tab" aria-selected={tab === 'code'} onClick={() => setTab('code')}>代码</button></div>{selected && !baseline && <><button disabled={busy} onClick={() => void run('checkProjectPrototype')}>工程检查</button><button disabled={busy} onClick={() => void run('startProjectPrototypePreview')}>运行预览</button>{preview && <button disabled={busy} onClick={() => void run('stopProjectPrototypePreview')}>停止预览</button>}</>}{baseline && <><button disabled={busy} onClick={() => void runBaseline('checkPrototypeBaseline')}>检查基线</button><button disabled={busy} onClick={() => void runBaseline('startPrototypeBaselinePreview')}>运行基线预览</button>{preview && <><button disabled={busy} onClick={() => void runBaseline('stopPrototypeBaselinePreview')}>停止预览</button><a href={preview.url} target="_blank" rel="noreferrer">外开同一构建</a></>}</>}</div>
      {runError && <p className={css.fileError} role="alert">{runError}</p>}
      {checkReport && <details><summary>最近{checkReport.kind === 'preview' ? '预览构建' : '工程检查'} · {checkReport.status === 'passed' ? '完成' : checkReport.status === 'failed' ? '失败' : checkReport.status === 'interrupted' ? '中断，待核对' : '运行中'}</summary><p>开始于 {checkReport.startedAt}{checkReport.completedAt ? `，结束于 ${checkReport.completedAt}` : ''}</p><ul>{checkReport.steps.map(step => <li key={step.name}>{step.name} · {step.status === 'passed' ? '完成' : step.status === 'failed' ? '失败' : '运行中'}{step.exitCode === undefined ? '' : `（退出码 ${step.exitCode}）`}</li>)}</ul>{checkReport.message && <p>{checkReport.message}</p>}<p>静态浏览器检查不等于业务用例验收。</p></details>}
      {baseline && selected?.taskStatus === 'active' && <details><summary>复用到当前事项</summary><p>登记只固定来源与目标事项；后续代码调整仍需在当前事项中检查、确认并由后台接受。</p>{adoption ? <p>{adoption.status === 'succeeded' ? `复用已完成，目标基线 ${adoption.targetBaselineId}` : '复用已登记；等待当前事项形成并接受目标基线。'}</p> : <button type="button" disabled={busy} onClick={() => void adoptBaseline()}>登记复用来源</button>}</details>}
      {selected && <details><summary>审阅原型成果</summary>{selected.taskStatus === 'active' && <button type="button" disabled={busy} onClick={() => void prepareCandidate()}>固定当前成果</button>}{candidateError && <p role="alert">{candidateError}</p>}{candidate && <><p>{selected.taskStatus === 'accepted' ? '后台已接受；原事项现场已保留。' : candidate.status === 'conflict' ? '发生冲突，请在当前事项中修复后重新固定并确认。' : candidate.status === 'no-change' ? '没有代码变化；事项仍在开发。' : candidate.status === 'confirmed' ? '作者已确认；后台接受尚未完成。' : '请阅读本次固定成果。'}</p><p>关联开发需求：{candidate.developmentRequirementIds.join('、')}</p>{candidate.conflict && <div role="alert"><strong>冲突涉及文件</strong><ul>{candidate.conflict.files.map(file => <li key={file}>{file}</li>)}</ul></div>}<ul>{candidate.changes.map(change => <li key={change.path}><button type="button" onClick={() => void readCandidate(change.path)}>{change.path} · {change.status === 'added' ? '新增' : change.status === 'deleted' ? '删除' : '修改'}</button></li>)}</ul>{candidateFile && <div><strong>{candidateFile.path}</strong>{candidateFile.binary ? <p>二进制文件不显示正文。</p> : <PrototypeComparison path={candidateFile.path} base={candidateFile.baseContent ?? ''} current={candidateFile.sourceContent ?? ''} baseLabel={candidateFile.baseContent === undefined ? '原始版本（无文件）' : '原始版本'} currentLabel={candidateFile.sourceContent === undefined ? '固定成果（无文件）' : '固定成果'} />}</div>}{selected.taskStatus === 'active' && (candidate.status === 'ready' || candidate.status === 'confirmed') && <button type="button" disabled={busy} onClick={() => void processCandidate(false)}>检查固定成果</button>}{candidate.checks && <p>固定成果的工程、Mock 和静态浏览器保护检查已记录；业务用例仍需核对。</p>}{selected.taskStatus === 'active' && candidate.status === 'ready' && <button type="button" disabled={busy} onClick={() => void confirmCandidate()}>确认这份成果</button>}{candidate.status === 'confirmed' && selected.taskStatus === 'active' && <button type="button" disabled={busy} onClick={() => void processCandidate(true)}>{candidate.integrationPhase ? '核对原提交' : '检查并提交成果'}</button>}{candidate.integrationPhase === 'accepted' && selected.taskStatus === 'accepted' && <button type="button" disabled={busy} onClick={() => void processCandidate(true)}>重试本机收尾</button>}</>}</details>}
      {tab === 'preview' && (preview ? <PrototypeCanvas identity={preview.identity} visible /> : <div className={css.empty}>{state.prototypePreviews ? `${baseline ? '当前基线' : '当前事项'}没有正在运行的预览。` : '尚未读取预览状态。'}</div>)}
      <div className={css.content} hidden={tab !== 'code'}>
        <label>工程来源 <select value={baseline?.id ?? ''} onChange={event => void selectBaseline(event.target.value)}><option value="">{selected ? '当前事项' : '选择已接受基线'}</option>{state.prototypeBaselines?.map(item => <option key={item.id} value={item.id}>原型基线 {item.sequence} · 只读</option>)}</select></label>
        {fileSource ? <PrototypeFiles key={JSON.stringify(fileSource)} source={fileSource} call={call} registerFlush={registerFlush} onNeedsAttention={showCode} /> : <div className={css.empty}>{baselineId ? '所选基线不可用，请重新选择工程来源。' : '选择事项或已接受基线，查看工程文件。'}</div>}
      </div>
    </section>
  </div>
}
