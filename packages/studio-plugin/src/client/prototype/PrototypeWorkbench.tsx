import { useCallback, useEffect, useRef, useState } from 'react'
import type { EntityView, StudioCommand, StudioReply, StudioState } from '../../shared/studio.ts'
import type { PrototypeCandidateFile, PrototypeInstructionAttachment, PrototypeInstructionDraft as StoredDraft } from '../../shared/prototype.ts'
import { PrototypeFiles } from './PrototypeFiles.tsx'
import { PrototypePreview } from './PrototypePreview.tsx'
import { PrototypeIcon as Icon } from './PrototypeIcon.tsx'
import { WorkbenchMenu } from './WorkbenchMenu.tsx'
import { NativeConversation, type NativeConversationFaces, type NativeConversationSelection } from '../components/NativeConversation.tsx'
import { NativeSessionSelector } from '../components/NativeSessionSelector.tsx'
import { WorkbenchDrawer } from './WorkbenchDrawer.tsx'
import { PrototypeComparison } from './PrototypeEditor.tsx'
import { RequirementReviewAction, requirementDevelopmentStatus } from './RequirementDevelopment.tsx'
import css from './prototype.module.css'
export interface PrototypeInstructionDraft { title: string; instruction: string; developmentIds: string[]; attachments?: PrototypeInstructionAttachment[]; pendingStartOperationId?: string }

export interface PrototypeViewState { tab: 'preview' | 'code'; baselineId?: string; confirmOpen: boolean }

