import { requireCondition } from '@eadp/asset-domain';
import type { ClaimRequest, EntityView, OccupationToken, OccupationView, ReleaseRequest, UpdateRelationsRequest } from '@eadp/contracts';
import { validatePrerequisites } from '@eadp/asset-domain';
import { finishOccupationRepairs } from './repairs.js';
import type { Actor } from '../auth/session.js';
import type { Transaction } from '../persistence/database.js';
import { abortIntegrations, audit, entity, fixedVersion, newId, now, saveEntity, saveOccupation, updateOccupation } from '../persistence/repository.js';

export function assertOccupation(value: EntityView, token: OccupationToken, actor: Actor, allowAdmin = false): OccupationView {
  const occupation = value.occupation;
  requireCondition(occupation && (occupation.ownerId === actor.id || allowAdmin) && occupation.occupationId === token.occupationId && occupation.generation === token.generation && occupation.taskId === token.taskId && occupation.clientId === token.clientId && value.revision === token.expectedRevision, 'STALE_OCCUPATION', 'Current occupation, owner, task, client and revision must match');
  return occupation;
}
export async function claim(c: Transaction, projectId: string, all: EntityView[], id: string, actor: Actor, input: ClaimRequest): Promise<EntityView> {
  const value = entity(all, id);
  requireCondition(!value.builtinKey, 'BUILTIN_SCENARIO_IMMUTABLE', 'The built-in general scenario cannot be occupied or edited', 409);
  requireCondition(value.revision === input.expectedRevision, 'REVISION_CONFLICT', 'Entity revision has changed');
  requireCondition(!value.occupation, 'ALREADY_OCCUPIED', 'Entity already has an active persistent occupation');
  value.revision++; value.generation++; value.taskStatus = 'active';
  const occupation: OccupationView = { occupationId: newId(), generation: value.generation, taskId: input.taskId, clientId: input.clientId, expectedRevision: value.revision, entityId: id, ownerId: actor.id, purpose: input.purpose, inputVersion: value.materialVersion, createdAt: now() };
  value.occupation = occupation;
  await saveOccupation(c, projectId, occupation);
  await saveEntity(c, projectId, value);
  return value;
}
export async function release(c: Transaction, projectId: string, all: EntityView[], id: string, actor: Actor, input: ReleaseRequest, admin: boolean): Promise<EntityView> {
  const value = entity(all, id);
  requireCondition(!admin || actor.admin, 'ADMIN_REQUIRED', 'Backend administrator permission is required', 403);
  const occupation = assertOccupation(value, input.token, actor, admin);
  await finishOccupation(c, projectId, all, value, 'aborted', actor);
  await abortIntegrations(c, projectId, occupation.occupationId);
  await audit(c, projectId, actor, admin ? 'occupation.admin-release' : 'occupation.cancel', { entityId: id, occupationId: occupation.occupationId, generation: occupation.generation, reason: input.reason });
  return value;
}
export async function finishOccupation(c: Transaction, projectId: string, all: EntityView[], value: EntityView, status: 'aborted' | 'completed', actor: Actor) {
  const id = value.occupation?.occupationId;
  requireCondition(id, 'STALE_OCCUPATION', 'Occupation is no longer active');
  await finishOccupationRepairs(c, projectId, id, actor, status === 'aborted' ? 'occupation-ended' : 'completed');
  await updateOccupation(c, projectId, id, false, status);
  delete value.occupation; value.revision++; value.taskStatus = status;
  await saveEntity(c, projectId, value);
}
export function checkBoundInputs(value: EntityView, all: EntityView[]) {
  const occupation = value.occupation;
  requireCondition(occupation && occupation.inputVersion === value.materialVersion, 'INPUT_CHANGED', 'Task material input has changed');
}
export async function updateRelations(c: Transaction, projectId: string, all: EntityView[], id: string, actor: Actor, input: UpdateRelationsRequest) {
  const value = entity(all, id); const occupation = assertOccupation(value, input.token, actor);
  requireCondition(!value.builtinKey, 'BUILTIN_SCENARIO_IMMUTABLE', 'The built-in general scenario cannot be occupied or edited', 409);
  requireCondition(occupation.purpose === 'design' && value.kind === 'requirement', 'DESIGN_OCCUPATION_REQUIRED', 'Requirement relations require a design occupation');
  validatePrerequisites(id, input.prerequisites, all);
  requireCondition(input.scenarioIds.length > 0, 'SCENARIO_SOURCE_REQUIRED', 'A requirement must retain at least one confirmed scenario source');
  requireCondition(input.sources.length === input.scenarioIds.length && new Set(input.sources.map(source => source.entityId)).size === input.sources.length, 'SCENARIO_SOURCE_REQUIRED', 'Every related scenario requires exactly one fixed source');
  for (const source of input.sources) {
    requireCondition(source.projectId === projectId && input.scenarioIds.includes(source.entityId), 'SCENARIO_SOURCE_REQUIRED', 'Requirement sources must identify related scenarios in the same project');
    const scenario = entity(all, source.entityId);
    requireCondition(scenario.kind === 'scenario', 'SCENARIO_SOURCE_REQUIRED', 'Requirement sources must identify scenarios');
    await fixedVersion(c, projectId, source.entityId, source.version);
  }
  for (const sceneId of new Set([...value.scenarioIds, ...input.scenarioIds])) { const scene = entity(all, sceneId); requireCondition(scene.kind === 'scenario', 'SCENARIO_SOURCE_REQUIRED', 'Requirement sources must identify scenarios'); }
  value.scenarioIds = input.scenarioIds; value.scenarioSources = input.sources; value.prerequisites = input.prerequisites; value.revision++; value.confirmationStatus = 'draft'; occupation.expectedRevision = value.revision;
  await saveEntity(c, projectId, value); return value;
}
