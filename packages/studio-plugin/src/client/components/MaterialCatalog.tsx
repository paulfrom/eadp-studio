import { useDeferredValue, useMemo, useState } from 'react'
import type { ConsistencyComparisonView } from '@eadp/contracts'
import type { Candidate, EntityView, MaterialDraft, StudioCommand, StudioReply, TaskView } from '../../shared/studio.ts'
import { isRevising, selectCatalog, type CatalogSort } from '../scenarios/catalog.ts'
import { latestComparison, requirementMetrics } from '../requirements/metrics.ts'
import { ConsistencyPanel } from './ConsistencyPanel.tsx'
import { RequirementCandidatePanel } from '../requirements/RequirementCandidatePanel.tsx'
import type { ConsistencyTaskView } from '../../shared/consistency.ts'
import css from '../studio.module.css'

const splitStatusName: Record<string, string> = { pending: '等待拆分', sent: '拆分进行中', failed: '拆分失败', completed: '拆分完成' }

export function MaterialCatalog({ entities, drafts, kind, busy, onSelect, onOpenMaterial, call, loadError, onRetry, comparisonError, onRetryComparisons, consistencyLatest, consistencyTasks = [], tasks, candidates }: {
  entities: EntityView[]; drafts: MaterialDraft[];
  kind: 'scenario' | 'requirement'; busy: boolean; loadError?: string; onRetry?(): void;
  onSelect(id: string): void; call(command: StudioCommand): Promise<StudioReply | undefined>;
  consistencyLatest: ConsistencyComparisonView[]; tasks: TaskView[]; candidates: Candidate[];
  consistencyTasks?: ConsistencyTaskView[]; onOpenMaterial?(entity: EntityView): void;
  comparisonError?: string | undefined; onRetryComparisons?(): void;
}) {
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [page, setPage] = useState(1)
  const [revisionFilter, setRevisionFilter] = useState('all')
  const [sourceFilter, setSourceFilter] = useState('all')
  const [sort, setSort] = useState<CatalogSort>('updated')
  const deferredSearch = useDeferredValue(search)
  const [creating, setCreating] = useState(false)
  const [operationId, setOperationId] = useState('')
  const [title, setTitle] = useState('')
  const [scenarioIds, setScenarioIds] = useState<string[]>([])
  const [splitting, setSplitting] = useState(false)
  const [splitSelection, setSplitSelection] = useState<string[]>([])
  const [createError, setCreateError] = useState('')
  const [splitError, setSplitError] = useState('')
  const [showComparisons, setShowComparisons] = useState(false)
  const name = kind === 'scenario' ? '场景' : '需求'
  const ownEntities = useMemo(() => entities.filter(entity => entity.kind === kind && !entity.builtinKey), [entities, kind])
  const confirmedScenarios = useMemo(() => entities.filter(entity => entity.kind === 'scenario' && entity.materialVersion > 0 && !entity.builtinKey), [entities])
  // Only ordinary business scenarios participate in requirement splitting.
  const splitScenarios = confirmedScenarios
  const visible = useMemo(() => selectCatalog(ownEntities, { search: deferredSearch, status: statusFilter, revision: revisionFilter, sort, source: kind === 'requirement' ? sourceFilter : 'all' }), [ownEntities, deferredSearch, statusFilter, revisionFilter, sort, kind, sourceFilter])
  const pageCount = Math.max(1, Math.ceil(visible.length / 12))
  const currentPage = Math.min(page, pageCount)
  const pageEntities = visible.slice((currentPage - 1) * 12, currentPage * 12)
  const splitTasks = useMemo(() => tasks.filter(task => task.purpose === 'split' && task.split), [tasks])
  const resetFilters = () => { setSearch(''); setStatusFilter('all'); setRevisionFilter('all'); setSourceFilter('all'); setPage(1) }
  return <section className={css.materialCatalog} aria-label="资产列表">
    {comparisonError && <p className={css.error} role="alert">对比未知：{comparisonError}<button onClick={onRetryComparisons}>重试读取最近对比</button></p>}
    <div className={css.catalogHeader}><strong>{name}目录 · 共 {ownEntities.length} 项 · 已确认 {ownEntities.filter(entity => entity.confirmationStatus === 'confirmed').length} · 草稿 {ownEntities.filter(entity => entity.confirmationStatus === 'draft').length}</strong><button className={css.primary} aria-expanded={creating} onClick={() => { if (!creating && !operationId) setOperationId(crypto.randomUUID()); if (creating) setOperationId(''); setCreating(value => !value) }}>＋ 新建{name}</button></div>
    {creating && <form className={css.createAsset} onSubmit={async event => {
      event.preventDefault()
      setCreateError('')
      const result = await call({ action: 'createMaterial', operationId, kind, title, ...(kind === 'requirement' ? { scenarioIds } : {}) })
      if (!result?.ok) setCreateError(result && !result.ok ? result.message : '创建未完成，输入已保留，请重试。')
      if (result?.ok) {
        setTitle(''); setScenarioIds([]); setOperationId(''); setCreating(false)
        const created = result.state.collaboration?.entities.filter((entity): entity is EntityView => 'title' in entity).filter(entity => entity.kind === kind && !entities.some(previous => previous.id === entity.id))
        if (kind === 'scenario' && result.state.scenario) onSelect(result.state.scenario.entityId)
        else if (created?.length === 1) onSelect(created[0]!.id)
      }
    }}><label>{name}标题<input autoFocus required maxLength={150} value={title} onChange={event => setTitle(event.target.value)} /></label>{kind === 'requirement' && <label>固定场景来源<select multiple required value={scenarioIds} onChange={event => setScenarioIds([...event.target.selectedOptions].map(option => option.value))}>{entities.filter(entity => entity.kind === 'scenario' && entity.materialVersion > 0).map(entity => <option key={entity.id} value={entity.id}>{entity.code ?? entity.id} · {entity.title}{entity.builtinKey ? ' · 系统内置' : ` · v${entity.materialVersion}`}</option>)}</select></label>}<button className={css.primary} disabled={busy || (kind === 'requirement' && !scenarioIds.length)}>创建{name}</button>{createError && <p role="alert" className={css.error}>{createError}</p>}<button type="button" onClick={() => { setCreating(false); setOperationId('') }}>取消</button></form>}
    <div className={css.catalogBody}>
      <div className={css.catalogResults}><div className={css.catalogToolbar}><input className={css.search} placeholder="搜索标题或编号…" aria-label="搜索资产" value={search} onChange={event => { setSearch(event.target.value); setPage(1) }} /><div className={css.segmented} role="group" aria-label="材料确认状态">{([['all', '全部'], ['confirmed', '已确认'], ['draft', '草稿']] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={statusFilter === value} onClick={() => { setStatusFilter(value); setPage(1) }}>{label}</button>)}</div>{kind === 'requirement' && <select aria-label="来源场景" value={sourceFilter} onChange={event => { setSourceFilter(event.target.value); setPage(1) }}><option value="all">全部来源场景</option>{confirmedScenarios.map(entity => <option key={entity.id} value={entity.id}>{entity.code ?? entity.id} · {entity.title}</option>)}</select>}<select aria-label="修订状态" value={revisionFilter} onChange={event => { setRevisionFilter(event.target.value); setPage(1) }}><option value="all">全部修订状态</option><option value="revising">正在修订</option><option value="stable">未在修订</option></select><select aria-label="列表排序" value={sort} onChange={event => { setSort(event.target.value as CatalogSort); setPage(1) }}><option value="updated">最近更新</option><option value="created">创建时间</option><option value="sequence">业务编号</option></select>{kind === 'requirement' && <button aria-expanded={splitting} onClick={() => setSplitting(value => !value)}>联合拆分需求</button>}<button onClick={resetFilters}>清空筛选</button><button aria-expanded={showComparisons} onClick={() => setShowComparisons(value => !value)}>项目对比记录</button></div>{showComparisons && <ConsistencyPanel entities={entities} tasks={consistencyTasks} busy={busy} call={call} onOpenMaterial={onOpenMaterial} />}{kind === 'requirement' && splitting && <form className={css.createAsset} aria-label="联合拆分需求" onSubmit={async event => {
        event.preventDefault()
        setSplitError('')
        const result = await call({ action: 'splitRequirements', scenarioIds: splitSelection })
        if (result?.ok) { setSplitSelection([]); setSplitting(false) }
        else setSplitError(result && !result.ok ? result.message : '拆分未完成，所选场景已保留，请重试。')
      }}><fieldset className={css.splitChoices}><legend>选择已确认的普通场景</legend>{splitScenarios.length === 0 && <p className={css.muted}>还没有可拆分的已确认普通场景。</p>}{splitScenarios.map(entity => <label key={entity.id}><input type="checkbox" checked={splitSelection.includes(entity.id)} onChange={event => setSplitSelection(selection => event.target.checked ? [...selection, entity.id] : selection.filter(id => id !== entity.id))} />{entity.code ?? entity.id} · {entity.title} · v{entity.materialVersion}</label>)}</fieldset><button className={css.primary} disabled={busy || splitSelection.length === 0}>生成需求候选</button>{splitError && <p role="alert" className={css.error}>{splitError}</p>}<button type="button" onClick={() => { setSplitting(false); setSplitSelection([]) }}>取消</button></form>}{loadError && <div role="alert" className={css.error}>{loadError}<button disabled={busy} onClick={onRetry}>重试目录读取</button></div>}<div className={css.assetGrid}>{pageEntities.map(entity => {
        const draft = drafts.find(draft => draft.entityId === entity.id)
        const body = draft?.body
        const summary = entity.summary || body?.split('\n').filter(line => line.trim() && !/^\s*#/.test(line)).join(' ').slice(0, 180)
        const metrics = kind === 'requirement' && draft ? requirementMetrics(draft.body, draft.metadata) : undefined
        const comparison = kind === 'requirement' ? latestComparison(entity.id, consistencyLatest) : undefined
        return <button key={entity.id} className={css.assetCard} onClick={() => onSelect(entity.id)}><small>{entity.code ?? entity.id}</small><strong>{entity.title}</strong><p className={css.cardSummary}>{summary && <span className={css.summaryLabel}>材料摘要 · </span>}{summary || '打开材料，查看业务内容与协作详情。'}</p>{kind === 'requirement' && entity.scenarioIds.length > 0 && <span className={css.cardSources}>{entity.scenarioIds.map(id => {
          const source = entities.find(item => item.id === id)
          const pinned = entity.scenarioSources?.find(item => item.entityId === id)
          return <span key={id} className={css.sourceChip}>{source?.builtinKey ? `${source.title} · 系统内置` : `${source ? `${source.code ?? source.id} · ${source.title}` : id}${pinned ? ` · v${pinned.version}` : ''}`}</span>
        })}</span>}{kind === 'requirement' && <span className={css.cardMetadata}><span>{metrics ? `${metrics.rules === null ? '规则未统计' : `规则 ${metrics.rules} 条`} · 待澄清 ${metrics.openQuestions} 项${metrics.blocking > 0 ? ` · 阻断 ${metrics.blocking}` : ''} · ${entity.confirmationStatus === 'confirmed' && draft?.sha256 === entity.current?.fixed.sha256 ? `已确认版 v${entity.materialVersion}` : '本地草稿'}` : '未统计'}</span><span>{comparison?.status === 'known' ? `冲突 ${comparison.conflictCount} · ${comparison.coverage === 'partial' ? '范围不足' : '完整'}` : '对比未知'}</span>{comparison?.status === 'known' && comparison.conflictCount > 0 && <span className={css.reminder}>最近一次检查不通过</span>}{comparison?.status === 'known' && comparison.coverage === 'partial' && <span className={css.reminder}>范围不足</span>}</span>}<div className={css.cardMetadata}><span>{entity.materialVersion ? `材料版本 ${entity.materialVersion}` : '尚无确认版本'}</span></div><div className={css.cardStatus}><span className={entity.confirmationStatus === 'confirmed' ? css.success : css.muted}>{entity.confirmationStatus === 'confirmed' ? '材料已确认' : '草稿'}</span><span>{entity.occupation ? `当前编辑人 #${entity.occupation.ownerId}` : '未占用'}</span><span>{isRevising(entity) ? '正在修订' : '未在修订'}</span></div><small>创建人 {entity.creator?.name ?? `#${entity.authorId}`} · 最近编辑 {entity.lastEditor?.name ?? entity.creator?.name ?? `#${entity.authorId}`}</small></button>
      })}{visible.length === 0 && !loadError && <div className={css.empty}>{ownEntities.length ? <>没有符合筛选条件的资产<button onClick={resetFilters}>清空筛选</button></> : <>还没有{name}<button onClick={() => { setCreating(true); setOperationId(crypto.randomUUID()) }}>新建{name}</button></>}</div>}</div><footer className={css.catalogPagination}><span>共 {visible.length} 项 · 第 {currentPage} / {pageCount} 页</span><button disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>上一页</button><button disabled={currentPage === pageCount} onClick={() => setPage(currentPage + 1)}>下一页</button></footer>
      {kind === 'requirement' && splitTasks.length > 0 && <section className={css.dockCard} aria-label="拆分任务">
        <header className={css.cardHead}><strong>拆分任务</strong><small>{splitTasks.length} 项</small></header>
        {splitTasks.map(task => <article className={css.candidateRow} key={task.split!.id}>
          <div><strong>拆分 {task.split!.id.slice(0, 8)}</strong><p>{splitStatusName[task.split!.status] ?? task.split!.status} · 来源 {task.split!.sources.map(source => source.title).join('、')}</p>{task.split!.status === 'failed' && task.error && <p role="alert">{task.error}</p>}</div>
        </article>)}
      </section>}
      {kind === 'requirement' && <RequirementCandidatePanel candidates={candidates} entities={entities} busy={busy} adopt={candidate => call({ action: 'selectCandidate', candidateId: candidate.id, expectedInputHash: candidate.inputHash })} onOpen={onSelect} />}</div>
    </div>
  </section>
}
