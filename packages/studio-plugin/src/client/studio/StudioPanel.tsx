import { useCallback, useEffect, useRef, useState } from 'react'
import type { PropsRenderFactories, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PropsStore } from '@deepseek-ai/dsh-client-store'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import { NativeConversation } from '../components/NativeConversation.tsx'
import { ScenarioWorkspace } from '../scenarios/ScenarioWorkspace.tsx'
import { RequirementWorkspace } from '../requirements/RequirementWorkspace.tsx'
import type { ConfirmationChoice, EntityView, Stage, StudioCommand, StudioReply } from '../../shared/studio.ts'
import { MaterialCatalog } from '../components/MaterialCatalog.tsx'
import { LegacyMaterial } from '../components/LegacyMaterial.tsx'
import { MaterialEditor } from '../components/MaterialEditor.tsx'
import { ReviewPanel } from '../components/ReviewPanel.tsx'
import { ProjectDialog } from '../components/ProjectDialog.tsx'
import { ProjectProgressNotice } from '../components/ProjectProgressNotice.tsx'
import { StudioTopbar } from '../components/StudioTopbar.tsx'
import type { ThemeFace } from '../theme.ts'
import type { StudioProjectionStore } from '../store.ts'
import { emptyStudioState } from '../state.ts'
import css from '../studio.module.css'
import '../studio.tw.generated.css'

export interface StudioFace {
  /** Run one command whose reply carries the newer projection. */
  run(command: StudioCommand): Promise<StudioReply>
  /** Refresh the shared projection; a read already in flight keeps its slot. */
  sync(): void
  /** Read the progress of the project operations the Host is running. */
  progress(): void
  retainSession(id: string): SessionReference
  openSettings(section?: string): void
  startSession(): void
  theme: ThemeFace
}
export type StudioProps = PropsRuntime<'main'> & PropsRenderFactories & PropsRenderSlots<'studio.session'> & StudioFace & PropsStore<StudioProjectionStore>
const stages: Array<{ id: Stage; name: string; mark: string; description: string; icon: string[] }> = [
  { id: 'scenarios', name: '项目场景', mark: '01', description: '沉淀业务背景，让需求有据可依', icon: ['M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z'] },
  { id: 'requirements', name: '需求协同', mark: '02', description: '明确规则、前置与验收条件', icon: ['M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z'] },
  { id: 'prototype', name: '原型展示', mark: '03', description: '与 AI 一起把需求变为可操作的演示', icon: ['M15 12a3 3 0 11-6 0 3 3 0 016 0z', 'M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z'] },
  { id: 'baselines', name: '基线确认', mark: '04', description: '查看已接受的原型版本与确认依据', icon: ['M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z'] },
  { id: 'handoffs', name: '交接清单', mark: '05', description: '把固定成果、来源和限制交给研发', icon: ['M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4'] },
]

