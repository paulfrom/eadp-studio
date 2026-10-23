import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { EntityView, MaterialMetadata, StudioCommand, StudioReply, StudioState } from '../../shared/studio.ts'
import type { ScenarioSource, ScenarioWorkspace as Workspace } from '../../shared/scenarios.ts'
import type { StudioProps } from '../studio/StudioPanel.tsx'
import { MaterialConversation } from '../components/MaterialConversation.tsx'
import { ConsistencyPanel } from '../components/ConsistencyPanel.tsx'
import { ScenarioChatPanel, type ScenarioCandidateFace, type ScenarioChatActions, type ScenarioRevisionFace, type ScenarioSplitFace } from './ScenarioChatPanel.tsx'
import { ScenarioGates } from './ScenarioGates.tsx'
import { ScenarioSpecPanel } from './ScenarioSpecPanel.tsx'
import { useDraftBuffer } from './useDraftBuffer.ts'
import css from '../studio.module.css'

interface WorkspaceProps {
  workspace: Workspace; entity: EntityView; state: StudioState; faces: StudioProps; busy: boolean;
  call(command: StudioCommand): Promise<StudioReply | undefined>;
  registerFlush(flush?: () => Promise<boolean>): void;
  onOpenMaterial?(entity: EntityView): void;
  onOpenRequirement(entityId: string): void;
}
/**
 * Scenario page: the AI conversation beside the material spec. Owns the draft
 * boundary, so every version-changing action first flushes the shared buffer.
 */
