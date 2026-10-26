import type { EntityView, MaterialMetadata } from '../../shared/studio.ts'

/** Scenario choices available while editing an existing requirement's ordinary relations. */
export const ordinaryScenarioSources = (entities: EntityView[]): EntityView[] => entities.filter(entity => entity.kind === 'scenario' && entity.materialVersion > 0 && !entity.builtinKey)

/** Changing ordinary relations preserves builtin attribution selected when the requirement was created. */
export function updateScenarioSources(metadata: MaterialMetadata, selectedIds: string[], entities: EntityView[], projectId: string): Pick<MaterialMetadata, 'scenarioIds' | 'sources'> {
  const allowed = new Set(ordinaryScenarioSources(entities).map(entity => entity.id))
  const ordinaryIds = selectedIds.filter(id => allowed.has(id))
  const retained = new Set([...ordinaryIds, ...metadata.scenarioIds.filter(id => entities.some(entity => entity.id === id && entity.builtinKey))])
  const scenarioIds = [...metadata.scenarioIds.filter(id => retained.has(id)), ...ordinaryIds.filter(id => !metadata.scenarioIds.includes(id))]
  return { scenarioIds, sources: scenarioIds.map(entityId => metadata.sources.find(source => source.entityId === entityId) ?? { projectId, entityId, version: entities.find(entity => entity.id === entityId)!.materialVersion }) }
}

/** Removes one relation only on the author's explicit action, preserving every other fixed source. */
export const removeScenarioSource = (metadata: MaterialMetadata, entityId: string): Pick<MaterialMetadata, 'scenarioIds' | 'sources'> => ({ scenarioIds: metadata.scenarioIds.filter(id => id !== entityId), sources: metadata.sources.filter(source => source.entityId !== entityId) })
