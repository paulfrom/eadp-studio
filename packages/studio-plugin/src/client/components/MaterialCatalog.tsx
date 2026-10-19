import { useState } from 'react'
import type { EntityView, MaterialDraft, StudioCommand, StudioReply } from '../../shared/studio.ts'
import css from '../studio.module.css'

export function MaterialCatalog({ entities, drafts, categories, kind, busy, onSelect, call }: {
  entities: EntityView[]; drafts: MaterialDraft[]; categories: Array<{ id: string; name: string }>;
  kind: 'scenario' | 'requirement'; busy: boolean;
  onSelect(id: string): void; call(command: StudioCommand): Promise<StudioReply | undefined>;
}) {
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [page, setPage] = useState(1)
  const [creating, setCreating] = useState(false)
  const [title, setTitle] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [newCategory, setNewCategory] = useState('')
  const name = kind === 'scenario' ? '场景' : '需求'
  const visible = entities.filter(entity => (!categoryFilter || entity.categoryId === categoryFilter) && (statusFilter === 'all' || entity.confirmationStatus === statusFilter) && `${entity.title} ${entity.id}`.toLowerCase().includes(search.toLowerCase()))
  const pageCount = Math.max(1, Math.ceil(visible.length / 8))
  const currentPage = Math.min(page, pageCount)
  const pageEntities = visible.slice((currentPage - 1) * 8, currentPage * 8)
  const selectedCategory = categoryId || categories[0]?.id || ''
  return <section className={css.materialCatalog} aria-label="资产列表">
    <div className={css.catalogHeader}><strong>{name}目录 · {visible.length}</strong><button className={css.primary} aria-expanded={creating} onClick={() => setCreating(value => !value)}>＋ 新建{name}</button></div>
    {creating && <form className={css.createAsset} onSubmit={async event => {
      event.preventDefault()
      const result = await call({ action: 'createMaterial', kind, title, categoryId: selectedCategory })
      if (result?.ok) {
        setTitle(''); setCreating(false)
        const created = result.state.collaboration?.entities.filter((entity): entity is EntityView => 'title' in entity).filter(entity => entity.kind === kind && !entities.some(previous => previous.id === entity.id))
        if (created?.length === 1) onSelect(created[0]!.id)
      }
    }}><label>{name}标题<input autoFocus required maxLength={150} value={title} onChange={event => setTitle(event.target.value)} /></label><label>业务分类<select required value={selectedCategory} onChange={event => setCategoryId(event.target.value)}><option value="" disabled>选择业务分类</option>{categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label><button className={css.primary} disabled={busy || !selectedCategory}>创建{name}</button><button type="button" onClick={() => setCreating(false)}>取消</button></form>}
    <div className={css.catalogBody}>
      <aside className={css.categorySidebar} aria-label="业务分类筛选"><strong>业务分类</strong><button aria-pressed={!categoryFilter} onClick={() => { setCategoryFilter(''); setPage(1) }}>全部分类<span>{entities.length}</span></button>{categories.map(category => <button key={category.id} aria-pressed={categoryFilter === category.id} onClick={() => { setCategoryFilter(category.id); setPage(1) }}><span>{category.name}</span><span>{entities.filter(entity => entity.categoryId === category.id).length}</span></button>)}<details className={css.categoryForm}><summary>维护项目分类</summary><form onSubmit={async event => { event.preventDefault(); if (await call({ action: 'addCategory', name: newCategory })) setNewCategory('') }}><input required aria-label="新分类名称" value={newCategory} onChange={event => setNewCategory(event.target.value)} placeholder="输入分类名称" /><button disabled={busy}>添加</button></form></details></aside>
      <div className={css.catalogResults}><div className={css.catalogToolbar}><input className={css.search} placeholder="搜索标题或编号…" aria-label="搜索资产" value={search} onChange={event => { setSearch(event.target.value); setPage(1) }} /><select aria-label="材料确认状态" value={statusFilter} onChange={event => { setStatusFilter(event.target.value); setPage(1) }}><option value="all">全部状态</option><option value="confirmed">已确认</option><option value="draft">草稿</option></select></div><div className={css.assetGrid}>{pageEntities.map(entity => {
        const body = drafts.find(draft => draft.entityId === entity.id)?.body
        const summary = body?.split('\n').filter(line => line.trim() && !/^\s*#/.test(line)).join(' ').slice(0, 180)
        return <button key={entity.id} className={css.assetCard} onClick={() => onSelect(entity.id)}><small>{entity.id}</small><strong>{entity.title}</strong><p className={css.cardSummary}>{summary && <span className={css.summaryLabel}>材料摘要 · </span>}{summary || '打开材料，查看业务内容与协作详情。'}</p><div className={css.cardMetadata}><span>{categories.find(category => category.id === entity.categoryId)?.name ?? entity.categoryId}</span><span>{entity.materialVersion ? `材料版本 ${entity.materialVersion}` : '尚无确认版本'}</span></div><div className={css.cardStatus}><span className={entity.confirmationStatus === 'confirmed' ? css.success : css.muted}>{entity.confirmationStatus === 'confirmed' ? '材料已确认' : '草稿'}</span><span>{entity.occupation ? '已占用' : '未占用'}</span></div></button>
      })}{visible.length === 0 && <div className={css.empty}>{entities.length ? '没有符合筛选条件的资产' : `还没有${name}`}</div>}</div><footer className={css.catalogPagination}><span>共 {visible.length} 项 · 第 {currentPage} / {pageCount} 页</span><button disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>上一页</button><button disabled={currentPage === pageCount} onClick={() => setPage(currentPage + 1)}>下一页</button></footer></div>
    </div>
  </section>
}
