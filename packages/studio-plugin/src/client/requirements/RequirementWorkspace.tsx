import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ConfirmationChoice, EntityView, StudioCommand, StudioReply, StudioState } from '../../shared/studio.ts'
import type { ScenarioSource, ScenarioWorkspace as Workspace } from '../../shared/scenarios.ts'
import type { StudioProps } from '../studio/StudioPanel.tsx'
import { MaterialConversation } from '../components/MaterialConversation.tsx'
import { ConsistencyPanel } from '../components/ConsistencyPanel.tsx'
import { ReviewPanel } from '../components/ReviewPanel.tsx'
import { ScenarioWriteProposalCard, ScenarioWriteProposalError } from '../scenarios/ScenarioWriteProposalCard.tsx'
import { ScenarioWriteReceiptCard } from '../scenarios/ScenarioWriteReceiptCard.tsx'
import { useDraftBuffer } from '../scenarios/useDraftBuffer.ts'
import { sameDraftInput, type DraftInput } from '../scenarios/DraftBuffer.ts'
import { RequirementGates } from './RequirementGates.tsx'
import { RequirementSpecPanel } from './RequirementSpecPanel.tsx'
import type { RequirementMetadataFormHandle } from './RequirementMetadataForm.tsx'
import { MaterialDiscussionSummary } from '../components/MaterialDiscussionSummary.tsx'
import { MaterialWorkspaceHeader, MaterialWorkspaceSheet, MaterialWorkspaceStatus, useMaterialDocumentFocus } from '../components/MaterialWorkspaceChrome.tsx'
import layout from '../components/materialWorkspace.module.css'
import css from '../studio.module.css'

interface WorkspaceProps {
  workspace: Workspace; entity: EntityView; state: StudioState; faces: StudioProps; busy: boolean;
  call(command: StudioCommand): Promise<StudioReply | undefined>;
  registerFlush(flush?: () => Promise<boolean>): void;
  onOpenMaterial?(entity: EntityView): void;
  onOpenScenario(entityId: string): void;
  onOpenPrototype(entityId: string): void;
}
/**
 * Requirement page: the AI conversation beside the requirement document. Owns
 * the draft and recovery choices; confirmation submits the complete current
 * input so the Host can save and continue the same confirmation flow.
 */