/** Project prototype, its requirements, and this account's local collaboration queue. */
export function PrototypeWorkbench({ state, entities, busy, call, refresh, registerFlush, flushBeforeLeave, onOpenRequirement, faces, initialDraft, onDraftChange, initialView, onViewChange }: {
  faces: NativeConversationFaces
  state: StudioState; entities: EntityView[]; busy: boolean
  call(command: StudioCommand): Promise<StudioReply | undefined>
  refresh(): void
  registerFlush(flush?: () => Promise<boolean>): void
  flushBeforeLeave(): Promise<boolean>
  onOpenRequirement(id: string): void
  initialView: PrototypeViewState | undefined
  onViewChange(view: PrototypeViewState): void
  initialDraft: PrototypeInstructionDraft | undefined
  onDraftChange(projectId: string, draft: PrototypeInstructionDraft): void
}) {
  const projectId = state.project!.id
  const [tab, setTab] = useState<'preview' | 'code'>(initialView?.tab ?? 'preview')
  const [drawer, setDrawer] = useState<'diagnostics'>()
  const [confirmOpen, setConfirmOpen] = useState(initialView?.confirmOpen ?? false)
  const [aiCollapsed, setAiCollapsed] = useState(false)
  const [requestedRequirementId, setRequestedRequirementId] = useState<string>()
  const showAi = useRef<HTMLButtonElement>(null)
  const hideAi = useRef<HTMLButtonElement>(null)
  const previousAiCollapsed = useRef(aiCollapsed)
  useEffect(() => {
    if (previousAiCollapsed.current === aiCollapsed) return
    previousAiCollapsed.current = aiCollapsed
    ;(aiCollapsed ? showAi : hideAi).current?.focus()
  }, [aiCollapsed])
  const [requestDiff, setRequestDiff] = useState(0)
  const [output, setOutput] = useState<'runtime' | 'problems'>()
  const [baselineId, setBaselineId] = useState<string | undefined>(initialView?.baselineId)
  useEffect(() => { onViewChange({ tab, ...(baselineId ? { baselineId } : {}), confirmOpen }) }, [tab, baselineId, confirmOpen, onViewChange])
  const [starting, setStarting] = useState<string>()
  const showCode = useCallback(() => setTab('code'), [])
  const initial = (state.prototypeInstructionDrafts ?? []).filter(item => item.projectId === projectId)
  const [drafts, setDrafts] = useState<Record<string, StoredDraft>>(() => {
    const values = Object.fromEntries(initial.map(item => [item.prototypeTaskId ?? '', item]))
    if (initialDraft) values[''] = { projectId, ...(initialDraft.pendingStartOperationId ? { pendingStartOperationId: initialDraft.pendingStartOperationId } : {}), title: initialDraft.title, instruction: initialDraft.instruction, developmentRequirementIds: initialDraft.developmentIds, ...(initialDraft.attachments ? { attachments: initialDraft.attachments } : {}) }
    return values
  })
  const draftsRef = useRef(drafts); draftsRef.current = drafts
  const saveQueue = useRef<Promise<void>>(Promise.resolve())
  const [draftError, setDraftError] = useState('')
  const [sendError, setSendError] = useState('')
  const [creating, setCreating] = useState(false)
  const [queueError, setQueueError] = useState('')
  const [runError, setRunError] = useState('')
  const [candidateError, setCandidateError] = useState('')
  const [reviewedCandidateId, setReviewedCandidateId] = useState<string>()
  const [candidateFile, setCandidateFile] = useState<PrototypeCandidateFile>()
  const sending = useRef(false)
  const draftSaved = useRef(true)
  const candidateOperation = useRef<{ taskId: string; id: string }>()
  const candidateCheckOperation = useRef<{ candidateId: string; id: string }>()
  const adoptionOperation = useRef<{ fingerprint: string; id: string }>()
  const runs = useRef(new Map<string, string>())
  const startingRef = useRef<string>()
  const queue = state.prototypeQueue
  const tasks = (queue?.items ?? []).filter(item => item.projectId === projectId)
  const candidateSelection = tasks.find(item => item.prototypeTaskId === queue?.selectedTaskId)
  const selected = requestedRequirementId && !candidateSelection?.developmentRequirementIds.includes(requestedRequirementId) ? undefined : candidateSelection
  const baseline = state.prototypeBaselines?.find(item => item.id === baselineId)
  const fileSource = baseline ? { kind: 'baseline' as const, projectId, baselineId: baseline.id, commitSha: baseline.commitSha } : !baselineId && selected && !selected.pendingCreation ? { kind: 'task' as const, projectId, prototypeTaskId: selected.prototypeTaskId } : undefined
  const draft = drafts[''] ?? { projectId, title: '', instruction: '', developmentRequirementIds: [] }
  const { title, instruction, developmentRequirementIds: developmentIds, attachments = [] } = draft
  const preview = baseline ? state.prototypePreviews?.find(item => item.baselineId === baseline.id)
    : selected && !selected.pendingCreation ? state.prototypePreviews?.find(item => item.prototypeTaskId === selected.prototypeTaskId) : undefined
  const checkReport = state.prototypeCheckReports?.find(item => baseline ? item.baselineId === baseline.id && item.projectId === projectId : item.prototypeTaskId === selected?.prototypeTaskId && item.projectId === projectId)
  const candidate = state.prototypeCandidates?.find(item => item.prototypeTaskId === selected?.prototypeTaskId && item.projectId === projectId)
  const reviewReady = !!candidate && candidate.operationId === reviewedCandidateId
  const adoption = state.prototypeAdoptions?.findLast(item => item.source.projectId === projectId && item.source.baselineId === baseline?.id && item.targetTaskId === selected?.prototypeTaskId)
  const materialReads = (state.prototypeMaterialReads ?? []).filter(item => item.projectId === projectId && item.prototypeTaskId === selected?.prototypeTaskId)
  const requirements = entities.filter(entity => entity.kind === 'requirement' && !entity.builtinKey)
  const sourceKey = baseline ? `baseline:${baseline.id}` : selected && !selected.pendingCreation ? `task:${selected.prototypeTaskId}` : undefined
  const startingCurrent = !!sourceKey && starting === sourceKey
  useEffect(() => { void call({ action: 'readPrototypeQueue' }) }, [call, projectId])
  useEffect(() => {
    if (!starting && checkReport?.status !== 'running') return
    refresh()
    const timer = setInterval(refresh, 1000)
    return () => clearInterval(timer)
  }, [starting, checkReport?.status, refresh])
  const selectedTaskId = selected?.prototypeTaskId
  useEffect(() => { setCandidateFile(undefined); setCandidateError('') }, [selectedTaskId, candidate?.operationId])
  useEffect(() => {
    if (!state.prototypeInstructionDrafts) return
    setDrafts(previous => {
      const merged = { ...previous }
      for (const item of state.prototypeInstructionDrafts!) if (item.projectId === projectId && !merged[item.prototypeTaskId ?? '']) merged[item.prototypeTaskId ?? ''] = item
      return merged
    })
  }, [projectId, state.prototypeInstructionDrafts])

  const rememberDraft = (next: StoredDraft) => {
    const key = next.prototypeTaskId ?? ''
    draftsRef.current = { ...draftsRef.current, [key]: next }
    setDrafts(draftsRef.current)
    if (!key) onDraftChange(projectId, { ...(next.pendingStartOperationId ? { pendingStartOperationId: next.pendingStartOperationId } : {}), title: next.title, instruction: next.instruction, developmentIds: next.developmentRequirementIds, ...(next.attachments ? { attachments: next.attachments } : {}) })
  }
  const editPendingInstruction = async () => {
    if (sending.current || !draft.pendingStartOperationId) return
    sending.current = true
    try {
      await saveQueue.current
      const { pendingStartOperationId: _pending, ...editable } = draft
      const reply = await call({ action: 'savePrototypeInstructionDraft', operationId: crypto.randomUUID(), draft: editable })
      if (!reply?.ok) { setDraftError(reply && !reply.ok ? reply.message : '原发送结果尚未明确，指令仍保留，请先核对原发送结果。'); return }
      rememberDraft(editable)
      draftSaved.current = true
      setDraftError('')
      setSendError('')
    } finally { sending.current = false }
  }
  const updateDraft = (next: StoredDraft) => {
    rememberDraft(next)
    const operationId = crypto.randomUUID()
    saveQueue.current = saveQueue.current.then(async () => {
      const reply = await call({ action: 'savePrototypeInstructionDraft', operationId, draft: next })
      draftSaved.current = !!reply?.ok
      if (!reply?.ok) setDraftError(reply && !reply.ok ? `指令草稿保存失败：${reply.message}` : '指令草稿保存失败，当前输入仍在页面中。')
      else setDraftError('')
    }).catch(error => { draftSaved.current = false; setDraftError(error instanceof Error ? error.message : '指令草稿保存失败，当前输入仍在页面中。') })
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
    if (sending.current || busy || !instruction.trim()) return
    sending.current = true
    setSendError('')
    try {
      await saveQueue.current
      if (!draftSaved.current) { updateDraft(draft); await saveQueue.current; if (!draftSaved.current) return }
      const operationId = draft.pendingStartOperationId ?? crypto.randomUUID()
      if (!draft.pendingStartOperationId) {
        updateDraft({ ...draft, pendingStartOperationId: operationId })
        await saveQueue.current
        if (!draftSaved.current) return
      }
      const reply = await call({ action: 'startPrototypeCollaboration', operationId, projectId, title: title.trim() || '原型协作事项', instruction: instruction.trim(), developmentRequirementIds: developmentIds, referenceRequirementIds: [], writeScope: [], attachments })
      if (!reply?.ok) { setSendError(reply && !reply.ok ? reply.message : '发送结果待核对，原指令与操作已保留。'); return }
      updateDraft({ projectId, title: '', instruction: '', developmentRequirementIds: [], attachments: [] })
      setCreating(false)
    } finally { sending.current = false }
  }
  const [recoveringPrompt, setRecoveringPrompt] = useState(false)
  const recoverNativePrompt = async () => {
    const operationId = selected?.pendingNativePromptOperationId
    if (!selected || !operationId || recoveringPrompt) return
    setRecoveringPrompt(true)
    setSendError('')
    try {
      const reply = await call({ action: 'retryPrototypeNativePrompt', prototypeTaskId: selected.prototypeTaskId, operationId })
      if (!reply?.ok) setSendError(reply && !reply.ok ? reply.message : '原指令发送结果仍待核对。')
      await call({ action: 'readPrototypeQueue' })
    } finally { setRecoveringPrompt(false) }
  }
  const entryOperations = useRef(new Map<string, string>())
  const entryInFlight = useRef(false)
  const [enteringRequirement, setEnteringRequirement] = useState<string>()
  const enterRequirement = async (requirementId: string) => {
    if (entryInFlight.current || !await flushBeforeLeave()) return
    entryInFlight.current = true
    setRequestedRequirementId(requirementId)
    setBaselineId(undefined); setCreating(false)
    setEnteringRequirement(requirementId)
    setQueueError('')
    let operationId = entryOperations.current.get(requirementId)
    if (!operationId) { operationId = crypto.randomUUID(); entryOperations.current.set(requirementId, operationId) }
    try {
      const reply = await call({ action: 'enterPrototypeRequirement', projectId, requirementId, operationId })
      if (!reply?.ok) { setQueueError(reply && !reply.ok ? reply.message : '进入结果待核对，请再次点击同一需求核对原操作。'); return }
      entryOperations.current.delete(requirementId)
      setBaselineId(undefined); setCreating(false); setAiCollapsed(false); setConfirmOpen(false)
    } finally { entryInFlight.current = false; setEnteringRequirement(undefined) }
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
  const run = async (action: 'startProjectPrototypePreview' | 'stopProjectPrototypePreview') => {
    if (!selected) return
    if (action === 'stopProjectPrototypePreview') {
      const reply = await call({ action, prototypeTaskId: selected.prototypeTaskId })
      setRunError(reply?.ok ? '' : reply && !reply.ok ? reply.message : '停止预览结果待核对')
      return reply?.ok === true
    }
    const key = `${selected.prototypeTaskId}:${action}`
    let operationId = runs.current.get(key)
    if (!operationId) { operationId = crypto.randomUUID(); runs.current.set(key, operationId) }
    const reply = await call({ action, prototypeTaskId: selected.prototypeTaskId, operationId })
    if (reply?.ok) runs.current.delete(key)
    setRunError(reply?.ok ? '' : reply && !reply.ok ? reply.message : '运行结果待核对')
    if (!reply?.ok) await call({ action: 'readPrototypeQueue' })
  }
  const runBaseline = async (action: 'startPrototypeBaselinePreview' | 'stopPrototypeBaselinePreview') => {
    if (!baseline || !fileSource || fileSource.kind !== 'baseline') return
    if (action === 'stopPrototypeBaselinePreview') {
      const reply = await call({ action, baselineId: baseline.id })
      setRunError(reply?.ok ? '' : reply && !reply.ok ? reply.message : '停止基线预览失败')
      return reply?.ok === true
    }
    const key = `${baseline.id}:${action}`
    let operationId = runs.current.get(key)
    if (!operationId) { operationId = crypto.randomUUID(); runs.current.set(key, operationId) }
    const reply = await call({ action, source: fileSource, operationId })
    if (reply?.ok) runs.current.delete(key)
    setRunError(reply?.ok ? '' : reply && !reply.ok ? reply.message : '运行结果待核对')
  }
  const adoptBaseline = async () => {
    if (!baseline || !selected || adoption) return
    const adjustmentSummary = `复用原型基线 ${baseline.sequence}，后续调整在当前事项中完成`
    const fingerprint = JSON.stringify([baseline.id, selected.prototypeTaskId, adjustmentSummary])
    if (adoptionOperation.current?.fingerprint !== fingerprint) adoptionOperation.current = { fingerprint, id: crypto.randomUUID() }
    const reply = await call({ action: 'adoptPrototypeBaseline', operationId: adoptionOperation.current.id, source: { projectId, baselineId: baseline.id }, targetTaskId: selected.prototypeTaskId, adjustmentSummary })
    if (reply?.ok) adoptionOperation.current = undefined
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
    setReviewedCandidateId(undefined)
    setCandidateFile(undefined)
    if (candidateOperation.current?.taskId !== selected.prototypeTaskId) candidateOperation.current = { taskId: selected.prototypeTaskId, id: crypto.randomUUID() }
    const operationId = candidateOperation.current.id
    const reply = await call({ action: 'preparePrototypeConfirmation', prototypeTaskId: selected.prototypeTaskId, operationId })
    if (reply?.ok) candidateOperation.current = undefined
    setReviewedCandidateId(reply?.ok ? operationId : undefined)
    setCandidateError(reply?.ok ? '' : reply && !reply.ok ? reply.message : '无法固定原型成果')
  }
  const readCandidate = async (file: string) => {
    if (!candidate) return
    const reply = await call({ action: 'readPrototypeCandidateFile', operationId: candidate.operationId, path: file })
    if (reply?.ok && reply.prototypeCandidateFile) { setCandidateFile(reply.prototypeCandidateFile); setCandidateError('') }
    else setCandidateError(reply && !reply.ok ? reply.message : '无法读取候选文件')
  }
  const confirmCandidate = async () => {
    if (!candidate) return false
    const reply = await call({ action: 'confirmPrototype', operationId: candidate.operationId, expectedSummaryHash: candidate.summaryHash })
    setCandidateError(reply?.ok ? '' : reply && !reply.ok ? reply.message : '无法确认原型成果')
    return reply?.ok === true
  }
  const processCandidate = async () => {
    if (!candidate) return
    if (candidateCheckOperation.current?.candidateId !== candidate.operationId) candidateCheckOperation.current = { candidateId: candidate.operationId, id: crypto.randomUUID() }
    const action = 'submitPrototypeCandidate' as const
    const reply = await call({ action, operationId: candidate.operationId, checkOperationId: candidateCheckOperation.current.id })
    if (reply?.ok) candidateCheckOperation.current = undefined
    setCandidateError(reply?.ok ? '' : reply && !reply.ok ? reply.message : '结果待核对，请保留原操作')
    if (!reply?.ok) await call({ action: 'readPrototypeQueue' })
  }
  const reviewPrototype = async () => {
    if (!selected || selected.pendingCreation || baseline) return
    setConfirmOpen(true)
    if (selected.taskStatus === 'active' && candidate?.status !== 'confirmed' && !candidate?.integrationPhase) await prepareCandidate()
  }
  const confirmAndSubmit = async () => {
    if (!candidate || busy || candidate.status === 'ready' && !reviewReady) return
    if (candidate.status === 'ready' && !await confirmCandidate()) return
    await processCandidate()
  }
  const startPreview = async () => {
    if (!sourceKey || startingRef.current) return
    startingRef.current = sourceKey
    setStarting(sourceKey)
    setRunError('')
    setOutput(undefined)
    setAiCollapsed(false)
    try { await (baseline ? runBaseline('startPrototypeBaselinePreview') : run('startProjectPrototypePreview')) }
    finally {
      if (startingRef.current === sourceKey) startingRef.current = undefined
      setStarting(current => current === sourceKey ? undefined : current)
      refresh()
    }
  }
  const toggleRun = () => preview
    ? baseline ? runBaseline('stopPrototypeBaselinePreview') : run('stopProjectPrototypePreview')
    : startPreview()
  const restartPreview = async () => {
    if (startingRef.current) return
    if (preview && !await (baseline ? runBaseline('stopPrototypeBaselinePreview') : run('stopProjectPrototypePreview'))) return
    await startPreview()
  }
  const selectedRequirementId = requestedRequirementId ?? selected?.focusedRequirementId ?? selected?.requirementId ?? selected?.developmentRequirementIds[0]
  const conversationSelection: NativeConversationSelection = {
    items: requirements.map(entity => {
      const relevant = tasks.filter(item => item.developmentRequirementIds.includes(entity.id))
      const item = relevant.find(item => item.taskStatus === 'active') ?? relevant.at(-1)
      return { id: entity.id, title: `${entity.code ?? entity.id} · ${entity.title}`, status: requirementDevelopmentStatus(item) }
    }),
    ...(selectedRequirementId ? { selectedId: selectedRequirementId } : {}), busy: busy || !!enteringRequirement,
    onSelect: id => { void enterRequirement(id) }, onOpenMaterial: onOpenRequirement,
  }
  const nativeSessionId = !enteringRequirement && !selected?.pendingCreation && selected?.taskStatus === 'active' ? selected.sessionId : undefined
  const emptyConversation = enteringRequirement ? '正在进入需求开发…' : selected?.pendingCreation
    ? `正在为「${selected.title}」准备开发会话，指令与排队位置已保留。`
    : selected?.taskStatus === 'accepted' ? '该事项成果已接受。选择需求可从项目认可成果继续开发。'
    : queueError || '在会话头部选择需求，进入对应的 AI 会话。'
  return <div className={css.workbench}>
    <header className={css.projectHeader}><div className={css.projectName}><span>交互原型</span><span aria-hidden="true">/</span><h1>{state.project?.name}</h1></div><span className={css.projectRequirementCount}>{requirements.length} 项需求</span></header>
    <div className={css.collaborationStrip}><button onClick={() => { setRequestedRequirementId(undefined); setCreating(true); setAiCollapsed(false) }}>新建补充事项</button><span>当前协作</span><span>{selected?.title ?? '在 AI 会话中选择需求'}</span><button onClick={() => setDrawer('diagnostics')}>现场详情</button></div>
    <div className={`${css.workspaceBody} ${aiCollapsed ? css.aiCollapsed : ''}`}>
    <section className={css.conversation} aria-label="原型协作" hidden={aiCollapsed}>
      <header className={css.heading}><strong><Icon name="spark" />原型 AI 协作</strong><button ref={hideAi} title="收起 AI 协作" aria-label="收起 AI 协作" onClick={() => setAiCollapsed(true)}><Icon name="panel-left" /></button></header>

      {creating ? <div className={css.content}><NativeSessionSelector {...conversationSelection} /><p className={css.taskInfo}>新建补充事项。继续已有需求请从会话选择中选择。</p>        <form className={css.instruction} onSubmit={event => { event.preventDefault(); void send() }}>
          <fieldset disabled={!!draft.pendingStartOperationId} className={css.creationFields}><span className={css.contextChip}><Icon name="files" />项目需求 · {requirements.length} 项</span>
          <div className={css.composerBox}><label className={css.srOnly} htmlFor="prototype-instruction">描述需要调整的内容</label>
          <textarea id="prototype-instruction" value={instruction} onChange={event => updateDraft({ ...draft, instruction: event.target.value })} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!busy && instruction.trim()) void send() } }} rows={3} placeholder="描述补充事项需要实现的内容…" />
          <details className={css.instructionOptions}><summary>协作范围与事项名称</summary>
            <label>事项名称（可选）<input value={title} onChange={event => updateDraft({ ...draft, title: event.target.value })} maxLength={150} /></label>
            {requirements.length > 0 && <div className={css.requirementChoices}>{requirements.map(entity => <label key={entity.id}><input type="checkbox" checked={developmentIds.includes(entity.id)} onChange={event => updateDraft({ ...draft, developmentRequirementIds: event.target.checked ? [...developmentIds, entity.id] : developmentIds.filter(id => id !== entity.id) })} />{entity.code ?? entity.id} · {entity.title}</label>)}</div>}
          </details>
          {attachments.length > 0 && <ul>{attachments.map((attachment, index) => <li key={`${attachment.name}:${index}`}>{attachment.kind === 'image' ? '图片' : '文件'} · {attachment.name}<button type="button" onClick={() => updateDraft({ ...draft, attachments: attachments.filter((_item, current) => current !== index) })}>移除</button></li>)}</ul>}

          {draftError && <p role="alert" className={css.fileError}>{draftError}</p>}
          {sendError && <p role="alert" className={css.fileError}>{sendError}</p>}
          <div className={css.composerBottom}><label className={css.attachmentButton} title="附加文件（最多 8 个，共 16 MiB）"><Icon name="plus" /><span className={css.srOnly}>附加文件</span><input className={css.srOnly} type="file" disabled={!!draft.pendingStartOperationId} multiple accept="image/*,.md,.txt,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx" onChange={event => { const files = event.target.files; event.target.value = ''; void attachFiles(files) }} /></label><span>Enter 发送 · Shift + Enter 换行</span><button className={css.sendButton} aria-label="发送实现指令" disabled={busy || !instruction.trim() || !!draft.pendingStartOperationId}><Icon name="arrow-up" /></button></div></div>
          </fieldset>{draft.pendingStartOperationId && <p>原发送结果尚未核对，指令已保留。<button type="submit" disabled={busy}>核对原发送结果</button><button type="button" disabled={busy} onClick={() => void editPendingInstruction()}>编辑指令</button></p>}
        </form>
