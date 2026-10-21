import { useDeferredValue, useMemo, useState } from 'react'
import type { EntityView, MaterialDraft, StudioCommand, StudioReply } from '../../shared/studio.ts'
import { isRevising, selectCatalog, type CatalogSort } from '../scenarios/catalog.ts'
import css from '../studio.module.css'

export function MaterialCatalog({ entities, drafts, categories, kind, busy, onSelect, call, loadError, onRetry }: {
  entities: EntityView[]; drafts: MaterialDraft[]; categories: Array<{ id: string; name: string }>;
  kind: 'scenario' | 'requirement'; busy: boolean; loadError?: string; onRetry?(): void;
  onSelect(id: string): void; call(command: StudioCommand): Promise<StudioReply | undefined>;
}) {
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [page, setPage] = useState(1)
  const [revisionFilter, setRevisionFilter] = useState('all')
  const [sort, setSort] = useState<CatalogSort>('updated')
  const deferredSearch = useDeferredValue(search)
  const [creating, setCreating] = useState(false)
  const [operationId, setOperationId] = useState('')
  const [title, setTitle] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [scenarioIds, setScenarioIds] = useState<string[]>([])
  const [newCategory, setNewCategory] = useState('')
  const name = kind === 'scenario' ? '场景' : '需求'
  const ownEntities = useMemo(() => entities.filter(entity => entity.kind === kind), [entities, kind])
  const visible = useMemo(() => selectCatalog(ownEntities, { search: deferredSearch, status: statusFilter, revision: kind === 'scenario' ? revisionFilter : 'all', sort, category: kind === 'requirement' ? categoryFilter : '' }), [ownEntities, deferredSearch, statusFilter, kind, revisionFilter, sort, categoryFilter])
  const pageCount = Math.max(1, Math.ceil(visible.length / 12))
  const currentPage = Math.min(page, pageCount)
  const pageEntities = visible.slice((currentPage - 1) * 12, currentPage * 12)
  const resetFilters = () => { setSearch(''); setCategoryFilter(''); setStatusFilter('all'); setRevisionFilter('all'); setPage(1) }
  const selectedCategory = categoryId || categories[0]?.id || ''
  return <section className={css.materialCatalog} aria-label="资产列表">
    <div className={css.catalogHeader}><strong>{name}目录 · 共 {ownEntities.length} 项 · 已确认 {ownEntities.filter(entity => entity.confirmationStatus === 'confirmed').length} · 草稿 {ownEntities.filter(entity => entity.confirmationStatus === 'draft').length}</strong><button className={css.primary} aria-expanded={creating} onClick={() => { if (!creating && !operationId) setOperationId(crypto.randomUUID()); if (creating) setOperationId(''); setCreating(value => !value) }}>＋ 新建{name}</button></div>
    {creating && <form className={css.createAsset} onSubmit={async event => {
      event.preventDefault()
      const result = await call({ action: 'createMaterial', operationId, kind, title, ...(kind === 'requirement' ? { categoryId: selectedCategory, scenarioIds } : {}) })
      if (result?.ok) {
        setTitle(''); setScenarioIds([]); setOperationId(''); setCreating(false)
        const created = result.state.collaboration?.entities.filter((entity): entity is EntityView => 'title' in entity).filter(entity => entity.kind === kind && !entities.some(previous => previous.id === entity.id))
        if (kind === 'scenario' && result.state.scenario) onSelect(result.state.scenario.entityId)
        else if (created?.length === 1) onSelect(created[0]!.id)
      }
    }}><label>{name}标题<input autoFocus required maxLength={150} value={title} onChange={event => setTitle(event.target.value)} /></label>{kind === 'requirement' && <><label>业务分类<select required value={selectedCategory} onChange={event => setCategoryId(event.target.value)}><option value="" disabled>选择业务分类</option>{categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label><label>固定场景来源<select multiple required value={scenarioIds} onChange={event => setScenarioIds([...event.target.selectedOptions].map(option => option.value))}>{entities.filter(entity => entity.kind === 'scenario' && entity.materialVersion > 0).map(entity => <option key={entity.id} value={entity.id}>{entity.code ?? entity.id} · {entity.title} · v{entity.materialVersion}</option>)}</select></label></>}<button className={css.primary} disabled={busy || (kind === 'requirement' && (!selectedCategory || !scenarioIds.length))}>创建{name}</button><button type="button" onClick={() => { setCreating(false); setOperationId('') }}>取消</button></form>}
    <div className={`${css.catalogBody} ${kind === 'scenario' ? css.scenarioCatalogBody : ''}`}>
      {kind === 'requirement' && <aside className={css.categorySidebar} aria-label="业务分类筛选"><strong>业务分类</strong><button aria-pressed={!categoryFilter} onClick={() => { setCategoryFilter(''); setPage(1) }}>全部分类<span>{ownEntities.length}</span></button>{categories.map(category => <button key={category.id} aria-pressed={categoryFilter === category.id} onClick={() => { setCategoryFilter(category.id); setPage(1) }}><span>{category.name}</span><span>{entities.filter(entity => entity.categoryId === category.id).length}</span></button>)}<details className={css.categoryForm}><summary>维护项目分类</summary><form onSubmit={async event => { event.preventDefault(); if ((await call({ action: 'addCategory', name: newCategory }))?.ok) setNewCategory('') }}><input required aria-label="新分类名称" value={newCategory} onChange={event => setNewCategory(event.target.value)} placeholder="输入业务分类" /><button disabled={busy}>添加</button></form></details></aside>}
      <div className={css.catalogResults}><div className={css.catalogToolbar}><input className={css.search} placeholder="搜索标题或编号…" aria-label="搜索资产" value={search} onChange={event => { setSearch(event.target.value); setPage(1) }} /><select aria-label="材料确认状态" value={statusFilter} onChange={event => { setStatusFilter(event.target.value); setPage(1) }}><option value="all">全部状态</option><option value="confirmed">已确认</option><option value="draft">草稿</option></select>{kind === 'scenario' && <select aria-label="修订状态" value={revisionFilter} onChange={event => { setRevisionFilter(event.target.value); setPage(1) }}><option value="all">全部修订状态</option><option value="revising">正在修订</option><option value="stable">未在修订</option></select>}<select aria-label="列表排序" value={sort} onChange={event => { setSort(event.target.value as CatalogSort); setPage(1) }}><option value="updated">最近更新</option><option value="created">创建时间</option><option value="sequence">业务编号</option></select><button onClick={resetFilters}>清空筛选</button></div>{loadError && <div role="alert" className={css.error}>{loadError}<button disabled={busy} onClick={onRetry}>重试目录读取</button></div>}<div className={css.assetGrid}>{pageEntities.map(entity => {
        const body = drafts.find(draft => draft.entityId === entity.id)?.body
        const summary = entity.summary || body?.split('\n').filter(line => line.trim() && !/^\s*#/.test(line)).join(' ').slice(0, 180)
        return <button key={entity.id} className={css.assetCard} onClick={() => onSelect(entity.id)}><small>{entity.code ?? entity.id}</small><strong>{entity.title}</strong><p className={css.cardSummary}>{summary && <span className={css.summaryLabel}>材料摘要 · </span>}{summary || '打开材料，查看业务内容与协作详情。'}</p><div className={css.cardMetadata}>{kind === 'requirement' && <span>{categories.find(category => category.id === entity.categoryId)?.name ?? entity.categoryId}</span>}<span>{entity.materialVersion ? `材料版本 ${entity.materialVersion}` : '尚无确认版本'}</span></div><div className={css.cardStatus}>{entity.legacyCurrent && <span className={css.muted} title={entity.legacyCurrent.reason}>旧契约 · 只读</span>}<span className={entity.confirmationStatus === 'confirmed' ? css.success : css.muted}>{entity.confirmationStatus === 'confirmed' ? '材料已确认' : '草稿'}</span><span>{entity.occupation ? `当前编辑人 #${entity.occupation.ownerId}` : '未占用'}</span>{kind === 'scenario' && <span>{isRevising(entity) ? '正在修订' : '未在修订'}</span>}</div><small>创建人 {entity.creator?.name ?? `#${entity.authorId}`} · 最近编辑 {entity.lastEditor?.name ?? entity.creator?.name ?? `#${entity.authorId}`}</small></button>
      })}{visible.length === 0 && !loadError && <div className={css.empty}>{ownEntities.length ? <>没有符合筛选条件的资产<button onClick={resetFilters}>清空筛选</button></> : <>还没有{name}<button onClick={() => { setCreating(true); setOperationId(crypto.randomUUID()) }}>新建{name}</button></>}</div>}</div><footer className={css.catalogPagination}><span>共 {visible.length} 项 · 第 {currentPage} / {pageCount} 页</span><button disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>上一页</button><button disabled={currentPage === pageCount} onClick={() => setPage(currentPage + 1)}>下一页</button></footer></div>
    </div>
  </section>
}