export function StudioPanel(props: StudioProps) {
  // The workbench and the settings sections render one projection: the store is
  // the only owner, so signing in or out anywhere shows up everywhere at once.
  const projection = props.useStore(snapshot => snapshot.projection)
  const progress = props.useStore(snapshot => snapshot.progress)
  const loading = props.useStore(snapshot => snapshot.loading)
  const storeError = props.useStore(snapshot => snapshot.error)
  const state = projection ?? emptyStudioState()
  const [stage, setStage] = useState<Stage>('scenarios')
  const [selectedId, setSelectedId] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [comparisonError, setComparisonError] = useState('')
  const [projectDialog, setProjectDialog] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [filter, setFilter] = useState('')
  const [activeTab, setActiveTab] = useState<'material' | 'versions'>('material')
  const [naturalConfirmation, setNaturalConfirmation] = useState('')
  const flushRef = useRef<(() => Promise<boolean>) | undefined>(undefined)
  const registerFlush = useCallback((flush?: () => Promise<boolean>) => { flushRef.current = flush }, [])
  const flushBeforeLeave = useCallback(async () => !flushRef.current || await flushRef.current(), [])
  const actions = useRef(0)
  const run = props.run
  const sync = props.sync
  const call = useCallback(async (command: StudioCommand, localError = false) => {
    const background = command.action === 'listConsistencyComparisons' || command.action === 'listConsistencySummaries' || command.action === 'readRequirementSource'
    if (!background) { actions.current += 1; if (!localError) setError(''); setBusy(true) }
    try {
      const result = await run(command)
      if (!result.ok) {
        if (result.code === 'LOGIN_REQUIRED') props.openSettings('studio-collab')
        if (!localError && !background) setError(result.message)
      }
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : '操作未完成，请重新查询状态'
      if (!localError && !background) setError(message)
      return { ok: false as const, code: 'CHANNEL_FAILED', message }
    }
    finally { if (!background) { actions.current -= 1; setBusy(actions.current > 0) } }
  }, [run, props.openSettings])
  const localCall = useCallback((command: StudioCommand) => call(command, true), [call])
  useEffect(() => {
    // The session joins a poll and a section's read into one Host round trip, and
    // a user action always writes the newer projection, so polling cannot undo it.
    sync()
    const timer = setInterval(() => sync(), 10_000)
    return () => clearInterval(timer)
  }, [sync])
  const materialTaskRunning = state.tasks.some(task => task.purpose === 'split' && ['pending', 'sent'].includes(task.split?.status ?? '')) || (state.consistencyTasks ?? []).some(task => task.phase === 'running' || task.phase === 'pending-sync')
  useEffect(() => {
    if (!materialTaskRunning) return
    const timer = setInterval(sync, 1000)
    return () => clearInterval(timer)
  }, [materialTaskRunning, sync])
  // A recorded initialization is the project operation in flight: the bar follows
  // it, and the record leaving the projection is what stops this poll.
  const initializing = state.projectInitializations.length > 0
  const readProgress = props.progress
  useEffect(() => {
    if (!initializing) return
    readProgress()
    const timer = setInterval(readProgress, 500)
    return () => clearInterval(timer)
  }, [initializing, readProgress])
  // Comparison summaries have their own read path, including results shared by other members.
  const consistencyProjectId = state.project?.id
  const summaryScope = useRef(consistencyProjectId); summaryScope.current = consistencyProjectId
  const summaryCall = useRef(call); summaryCall.current = call
  const summaryRead = useRef(0)
  const refreshComparisons = useCallback(async () => {
    const request = ++summaryRead.current
    const reply = await summaryCall.current({ action: 'listConsistencySummaries' })
    if (request !== summaryRead.current || summaryScope.current !== consistencyProjectId) return
    setComparisonError(reply?.ok ? '' : reply && !reply.ok ? reply.message : '最近对比结论未能读取，请重试。')
  }, [consistencyProjectId])
  const sharedComparisons = (state.consistencyTasks ?? []).filter(task => task.phase === 'shared').map(task => task.id).sort().join(':')
  useEffect(() => {
    if (stage !== 'requirements' || !consistencyProjectId) return
    setComparisonError('')
    void refreshComparisons()
    const timer = setInterval(() => void refreshComparisons(), 10_000)
    return () => { clearInterval(timer); summaryRead.current += 1 }
  }, [stage, consistencyProjectId, sharedComparisons, refreshComparisons])
  const loadError = storeError || (state.connected ? '' : '请登录后读取项目目录')
  const entities: EntityView[] = (state.collaboration?.entities ?? []).filter((entity): entity is EntityView => 'title' in entity)
  const openProjectDialog = async () => { if (!await flushBeforeLeave()) return; setProjectDialog(true); await call({ action: 'namespaces' }) }
  const selected = entities.find(e => e.id === selectedId && !e.builtinKey)
  const draft = state.drafts.find(d => d.entityId === selectedId)
  const purpose = stage === 'prototype' ? 'prototype' : 'material'
  const taskPurpose = stage === 'handoffs' ? 'handoff' : purpose
  const task = state.tasks.find(t => t.entityId === selectedId && t.purpose === taskPurpose)
  const review = state.reviews.filter(item => item.entityId === selectedId && item.purpose === purpose).at(-1)
  const visible = entities.filter(e => !e.builtinKey && e.kind === (stage === 'scenarios' ? 'scenario' : stage === 'handoffs' ? 'handoff' : 'requirement'))
    .filter(e => `${e.title} ${e.id}`.toLowerCase().includes(filter.toLowerCase()))
  const currentStage = stages.find(s => s.id === stage)!
  const materialStage = stage === 'scenarios' || stage === 'requirements'
  const selectStage = async (next: Stage) => { if (!await flushBeforeLeave()) return; setStage(next); setSelectedId(undefined); setFilter('') }
  const backToList = async () => { if (await flushBeforeLeave()) setSelectedId(undefined) }
  const selectTab = async (next: 'material' | 'versions') => { if (await flushBeforeLeave()) setActiveTab(next) }
  const selectMaterial = async (id: string) => {
    if (entities.find(entity => entity.id === id)?.builtinKey) return
    if (!await flushBeforeLeave()) return
    setSelectedId(id); setActiveTab('material')
    if (stage === 'scenarios' && !entities.find(e => e.id === id)?.legacyCurrent) await call({ action: 'openScenario', entityId: id })
    if (stage === 'requirements' && !entities.find(e => e.id === id)?.legacyCurrent) await call({ action: 'openRequirement', entityId: id })
  }
  /** A requirement's formal source opens in the scenario stage with its own workspace. */
  const openScenarioFromRequirement = async (entityId: string) => {
    if (entities.find(entity => entity.id === entityId)?.builtinKey) return
    if (!await flushBeforeLeave()) return
    setStage('scenarios'); setSelectedId(entityId); setActiveTab('material')
    await call({ action: 'openScenario', entityId })
  }
  /** A scenario's related requirement opens in the requirement stage with its own workspace. */
  const openRequirementFromScenario = async (entityId: string) => {
    if (!await flushBeforeLeave()) return
    setStage('requirements'); setSelectedId(entityId); setActiveTab('material')
    await call({ action: 'openRequirement', entityId })
  }
  const openRelatedMaterial = (entity: EntityView) => {
    if (entity.builtinKey) return
    if (entity.kind === 'scenario') void openScenarioFromRequirement(entity.id)
    else if (entity.kind === 'requirement') void openRequirementFromScenario(entity.id)
  }
  const confirm = async (choice: ConfirmationChoice) => {
    if (!draft || !await flushBeforeLeave()) return undefined
    const refreshed = await call({ action: 'state' })
    const current = refreshed?.ok ? refreshed.state.drafts.find(value => value.entityId === draft.entityId) : undefined
    return current ? call({ action: 'confirmMaterial', entityId: current.entityId, expectedHash: current.sha256, ...choice }) : undefined
  }
  const sourceCommand = async (command: StudioCommand) => {
    if (!await flushBeforeLeave()) return undefined
    return call(command)
  }
  const operation = (action: 'claimPrototype' | 'checkPrototype' | 'startPreview' | 'stopPreview' | 'releaseOccupation') => {
    if (selectedId) void call({ action, entityId: selectedId })
  }
  // Before the first answer, "signed out" and "not read yet" must look different:
  // the workbench states which one it is instead of showing the signed-out shell.
  if (projection === undefined) return <div className={`${css.studio} studio-root`} data-studio-panel="studio"><div className={css.welcome}>
    <span className={css.welcomeMark}>e</span><p className={css.eyebrow}>PROJECT WORKBENCH</p>
    {storeError ? <><h2>无法确认工作台状态</h2><p role="alert">{storeError}</p><button className={css.primary} onClick={() => props.sync()}>重新同步</button></> : <><h2>正在读取工作台状态</h2><p>{loading ? '正在与协同工作台核对登录状态与项目目录…' : '等待工作台答复。'}</p></>}
  </div></div>
  return <div className={`${css.studio} studio-root`} data-studio-panel="studio">
    <StudioTopbar faces={{ state, busy, theme: props.theme, stage, stages, refresh: () => { props.sync(); if (stage === 'requirements' && consistencyProjectId) void refreshComparisons() }, selectStage: next => { void selectStage(next) }, startSession: () => { void flushBeforeLeave().then(saved => { if (saved) props.startSession() }) }, openSettings: props.openSettings }} sidebarCollapsed={sidebarCollapsed} onToggleSidebar={() => setSidebarCollapsed(collapsed => !collapsed)} />
    <div className={css.shell}>
      <aside className={`${css.rail} ${sidebarCollapsed ? css.collapsed : ''}`} aria-label="工作台导航">
        <button className={css.repoBox} disabled={!state.connected} onClick={() => void openProjectDialog()} title="切换、新建或获取项目">
          <span className={css.repoMark} aria-hidden="true">&lt;/&gt;</span>
          <span className={css.repoText}>
            <strong>{state.project?.name ?? '选择项目'}</strong>
            <small>{state.project ? <><span className={state.connected ? css.repoReady : css.repoOff} />{state.project.stableBranch} • {state.connected ? '已同步' : '未连接'}</> : '登录后查看可用项目'}</small>
          </span>
          <svg className={css.repoChevron} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" width={13} height={13}><path d="M8 9l4-4 4 4m0 6l-4 4-4-4" /></svg>
        </button>
        <nav className={css.stageNav} aria-label="Studio 工作区">
          <div className={css.navCaption}>Studio Navigation</div>
          {stages.flatMap(item => {
            const chip = stage === item.id && materialStage && selected ? <div className={css.stageChip} key={`${item.id}-chip`}>
              <span>{selected.code ?? selected.id}</span>
              <button onClick={() => void backToList()} aria-label={`返回${item.name}列表`}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" width={13} height={13}><path d="M19 12H5m0 0l6 6m-6-6l6-6" /></svg>
              </button>
            </div> : null
            return [<button key={item.id} aria-current={stage === item.id ? 'page' : undefined} className={`${css.stage} ${stage === item.id ? css.active : ''}`} onClick={() => void selectStage(item.id)}>
              <svg className={css.stageIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" width={15} height={15}>{item.icon.map((d, index) => <path key={index} d={d} />)}</svg>
              <span className={css.stageLabel}>{item.name}</span>
              <svg className={css.stageChev} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" width={13} height={13}><path d="M9 6l6 6-6 6" /></svg>
            </button>, chip]
          })}
        </nav>
        <div className={css.railFoot}>
          <button className={css.accountRow} onClick={() => props.openSettings('studio-collab')} title="用户账号与偏好设置">
            <span className={`${css.avatar} ${state.account ? css.accent : ''}`}>{state.account ? state.account.name.slice(0, 1) || '@' : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" width={15} height={15}><path d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>}</span>
            <span className={css.accountText}>
              <span className={css.accountName}>{state.account?.name ?? '登录协同工作台'}</span>
              <span className={css.accountSub}>{state.account ? `@${state.account.gitlabUsername} @ GitLab` : '登录后查看可用项目'}</span>
            </span>
            <svg className={css.accountGear} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" width={15} height={15}><path d="M12 15a3 3 0 100-6 3 3 0 000 6z" /><path d="M19.4 15a1.7 1.7 0 00.34 1.87l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.7 1.7 0 00-1.87-.34 1.7 1.7 0 00-1 1.55V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.11-1.55 1.7 1.7 0 00-1.87.34l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.7 1.7 0 00.34-1.87 1.7 1.7 0 00-1.55-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.55-1.11 1.7 1.7 0 00-.34-1.87l-.06-.06a2 2 0 112.83-2.83l.06.06a1.7 1.7 0 001.87.34H9a1.7 1.7 0 001-1.55V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.55 1.7 1.7 0 001.87-.34l.06-.06a2 2 0 112.83 2.83l-.06.06a1.7 1.7 0 00-.34 1.87V9a1.7 1.7 0 001.55 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.55 1z" /></svg>
          </button>
        </div>
      </aside>
      <main className={css.main}>
        <header className={`${css.pageHeader} ${materialStage && selected ? css.compactHeader : ''}`}><div>{materialStage && selected && <button className={css.backToList} onClick={() => void backToList()}>← 返回{currentStage.name}列表</button>}{!(materialStage && selected) && <><p className={css.eyebrow}>PROJECT / {currentStage.mark}</p><h1>{materialStage && selected ? selected.title : currentStage.name}</h1><p>{currentStage.description}</p></>}</div><span className={css.statusPill}><i />{busy ? '正在处理' : state.connected ? '协同工作台已登录' : '等待连接'}</span></header>
        {error && <div className={css.error} role="alert">{error}<button onClick={() => setError('')} aria-label="关闭错误">×</button></div>}
        {state.recovery && <div className={css.notice}>此前的本地恢复记录格式无效，已保留原文件：<code>{state.recovery.preservedPath}</code>，并已重建当前版本的本地状态。请重新打开项目。</div>}
        {state.projectInitializations.map(operation => <ProjectProgressNotice key={operation.id} operation={operation} progress={progress.find(item => item.operationId === operation.id)} busy={busy} onRetry={() => void call({ action: 'retryProjectInitialization', operationId: operation.id })} />)}
        {state.pending.filter(p => p.phase !== 'accepted').map(p => <div className={css.notice} key={p.id}>待核对：{p.message ?? p.phase}<button disabled={busy} onClick={() => void call({ action: 'retryOperation', operationId: p.id })}>查询并恢复</button></div>)}
        {!state.project ? <div className={css.welcome}><span className={css.welcomeMark}>e</span><p className={css.eyebrow}>IDEAS INTO ASSETS</p><h2>从一个项目开始</h2><p>登录协同工作台，创建或打开项目。<br />场景、需求与原型将在这里持续沉淀。</p><button className={css.primary} onClick={() => state.connected ? void openProjectDialog() : props.openSettings('studio-collab')}>{state.connected ? "＋ 创建 / 打开项目" : "登录协同工作台"}</button><small>一个项目，对应一个 Git 仓库</small></div> : stage === 'baselines' ? <div className={css.resultList}>
          <div className={css.sectionHeading}><h2>已确认基线</h2><span>原型完成后自动形成，无需再次审批</span></div>
          {(state.collaboration?.baselines ?? []).length === 0 && <Empty text="完成一个需求的原型确认后，固定基线会出现在这里。" />}
          {state.collaboration?.baselines.map(b => <article className={css.baseline} key={b.id}><span className={css.assetIcon}>✓</span><div><h3>{entities.find(e => e.id === b.entityId)?.title ?? b.entityId}</h3><p>{b.id} · 版本 {b.version}</p><code>{b.commitSha}</code></div><span className={css.success}>后端已接受</span><button disabled={busy} onClick={() => void call({ action: 'generateHandoff', baselineId: b.id })}>生成交接清单</button></article>)}
        </div> : selected?.legacyCurrent ? <LegacyMaterial entity={selected} body={state.legacyMaterials?.find(material => material.entityId === selected.id)?.body} /> : materialStage && !selected ? <MaterialCatalog key={`${state.project.id}:${stage}`} entities={entities} drafts={state.drafts} kind={stage === 'scenarios' ? 'scenario' : 'requirement'} busy={busy} call={localCall} onSelect={id => void selectMaterial(id)} onOpenMaterial={openRelatedMaterial} loadError={loadError} onRetry={() => props.sync()} comparisonError={comparisonError} onRetryComparisons={() => void refreshComparisons()} consistencyLatest={comparisonError ? [] : state.consistencyLatest ?? []} consistencyTasks={state.consistencyTasks ?? []} tasks={state.tasks} candidates={stage === 'requirements' ? state.candidates.filter(candidate => candidate.projectId === state.project!.id) : []} /> : stage === 'scenarios' && selected ? state.scenario?.entityId === selected.id ? <ScenarioWorkspace key={`${state.project.id}:${selected.id}`} workspace={state.scenario} entity={selected} state={state} faces={props} busy={busy} call={call} registerFlush={registerFlush} onOpenMaterial={openRelatedMaterial} onOpenRequirement={id => void openRequirementFromScenario(id)} /> : <div className={css.empty}>正在读取场景材料…<button disabled={busy} onClick={() => void call({ action: 'openScenario', entityId: selected.id })}>重新读取</button></div> : stage === 'requirements' && selected ? state.requirement?.entityId === selected.id ? <RequirementWorkspace key={`${state.project.id}:${selected.id}`} workspace={state.requirement} entity={selected} state={state} faces={props} busy={busy} call={call} registerFlush={registerFlush} onOpenMaterial={openRelatedMaterial} onOpenScenario={id => void openScenarioFromRequirement(id)} /> : <div className={css.empty}>正在读取需求材料…<button disabled={busy} onClick={() => void call({ action: 'openRequirement', entityId: selected.id })}>重新读取</button></div> : <div className={css.workspace}>
          <section className={css.catalog} aria-label="资产列表"><div className={css.catalogHeader}><strong>{stage === 'handoffs' ? '清单' : '需求'}目录</strong><span>{visible.length}</span></div><input className={css.search} placeholder="搜索标题或编号…" aria-label="搜索资产" value={filter} onChange={e => setFilter(e.target.value)} />
            <div className={css.assetList}>{visible.map(e => <button key={e.id} className={`${css.assetItem} ${selectedId === e.id ? css.selectedAsset : ''}`} onClick={() => { setSelectedId(e.id); setActiveTab('material') }}><small>{e.id}</small><strong>{e.title}</strong><div><span className={e.confirmationStatus === 'confirmed' ? css.success : css.muted}>{e.confirmationStatus === 'confirmed' ? '材料已确认' : '草稿'}</span><span>{e.occupation ? '处理中' : '空闲'}</span></div></button>)}{visible.length === 0 && <Empty text="还没有资产" />}</div>
          </section>
          <section className={css.taskArea}><div className={css.taskHeader}><div><span className={css.eyebrow}>{selected?.id ?? 'AI WORKSPACE'}</span><h2>{selected?.title ?? '选择一项材料，与 AI 一起完善'}</h2></div>{selected && <button disabled={busy || !!selected.legacyCurrent} onClick={() => void call({ action: 'startSession', entityId: selected.id, purpose: taskPurpose })}>{task ? '恢复对话' : '与 AI 整理'}</button>}</div>
            {selected ? <><div className={css.contextStrip}><span>输入版本 {selected.materialVersion || '草稿'}</span><span>{selected.occupation ? `由 #${selected.occupation.ownerId} 处理中` : '尚未认领'}</span></div>{task?.error && <div className={css.notice}>{task.error}</div>}
              {task ? <NativeConversation key={task.sessionId} {...props} sessionId={task.sessionId} /> : <div className={css.conversationEmpty}><span>✦</span><h3>让业务意图更清晰</h3><p>点击「与 AI 整理」打开原生 Agent 对话。<br />材料、来源与当前输入将绑定到该任务。</p></div>}
              {stage === 'prototype' && <div className={css.actionBar}><button disabled={busy} onClick={() => operation('claimPrototype')}>认领原型任务</button><button disabled={busy} onClick={() => operation('checkPrototype')}>运行工程检查</button><button disabled={busy} onClick={() => operation('startPreview')}>启动预览</button><button disabled={busy} onClick={() => operation('stopPreview')}>停止预览</button><button className={css.primary} disabled={busy} onClick={() => void call({ action: 'confirmPrototype', entityId: selected.id, method: 'direct' })}>确认当前需求完成</button></div>}
              {stage !== 'prototype' && draft && <><div className={css.confirmBar}><div><strong>作者确认当前材料</strong><small>检查通过后，由你确认当前已保存的材料版本</small></div><button className={css.primary} disabled={busy} onClick={() => void confirm({ method: 'direct' })}>确认材料</button></div><form className={css.naturalConfirm} onSubmit={e => { e.preventDefault(); if (/^(确认|确认当前材料)[。！!]?$/u.test(naturalConfirmation.trim())) { void confirm({ method: 'direct' }); setNaturalConfirmation('') } else setError('请明确输入“确认当前材料”，操作仅绑定右侧已保存的版本。') }}><input aria-label="自然语言确认当前材料" value={naturalConfirmation} onChange={e => setNaturalConfirmation(e.target.value)} placeholder="也可以输入：确认当前材料" /><button disabled={busy}>发送确认</button></form></>}
              {(purpose === 'prototype' || draft) && <ReviewPanel key={`${state.project.id}:${selected.id}:${purpose}`} review={review} purpose={purpose} busy={busy} onRequest={() => void sourceCommand({ action: 'requestReview', entityId: selected.id, purpose })} onConfirm={choice => { if (purpose === 'prototype') void call({ action: 'confirmPrototype', entityId: selected.id, ...choice }); else void confirm(choice) }} />}
            </> : <Empty text="选择左侧资产，查看材料和协作状态。" />}
          </section>
          <aside className={css.inspector} aria-label="材料与固定版本"><div className={css.tabs}><button aria-selected={activeTab === 'material'} onClick={() => void selectTab('material')}>材料内容</button><button aria-selected={activeTab === 'versions'} onClick={() => void selectTab('versions')}>确认与复用</button></div>{activeTab === 'material' ? draft ? <MaterialEditor key={`${state.project.id}:${draft.entityId}`} draft={draft} entities={entities} projectId={state.project!.id} templates={draft.metadata.kind === 'requirement' ? state.projectTemplates?.requirements : state.projectTemplates?.scenarios} busy={busy} saveRecovery={state.requirement?.entityId === draft.entityId ? state.requirement.requirementSave : undefined} onRetrySave={draft.metadata.kind === 'requirement' ? operationId => call({ action: 'retryRequirementSave', entityId: draft.entityId, operationId }) : undefined} onSave={input => draft.metadata.kind === 'requirement' ? call({ action: 'saveRequirement', entityId: draft.entityId, ...input }) : call({ action: 'saveMaterial', entityId: draft.entityId, body: input.body, metadata: input.metadata })} onResolveConflict={draft.metadata.kind === 'requirement' ? input => call({ action: 'resolveRequirementConflict', entityId: draft.entityId, ...input }) : undefined} onBindTemplate={draft.metadata.kind === 'scenario' ? templateId => call({ action: 'bindScenarioTemplate', entityId: draft.entityId, templateId }) : undefined} /> : <Empty text="材料保存在项目 Git 仓库中。" /> : selected && <VersionPanel entity={selected} entities={entities} projectId={state.project.id} busy={busy} call={call} />}
            {selected?.occupation && <button className={css.release} disabled={busy} onClick={() => operation('releaseOccupation')}>取消本人任务并释放占用</button>}{stage === 'handoffs' && selected?.current && <button disabled={busy} onClick={() => void call({ action: 'acknowledgeHandoff', entityId: selected.id, note: '已收悉固定交接材料' })}>研发收悉</button>}
          </aside>
        </div>}
        {stage === 'prototype' && state.project && <div className={css.publication}><span>发布项目当前已确认基线</span><button disabled={busy} onClick={() => void call({ action: 'publish' })}>部署到远端</button><button disabled={busy} onClick={() => void call({ action: 'revokePublication' })}>撤回当前站点</button></div>}
      </main>
    </div>{projectDialog && <ProjectDialog busy={busy} projects={state.availableProjects} namespaces={state.namespaces} onClose={() => setProjectDialog(false)} onSubmit={async command => { if (!await flushBeforeLeave()) return; const result = await call(command); if (result?.ok) { setSelectedId(undefined); setProjectDialog(false) } }} />}
  </div>
}
function Empty({ text }: { text: string }) { return <div className={css.empty}>{text}</div> }
function VersionPanel({ entity, entities, projectId, busy, call }: { entity: EntityView; entities: EntityView[]; projectId: string; busy: boolean; call: (command: StudioCommand) => Promise<unknown> }) {
  const [reason, setReason] = useState(''); const [targetId, setTargetId] = useState(''); const fixed = entity.current
  return <div className={css.versionPanel}><h3>材料确认</h3><p>{fixed ? `版本 ${fixed.version} · 已确认` : '草稿，尚未确认'}</p>{fixed && <><code>{fixed.fixed.commitSha}</code><h3>复用资格</h3><span className={fixed.reuse.enabled ? css.success : css.muted}>{fixed.reuse.enabled ? '允许采用' : '已停用'}</span><p>{fixed.reuse.reason}</p><label>操作原因<input value={reason} onChange={e => setReason(e.target.value)} placeholder="填写停用、恢复或采用原因" /></label><button disabled={busy || !reason.trim()} onClick={() => void call({ action: 'setEligibility', entityId: entity.id, version: fixed.version, enabled: !fixed.reuse.enabled, reason })}>{fixed.reuse.enabled ? '停用此固定来源' : '恢复此固定来源'}</button><h3>显式采用完整材料包</h3><select aria-label="采用目标" value={targetId} onChange={e => setTargetId(e.target.value)}><option value="">选择目标草稿</option>{entities.filter(e => e.id !== entity.id && e.kind === entity.kind).map(e => <option key={e.id} value={e.id}>{e.title}</option>)}</select><button disabled={busy || !targetId || !reason.trim() || !fixed.reuse.enabled} onClick={() => void call({ action: 'adopt', sourceProjectId: projectId, sourceEntityId: entity.id, version: fixed.version, targetEntityId: targetId, reason })}>采用并在目标中调整</button><p className={css.muted}>采用受理后保留固定来源；目标独立确认后才计为复用成功。</p></>}</div>
}
