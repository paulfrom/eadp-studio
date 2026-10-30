import type { ConsistencyComparisonView } from '@eadp/contracts'
import type { EntityView, MaterialDraft } from '../../shared/studio.ts'
import { isRevising } from '../scenarios/catalog.ts'
import { latestComparison, requirementMetrics } from '../requirements/metrics.ts'
import css from './materialCatalog.module.css'

/** A material's current business content and editing state in the catalog matrix. */
export function MaterialCatalogCard({ entity, entities, draft, consistencyLatest, onSelect }: {
  entity: EntityView; entities: EntityView[]; draft: MaterialDraft | undefined;
  consistencyLatest: ConsistencyComparisonView[]; onSelect(id: string): void;
}) {
  const summary = entity.summary || draft?.body.split('\n').filter(line => line.trim() && !/^\s*#/.test(line)).join(' ').slice(0, 180)
  const requirement = entity.kind === 'requirement'
  const metrics = requirement && draft ? requirementMetrics(draft.body, draft.metadata) : undefined
  const comparison = requirement ? latestComparison(entity.id, consistencyLatest) : undefined
  const confirmed = entity.confirmationStatus === 'confirmed'
  const editor = entity.lastEditor?.name ?? entity.creator?.name ?? `#${entity.authorId}`
  return <button type="button" className={css.assetCard} onClick={() => onSelect(entity.id)}>
    <span className={css.cardHead}><span className={css.code}>{entity.code ?? entity.id}</span><span className={`${css.status} ${confirmed ? css.confirmed : ''}`}>{confirmed ? '材料已确认' : '草稿'}{isRevising(entity) ? ' · 正在修订' : ''}</span></span>
    <strong className={css.cardTitle}>{entity.title}</strong>
    <span className={css.cardSummary} title={summary}>{summary || '打开材料，查看业务内容与协作详情。'}</span>
    {requirement && entity.scenarioIds.length > 0 && <span className={css.cardSources}>{entity.scenarioIds.map(id => {
      const source = entities.find(item => item.id === id)
      const pinned = entity.scenarioSources?.find(item => item.entityId === id)
      return <span key={id} className={css.sourceChip}>{source?.builtinKey ? `${source.title} · 系统内置` : `${source ? `${source.code ?? source.id} · ${source.title}` : id}${pinned ? ` · v${pinned.version}` : ''}`}</span>
    })}</span>}
    {requirement && <span className={css.metrics}><span>{metrics ? `${metrics.rules === null ? '规则未统计' : `规则 ${metrics.rules} 条`} · 待澄清 ${metrics.openQuestions} 项${metrics.blocking > 0 ? ` · 阻断 ${metrics.blocking}` : ''} · ${confirmed && draft?.sha256 === entity.current?.fixed.sha256 ? `已确认版 v${entity.materialVersion}` : '本地草稿'}` : '未统计'}</span><span>{comparison?.status === 'known' ? `冲突 ${comparison.conflictCount} · ${comparison.coverage === 'partial' ? '范围不足' : '完整'}` : '对比未知'}</span>{comparison?.status === 'known' && comparison.conflictCount > 0 && <span className={css.reminder}>最近一次检查不通过</span>}{comparison?.status === 'known' && comparison.coverage === 'partial' && <span className={css.reminder}>范围不足</span>}</span>}
    <span className={css.cardFooter}><span className={css.editor}><span className={css.avatar} aria-hidden="true">{Array.from(editor).slice(0, 2).join('')}</span><span>最近编辑 {editor}</span></span><span className={css.version}>{entity.materialVersion ? `材料版本 ${entity.materialVersion}` : '尚无确认版本'}</span></span>
    <span className={css.editing}><span>创建人 {entity.creator?.name ?? `#${entity.authorId}`}</span><span>{entity.occupation ? `当前编辑人 #${entity.occupation.ownerId}` : '未占用'}</span></span>
  </button>
}
