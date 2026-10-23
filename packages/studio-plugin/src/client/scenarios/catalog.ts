import type { EntityView } from '../../shared/studio.ts'

export type CatalogSort = 'updated' | 'created' | 'sequence'
export const isRevising = (entity: EntityView) => entity.materialVersion > 0 && entity.confirmationStatus === 'draft'
export function selectCatalog(entities: EntityView[], options: { search: string; status: string; revision: string; sort: CatalogSort; source: string }): EntityView[] {
  const search = options.search.trim().toLocaleLowerCase()
  return entities.filter(entity => (options.status === 'all' || entity.confirmationStatus === options.status)
    && (options.revision === 'all' || isRevising(entity) === (options.revision === 'revising'))
    && (options.source === 'all' || entity.scenarioIds.includes(options.source))
    && `${entity.title} ${entity.code ?? entity.id}`.toLocaleLowerCase().includes(search))
    .sort((a, b) => {
      const sequence = (a.sequence ?? 0) - (b.sequence ?? 0)
      if (options.sort === 'sequence') return sequence || a.id.localeCompare(b.id)
      const at = (entity: EntityView) => Date.parse((options.sort === 'created' ? entity.creator?.at : entity.lastEditor?.at ?? entity.creator?.at) ?? '') || 0
      return at(b) - at(a) || sequence || a.id.localeCompare(b.id)
    })
}