</div> : <div className={css.nativeSession}><NativeConversation {...faces} sessionId={nativeSessionId} selection={conversationSelection} emptyMessage={emptyConversation} /></div>}
      {selected?.requirementId && <RequirementReviewAction key={selected.prototypeTaskId} item={selected} busy={busy} call={call} />}
      {selected?.pendingNativePromptOperationId && selected.nativePromptDelivery && <div className={css.taskInfo} role="status"><p>{selected.nativePromptDelivery === 'unknown' ? '上次发送结果尚未明确，请核对原指令。' : '上次指令尚未投递，可重试原指令。'}</p><button disabled={busy || recoveringPrompt} onClick={() => void recoverNativePrompt()}>{recoveringPrompt ? '正在核对原指令…' : selected.nativePromptDelivery === 'unknown' ? '核对上次发送' : '重试原指令'}</button></div>}
      {queueError && <p role="alert" className={css.fileError}>{queueError}</p>}
      {sendError && <p role="alert" className={css.fileError}>{sendError}</p>}

    </section>
    <section className={css.result} aria-label="原型成果">
      <div className={css.toolbar}>
        {aiCollapsed && <button ref={showAi} title="展开 AI 协作" aria-label="展开 AI 协作" onClick={() => setAiCollapsed(false)}><Icon name="panel-left" /></button>}
        <div className={css.modeSwitch} role="tablist" aria-label="工作区模式" onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          const next = event.key === 'Home' ? 'preview' : event.key === 'End' ? 'code' : tab === 'preview' ? 'code' : 'preview'
          setTab(next); document.getElementById(`prototype-${next}-tab`)?.focus()
        }}><button id="prototype-preview-tab" role="tab" aria-controls="prototype-preview" aria-selected={tab === 'preview'} tabIndex={tab === 'preview' ? 0 : -1} onClick={() => setTab('preview')}><Icon name="eye" />预览</button><button id="prototype-code-tab" role="tab" aria-controls="prototype-code" aria-selected={tab === 'code'} tabIndex={tab === 'code' ? 0 : -1} onClick={() => setTab('code')}><Icon name="code" />代码</button></div>
        <span className={css.spacer} />
        <button disabled={busy || !fileSource || !!starting} onClick={() => void toggleRun()}><Icon name={preview ? "square" : "play"} />{startingCurrent ? "启动中" : preview ? "停止" : "运行"}</button>
        <button className={css.primaryButton} disabled={busy || !selected || selected.pendingCreation || !!baseline} onClick={() => void reviewPrototype()}>确认原型<Icon name="arrow-right" /></button>
        <WorkbenchMenu actions={[
          { id: 'restart', label: '重新运行预览', disabled: busy || !fileSource || !!starting, run: () => { void restartPreview() } },
          { id: 'diff', label: '变更对比', disabled: !fileSource || !!baseline, run: () => { setTab('code'); setRequestDiff(value => value + 1) } },
          { id: 'diagnostics', label: '诊断信息', run: () => setDrawer('diagnostics') },
        ]} />
      </div>
      {runError && <p className={css.fileError} role="alert">运行尚未成功，请查看 AI 反馈或诊断信息</p>}
      {!baseline && selected?.nextAction && <p className={css.nextAction} aria-live="polite">{selected.nextAction}{selected.localDispatchState === 'running' && <button type="button" disabled={busy} onClick={() => void pauseTask()}>暂停 AI 处理</button>}</p>}
      <div className={css.previewPane} role="tabpanel" id="prototype-preview" aria-labelledby="prototype-preview-tab" hidden={tab !== 'preview'}>
        <PrototypePreview key={preview?.identity.previewId ?? 'empty'} identity={preview?.identity} externalUrl={preview?.url} starting={startingCurrent} visible={tab === 'preview' && !drawer} />
      </div>
      <div className={css.content} hidden={tab !== 'code'} role="tabpanel" id="prototype-code" aria-labelledby="prototype-code-tab">
        {fileSource ? <PrototypeFiles key={JSON.stringify(fileSource)} source={fileSource} requestDiff={requestDiff} call={call} registerFlush={registerFlush} onNeedsAttention={showCode} /> : <div className={css.empty}>{baselineId ? '所选基线不可用，请重新选择工程来源。' : '选择事项或已接受基线，查看工程文件。'}</div>}
      </div>

      {confirmOpen && <section className={css.confirmationPanel} aria-label="确认原型成果"><button onClick={() => setConfirmOpen(false)}>收起成果审阅</button>{selected && <details open><summary>审阅原型成果</summary>{selected.taskStatus === 'active' && (!candidate || candidate.status === 'conflict' || candidate.status === 'no-change' || !reviewReady && candidate.status === 'ready') && <button type="button" disabled={busy} onClick={() => void prepareCandidate()}>重新准备审阅</button>}{candidateError && <p role="alert">{candidateError}</p>}{candidate && <><p>{selected.taskStatus === 'accepted' ? '后台已接受；原事项现场已保留。' : candidate.status === 'conflict' ? '发生冲突，请在当前事项中修复后重新固定并确认。' : candidate.status === 'no-change' ? '没有代码变化；事项仍在开发。' : candidate.status === 'confirmed' ? '作者已确认；后台接受尚未完成。' : '请阅读本次固定成果。'}</p><p>关联开发需求：{candidate.developmentRequirementIds.map(id => { const entity = requirements.find(item => item.id === id); return entity ? `${entity.code ?? id} · ${entity.title}` : id }).join('、')}</p>{candidate.conflict && <div role="alert"><strong>冲突涉及文件</strong><ul>{candidate.conflict.files.map(file => <li key={file}>{file}</li>)}</ul></div>}<ul>{candidate.changes.map(change => <li key={change.path}><button type="button" onClick={() => void readCandidate(change.path)}>{change.path} · {change.status === 'added' ? '新增' : change.status === 'deleted' ? '删除' : '修改'}</button></li>)}</ul>{candidateFile && <div><strong>{candidateFile.path}</strong>{candidateFile.binary ? <p>二进制文件不显示正文。</p> : <PrototypeComparison path={candidateFile.path} base={candidateFile.baseContent ?? ''} current={candidateFile.sourceContent ?? ''} baseLabel={candidateFile.baseContent === undefined ? '原始版本（无文件）' : '原始版本'} currentLabel={candidateFile.sourceContent === undefined ? '固定成果（无文件）' : '固定成果'} />}</div>}{selected.taskStatus === 'active' && (candidate.status === 'ready' || candidate.status === 'confirmed') && <button type="button" disabled={busy || candidate.status === 'ready' && !reviewReady} onClick={() => void confirmAndSubmit()}>{candidate.integrationPhase ? '核对原提交' : candidate.status === 'confirmed' ? '提交已确认成果' : '确认并提交原型'}</button>}{candidate.integrationPhase === 'accepted' && selected.taskStatus === 'accepted' && <button type="button" disabled={busy} onClick={() => void processCandidate()}>重试本机收尾</button>}</>}</details>}{!selected && <p>请先选择一个协作事项。</p>}</section>}
      {runError && <p role="alert" className={css.fileError}>{runError}<button onClick={() => setDrawer('diagnostics')}>查看诊断</button></p>}

    </section>
    </div>
    <footer className={css.workbenchFooter}><span>● 项目原型</span><span>页面与 Mock · 未连接真实业务服务 <button onClick={() => setDrawer('diagnostics')}>诊断</button></span></footer>
    {drawer && <WorkbenchDrawer title='诊断信息' onClose={() => setDrawer(undefined)}>
      {drawer === 'diagnostics' && <>      <section className={css.outputPanel} aria-label="运行与检查输出">
        <div className={css.outputTabs}>{(['runtime', 'problems'] as const).map(value => <button key={value} aria-expanded={output === value} aria-controls="prototype-output" onClick={() => setOutput(output === value ? undefined : value)}>{value === 'runtime' ? '运行日志' : '问题'}</button>)}</div>
        {output && <div id="prototype-output" className={css.outputContent}>{output === 'problems' ? <p>{runError || checkReport?.message || '暂无已记录问题。'}</p> : checkReport ? <details open={output === 'runtime' || checkReport.status === 'running'}>
          <summary>最近{checkReport.kind === 'preview' ? '预览构建' : '工程检查'} · {checkReport.status === 'passed' ? '完成' : checkReport.status === 'failed' ? '失败' : checkReport.status === 'interrupted' ? '中断，待核对' : '运行中'}</summary>
          <p>结果对应本次运行记录。</p>
          <p>开始于 {checkReport.startedAt}{checkReport.completedAt ? `，结束于 ${checkReport.completedAt}` : ''}</p>
          <ul>{checkReport.steps.map(step => <li key={step.name}>{step.name} · {step.status === 'passed' ? '完成' : step.status === 'failed' ? '失败' : '运行中'}{step.exitCode === undefined ? '' : `（退出码 ${step.exitCode}）`}
            {step.status === 'running' && !step.diagnostic && <p>等待进程输出…</p>}
            {step.diagnostic && <details><summary>进程诊断</summary>{step.diagnostic.stdout && <pre>{step.diagnostic.stdout}</pre>}{step.diagnostic.stderr && <pre>{step.diagnostic.stderr}</pre>}{step.diagnostic.error && <p>{step.diagnostic.error}</p>}{step.diagnostic.truncated && <p>输出超过显示上限，日志已截断。</p>}</details>}
          </li>)}</ul>
          {checkReport.message && <p>{checkReport.message}</p>}<p>静态浏览器检查不等于业务用例验收。</p>
        </details> : <p>{startingCurrent ? '正在等待 Host 记录启动操作…' : '尚无运行与检查记录。'}</p>}</div>}
      </section><button type="button" onClick={() => { setDrawer(undefined); setOutput('runtime') }}>查看运行与检查日志</button>{runError && <p role="alert">{runError}</p>}<label>工程来源 <select value={baseline?.id ?? ''} onChange={event => void selectBaseline(event.target.value)}><option value="">{selected ? '当前事项' : '选择已接受基线'}</option>{state.prototypeBaselines?.map(item => <option key={item.id} value={item.id}>原型基线 {item.sequence} · 只读</option>)}</select></label>{selected && materialReads.length > 0 && <details><summary>已读取的需求材料 · {materialReads.length} 次</summary><ul>{materialReads.map((item, index) => <li key={`${item.sessionId}:${item.readAt}:${index}`}>{item.title} · {item.source === 'draft' ? '本人草稿' : `已确认版本 ${item.version}`} · 正文第 {item.startLine}–{item.endLine} 行 · {item.readAt}{item.stale ? ' · 材料已更新，仅提醒，不重绑工程' : ''}</li>)}</ul></details>}{selected && <div className={css.taskInfo}><strong>{selected.title} · 会话与现场</strong><p>逐需求开发进度以队列为准；中断恢复由 Host 按持久记录自动处理。</p>{selected.localDispatchState === 'running' && <button type="button" disabled={busy} onClick={() => void pauseTask()}>暂停</button>}{selected.pauseOperationId && <button type="button" disabled={busy} onClick={() => void pauseTask()}>核对暂停结果</button>}{selected.taskStatus === 'active' && <button type="button" disabled={busy} onClick={() => void endTask()}>{selected.endOperationId ? '核对结束事项结果' : '结束事项'}</button>}<details><summary>事项技术诊断</summary><p>调度状态：{selected.localDispatchState}{selected.nextAction ? ` · ${selected.nextAction}` : ''}{selected.gitRecovery ? ` · Git：${selected.gitRecovery}` : ''}</p>{selected.localDispatchState === 'recovery-required' && !selected.pauseOperationId && <button type="button" disabled={busy} onClick={() => void call({ action: 'queryPrototypeMessage', prototypeTaskId: selected.prototypeTaskId })}>核对消息记录</button>}</details></div>}{baseline && selected?.taskStatus === 'active' && <details><summary>复用到当前事项</summary><p>登记只固定来源与目标事项；后续代码调整仍需在当前事项中检查、确认并由后台接受。</p>{adoption ? <p>{adoption.status === 'succeeded' ? `复用已完成，目标基线 ${adoption.targetBaselineId}` : '复用已登记；等待当前事项形成并接受目标基线。'}</p> : <button type="button" disabled={busy} onClick={() => void adoptBaseline()}>登记复用来源</button>}</details>}</>}

    </WorkbenchDrawer>}
  </div>
}
