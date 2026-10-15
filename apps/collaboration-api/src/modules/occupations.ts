import { canonical, prototypeBindings, requireCondition } from '@eadp/asset-domain';
import type { ClaimRequest, EntityView, OccupationToken, OccupationView, ReleaseRequest, UpdateRelationsRequest } from '@eadp/contracts';
import { validatePrerequisites } from '@eadp/asset-domain';
import type { Actor } from '../auth/gitlab.js';
import type { Transaction } from '../persistence/database.js';
import { audit, entity, newId, now, saveEntity } from '../persistence/repository.js';

export function assertOccupation(value: EntityView, token: OccupationToken, actor: Actor, allowAdmin = false): OccupationView {
  const occupation = value.occupation;
  requireCondition(occupation && (occupation.ownerId === actor.id || allowAdmin) && occupation.occupationId === token.occupationId && occupation.generation === token.generation && occupation.taskId === token.taskId && occupation.clientId === token.clientId && value.revision === token.expectedRevision, 'STALE_OCCUPATION', 'Current occupation, owner, task, client and revision must match');
  return occupation;
}
export function assertNotFrozen(value: EntityView) { requireCondition(value.frozenBy.length === 0, 'SCENARIO_FROZEN', 'Entity is frozen by an active scenario batch', 409, { batches: value.frozenBy }); }
export async function claim(c: Transaction, projectId: string, all: EntityView[], id: string, actor: Actor, input: ClaimRequest): Promise<EntityView> {
  const value = entity(all, id);
  requireCondition(value.revision === input.expectedRevision, 'REVISION_CONFLICT', 'Entity revision has changed');
  requireCondition(!value.occupation, 'ALREADY_OCCUPIED', 'Entity already has an active persistent occupation');
  assertNotFrozen(value);
  const related = all.filter(e => e.kind === 'requirement' && e.scenarioIds.includes(id));
  requireCondition(input.purpose !== 'scenario-batch' || value.kind === 'scenario', 'INVALID_PURPOSE', 'Scenario batch requires a scenario', 422);
  requireCondition(!(value.kind === 'scenario' && related.length > 0 && input.purpose !== 'scenario-batch'), 'BATCH_REQUIRED', 'A scenario with related requirements must use a scenario batch');
  for (const scenarioId of value.scenarioIds) requireCondition(!entity(all, scenarioId).occupation, 'SCENARIO_FROZEN', 'A related scenario is being edited');
  if (input.purpose === 'scenario-batch') {
    for (const requirement of related) { assertNotFrozen(requirement); requireCondition(!requirement.occupation, 'RELATED_REQUIREMENT_BUSY', 'A related requirement has an unfinished task', 409, { entityId: requirement.id }); }
  }
  const bindings = input.purpose === 'prototype' ? prototypeBindings(value, all) : [];
  value.revision++; value.generation++; value.taskStatus = 'active';
  const occupation: OccupationView = { occupationId: newId(), generation: value.generation, taskId: input.taskId, clientId: input.clientId, expectedRevision: value.revision, entityId: id, ownerId: actor.id, purpose: input.purpose, inputVersion: value.materialVersion, prerequisiteBindings: bindings, createdAt: now() };
  value.occupation = occupation;
  await c.query('INSERT INTO studio_occupations(id,project_id,entity_id,generation,owner_id,data) VALUES($1,$2,$3,$4,$5,$6)', [occupation.occupationId, projectId, id, occupation.generation, actor.id, occupation]);
  if (input.purpose === 'scenario-batch') for (const requirement of related) { requirement.frozenBy.push(occupation.occupationId); await saveEntity(c, projectId, requirement); }
  await saveEntity(c, projectId, value);
  return value;
}
export async function release(c: Transaction, projectId: string, all: EntityView[], id: string, actor: Actor, input: ReleaseRequest, admin: boolean): Promise<EntityView> {
  const value = entity(all, id);
  requireCondition(!admin || actor.admin, 'ADMIN_REQUIRED', 'Backend administrator permission is required', 403);
  const occupation = assertOccupation(value, input.token, actor, admin);
  await finishOccupation(c, projectId, all, value, 'aborted');
  await c.query("UPDATE studio_integrations SET status='aborted', data=jsonb_set(data,'{status}','\"aborted\"') WHERE project_id=$1 AND status='prepared' AND data->>'occupationId'=$2", [projectId, occupation.occupationId]);
  await audit(c, projectId, actor, admin ? 'occupation.admin-release' : 'occupation.cancel', { entityId: id, occupationId: occupation.occupationId, generation: occupation.generation, reason: input.reason });
  return value;
}
export async function finishOccupation(c: Transaction, projectId: string, all: EntityView[], value: EntityView, status: 'aborted' | 'completed') {
  const id = value.occupation?.occupationId;
  requireCondition(id, 'STALE_OCCUPATION', 'Occupation is no longer active');
  await c.query('UPDATE studio_occupations SET active=false WHERE id=$1 AND active', [id]);
  for (const other of all) if (other.frozenBy.includes(id)) { other.frozenBy = other.frozenBy.filter(x => x !== id); await saveEntity(c, projectId, other); }
  delete value.occupation; value.revision++; value.taskStatus = status;
  await saveEntity(c, projectId, value);
}
export function checkBoundInputs(value: EntityView, all: EntityView[]) {
  const occupation = value.occupation;
  requireCondition(occupation && occupation.inputVersion === value.materialVersion, 'INPUT_CHANGED', 'Task material input has changed');
  if (occupation.purpose === 'prototype') requireCondition(canonical(prototypeBindings(value, all)) === canonical(occupation.prerequisiteBindings), 'PREREQUISITE_CHANGED', 'Bound prerequisite completion evidence has changed');
  for (const scenarioId of value.scenarioIds) requireCondition(!entity(all, scenarioId).occupation, 'SCENARIO_FROZEN', 'A related scenario is being edited');
}
export async function updateRelations(c: Transaction, projectId: string, all: EntityView[], id: string, actor: Actor, input: UpdateRelationsRequest) {
  const value = entity(all, id); const occupation = assertOccupation(value, input.token, actor);
  requireCondition(occupation.purpose === 'design' && value.kind === 'requirement', 'DESIGN_OCCUPATION_REQUIRED', 'Requirement relations require a design occupation');
  assertNotFrozen(value); validatePrerequisites(id, input.prerequisites, all);
  for (const sceneId of new Set([...value.scenarioIds, ...input.scenarioIds])) { const scene = entity(all, sceneId); requireCondition(scene.kind === 'scenario' && !scene.occupation, 'SCENARIO_FROZEN', 'Source and target scenarios must be available'); scene.associationRevision++; await saveEntity(c, projectId, scene); }
  value.scenarioIds = input.scenarioIds; value.prerequisites = input.prerequisites; value.revision++; value.confirmationStatus = 'draft'; occupation.expectedRevision = value.revision;
  await saveEntity(c, projectId, value); return value;
}
