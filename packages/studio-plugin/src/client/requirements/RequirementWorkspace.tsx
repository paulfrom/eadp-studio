import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ConfirmationChoice, EntityView, MaterialMetadata, StudioCommand, StudioReply, StudioState } from '../../shared/studio.ts'
import type { ScenarioSource, ScenarioWorkspace as Workspace } from '../../shared/scenarios.ts'
import type { StudioProps } from '../studio/StudioPanel.tsx'
import { MaterialConversation } from '../components/MaterialConversation.tsx'
import { ConsistencyPanel } from '../components/ConsistencyPanel.tsx'
import { ReviewPanel } from '../components/ReviewPanel.tsx'
import { ScenarioWriteProposalCard } from '../scenarios/ScenarioWriteProposalCard.tsx'
import { ScenarioWriteReceiptCard } from '../scenarios/ScenarioWriteReceiptCard.tsx'
import { useDraftBuffer } from '../scenarios/useDraftBuffer.ts'
import { RequirementGates } from './RequirementGates.tsx'
import { RequirementSpecPanel } from './RequirementSpecPanel.tsx'
import type { RequirementMetadataFormHandle } from './RequirementMetadataForm.tsx'
import css from '../studio.module.css'

interface WorkspaceProps {
  workspace: Workspace; entity: EntityView; state: StudioState; faces: StudioProps; busy: boolean;
  call(command: StudioCommand): Promise<StudioReply | undefined>;
  registerFlush(flush?: () => Promise<boolean>): void;
  onOpenMaterial?(entity: EntityView): void;
  onOpenScenario(entityId: string): void;
}
/**
 * Requirement page: the AI conversation beside the requirement document. Owns
 * the draft boundary, so every version-changing action first flushes the
 * shared buffer, and invalid business-field text keeps it from flushing.
 */
