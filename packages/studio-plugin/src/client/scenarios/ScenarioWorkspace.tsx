import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { EntityView, MaterialMetadata, StudioCommand, StudioReply, StudioState } from '../../shared/studio.ts'
import type { ScenarioSource, ScenarioWorkspace as Workspace } from '../../shared/scenarios.ts'
import type { StudioProps } from '../studio/StudioPanel.tsx'
import { NativeConversation } from '../components/NativeConversation.tsx'
import { ScenarioEditor } from './ScenarioEditor.tsx'
import { ScenarioEvidence } from './ScenarioEvidence.tsx'
import { ScenarioGates } from './ScenarioGates.tsx'
import { ScenarioSuggestions } from './ScenarioSuggestions.tsx'
import { useDraftBuffer } from './useDraftBuffer.ts'
import css from '../studio.module.css'

interface WorkspaceProps {
  workspace: Workspace; entity: EntityView; state: StudioState; faces: StudioProps; busy: boolean;
  call(command: StudioCommand): Promise<StudioReply | undefined>;
  registerFlush(flush?: () => Promise<boolean>): void;
}
/** Owns the scenario draft boundary; every version-changing action first flushes the shared buffer. */
export function ScenarioWorkspace({ workspace, entity, state, faces, busy, call, registerFlush }: WorkspaceProps) {
  const [collapsed, setCollapsed] = useState(false)
  const [showImpact, setShowImpact] = useState(false)
  const [splitLater, setSplitLater] = useState(false)
  const [categoryId, setCategoryId] = useState('')
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
    adopt: async (batchId: string, itemIds: string[]) => { await execute(hash => ({ action: 'adoptScenarioSuggestions', entityId: entity.id, batchId, itemIds, expectedHash: hash, operationId: operationId('adopt', { batchId, itemIds: [...itemIds].sort(), hash }) })) },
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
  const categories = state.project?.categories ?? []
  const selectedCategory = categoryId || categories[0]?.id || ''
  const candidates = state.candidates.filter(candidate => candidate.scenarioId === entity.id)
  const locked = busy || !!snapshot.conflict || workspace.repair?.status === 'active'
  return <div className={`${css.workspace} ${css.materialWorkspace} ${collapsed ? css.materialCollapsed : ''}`}>
    <section className={css.taskArea}>
      <div className={css.taskHeader}><div><span className={css.eyebrow}>{entity.code}</span><h2>场景 AI 工作区</h2></div><button onClick={() => faces.openSettings('studio-scenario-templates')}>场景模板设置</button></div>
      <div className={css.contextStrip}><span>{workspace.readOnly ? `确认版本 ${entity.materialVersion}` : '本地草稿'}</span><span>{entity.occupation ? `当前编辑人 #${entity.occupation.ownerId}` : '无设计占用'}</span><span>创建人 {entity.creator?.name ?? `#${entity.authorId}`}</span></div>
      {workspace.readOnly && <div className={css.notice}>确认人 #{workspace.confirmedBy ?? entity.current?.confirmedBy} · {workspace.confirmedAt ?? entity.current?.confirmedAt}<button disabled={busy} onClick={async () => { const result = await execute({ action: 'scenarioRevisionImpact', entityId: entity.id }); if (result?.ok) setShowImpact(true) }}>开始修订：查看影响</button></div>}
      {showImpact && <section className={css.revisionImpact}><h3>修订影响清单</h3><p>启动后会领取设计占用，关联需求进入场景批次冻结，并按同批规则处理及确认。</p>{workspace.impact?.length ? <ul>{workspace.impact.map(item => <li key={item.id}>{item.code ?? item.id} · {item.title}</li>)}</ul> : <p>没有关联需求。</p>}<button className={css.primary} disabled={busy || workspace.impact === undefined} onClick={async () => { const result = await execute({ action: 'startScenarioRevision', entityId: entity.id, expectedRevision: entity.revision, expectedAssociationRevision: entity.associationRevision }); if (result?.ok) setShowImpact(false) }}>确认影响并启动修订</button><button onClick={() => setShowImpact(false)}>取消</button></section>}
      {!workspace.readOnly && <div className={css.actionBar}><button disabled={locked} onClick={() => void execute({ action: 'newScenarioSession', entityId: entity.id })}>新建场景会话</button><label>恢复历史会话<select disabled={locked} value={workspace.activeSessionId ?? ''} onChange={event => { if (event.target.value) void execute({ action: 'selectScenarioSession', entityId: entity.id, sessionId: event.target.value }) }}><option value="">选择场景会话</option>{sessions.map((session, index) => <option key={session.sessionId} value={session.sessionId}>会话 {index + 1} · {session.sessionId.slice(0, 8)}</option>)}</select></label></div>}
      {activeTask?.error && <div className={css.notice}>{activeTask.error}</div>}
      {activeSessionId ? <NativeConversation key={activeSessionId} call={faces.call} retainSession={faces.retainSession} SessionProvider={faces.SessionProvider} renderFactorySlot={faces.renderFactorySlot} sessionId={activeSessionId} /> : <div className={css.conversationEmpty}><span>✦</span><h3>{workspace.readOnly ? '已确认固定场景' : '与 AI 整理业务场景'}</h3><p>{workspace.readOnly ? '开始修订后可继续编辑与对话。' : '新建场景会话，继承当前 Markdown、固定模板和当前选定资料。普通建议只在采纳后写入。'}</p></div>}
      <ScenarioEvidence sources={workspace.sources} disabled={locked} readOnly={workspace.readOnly} onImport={actions.importSource} onRetry={actions.retrySource} onSelect={actions.selectSource} />
      <ScenarioSuggestions batches={workspace.suggestions} hash={snapshot.sha256} disabled={locked || workspace.readOnly || snapshot.dirty} onAdopt={actions.adopt} />
      <ScenarioGates workspace={workspace} disabled={busy || !!snapshot.conflict} dirty={snapshot.dirty} onConfirm={actions.confirm} onRepair={actions.repair} onResume={actions.resume} onCancel={actions.cancel} onStructureCheck={actions.structureCheck} />
      {workspace.readOnly && <section className={css.splitOffer}><h3>{workspace.splitOffered && !splitLater ? '场景已被后台接受，是否立即拆分需求？' : '从当前确认版拆分需求'}</h3><button disabled={busy} onClick={() => void execute({ action: 'splitScenario', entityId: entity.id })}>{workspace.splitOffered && !splitLater ? '立即生成拆分候选' : '生成需求候选'}</button>{workspace.splitOffered && !splitLater && <button onClick={() => setSplitLater(true)}>稍后拆分</button>}<p>仅生成候选，选用后才创建需求草稿。</p></section>}
      {candidates.length > 0 && <section className={css.candidates}><h3>需求拆分候选</h3><label>需求业务分类<select value={selectedCategory} onChange={event => setCategoryId(event.target.value)}>{categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>{candidates.map(candidate => <div key={candidate.id}><div><strong>{candidate.title}</strong><p>{candidate.summary}</p></div><button disabled={busy || !selectedCategory || !!candidate.selectedEntityId} onClick={() => void execute({ action: 'selectCandidate', candidateId: candidate.id, categoryId: selectedCategory })}>{candidate.selectedEntityId ? '已创建草稿' : '选用并创建需求草稿'}</button></div>)}</section>}
    </section>
    <aside className={`${css.inspector} ${collapsed ? css.hiddenMaterial : ''}`} aria-label="场景材料"><div className={css.tabs}><button onClick={() => setCollapsed(true)}>收起材料 →</button><span>Markdown 与业务确认信息</span></div><ScenarioEditor draft={workspace.draft} buffer={buffer} snapshot={snapshot} readOnly={workspace.readOnly} editingDisabled={workspace.repair?.status === 'active'} templates={state.scenarioTemplates} busy={busy} onBindTemplate={actions.bindTemplate} onResolve={resolve} /></aside>
    {collapsed && <button className={css.restoreMaterial} onClick={() => setCollapsed(false)}>← 展开材料</button>}
  </div>
}
