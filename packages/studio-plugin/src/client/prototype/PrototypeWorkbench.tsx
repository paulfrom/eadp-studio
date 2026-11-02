import { useCallback, useEffect, useRef, useState } from 'react'
import type { EntityView, StudioCommand, StudioReply, StudioState } from '../../shared/studio.ts'
import type { PrototypeCandidateFile, PrototypeInstructionAttachment } from '../../shared/prototype.ts'
import { PrototypeFiles } from './PrototypeFiles.tsx'
import { PrototypePreview } from './PrototypePreview.tsx'
import { PrototypeIcon as Icon } from './PrototypeIcon.tsx'
import { WorkbenchMenu } from './WorkbenchMenu.tsx'
import { NativeConversation, type NativeConversationFaces, type NativeConversationSelection } from '../components/NativeConversation.tsx'
import { WorkbenchDrawer } from './WorkbenchDrawer.tsx'
import { PrototypeComparison } from './PrototypeEditor.tsx'
import { RequirementReviewAction, requirementDevelopmentStatus } from './RequirementDevelopment.tsx'
import css from './prototype.module.css'

/** Recover an existing attachment locally without sending it to another service. */
function PreservedAttachment({ attachment }: { attachment: PrototypeInstructionAttachment }) {
  const [url, setUrl] = useState<string>()
  useEffect(() => {
    const bytes = Uint8Array.from(atob(attachment.data), character => character.charCodeAt(0))
    const next = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }))
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [attachment.data])
  return <p>{url ? <a href={url} download={attachment.name}>下载保留附件：{attachment.name}</a> : attachment.name}</p>
}

/** Technical failures remain in diagnostics while the work surface explains the next action. */
function collaborationFeedback(message: string, guidance: string): string {
  return !/[\u4e00-\u9fff]/.test(message) || /(?:\bE[A-Z]{2,}\b|[A-Za-z]:[\\/]|\bstack\b|\bTypeError\b|\bHTTP\s+5\d\d\b)/.test(message) ? guidance : message
}

export interface PrototypeViewState { tab: 'preview' | 'code'; baselineId?: string; confirmOpen: boolean }