export function RequirementWorkspace({ workspace, entity, state, faces, busy, call, registerFlush, onOpenScenario, onOpenMaterial, onOpenPrototype }: WorkspaceProps) {
  const [collapsed, setCollapsed] = useState(false)
  const documentFocus = useMaterialDocumentFocus(collapsed)
  const [confirmationOpen, setConfirmationOpen] = useState(false)
  const [consistencyOpen, setConsistencyOpen] = useState(false)
  const [consistencyStatus, setConsistencyStatus] = useState('读取中')
  const [reviewRequested, setReviewRequested] = useState(0)
  useEffect(() => { if (workspace.readOnly) setConfirmationOpen(false) }, [workspace.readOnly])
  const [confirmationChoice, setConfirmationChoice] = useState<ConfirmationChoice>()
  const [confirming, setConfirming] = useState(false)
  const [recoveryError, setRecoveryError] = useState('')
  const [recoveryDeferred, setRecoveryDeferred] = useState(false)
  const [editRequested, setEditRequested] = useState(0)
  const operations = useRef(new Map<string, { fingerprint: string; id: string }>())
  const operationId = useCallback((action: string, input: unknown) => {
    const fingerprint = JSON.stringify(input)
    let operation = operations.current.get(action)
    if (!operation || operation.fingerprint !== fingerprint) { operation = { fingerprint, id: crypto.randomUUID() }; operations.current.set(action, operation) }
    return operation.id
  }, [])
  const metadataForm = useRef<RequirementMetadataFormHandle | null>(null)
  const deferredInputPreserved = useRef(false)
  const registerWorkspaceFlush = useCallback((flush?: () => Promise<boolean>) => {
    registerFlush(flush && (async () => (metadataForm.current?.validate() ?? true) ? deferredInputPreserved.current || flush() : false))
  }, [registerFlush])
  const { buffer, snapshot } = useDraftBuffer(workspace.draft, async input => {
    const result = await call({ action: 'saveRequirement', entityId: entity.id, ...input })
    if (!result?.ok || !result.state.requirement) {
      await call({ action: 'state' })
      throw new Error(result && !result.ok ? result.message : '本地保存失败，当前输入已保留。')
    }
    const saved = result.state.requirement
    if (saved.requirementSave && !saved.requirementSave.documentSaved) throw new Error(saved.requirementSave.message)
    return saved.draft
  }, registerWorkspaceFlush)
  const restoredOperations = useRef(new Set<string>())
  useEffect(() => {
    const pending = workspace.requirementSave
    if (!pending?.input || restoredOperations.current.has(pending.operationId)) return
    restoredOperations.current.add(pending.operationId)
    const current = buffer.getSnapshot()
    if (!current.dirty && !current.saving) buffer.restoreInput(pending.input)
  }, [buffer, workspace.requirementSave])
  const flush = useCallback(async (): Promise<boolean> => {
    if (metadataForm.current && !metadataForm.current.validate()) { setRecoveryError('请修正业务字段后继续保存。'); setRecoveryDeferred(false); return false }
    const saved = await buffer.flush()
    if (!saved) { setRecoveryError(buffer.getSnapshot().error || '请选择恢复方案后继续保存。'); setRecoveryDeferred(false) }
    return saved
  }, [buffer])
  const execute = useCallback(async (command: StudioCommand | ((hash: string) => StudioCommand), flushFirst = true) => {
    if (flushFirst && !await flush()) return undefined
    const result = await call(typeof command === 'function' ? command(buffer.getSnapshot().sha256) : command)
    if (result?.ok && result.state.requirement?.entityId === entity.id) buffer.receive(result.state.requirement.draft)
    return result
  }, [buffer, call, entity.id, flush])
  const receiveSaved = useCallback((result: StudioReply | undefined, input?: DraftInput) => {
    if (!result?.ok || result.state.requirement?.entityId !== entity.id) {
      buffer.finishWrite()
      setRecoveryError(result && !result.ok ? result.message : '保存结果尚未核对，请重试或稍后继续。')
      return undefined
    }
    const saved = result.state.requirement
    if (!saved.requirementSave || saved.requirementSave.documentSaved) {
      if (input) buffer.acknowledge(saved.draft, input)
      else buffer.receive(saved.draft)
    }
    buffer.finishWrite()
    if (!saved.requirementSave && !saved.confirmationRecovery) {
      setRecoveryError(buffer.getSnapshot().dirty ? '本次提交已处理，期间的新输入仍已保留，请核对后继续。' : '')
      setConfirmationChoice(undefined)
    }
    return saved
  }, [buffer, entity.id])
  const confirm = useCallback(async (choice: ConfirmationChoice) => {
    setConfirmationChoice(choice); setRecoveryDeferred(false); setRecoveryError('')
    if (metadataForm.current && !metadataForm.current.validate()) { setRecoveryError('请修正业务字段后继续确认。'); setConfirmationOpen(false); setEditRequested(value => value + 1); return }
    setConfirming(true)
    try {
      await buffer.prepareWrite()
      const current = buffer.getSnapshot()
      const input = { body: current.body, metadata: current.metadata, expectedHash: current.sha256 }
      const occupation = entity.occupation && { id: entity.occupation.occupationId, generation: entity.occupation.generation, taskId: entity.occupation.taskId, clientId: entity.occupation.clientId }
      receiveSaved(await call({ action: 'confirmRequirement', entityId: entity.id, operationId: operationId('confirm', { ...input, choice, occupation }), ...input, ...choice }), input)
    } finally { buffer.finishWrite(); setConfirming(false) }
  }, [buffer, call, entity.id, entity.occupation, operationId, receiveSaved])
  const continuingConfirmation = !!confirmationChoice || !!workspace.confirmationRecovery
  const retryRecovery = useCallback(async () => {
    setRecoveryDeferred(false)
    const current = buffer.getSnapshot()
    const original = workspace.requirementSave?.operationId ?? workspace.confirmationRecovery?.operationId
    const originalInput = workspace.requirementSave?.input
    const confirmationVersionChanged = !workspace.requirementSave && workspace.confirmationRecovery?.expectedHash && workspace.confirmationRecovery.expectedHash !== current.sha256
    if ((current.dirty && (!originalInput || !sameDraftInput(current, originalInput))) || confirmationVersionChanged || !original) {
      if (continuingConfirmation) await confirm(confirmationChoice ?? { method: 'direct' })
      else await flush()
      return
    }
    setConfirming(true)
    try {
      await buffer.prepareWrite()
      const input = buffer.getSnapshot()
      receiveSaved(await call({ action: 'retryRequirementSave', entityId: entity.id, operationId: original }), input)
    }
    finally { buffer.finishWrite(); setConfirming(false) }
  }, [buffer, call, entity.id, workspace.requirementSave, workspace.confirmationRecovery, continuingConfirmation, confirmationChoice, confirm, flush, receiveSaved])
  const reclaim = useCallback(async () => {
    const refreshed = await call({ action: 'state' })
    if (!refreshed?.ok) { receiveSaved(refreshed); return }
    const current = refreshed.state.collaboration?.entities.find(value => value.id === entity.id && 'revision' in value) as EntityView | undefined
    const result = await call(current?.current ? { action: 'startRequirementRevision', entityId: entity.id, expectedRevision: current.revision } : { action: 'openRequirement', entityId: entity.id })
    if (!result?.ok) { receiveSaved(result); return }
    operations.current.delete('confirm')
    if (continuingConfirmation) await confirm(confirmationChoice ?? { method: 'direct' })
    else if (metadataForm.current?.validate() ?? true) {
      await buffer.prepareWrite()
      const input = buffer.getSnapshot()
      receiveSaved(await call({ action: 'saveRequirement', entityId: entity.id, operationId: crypto.randomUUID(), body: input.body, metadata: input.metadata }), input)
    }
  }, [buffer, call, entity.id, receiveSaved, continuingConfirmation, confirmationChoice, confirm])
  const actions = useMemo(() => ({
    refresh: () => { void execute({ action: 'openRequirement', entityId: entity.id }) },
    newSession: () => { void execute({ action: 'newRequirementSession', entityId: entity.id }) },
    selectSession: (sessionId: string) => { void execute({ action: 'selectRequirementSession', entityId: entity.id, sessionId }) },
    openTemplates: () => faces.openSettings('studio-scenario-templates'),
    startRevision: () => {
      if (workspace.requirementSave || workspace.confirmationRecovery) void reclaim()
      else void execute({ action: 'startRequirementRevision', entityId: entity.id, expectedRevision: entity.revision }, false)
    },
    importSource: async (name: string, base64: string) => { const result = await execute({ action: 'importScenarioSource', entityId: entity.id, name, base64, operationId: crypto.randomUUID() }); if (!result?.ok) throw new Error('资料未能导入，请查看错误并重试。') },
    retrySource: (sourceId: string) => { void execute({ action: 'retryScenarioSource', entityId: entity.id, sourceId }) },
    selectSource: (source: ScenarioSource, selected: boolean, formal: boolean) => { void execute({ action: 'selectScenarioSource', entityId: entity.id, sourceId: source.id, selected, formal }) },
    resolveWriteProposal: (decision: 'write' | 'reject', selectedChangeIds?: string[]) => {
      const proposal = workspace.writeProposal
      if (proposal) void execute(hash => ({ action: 'resolveRequirementWriteProposal', entityId: entity.id, proposalId: proposal.id, decision, ...(selectedChangeIds ? { selectedChangeIds } : {}), expectedHash: hash }))
    },
    undoWrite: () => {
      const receipt = workspace.writeReceipt
      if (receipt) void execute(hash => ({ action: 'undoRequirementWrite', entityId: entity.id, operationId: receipt.operationId, expectedHash: hash }))
    },
    requestReview: () => { void execute({ action: 'requestReview', entityId: entity.id, purpose: 'material' }) },
    confirm: (choice: ConfirmationChoice) => { void confirm(choice) },
    structureCheck: (enabled: boolean) => { void execute({ action: 'setScenarioStructureCheck', enabled }) },
  }), [execute, entity.id, entity.revision, faces, call, confirm, reclaim, workspace.writeProposal, workspace.writeReceipt, workspace.requirementSave, workspace.confirmationRecovery])
  const entities = useMemo(() => (state.collaboration?.entities ?? []).filter((value): value is EntityView => 'title' in value), [state.collaboration])
  const sessions = workspace.sessions.filter(session => session.entityId === entity.id && session.purpose === 'material')
  const task = sessions.find(session => session.sessionId === workspace.activeSessionId)
  const review = state.reviews.filter(item => item.entityId === entity.id && item.purpose === 'material').at(-1)
  const materialSources = state.materialSources?.find(value => value.entityId === entity.id)
  const locked = busy || confirming
  const hasRecovery = !!workspace.requirementSave || !!workspace.confirmationRecovery
  const recoveryMessage = workspace.requirementSave?.message || workspace.confirmationRecovery?.message || recoveryError || snapshot.error
  deferredInputPreserved.current = recoveryDeferred && (workspace.requirementSave?.input
    ? sameDraftInput(snapshot, workspace.requirementSave.input)
    : !!workspace.confirmationRecovery && !snapshot.dirty || !!workspace.requirementSave?.documentSaved && !snapshot.dirty)
  return <div className={layout.frame}><div ref={documentFocus.panes} className={`${css.scenarioWorkspace} ${layout.panes} ${collapsed ? css.scenarioCollapsed : ''}`}>
    <section className={`${css.chatPanel} ${layout.materialPanel}`} aria-label="需求对话">
      <MaterialWorkspaceHeader entity={entity} sessions={sessions} activeSessionId={task?.sessionId} locked={locked} readOnly={workspace.readOnly} reviewCount={workspace.writeProposal?.status === 'pending' ? workspace.writeProposal.changes.length : 0} onReview={() => setReviewRequested(value => value + 1)} onConfirm={() => setConfirmationOpen(true)} onRefresh={actions.refresh} onNewSession={actions.newSession} onSelectSession={actions.selectSession} onTemplates={actions.openTemplates} onOpenPrototype={() => onOpenPrototype(entity.id)} />
      {workspace.readOnly && <div className={css.panelNotice}>
        <span>确认人 #{workspace.confirmedBy ?? entity.current?.confirmedBy} · {workspace.confirmedAt ?? entity.current?.confirmedAt}</span>
        <button disabled={busy || confirming} onClick={actions.startRevision}>开始修订需求</button>
      </div>}
      <div className={css.chatDock}>
        {task?.error && <div className={css.notice}>{task.error}</div>}
        {recoveryMessage && (!workspace.readOnly || hasRecovery) && <section className={css.panelNotice} aria-label="需求保存恢复">
          {recoveryDeferred ? <><p>输入和已生效结果已保留，可稍后继续处理。</p><button disabled={busy || confirming} onClick={() => setRecoveryDeferred(false)}>继续处理</button></> : <>
            <strong>{continuingConfirmation ? '选择恢复方案，继续本次确认' : '保存未完成，请选择恢复方式'}</strong>
            <p role="alert">{recoveryMessage}</p>
            {workspace.requirementSave?.documentSaved && <p>正文已保存，剩余更新仍待完成。</p>}
            <div className={css.actionBar}>
              {!workspace.readOnly && <button disabled={busy || confirming} onClick={() => void retryRecovery()}>{continuingConfirmation ? '重试保存并继续确认' : '核对并重试保存'}</button>}
              {(workspace.requirementSave?.reason === 'occupation' || workspace.readOnly) && <button disabled={busy || confirming} onClick={() => void reclaim()}>核对并重新取得编辑权</button>}
              <button disabled={busy || confirming} onClick={() => { setEditRequested(value => value + 1); setRecoveryDeferred(false) }}>{workspace.readOnly ? '查看保留的输入' : '修改内容或关系'}</button>
              <button disabled={busy || confirming} onClick={() => setRecoveryDeferred(true)}>稍后继续</button>
            </div>
          </>}
        </section>}
        <MaterialDiscussionSummary questions={snapshot.metadata.openQuestions} sources={materialSources?.sources ?? []} onQuestions={() => setConfirmationOpen(true)} />
        {workspace.writeProposalError && <ScenarioWriteProposalError message={workspace.writeProposalError} />}
        {workspace.writeProposal && <ScenarioWriteProposalCard sources={materialSources?.sources ?? []} hideReviewAction reviewRequested={reviewRequested} materialLabel="需求" proposal={workspace.writeProposal} disabled={locked || workspace.readOnly} onResolve={actions.resolveWriteProposal} />}
        {workspace.writeReceipt && <ScenarioWriteReceiptCard receipt={workspace.writeReceipt} disabled={locked || workspace.readOnly} onUndo={actions.undoWrite} />}
      </div>
      <MaterialConversation sessionId={task?.sessionId} faces={faces} decisionQuestions={workspace.decisionQuestions} decisionQuestionsError={workspace.decisionQuestionsError} attachments={{
        sources: materialSources?.sources ?? [], disabled: locked || !materialSources, readOnly: materialSources?.readOnly ?? true,
        onImport: actions.importSource, onRetry: actions.retrySource, onSelect: actions.selectSource,
      }}>
        <span>✦</span><h3>{workspace.readOnly ? '已确认固定需求' : '与 AI 整理业务需求'}</h3><p>{workspace.readOnly ? '开始修订后可继续编辑与对话。' : '新建需求会话，继承当前 Markdown、固定模板和当前选定资料。明确同意写入后，才会更新正文。'}</p>
      </MaterialConversation>
      <p className={layout.composerHint}>Enter 发送 · Shift + Enter 换行 · 助手建议经审阅后写入正文</p>
    </section>
    <RequirementSpecPanel entity={entity} draft={workspace.draft} buffer={buffer} snapshot={snapshot} workspace={workspace} templates={state.projectTemplates?.requirements} entities={entities} projectId={state.project!.id} candidates={state.candidates} busy={busy || confirming} call={call} metadataForm={metadataForm} onFlush={flush} onCollapse={() => setCollapsed(true)} onOpenScenario={onOpenScenario} confirming={confirming} editRequested={editRequested}>
    </RequirementSpecPanel>
    {collapsed && <aside className={layout.restore}><button ref={documentFocus.restore} aria-label="展开需求文档" onClick={() => setCollapsed(false)}>‹ 文档预览</button></aside>}
  </div>
  <MaterialWorkspaceStatus entity={entity} workspace={workspace} snapshot={snapshot} task={task} consistency={consistencyStatus} onConfirmation={() => setConfirmationOpen(true)} onConsistency={() => setConsistencyOpen(true)} />
  <MaterialWorkspaceSheet open={consistencyOpen} title="一致性对比" subtitle="查看对比结论、覆盖范围与历史记录" drawer onClose={() => setConsistencyOpen(false)}>
      <ConsistencyPanel entityId={entity.id} entities={entities} tasks={state.consistencyTasks ?? []} busy={busy} call={call} onOpenMaterial={onOpenMaterial} onStatusChange={setConsistencyStatus} />
  </MaterialWorkspaceSheet>
  <MaterialWorkspaceSheet open={confirmationOpen} title="确认需求" subtitle="保存当前输入后重新检查，接受后形成固定版本" onClose={() => setConfirmationOpen(false)}>
      <RequirementGates workspace={workspace} disabled={busy || confirming} dirty={snapshot.dirty} buffer={buffer} snapshot={snapshot} onConfirm={() => actions.confirm({ method: 'direct' })} onStructureCheck={actions.structureCheck} />
      <div className={layout.reviewBlock}><ReviewPanel review={review} purpose="material" busy={busy || confirming} onRequest={actions.requestReview} onConfirm={actions.confirm} /></div>
  </MaterialWorkspaceSheet>
  </div>
}