export function RequirementWorkspace({ workspace, entity, state, faces, busy, call, registerFlush, onOpenScenario, onOpenMaterial }: WorkspaceProps) {
  const [collapsed, setCollapsed] = useState(false)
  const [naturalConfirmation, setNaturalConfirmation] = useState('')
  const operations = useRef(new Map<string, { fingerprint: string; id: string }>())
  const operationId = useCallback((action: string, input: unknown) => {
    const fingerprint = JSON.stringify(input)
    let operation = operations.current.get(action)
    if (!operation || operation.fingerprint !== fingerprint) { operation = { fingerprint, id: crypto.randomUUID() }; operations.current.set(action, operation) }
    return operation.id
  }, [])
  const metadataForm = useRef<RequirementMetadataFormHandle | null>(null)
  const registerWorkspaceFlush = useCallback((flush?: () => Promise<boolean>) => {
    registerFlush(flush && (async () => (metadataForm.current?.validate() ?? true) ? flush() : false))
  }, [registerFlush])
  const { buffer, snapshot } = useDraftBuffer(workspace.draft, async input => {
    const result = await call({ action: 'saveRequirement', entityId: entity.id, ...input })
    if (!result?.ok || !result.state.requirement) {
      await call({ action: 'state' })
      throw new Error(result && !result.ok ? result.message : '本地保存失败，当前输入已保留。')
    }
    if (result.state.requirement.conflict) throw new Error('文件出现并发修改，请先解决冲突。')
    return result.state.requirement.draft
  }, registerWorkspaceFlush)
  useEffect(() => { if (workspace.conflict) buffer.receive(workspace.conflict.actual) }, [buffer, workspace.conflict])
  const flush = useCallback(async (): Promise<boolean> => {
    if (metadataForm.current && !metadataForm.current.validate()) return false
    return buffer.flush()
  }, [buffer])
  const execute = useCallback(async (command: StudioCommand | ((hash: string) => StudioCommand), flushFirst = true) => {
    if (flushFirst && !await flush()) return undefined
    const result = await call(typeof command === 'function' ? command(buffer.getSnapshot().sha256) : command)
    if (result?.ok && result.state.requirement?.entityId === entity.id && !result.state.requirement.conflict) buffer.receive(result.state.requirement.draft)
    return result
  }, [buffer, call, entity.id, flush])
  const resolve = useCallback(async (body: string, metadata: MaterialMetadata, actualHash: string) => {
    const result = await execute({ action: 'resolveRequirementConflict', entityId: entity.id, body, metadata, expectedHash: actualHash, operationId: operationId('resolve', { body, metadata, actualHash }) }, false)
    if (result?.ok && result.state.requirement && !result.state.requirement.conflict) buffer.accept(result.state.requirement.draft)
  }, [buffer, execute, entity.id, operationId])
  const actions = useMemo(() => ({
    refresh: () => { void execute({ action: 'openRequirement', entityId: entity.id }) },
    newSession: () => { void execute({ action: 'newRequirementSession', entityId: entity.id }) },
    selectSession: (sessionId: string) => { void execute({ action: 'selectRequirementSession', entityId: entity.id, sessionId }) },
    openTemplates: () => faces.openSettings('studio-scenario-templates'),
    bindTemplate: (templateId: string) => { void execute(hash => ({ action: 'bindRequirementTemplate', entityId: entity.id, templateId, expectedHash: hash, operationId: operationId('bind', { templateId, hash }) })) },
    startRevision: () => { void execute({ action: 'startRequirementRevision', entityId: entity.id, expectedRevision: entity.revision }) },
    importSource: async (name: string, base64: string) => { const result = await execute({ action: 'importScenarioSource', entityId: entity.id, name, base64, operationId: crypto.randomUUID() }); if (!result?.ok) throw new Error('资料未能导入，请查看错误并重试。') },
    retrySource: (sourceId: string) => { void execute({ action: 'retryScenarioSource', entityId: entity.id, sourceId }) },
    selectSource: (source: ScenarioSource, selected: boolean, formal: boolean) => { void execute({ action: 'selectScenarioSource', entityId: entity.id, sourceId: source.id, selected, formal }) },
    resolveWriteProposal: (decision: 'write' | 'reject') => {
      const proposal = workspace.writeProposal
      if (proposal) void execute(hash => ({ action: 'resolveRequirementWriteProposal', entityId: entity.id, proposalId: proposal.id, decision, expectedHash: hash }))
    },
    undoWrite: () => {
      const receipt = workspace.writeReceipt
      if (receipt) void execute(hash => ({ action: 'undoRequirementWrite', entityId: entity.id, operationId: receipt.operationId, expectedHash: hash }))
    },
    requestReview: () => { void execute({ action: 'requestReview', entityId: entity.id, purpose: 'material' }) },
    confirm: (choice: ConfirmationChoice) => { void execute(hash => ({ action: 'confirmMaterial', entityId: entity.id, expectedHash: hash, ...choice })) },
    structureCheck: (enabled: boolean) => { void execute({ action: 'setScenarioStructureCheck', enabled }) },
  }), [execute, entity.id, entity.revision, faces, call, operationId, workspace.writeProposal, workspace.writeReceipt])
  const entities = useMemo(() => (state.collaboration?.entities ?? []).filter((value): value is EntityView => 'title' in value), [state.collaboration])
  const sessions = workspace.sessions.filter(session => session.entityId === entity.id && session.purpose === 'material')
  const task = sessions.find(session => session.sessionId === workspace.activeSessionId)
  const review = state.reviews.filter(item => item.entityId === entity.id && item.purpose === 'material').at(-1)
  const materialSources = state.materialSources?.find(value => value.entityId === entity.id)
  const locked = busy || !!snapshot.conflict
  return <div className={`${css.scenarioWorkspace} ${collapsed ? css.scenarioCollapsed : ''}`}>
    <section className={css.chatPanel} aria-label="需求对话">
      <header className={css.panelBar}>
        <div className={css.panelIdentity}>
          <span className={css.codeChip}>{entity.code ?? entity.id}</span>
          <strong>{entity.title}</strong>
        </div>
        <div className={css.panelActions}>
          <button onClick={actions.refresh} disabled={busy} title="重新读取需求材料">刷新</button>
          <label className={css.inlineField}>历史会话<select disabled={locked} value={task?.sessionId ?? ''} onChange={event => { if (event.target.value) actions.selectSession(event.target.value) }}><option value="" disabled>选择需求会话</option>{sessions.map((session, index) => <option key={session.sessionId} value={session.sessionId}>会话 {index + 1} · {session.sessionId.slice(0, 8)}</option>)}</select></label>
          <button onClick={actions.newSession} disabled={locked}>新会话</button>
          <button onClick={actions.openTemplates}>需求模板</button>
          {collapsed && <button className={css.primary} onClick={() => setCollapsed(false)}>展开说明</button>}
        </div>
      </header>
      <div className={css.contextStrip}>
        <span>{workspace.readOnly ? `确认版本 v${entity.materialVersion}` : '本地草稿'}</span>
        <span>{entity.occupation ? `当前编辑人 #${entity.occupation.ownerId}` : '无设计占用'}</span>
        <span>创建人 {entity.creator?.name ?? `#${entity.authorId}`}</span>
      </div>
      {workspace.readOnly && <div className={css.panelNotice}>
        <span>确认人 #{workspace.confirmedBy ?? entity.current?.confirmedBy} · {workspace.confirmedAt ?? entity.current?.confirmedAt}</span>
        <button disabled={busy} onClick={actions.startRevision}>开始修订需求</button>
      </div>}
      <div className={css.chatDock}>
        {task?.error && <div className={css.notice}>{task.error}</div>}
        {workspace.writeProposal && <ScenarioWriteProposalCard materialLabel="需求" proposal={workspace.writeProposal} disabled={locked || workspace.readOnly} onResolve={actions.resolveWriteProposal} />}
        {workspace.writeReceipt && <ScenarioWriteReceiptCard receipt={workspace.writeReceipt} disabled={locked || workspace.readOnly} onUndo={actions.undoWrite} />}
        <ReviewPanel review={review} purpose="material" busy={busy} onRequest={actions.requestReview} onConfirm={actions.confirm} />
        {!workspace.readOnly && <>
          <div className={css.confirmBar}><div><strong>作者确认当前材料</strong><small>检查通过后，由你确认当前已保存的材料版本</small></div><button className={css.primary} disabled={busy} onClick={() => actions.confirm({ method: 'direct' })}>确认材料</button></div>
          <form className={css.naturalConfirm} onSubmit={event => { event.preventDefault(); if (/^(确认|确认当前材料)[。！!]?$/u.test(naturalConfirmation.trim())) { actions.confirm({ method: 'direct' }); setNaturalConfirmation('') } }}><input aria-label="自然语言确认当前材料" value={naturalConfirmation} onChange={event => setNaturalConfirmation(event.target.value)} placeholder="也可以输入：确认当前材料" /><button disabled={busy}>发送确认</button></form>
        </>}
      </div>
      <MaterialConversation sessionId={task?.sessionId} faces={faces} attachments={{
        sources: materialSources?.sources ?? [], disabled: locked || !materialSources, readOnly: materialSources?.readOnly ?? true,
        onImport: actions.importSource, onRetry: actions.retrySource, onSelect: actions.selectSource,
      }}>
        <span>✦</span><h3>{workspace.readOnly ? '已确认固定需求' : '与 AI 整理业务需求'}</h3><p>{workspace.readOnly ? '开始修订后可继续编辑与对话。' : '新建需求会话，继承当前 Markdown、固定模板和当前选定资料。明确同意写入后，才会更新正文。'}</p>
      </MaterialConversation>
    </section>
    <RequirementSpecPanel entity={entity} draft={workspace.draft} buffer={buffer} snapshot={snapshot} workspace={workspace} templates={state.projectTemplates?.requirements} entities={entities} projectId={state.project!.id} candidates={state.candidates} busy={busy} call={call} metadataForm={metadataForm} onFlush={flush} onCollapse={() => setCollapsed(true)} onBindTemplate={actions.bindTemplate} onResolve={resolve} onOpenScenario={onOpenScenario}>
      <ConsistencyPanel entityId={entity.id} entities={entities} tasks={state.consistencyTasks ?? []} busy={busy} call={call} onOpenMaterial={onOpenMaterial} />
      <RequirementGates workspace={workspace} disabled={busy || !!snapshot.conflict} dirty={snapshot.dirty} buffer={buffer} snapshot={snapshot} onConfirm={() => actions.confirm({ method: 'direct' })} onStructureCheck={actions.structureCheck} />
    </RequirementSpecPanel>
  </div>
}