/** Project prototype, its requirements, and this account's local collaboration queue. */
export function PrototypeWorkbench({ state, entities, busy, call, refresh, registerFlush, flushBeforeLeave, onOpenRequirement, faces, initialView, onViewChange }: {
  faces: NativeConversationFaces
  state: StudioState; entities: EntityView[]; busy: boolean
  call(command: StudioCommand): Promise<StudioReply | undefined>
  refresh(): void
  registerFlush(flush?: () => Promise<boolean>): void
  flushBeforeLeave(): Promise<boolean>
  onOpenRequirement(id: string): void
  initialView: PrototypeViewState | undefined
  onViewChange(view: PrototypeViewState): void
}) {
  const projectId = state.project!.id
  const [tab, setTab] = useState<'preview' | 'code'>(initialView?.tab ?? 'preview')
  const [drawer, setDrawer] = useState<'diagnostics'>()
  const [confirmOpen, setConfirmOpen] = useState(initialView?.confirmOpen ?? false)
  const [aiCollapsed, setAiCollapsed] = useState(false)
  const [previewCollapsed, setPreviewCollapsed] = useState(false)
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
  const [sendError, setSendError] = useState('')
  const [queueError, setQueueError] = useState('')
  const [runError, setRunError] = useState('')
  const [candidateError, setCandidateError] = useState('')
  const [reviewedCandidateId, setReviewedCandidateId] = useState<string>()
  const [candidateFile, setCandidateFile] = useState<PrototypeCandidateFile>()
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
    setBaselineId(undefined)
    setEnteringRequirement(requirementId)
    setQueueError('')
    let operationId = entryOperations.current.get(requirementId)
    if (!operationId) { operationId = crypto.randomUUID(); entryOperations.current.set(requirementId, operationId) }
    try {
      const reply = await call({ action: 'enterPrototypeRequirement', projectId, requirementId, operationId })
      if (!reply?.ok) { setQueueError(reply && !reply.ok ? reply.message : '进入结果待核对，请再次点击同一需求核对原操作。'); return }
      entryOperations.current.delete(requirementId)
      setBaselineId(undefined); setAiCollapsed(false); setConfirmOpen(false)
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
      await call({ action: 'readPrototypeQueue' })
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
  const requirementTitle = requirements.find(entity => entity.id === selectedRequirementId)?.title
  const queueFeedback = collaborationFeedback(queueError, '会话尚未准备好，请重试进入；详细原因可在诊断中查看。')
  const progressMessage = selected?.localDispatchState === 'recovery-required' ? '开发会话需要恢复，原输入和现场已保留。' : selected?.pendingCreation ? '正在准备开发会话，原输入和排队位置已保留。' : selected?.localDispatchState === 'running' ? 'AI 正在处理当前指令，可在对话中查看进展。' : selected?.localDispatchState === 'queued' ? '指令已保留，等待开发会话准备完成。' : selected?.localDispatchState === 'paused' ? '开发已暂停，可以在原会话继续说明。' : '可在当前会话继续描述修改，或运行原型查看结果。'
  const emptyConversation = enteringRequirement ? '正在进入需求开发…' : selected?.pendingCreation
    ? progressMessage
    : selected?.taskStatus === 'accepted' ? '当前成果已接受。选择需求可从项目认可成果继续开发。'
    : queueError ? queueFeedback : '在会话头部选择需求，进入对应的 AI 会话。'
  const runtimeFeedback = runError && <p className={css.fileError} role="alert">{collaborationFeedback(runError, '运行未完成，请查看诊断中的具体原因。')}<button onClick={() => { setAiCollapsed(false); setPreviewCollapsed(true) }}>查看当前会话</button><button onClick={() => setDrawer('diagnostics')}>查看诊断</button></p>
  return <div className={css.workbench}>
    <header className={css.projectHeader}><div className={css.projectName}><span>交互原型</span><span aria-hidden="true">/</span><h1>{state.project?.name}</h1></div><span className={css.projectRequirementCount}>{requirements.length} 项需求</span></header>
    <div className={css.collaborationStrip}><span>当前协作</span><span>{requirementTitle ?? '选择需求继续协作'}</span><button onClick={() => setDrawer('diagnostics')}>现场详情</button></div>
    <div className={`${css.workspaceBody} ${aiCollapsed ? css.aiCollapsed : ''} ${previewCollapsed ? css.previewCollapsed : ''}`}>
    <section className={css.conversation} aria-label="原型协作" hidden={aiCollapsed}>
      <header className={css.heading}><strong><Icon name="spark" />原型 AI 协作</strong><button className={css.panelToggle} aria-expanded={!previewCollapsed} aria-controls="prototype-result" onClick={() => { setPreviewCollapsed(value => !value); setAiCollapsed(false) }}>{previewCollapsed ? '展开预览' : '收起预览'}</button>{previewCollapsed && <button className={css.panelToggle} disabled={busy || !fileSource || !!starting} onClick={() => void toggleRun()}>{startingCurrent ? '启动中' : preview ? '停止' : '运行'}</button>}<button ref={hideAi} title="收起 AI 协作" aria-label="收起 AI 协作" onClick={() => { setAiCollapsed(true); setPreviewCollapsed(false) }}><Icon name="panel-left" /></button></header>

      {previewCollapsed && runtimeFeedback}
      <div className={css.nativeSession}><NativeConversation {...faces} sessionId={nativeSessionId} selection={conversationSelection} emptyMessage={emptyConversation} /></div>
      {selected?.requirementId && <RequirementReviewAction key={selected.prototypeTaskId} item={selected} busy={busy} call={call} />}
      {selected?.pendingNativePromptOperationId && selected.nativePromptDelivery && <div className={css.taskInfo} role="status"><p>{selected.nativePromptDelivery === 'unknown' ? '上次发送结果尚未明确，请核对原指令。' : '上次指令尚未投递，可重试原指令。'}</p><button disabled={busy || recoveringPrompt} onClick={() => void recoverNativePrompt()}>{recoveringPrompt ? '正在核对原指令…' : selected.nativePromptDelivery === 'unknown' ? '核对上次发送' : '重试原指令'}</button></div>}
      {queueError && <p role="alert" className={css.fileError}>{queueFeedback}<button onClick={() => setDrawer('diagnostics')}>查看诊断</button>{selectedRequirementId && <button disabled={busy || !!enteringRequirement} onClick={() => void enterRequirement(selectedRequirementId)}>重试进入</button>}</p>}
      {sendError && <p role="alert" className={css.fileError}>{collaborationFeedback(sendError, '指令处理尚未完成，输入已保留，请查看诊断后恢复。')}<button onClick={() => setDrawer('diagnostics')}>查看诊断</button></p>}

    </section>
    <section id="prototype-result" className={css.result} aria-label="原型成果" hidden={previewCollapsed}>
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
      {runtimeFeedback}
      {!baseline && selected?.nextAction && <p className={css.nextAction} aria-live="polite">{progressMessage}{selectedRequirementId && (selected.pendingCreation || selected.localDispatchState === 'recovery-required') && <button disabled={busy || !!enteringRequirement} onClick={() => void enterRequirement(selectedRequirementId)}>恢复开发会话</button>}<button onClick={() => setDrawer('diagnostics')}>查看诊断</button>{!selected.pendingCreation && selected.localDispatchState === 'running' && <button type="button" disabled={busy} onClick={() => void pauseTask()}>暂停 AI 处理</button>}</p>}
      <div className={css.previewPane} role="tabpanel" id="prototype-preview" aria-labelledby="prototype-preview-tab" hidden={tab !== 'preview'}>
        <PrototypePreview key={preview?.identity.previewId ?? 'empty'} identity={preview?.identity} externalUrl={preview?.url} starting={startingCurrent} visible={tab === 'preview' && !drawer && !previewCollapsed} />
      </div>
      <div className={css.content} hidden={tab !== 'code'} role="tabpanel" id="prototype-code" aria-labelledby="prototype-code-tab">
        {fileSource ? <PrototypeFiles key={JSON.stringify(fileSource)} source={fileSource} requestDiff={requestDiff} call={call} registerFlush={registerFlush} onNeedsAttention={showCode} /> : <div className={css.empty}>{baselineId ? '所选基线不可用，请重新选择工程来源。' : '选择需求查看工程文件，也可在诊断中查看已接受基线。'}</div>}
      </div>

      {confirmOpen && <section className={css.confirmationPanel} aria-label="确认原型成果"><button onClick={() => setConfirmOpen(false)}>收起成果审阅</button>{selected && <details open><summary>审阅原型成果</summary>{selected.taskStatus === 'active' && (!candidate || candidate.status === 'conflict' || candidate.status === 'no-change' || !reviewReady && candidate.status === 'ready') && <button type="button" disabled={busy} onClick={() => void prepareCandidate()}>重新准备审阅</button>}{candidateError && <p role="alert">{candidateError}</p>}{candidate && <><p>{selected.taskStatus === 'accepted' ? '成果已接受，原开发现场已保留。' : candidate.status === 'conflict' ? '发生冲突，请在当前会话中修复后重新审阅并确认。' : candidate.status === 'no-change' ? '没有代码变化，当前需求仍在开发。' : candidate.status === 'confirmed' ? '作者已确认；后台接受尚未完成。' : '请阅读本次固定成果。'}</p><p>关联开发需求：{candidate.developmentRequirementIds.map(id => { const entity = requirements.find(item => item.id === id); return entity ? `${entity.code ?? id} · ${entity.title}` : id }).join('、')}</p>{candidate.conflict && <div role="alert"><strong>冲突涉及文件</strong><ul>{candidate.conflict.files.map(file => <li key={file}>{file}</li>)}</ul></div>}<ul>{candidate.changes.map(change => <li key={change.path}><button type="button" onClick={() => void readCandidate(change.path)}>{change.path} · {change.status === 'added' ? '新增' : change.status === 'deleted' ? '删除' : '修改'}</button></li>)}</ul>{candidateFile && <div><strong>{candidateFile.path}</strong>{candidateFile.binary ? <p>二进制文件不显示正文。</p> : <PrototypeComparison path={candidateFile.path} base={candidateFile.baseContent ?? ''} current={candidateFile.sourceContent ?? ''} baseLabel={candidateFile.baseContent === undefined ? '原始版本（无文件）' : '原始版本'} currentLabel={candidateFile.sourceContent === undefined ? '固定成果（无文件）' : '固定成果'} />}</div>}{selected.taskStatus === 'active' && (candidate.status === 'ready' || candidate.status === 'confirmed') && <button type="button" disabled={busy || candidate.status === 'ready' && !reviewReady} onClick={() => void confirmAndSubmit()}>{candidate.integrationPhase ? '核对原提交' : candidate.status === 'confirmed' ? '提交已确认成果' : '确认并提交原型'}</button>}{candidate.integrationPhase === 'accepted' && selected.taskStatus === 'accepted' && <button type="button" disabled={busy} onClick={() => void processCandidate()}>重试本机收尾</button>}</>}</details>}{!selected && <p>请先在会话头部选择需求。</p>}</section>}

    </section>
    </div>
    <footer className={css.workbenchFooter}><span>● 项目原型</span><span>页面与 Mock · 未连接真实业务服务 <button onClick={() => setDrawer('diagnostics')}>诊断</button></span></footer>
    {drawer && <WorkbenchDrawer title='诊断信息' onClose={() => setDrawer(undefined)}>
      {drawer === 'diagnostics' && <>{queueError && <details open><summary>会话进入诊断</summary><pre>{queueError}</pre></details>}{sendError && <details open><summary>指令处理诊断</summary><pre>{sendError}</pre></details>}{(state.prototypeInstructionDrafts ?? []).some(draft => draft.projectId === projectId && (draft.instruction || draft.attachments?.length)) && <details><summary>保留的未发送输入</summary>{(state.prototypeInstructionDrafts ?? []).filter(draft => draft.projectId === projectId && (draft.instruction || draft.attachments?.length)).map((draft, index) => <section key={index}><p>{draft.title}</p><pre>{draft.instruction}</pre>{draft.attachments?.map((attachment, i) => <PreservedAttachment key={i} attachment={attachment} />)}<p>{draft.pendingStartOperationId ? `原发送结果待核对，操作：${draft.pendingStartOperationId}。请先核对原操作，不要复制重发；输入与附件已保留。` : '输入仍保存在项目中，可复制到原生对话继续，附件可下载后重新附加。'}</p></section>)}</details>}      <section className={css.outputPanel} aria-label="运行与检查输出">
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
      </section><button type="button" onClick={() => { setOutput('runtime') }}>查看运行与检查日志</button>{runError && <p role="alert">{runError}</p>}<label>工程来源 <select value={baseline?.id ?? ''} onChange={event => void selectBaseline(event.target.value)}><option value="">{selected ? '当前事项' : '选择已接受基线'}</option>{state.prototypeBaselines?.map(item => <option key={item.id} value={item.id}>原型基线 {item.sequence} · 只读</option>)}</select></label>{selected && materialReads.length > 0 && <details><summary>已读取的需求材料 · {materialReads.length} 次</summary><ul>{materialReads.map((item, index) => <li key={`${item.sessionId}:${item.readAt}:${index}`}>{item.title} · {item.source === 'draft' ? '本人草稿' : `已确认版本 ${item.version}`} · 正文第 {item.startLine}–{item.endLine} 行 · {item.readAt}{item.stale ? ' · 材料已更新，仅提醒，不重绑工程' : ''}</li>)}</ul></details>}{selected && <div className={css.taskInfo}><strong>{selected.title} · 会话与现场</strong><p>逐需求开发进度以队列为准；中断恢复由 Host 按持久记录自动处理。</p>{!selected.pendingCreation && selected.localDispatchState === 'running' && <button type="button" disabled={busy} onClick={() => void pauseTask()}>暂停</button>}{!selected.pendingCreation && selected.pauseOperationId && <button type="button" disabled={busy} onClick={() => void pauseTask()}>核对暂停结果</button>}{!selected.pendingCreation && selected.taskStatus === 'active' && <button type="button" disabled={busy} onClick={() => void endTask()}>{selected.endOperationId ? '核对结束事项结果' : '结束事项'}</button>}<details><summary>事项技术诊断</summary><p>调度状态：{selected.localDispatchState}{selected.nextAction ? ` · ${selected.nextAction}` : ''}{selected.gitRecovery ? ` · Git：${selected.gitRecovery}` : ''}</p>{!selected.pendingCreation && selected.localDispatchState === 'recovery-required' && !selected.pauseOperationId && <button type="button" disabled={busy} onClick={() => void call({ action: 'queryPrototypeMessage', prototypeTaskId: selected.prototypeTaskId })}>核对消息记录</button>}</details></div>}{baseline && selected?.taskStatus === 'active' && !selected.pendingCreation && <details><summary>复用到当前事项</summary><p>登记只固定来源与目标事项；后续代码调整仍需在当前事项中检查、确认并由后台接受。</p>{adoption ? <p>{adoption.status === 'succeeded' ? `复用已完成，目标基线 ${adoption.targetBaselineId}` : '复用已登记；等待当前事项形成并接受目标基线。'}</p> : <button type="button" disabled={busy} onClick={() => void adoptBaseline()}>登记复用来源</button>}</details>}</>}

    </WorkbenchDrawer>}
  </div>
}