export function ScenarioWorkspace({ workspace, entity, state, faces, busy, call, registerFlush, onOpenRequirement, onOpenMaterial }: WorkspaceProps) {
  const [collapsed, setCollapsed] = useState(false)
  const [showImpact, setShowImpact] = useState(false)
  const [splitLater, setSplitLater] = useState(false)
  const operations = useRef(new Map<string, { fingerprint: string; id: string }>())
  const operationId = useCallback((action: string, input: unknown) => {
    const fingerprint = JSON.stringify(input)
    let operation = operations.current.get(action)
    if (!operation || operation.fingerprint !== fingerprint) { operation = { fingerprint, id: crypto.randomUUID() }; operations.current.set(action, operation) }
    return operation.id
  }, [])
  const { buffer, snapshot } = useDraftBuffer(workspace.draft, async input => {
    const result = await call({ action: 'saveScenario', entityId: entity.id, ...input })
    if (!result?.ok || !result.state.scenario) {
      await call({ action: 'state' })
      throw new Error(result && !result.ok ? result.message : '本地保存失败，当前输入已保留。')
    }
    if (result.state.scenario.conflict) throw new Error('文件出现并发修改，请先解决冲突。')
    return result.state.scenario.draft
  }, registerFlush)
  useEffect(() => { if (workspace.conflict) buffer.receive(workspace.conflict.actual) }, [buffer, workspace.conflict])
  const execute = useCallback(async (command: StudioCommand | ((hash: string) => StudioCommand), flush = true) => {
    if (flush && !await buffer.flush()) return undefined
    const result = await call(typeof command === 'function' ? command(buffer.getSnapshot().sha256) : command)
    if (result?.ok && result.state.scenario?.entityId === entity.id && !result.state.scenario.conflict) buffer.receive(result.state.scenario.draft)
    return result
  }, [buffer, call, entity.id])
  const resolve = useCallback(async (body: string, metadata: MaterialMetadata, actualHash: string) => {
    const result = await execute({ action: 'resolveScenarioConflict', entityId: entity.id, body, metadata, expectedHash: actualHash, operationId: operationId('resolve', { body, metadata, actualHash }) }, false)
    if (result?.ok && result.state.scenario && !result.state.scenario.conflict) buffer.accept(result.state.scenario.draft)
  }, [buffer, execute, entity.id, operationId])
  const actions = useMemo(() => ({
    bindTemplate: (templateId: string) => { void execute({ action: 'bindScenarioTemplate', entityId: entity.id, templateId }) },
    importSource: async (name: string, base64: string) => { const result = await execute({ action: 'importScenarioSource', entityId: entity.id, name, base64, operationId: crypto.randomUUID() }); if (!result?.ok) throw new Error('资料未能导入，请查看错误并重试。') },
    retrySource: (sourceId: string) => { void execute({ action: 'retryScenarioSource', entityId: entity.id, sourceId }) },
    selectSource: (source: ScenarioSource, selected: boolean, formal: boolean) => { void execute({ action: 'selectScenarioSource', entityId: entity.id, sourceId: source.id, selected, formal }) },
    confirm: () => { void execute(hash => ({ action: 'confirmMaterial', entityId: entity.id, expectedHash: hash, method: 'direct' })) },
    repair: () => { void execute(hash => ({ action: 'startScenarioRepair', entityId: entity.id, expectedHash: hash, userActionId: crypto.randomUUID() })) },
    resume: (answer: string) => { void execute(hash => ({ action: 'resumeScenarioRepair', entityId: entity.id, answer, expectedHash: hash, userActionId: crypto.randomUUID() })) },
    cancel: () => { void execute({ action: 'cancelScenarioRepair', entityId: entity.id }, false) },
    structureCheck: (enabled: boolean) => { void execute({ action: 'setScenarioStructureCheck', enabled }) },
  }), [execute, entity.id, operationId])
  const sessions = workspace.sessions.filter(session => session.entityId === entity.id && session.purpose === 'material')
  const activeTask = sessions.find(session => session.sessionId === workspace.activeSessionId)
  const activeSessionId = workspace.repair?.status === 'active' ? workspace.repair.sessionId : activeTask?.sessionId
  const entities = useMemo(() => (state.collaboration?.entities ?? []).filter((value): value is EntityView => 'title' in value), [state.collaboration])
  const relatedRequirements = useMemo(() => entities.filter(value => value.kind === 'requirement' && value.scenarioIds.includes(entity.id)), [entities, entity.id])
  const candidates = state.candidates.filter(candidate => candidate.sources.some(source => source.entityId === entity.id))
  const locked = busy || !!snapshot.conflict || workspace.repair?.status === 'active'
  const chat = useMemo<ScenarioChatActions>(() => ({
    refresh: () => { void execute({ action: 'openScenario', entityId: entity.id }) },
    newSession: () => { void execute({ action: 'newScenarioSession', entityId: entity.id }) },
    selectSession: sessionId => { void execute({ action: 'selectScenarioSession', entityId: entity.id, sessionId }) },
    openTemplates: () => faces.openSettings('studio-scenario-templates'),
    resolveWriteProposal: decision => {
      const proposal = workspace.writeProposal
      if (proposal) void execute(hash => ({ action: 'resolveScenarioWriteProposal', entityId: entity.id, proposalId: proposal.id, decision, expectedHash: hash })).then(result => { if (!result?.ok) void call({ action: 'state' }) })
    },
    undoWrite: () => {
      const receipt = workspace.writeReceipt
      if (receipt) void execute(hash => ({ action: 'undoScenarioWrite', entityId: entity.id, operationId: receipt.operationId, expectedHash: hash }))
    },
  }), [execute, entity.id, faces, actions, workspace.writeProposal, workspace.writeReceipt])
  const revision: ScenarioRevisionFace = {
    shown: showImpact,
    ...(workspace.impact ? { impact: workspace.impact } : {}),
    inspect: () => { void execute({ action: 'scenarioRevisionImpact', entityId: entity.id }).then(result => { if (result?.ok) setShowImpact(true) }) },
    start: () => { void execute({ action: 'startScenarioRevision', entityId: entity.id, expectedRevision: entity.revision }).then(result => { if (result?.ok) setShowImpact(false) }) },
    dismiss: () => setShowImpact(false),
  }
  const split: ScenarioSplitFace = {
    offered: workspace.splitOffered === true,
    deferred: splitLater,
    split: () => { void execute({ action: 'splitScenario', entityId: entity.id }) },
    defer: () => setSplitLater(true),
  }
  const candidateFace: ScenarioCandidateFace = {
    items: candidates,
    create: candidateId => { const candidate = candidates.find(value => value.id === candidateId); return candidate ? execute({ action: 'selectCandidate', candidateId, expectedInputHash: candidate.inputHash }) : Promise.resolve(undefined) },
  }
  return <div className={`${css.scenarioWorkspace} ${collapsed ? css.scenarioCollapsed : ''}`}>
    <ScenarioChatPanel entity={entity} workspace={workspace} busy={busy} locked={locked} material={{ hash: snapshot.sha256, dirty: snapshot.dirty }} sessions={sessions} activeSessionId={activeSessionId} actions={chat} revision={revision} split={split} candidates={candidateFace} relatedRequirements={relatedRequirements} onOpenRequirement={onOpenRequirement} expandSpec={collapsed ? () => setCollapsed(false) : undefined}>
      <MaterialConversation sessionId={activeSessionId} faces={faces} attachments={{ sources: workspace.sources, disabled: locked, readOnly: workspace.readOnly, onImport: actions.importSource, onRetry: actions.retrySource, onSelect: actions.selectSource }}>
        <span>✦</span><h3>{workspace.readOnly ? '已确认固定场景' : '与 AI 整理业务场景'}</h3><p>{workspace.readOnly ? '开始修订后可继续编辑与对话。' : '新建场景会话，继承当前 Markdown、固定模板和当前选定资料。明确同意写入后，才会更新正文。'}</p>
      </MaterialConversation>
    </ScenarioChatPanel>
    <ScenarioSpecPanel entity={entity} draft={workspace.draft} buffer={buffer} snapshot={snapshot} workspace={workspace} templates={state.projectTemplates?.scenarios} busy={busy} onCollapse={() => setCollapsed(true)} onBindTemplate={actions.bindTemplate} onResolve={resolve}>
      <ConsistencyPanel entityId={entity.id} entities={entities} tasks={state.consistencyTasks ?? []} busy={busy} call={call} onOpenMaterial={onOpenMaterial} />
      <ScenarioGates workspace={workspace} disabled={busy || !!snapshot.conflict} dirty={snapshot.dirty} buffer={buffer} snapshot={snapshot} onConfirm={actions.confirm} onRepair={actions.repair} onResume={actions.resume} onCancel={actions.cancel} onStructureCheck={actions.structureCheck} />
    </ScenarioSpecPanel>
  </div>
}
