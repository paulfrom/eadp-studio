import { useCallback, useEffect, useState } from 'react'
import type { PropsRenderFactories, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { EntityView, Stage, StudioCommand, StudioReply, StudioState } from '../../shared/studio.ts'
import { MaterialEditor } from '../components/MaterialEditor.tsx'
import { ProjectDialog } from '../components/ProjectDialog.tsx'
import { LoginDialog } from '../components/LoginDialog.tsx'
import css from '../studio.module.css'
import '../studio.tw.generated.css'

export interface StudioFace { call(command: StudioCommand): Promise<StudioReply>; retainSession(id: string): SessionReference }
export type StudioProps = PropsRuntime<'main'> & PropsRenderFactories & PropsRenderSlots<'studio.session'> & StudioFace
const stages: Array<{ id: Stage; name: string; mark: string; description: string }> = [
  { id: 'scenarios', name: '项目场景', mark: '01', description: '沉淀业务背景，让需求有据可依' },
  { id: 'requirements', name: '需求协同', mark: '02', description: '明确规则、前置与验收条件' },
  { id: 'prototype', name: '原型展示', mark: '03', description: '与 AI 一起把需求变为可操作的演示' },
  { id: 'baselines', name: '基线确认', mark: '04', description: '查看已接受的原型版本与确认依据' },
  { id: 'handoffs', name: '交接清单', mark: '05', description: '把固定成果、来源和限制交给研发' },
]

const disconnectedState = (): StudioState => ({ connected: false, projects: [], availableProjects: [], namespaces: [], projectInitializations: [], drafts: [], tasks: [], candidates: [], pending: [] })
const stageIconPaths: Record<Stage, string> = {
  scenarios: 'M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z',
  requirements: 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z',
  prototype: 'M15 12a3 3 0 11-6 0 3 3 0 016 0zM2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z',
  baselines: 'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z',
  handoffs: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4',
}
function StageIcon({ path }: { path: string }) {
  return <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d={path} /></svg>
}
export function StudioPanel(props: StudioProps) {
  const [state, setState] = useState<StudioState>(disconnectedState)
  const [stage, setStage] = useState<Stage>('scenarios')
  const [selectedId, setSelectedId] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [projectDialog, setProjectDialog] = useState(false)
  const [loginDialog, setLoginDialog] = useState(false)
  const [filter, setFilter] = useState('')
  const [title, setTitle] = useState('')
  const [category, setCategory] = useState('')
  const [newCategory, setNewCategory] = useState('')
  const [activeTab, setActiveTab] = useState<'material' | 'versions'>('material')
  const [naturalConfirmation, setNaturalConfirmation] = useState('')
  const call = useCallback(async (command: StudioCommand) => {
    setError(''); setBusy(true)
    try {
      const result = await props.call(command)
      if (!result.ok) { if (result.code === 'LOGIN_REQUIRED') { setState(disconnectedState()); setSelectedId(undefined); setLoginDialog(true) }; throw new Error(result.message) }
      setState(result.state)
      return result
    } catch (err) { setError(err instanceof Error ? err.message : '操作未完成，请重新查询状态'); return undefined }
    finally { setBusy(false) }
  }, [props.call])
  useEffect(() => {
    let cancelled = false
    const refresh = async () => {
      try { const result = await props.call({ action: 'state' }); if (!cancelled) { if (result.ok) setState(result.state); else if (result.code === 'LOGIN_REQUIRED') setState(disconnectedState()) } }
      catch { /* Explicit refresh reports failures without hiding the previous projection. */ }
    }
    void refresh()
    const timer = setInterval(() => { void refresh() }, 5000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [props.call])
  const entities: EntityView[] = (state.collaboration?.entities ?? []).filter((entity): entity is EntityView => 'title' in entity)
  const selected = entities.find(e => e.id === selectedId)
  const draft = state.drafts.find(d => d.entityId === selectedId)
  const task = state.tasks.find(t => t.entityId === selectedId && t.purpose === (stage === 'prototype' ? 'prototype' : 'material'))
  const visible = entities.filter(e => e.kind === (stage === 'scenarios' ? 'scenario' : stage === 'handoffs' ? 'handoff' : 'requirement'))
    .filter(e => `${e.title} ${e.id}`.toLowerCase().includes(filter.toLowerCase()))
  const currentStage = stages.find(s => s.id === stage)!
  const categories = state.project?.categories ?? []
  const selectedCategory = category || categories[0]?.id || ''
  const selectStage = (next: Stage) => { setStage(next); setSelectedId(undefined); setFilter('') }
  const confirm = () => draft && call({ action: 'confirmMaterial', entityId: draft.entityId, expectedHash: draft.sha256, method: 'direct' })
  const operation = (action: 'claimPrototype' | 'checkPrototype' | 'startPreview' | 'stopPreview' | 'confirmPrototype' | 'releaseOccupation') => {
    if (selectedId) void call({ action, entityId: selectedId })
  }
  return <div className={`${css.studio} studio-root flex h-full min-h-0 w-full flex-col overflow-hidden bg-[#f4f6fa] antialiased`} data-studio-panel="studio">
    <header className="flex h-10 flex-shrink-0 items-center justify-between border-b border-slate-200 bg-[#f8fafc] px-3">
      <div className="flex min-w-0 items-center space-x-2">
        <span className="text-[12px] font-medium tracking-tight text-slate-800">EADP Studio</span>
        <span className="text-slate-400">/</span>
        <span className="truncate rounded border border-slate-200 bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-600">{state.project?.name ?? '项目工作台'}</span>
        <span className="flex items-center space-x-1 pl-1 font-mono text-[10px] text-slate-500">
          <span className={`h-1.5 w-1.5 rounded-full ${state.connected ? 'bg-emerald-500' : 'bg-slate-300'}`} />
          <span>{state.project?.stableBranch ?? '工作空间'}{state.connected ? '（已同步）' : ''}</span>
        </span>
      </div>
      <div className="flex items-center space-x-2">
        {state.preview ? <a className="text-[11px] text-emerald-700 hover:text-emerald-800" href={state.preview.url} target="_blank" rel="noreferrer">● 本地原型 ↗</a> : <span className="text-[11px] text-slate-400">原型未运行</span>}
        <button className="rounded border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-600 transition-colors hover:bg-slate-100 disabled:opacity-50" onClick={() => void call({ action: 'state' })} disabled={busy}>刷新</button>
      </div>
    </header>
    <div className="flex flex-1 overflow-hidden">
      <aside className="flex w-52 flex-shrink-0 flex-col justify-between border-r border-slate-200 bg-white" aria-label="工作台导航">
        <div>
          <div className="border-b border-slate-100 bg-slate-50/50 p-3">
            <label htmlFor="studio-project" className="mb-1.5 block text-[10px] font-bold uppercase tracking-wider text-slate-400">工作空间 / 项目</label>
            <select id="studio-project" className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-[11px] font-semibold text-slate-700" value={state.selectedProjectId ?? ''} onChange={e => { setSelectedId(undefined); void call({ action: 'selectProject', projectId: e.target.value }) }}><option value="" disabled>选择项目</option>{state.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
            <button className="mt-2 w-full rounded-md border border-dashed border-slate-300 py-1.5 text-[11px] text-slate-600 transition-colors hover:border-indigo-300 hover:text-indigo-700 disabled:opacity-50" disabled={!state.connected} onClick={() => setProjectDialog(true)}>＋ 新建 / 获取项目</button>
          </div>
          <nav className="space-y-1 p-2">
            <div className="px-2 py-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">Studio Workspace</div>
            {stages.map(item => <button key={item.id} aria-current={stage === item.id ? 'page' : undefined} className={`flex w-full items-center space-x-2.5 rounded-md px-3 py-2 text-left text-[11px] transition-colors ${stage === item.id ? 'bg-[#1e40af] font-semibold text-white shadow-sm' : 'font-medium text-slate-600 hover:bg-slate-100/80'}`} onClick={() => selectStage(item.id)}>
              <span className={stage === item.id ? 'text-white' : 'text-slate-400'}><StageIcon path={stageIconPaths[item.id]} /></span>
              <span>{item.name}</span>
              <span className={`ml-auto ${stage === item.id ? 'text-indigo-200' : 'text-slate-300'}`}>›</span>
            </button>)}
          </nav>
        </div>
        <div className="flex flex-shrink-0 items-center justify-between border-t border-slate-200 bg-slate-50/70 p-3">
          <div className="flex min-w-0 items-center space-x-2">
            <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border border-slate-300 bg-slate-200 text-[11px] text-slate-600">{state.account?.name?.slice(0, 1) ?? 'S'}</div>
            <div className="min-w-0 leading-tight">
              <div className="truncate text-[11px] font-medium text-slate-800">{state.account?.name ?? '登录协同工作台'}</div>
              <div className="truncate font-mono text-[9px] text-slate-500">{state.account ? `@${state.account.username} · GitLab @${state.account.gitlabUsername}` : '登录后查看可用项目'}</div>
            </div>
          </div>
          <button className="rounded p-1 text-[10px] text-slate-400 transition-colors hover:bg-slate-200/60 hover:text-slate-700" onClick={() => { if (state.connected) { setState(disconnectedState()); setSelectedId(undefined); void call({ action: 'logout' }) } else setLoginDialog(true) }}>{state.connected ? '退出' : '登录'}</button>
        </div>
      </aside>
      <main className={css.main}>
        <header className={css.pageHeader}><div><p className={css.eyebrow}>PROJECT / {currentStage.mark}</p><h1>{currentStage.name}</h1><p>{currentStage.description}</p></div><span className={css.statusPill}><i />{busy ? '正在处理' : state.connected ? '协同工作台已登录' : '等待连接'}</span></header>
        {error && <div className={css.error} role="alert">{error}<button onClick={() => setError('')} aria-label="关闭错误">×</button></div>}
        {state.projectInitializations.map(operation => <div className={css.notice} key={operation.id}>项目「{operation.name}」待处理：{operation.message ?? operation.phase}<button disabled={busy} onClick={() => void call({ action: 'retryProjectInitialization', operationId: operation.id })}>继续初始化</button></div>)}
        {state.pending.filter(p => p.phase !== 'accepted').map(p => <div className={css.notice} key={p.id}>待核对：{p.message ?? p.phase}<button disabled={busy} onClick={() => void call({ action: 'retryOperation', operationId: p.id })}>查询并恢复</button></div>)}
        {!state.project ? <div className={css.welcome}><span className={css.welcomeMark}>e</span><p className={css.eyebrow}>IDEAS INTO ASSETS</p><h2>从一个项目开始</h2><p>登录协同工作台，创建或打开项目。<br />场景、需求与原型将在这里持续沉淀。</p><button className={css.primary} onClick={() => state.connected ? setProjectDialog(true) : setLoginDialog(true)}>{state.connected ? "＋ 创建 / 打开项目" : "登录协同工作台"}</button><small>一个项目，对应一个 Git 仓库</small></div> : stage === 'baselines' ? <div className={css.resultList}>
          <div className={css.sectionHeading}><h2>已确认基线</h2><span>原型完成后自动形成，无需再次审批</span></div>
          {(state.collaboration?.baselines ?? []).length === 0 && <Empty text="完成一个需求的原型确认后，固定基线会出现在这里。" />}
          {state.collaboration?.baselines.map(b => <article className={css.baseline} key={b.id}><span className={css.assetIcon}>✓</span><div><h3>{entities.find(e => e.id === b.entityId)?.title ?? b.entityId}</h3><p>{b.id} · 版本 {b.version}</p><code>{b.commitSha}</code></div><span className={css.success}>后端已接受</span><button disabled={busy} onClick={() => void call({ action: 'generateHandoff', baselineId: b.id })}>生成交接清单</button></article>)}
        </div> : <div className={css.workspace}>
          <section className={css.catalog} aria-label="资产列表"><div className={css.catalogHeader}><strong>{stage === 'scenarios' ? '场景' : stage === 'handoffs' ? '清单' : '需求'}目录</strong><span>{visible.length}</span></div><input className={css.search} placeholder="搜索标题或编号…" aria-label="搜索资产" value={filter} onChange={e => setFilter(e.target.value)} />
            <div className={css.assetList}>{visible.map(e => <button key={e.id} className={`${css.assetItem} ${selectedId === e.id ? css.selectedAsset : ''}`} onClick={() => { setSelectedId(e.id); setActiveTab('material') }}><small>{e.id}</small><strong>{e.title}</strong><div><span className={e.confirmationStatus === 'confirmed' ? css.success : css.muted}>{e.confirmationStatus === 'confirmed' ? '材料已确认' : '草稿'}</span><span>{e.occupation ? '处理中' : '空闲'}</span></div></button>)}{visible.length === 0 && <Empty text="还没有资产" />}</div>
            {stage !== 'prototype' && stage !== 'handoffs' && <form className={css.addMaterial} onSubmit={async e => { e.preventDefault(); const r = await call({ action: 'createMaterial', kind: stage === 'scenarios' ? 'scenario' : 'requirement', title, categoryId: selectedCategory }); if (r) setTitle('') }}><label>新增{stage === 'scenarios' ? '场景' : '需求'}<input required value={title} onChange={e => setTitle(e.target.value)} placeholder="输入标题" maxLength={150} /></label><select aria-label="业务分类" value={selectedCategory} onChange={e => setCategory(e.target.value)}><option value="" disabled>选择业务分类</option>{categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select><button className={css.primary} disabled={busy || !selectedCategory}>＋ 新增</button></form>}
            <details className={css.categoryForm}><summary>维护项目分类</summary><form onSubmit={async e => { e.preventDefault(); if (await call({ action: 'addCategory', name: newCategory })) setNewCategory('') }}><input required aria-label="新分类名称" value={newCategory} onChange={e => setNewCategory(e.target.value)} placeholder="例如：采购、库存" /><button disabled={busy}>添加</button></form></details>
          </section>
          <section className={css.taskArea}><div className={css.taskHeader}><div><span className={css.eyebrow}>{selected?.id ?? 'AI WORKSPACE'}</span><h2>{selected?.title ?? '选择一项材料，与 AI 一起完善'}</h2></div>{selected && <button disabled={busy} onClick={() => void call({ action: 'startSession', entityId: selected.id, purpose: stage === 'prototype' ? 'prototype' : 'material' })}>{task ? '恢复对话' : '与 AI 整理'}</button>}</div>
            {selected ? <><div className={css.contextStrip}><span>输入版本 {selected.materialVersion || '草稿'}</span><span>{selected.occupation ? `由 #${selected.occupation.ownerId} 处理中` : '尚未认领'}</span>{selected.frozenBy.length > 0 && <strong>场景联动冻结</strong>}</div>{task?.error && <div className={css.notice}>{task.error}</div>}
              {task ? <NativeConversation {...props} sessionId={task.sessionId} /> : <div className={css.conversationEmpty}><span>✦</span><h3>让业务意图更清晰</h3><p>点击「与 AI 整理」打开原生 Agent 对话。<br />材料、来源与当前输入将绑定到该任务。</p></div>}
              {stage === 'prototype' && <div className={css.actionBar}><button disabled={busy} onClick={() => operation('claimPrototype')}>认领原型任务</button><button disabled={busy} onClick={() => operation('checkPrototype')}>运行工程检查</button><button disabled={busy} onClick={() => operation('startPreview')}>启动预览</button><button disabled={busy} onClick={() => operation('stopPreview')}>停止预览</button><button className={css.primary} disabled={busy} onClick={() => operation('confirmPrototype')}>确认当前需求完成</button></div>}
              {stage !== 'prototype' && draft && <><div className={css.confirmBar}><div><strong>作者确认当前材料</strong><small>内容检查、Git 推送及后端接受后生效</small></div><button className={css.primary} disabled={busy} onClick={() => void confirm()}>确认材料</button></div><form className={css.naturalConfirm} onSubmit={e => { e.preventDefault(); if (/^(确认|确认当前材料)[。！!]?$/u.test(naturalConfirmation.trim())) { void confirm(); setNaturalConfirmation('') } else setError('请明确输入“确认当前材料”，操作仅绑定右侧已保存的版本。') }}><input aria-label="自然语言确认当前材料" value={naturalConfirmation} onChange={e => setNaturalConfirmation(e.target.value)} placeholder="也可以输入：确认当前材料" /><button disabled={busy}>发送确认</button></form></>}
            </> : <Empty text="选择左侧资产，查看材料和协作状态。" />}
            {stage === 'scenarios' && state.candidates.some(c => c.scenarioId === selectedId) && <div className={css.candidates}><h3>AI 拆分的需求候选</h3>{state.candidates.filter(c => c.scenarioId === selectedId).map(c => <div key={c.id}><div><strong>{c.title}</strong><p>{c.summary}</p></div><button disabled={busy || !!c.selectedEntityId} onClick={() => void call({ action: 'selectCandidate', candidateId: c.id, categoryId: selectedCategory })}>{c.selectedEntityId ? '已选用' : '选用并完善'}</button></div>)}</div>}
          </section>
          <aside className={css.inspector} aria-label="材料与固定版本"><div className={css.tabs}><button aria-selected={activeTab === 'material'} onClick={() => setActiveTab('material')}>材料内容</button><button aria-selected={activeTab === 'versions'} onClick={() => setActiveTab('versions')}>确认与复用</button></div>{activeTab === 'material' ? draft ? <MaterialEditor key={`${draft.entityId}:${draft.sha256}`} draft={draft} categories={categories} entities={entities} busy={busy} onSave={(body, metadata) => call({ action: 'saveMaterial', entityId: draft.entityId, body, metadata })} /> : <Empty text="材料保存在项目 Git 仓库中。" /> : selected && <VersionPanel entity={selected} entities={entities} projectId={state.project.id} busy={busy} call={call} />}
            {selected?.occupation && <button className={css.release} disabled={busy} onClick={() => operation('releaseOccupation')}>取消本人任务并释放占用</button>}{stage === 'handoffs' && selected?.current && <button disabled={busy} onClick={() => void call({ action: 'acknowledgeHandoff', entityId: selected.id, note: '已收悉固定交接材料' })}>研发收悉</button>}
          </aside>
        </div>}
        {stage === 'prototype' && state.project && <div className={css.publication}><span>发布项目当前已确认基线</span><button disabled={busy} onClick={() => void call({ action: 'publish' })}>部署到远端</button><button disabled={busy} onClick={() => void call({ action: 'revokePublication' })}>撤回当前站点</button></div>}
      </main>
    </div>{loginDialog && <LoginDialog busy={busy} error={error} onClose={() => setLoginDialog(false)} onSubmit={async (username, password) => { if (await call({ action: 'login', username, password })) { setLoginDialog(false); setSelectedId(undefined) } }} />}{projectDialog && <ProjectDialog busy={busy} projects={state.availableProjects} namespaces={state.namespaces} onClose={() => setProjectDialog(false)} onSubmit={async command => { if (await call(command)) setProjectDialog(false) }} />}
  </div>
}
function Empty({ text }: { text: string }) { return <div className={css.empty}>{text}</div> }
function NativeConversation(props: StudioProps & { sessionId: string }) {
  const [reference, setReference] = useState<SessionReference>()
  const [error, setError] = useState('')
  useEffect(() => { const ref = props.retainSession(props.sessionId); setReference(ref); setError(''); void ref.ready.catch(() => setError('会话恢复失败，请使用“恢复对话”重试')); return () => ref.release() }, [props.sessionId, props.retainSession])
  if (error) return <div role="alert" className={css.error}>{error}</div>
  if (!reference) return <Empty text="正在恢复原生会话…" />
  const Provider = props.SessionProvider
  return <div className={css.nativeConversation}><Provider session={reference}>{props.renderFactorySlot('conversation.content', { variant: 'embedded', phase: 'active', hero: false })}</Provider></div>
}
function VersionPanel({ entity, entities, projectId, busy, call }: { entity: EntityView; entities: EntityView[]; projectId: string; busy: boolean; call: (command: StudioCommand) => Promise<unknown> }) {
  const [reason, setReason] = useState(''); const [targetId, setTargetId] = useState(''); const fixed = entity.current
  return <div className={css.versionPanel}><h3>材料确认</h3><p>{fixed ? `版本 ${fixed.version} · 已确认` : '草稿，尚未确认'}</p>{fixed && <><code>{fixed.fixed.commitSha}</code><h3>复用资格</h3><span className={fixed.reuse.enabled ? css.success : css.muted}>{fixed.reuse.enabled ? '允许采用' : '已停用'}</span><p>{fixed.reuse.reason}</p><label>操作原因<input value={reason} onChange={e => setReason(e.target.value)} placeholder="填写停用、恢复或采用原因" /></label><button disabled={busy || !reason.trim()} onClick={() => void call({ action: 'setEligibility', entityId: entity.id, version: fixed.version, enabled: !fixed.reuse.enabled, reason })}>{fixed.reuse.enabled ? '停用此固定来源' : '恢复此固定来源'}</button><h3>显式采用完整材料包</h3><select aria-label="采用目标" value={targetId} onChange={e => setTargetId(e.target.value)}><option value="">选择目标草稿</option>{entities.filter(e => e.id !== entity.id && e.kind === entity.kind).map(e => <option key={e.id} value={e.id}>{e.title}</option>)}</select><button disabled={busy || !targetId || !reason.trim() || !fixed.reuse.enabled} onClick={() => void call({ action: 'adopt', sourceProjectId: projectId, sourceEntityId: entity.id, version: fixed.version, targetEntityId: targetId, reason })}>采用并在目标中调整</button><p className={css.muted}>采用受理后保留固定来源；目标独立确认后才计为复用成功。</p></>}</div>
}
