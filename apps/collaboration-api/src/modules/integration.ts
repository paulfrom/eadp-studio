import { canonical, requireCondition, validatePrerequisites } from '@eadp/asset-domain';
import type { BaselineView, ConfirmationEvent, ConfirmationInput, EntityView, FixedVersion, IntegrationView, PrepareIntegrationRequest, ProjectView } from '@eadp/contracts';
import type { Actor } from '../auth/session.js';
import type { Transaction } from '../persistence/database.js';
import { entity, newId, now, saveEntity, saveProject } from '../persistence/repository.js';
import { assertNotFrozen, assertOccupation, checkBoundInputs, finishOccupation } from './occupations.js';

export interface StoredIntegration extends IntegrationView { occupationId: string; request: PrepareIntegrationRequest }
export function validateIntegration(project: ProjectView, all: EntityView[], actor: Actor, input: PrepareIntegrationRequest) {
  const root = entity(all, input.entityId), occupation = assertOccupation(root, input.token, actor);
  requireCondition(project.recognizedHead === input.expectedHead, 'INTEGRATION_HEAD_CHANGED', 'Recognized integration head changed; rebuild and recheck the candidate');
  requireCondition(input.confirmations.length === new Set(input.confirmations.map(x => x.entityId)).size, 'DUPLICATE_CONFIRMATION', 'Batch contains duplicate entity confirmations', 422);
  requireCondition(input.confirmations.some(x => x.entityId === root.id), 'ROOT_CONFIRMATION_REQUIRED', 'Integration must confirm its occupied entity', 422);
  requireCondition(input.stage === 'scenario-batch' ? occupation.purpose === 'scenario-batch' : input.stage === 'prototype' ? occupation.purpose === 'prototype' : occupation.purpose === 'design', 'OCCUPATION_PURPOSE_MISMATCH', 'Integration stage does not match occupation purpose');
  if (input.stage !== 'scenario-batch') { assertNotFrozen(root); checkBoundInputs(root, all); requireCondition(input.confirmations.length === 1, 'SINGLE_ENTITY_REQUIRED', 'Ordinary integration can only confirm the occupied entity'); }
  else {
    requireCondition(input.expectedAssociationRevision === root.associationRevision, 'ASSOCIATION_REVISION_CONFLICT', 'Scenario association set has changed');
    const frozen = all.filter(e => e.frozenBy.includes(occupation.occupationId));
    requireCondition(canonical(frozen.map(x => x.id).sort()) === canonical([...(input.batchRequirementIds ?? [])].sort()), 'INCOMPLETE_SCENARIO_BATCH', 'Scenario batch must declare its complete frozen requirement set');
    for (const requirement of frozen) {
      const changing = input.confirmations.some(x => x.entityId === requirement.id);
      if (requirement.completedVersion === requirement.materialVersion && requirement.materialVersion > 0) requireCondition(!changing, 'COMPLETED_REQUIREMENT_IMMUTABLE', 'Completed requirements must be preserved; derive a new requirement for changed scope');
      else requireCondition(changing, 'INCOMPLETE_SCENARIO_BATCH', 'Every unstarted related requirement must be confirmed atomically in the batch');
    }
    requireCondition(input.confirmations.every(x => x.entityId === root.id || frozen.some(e => e.id === x.entityId)), 'BATCH_ENTITY_SCOPE', 'Batch can only modify the scenario and its frozen requirements');
  }
  const prospective = structuredClone(all);
  for (const confirmation of input.confirmations) {
    const value = entity(prospective, confirmation.entityId), metadata = confirmation.metadata;
    requireCondition(value.revision === confirmation.expectedRevision && metadata.entityId === value.id && metadata.kind === value.kind, 'CONFIRMATION_REVISION_CONFLICT', 'Confirmation entity, kind and revision must match');
    requireCondition(!metadata.applicability || value.kind === 'requirement', 'INVALID_APPLICABILITY', 'Only a requirement may be marked not applicable', 422);
    requireCondition(project.categories.some(c => c.id === metadata.categoryId), 'CATEGORY_NOT_FOUND', 'Choose an existing project category');
    if (input.stage === 'prototype') {
      requireCondition(value.current && value.completedVersion !== value.materialVersion && canonical(value.current.metadata) === canonical(metadata) && value.current.fixed.sha256 === confirmation.fixed.sha256, 'PROTOTYPE_INPUT_CHANGED', 'Prototype completion must bind its confirmed requirement material');
    } else {
      if (value.kind !== 'requirement') requireCondition(metadata.prerequisites.length === 0 && metadata.scenarioIds.length === 0, 'INVALID_RELATIONS', 'Only requirements may declare scenarios and prerequisites', 422);
      for (const scenarioId of metadata.scenarioIds) {
        const scenario = entity(prospective, scenarioId);
        requireCondition(scenario.kind === 'scenario' && (!scenario.occupation || (input.stage === 'scenario-batch' && scenario.id === root.id)), 'SCENARIO_FROZEN', 'Related scenario is unavailable');
      }
      value.scenarioIds = metadata.scenarioIds; value.prerequisites = metadata.prerequisites;
    }
    requireCondition(!metadata.sources.some(s => s.projectId === project.id && s.entityId === value.id), 'SELF_REFERENCE', 'Asset source cannot reference itself');
    for (const reference of metadata.referencedAssets) {
      requireCondition(reference.projectId === project.id && reference.entityId !== value.id, 'INVALID_MANIFEST_REFERENCE', 'Manifest references must identify other fixed assets in this project');
      const referenced = entity(all, reference.entityId);
      requireCondition(reference.version > 0 && reference.version <= referenced.materialVersion, 'FIXED_REFERENCE_UNAVAILABLE', 'Manifest fixed version is not currently available');
      if (value.kind === 'baseline' || value.kind === 'handoff') requireCondition(referenced.completions?.some(c => c.version === reference.version), 'COMPLETED_REFERENCE_REQUIRED', 'Baseline and handoff manifests can only aggregate accepted completed requirements');
    }
    if (value.kind === 'baseline' || value.kind === 'handoff') requireCondition(metadata.referencedAssets.length > 0, 'EMPTY_MANIFEST', 'Baseline and handoff require accepted fixed references');
  }
  for (const value of prospective) if (value.kind === 'requirement') validatePrerequisites(value.id, value.prerequisites, prospective);
  return root;
}
export async function prepare(c: Transaction, project: ProjectView, all: EntityView[], actor: Actor, input: PrepareIntegrationRequest): Promise<IntegrationView> {
  const root = validateIntegration(project, all, actor, input);
  requireCondition((await c.query("SELECT id FROM studio_integrations WHERE project_id=$1 AND status='prepared'", [project.id])).rowCount === 0, 'INTEGRATION_PENDING', 'An integration is pending; query and reconcile it before accepting another');
  const operation: StoredIntegration = { id: newId(), entityId: root.id, ownerId: actor.id, status: 'prepared', sourceSha: input.sourceSha, expectedHead: input.expectedHead, candidateSha: input.candidateSha, stage: input.stage, createdAt: now(), occupationId: input.token.occupationId, request: input };
  await c.query('INSERT INTO studio_integrations(id,project_id,status,data) VALUES($1,$2,$3,$4)', [operation.id, project.id, operation.status, operation]);
  return publicIntegration(operation);
}
export function publicIntegration(value: StoredIntegration): IntegrationView {
  const { request: _request, occupationId: _occupationId, ...view } = value; return view;
}
export async function getIntegration(c: Transaction, projectId: string, id: string): Promise<StoredIntegration> {
  const result = (await c.query<{ data: StoredIntegration }>('SELECT data FROM studio_integrations WHERE project_id=$1 AND id=$2', [projectId, id])).rows[0];
  requireCondition(result, 'INTEGRATION_NOT_FOUND', 'Integration operation was not found', 404); return result.data;
}
async function confirmMaterial(c: Transaction, projectId: string, value: EntityView, input: ConfirmationInput, actor: Actor, occupied: boolean): Promise<ConfirmationEvent> {
  const event: ConfirmationEvent = { id: newId(), projectId, entityId: value.id, version: value.materialVersion + 1, fixed: input.fixed, revision: value.revision + 1, confirmedBy: actor.id, confirmedAt: now() };
  const version: FixedVersion = { version: event.version, fixed: input.fixed, metadata: input.metadata, confirmationId: event.id, confirmedBy: actor.id, confirmedAt: event.confirmedAt, reuse: { enabled: (value.kind === 'scenario' || value.kind === 'requirement') && !input.metadata.applicability, reason: input.metadata.applicability?.reason ?? 'Confirmed material accepted' } };
  value.materialVersion = version.version; value.current = version; value.title = input.metadata.title; value.categoryId = input.metadata.categoryId; value.scenarioIds = input.metadata.scenarioIds; value.prerequisites = input.metadata.prerequisites; value.confirmationStatus = 'confirmed'; if (!occupied) value.revision++;
  await c.query("INSERT INTO studio_confirmations(id,project_id,entity_id,version,stage,data) VALUES($1,$2,$3,$4,'material',$5)", [event.id, projectId, value.id, version.version, { event, version, method: input.confirmationMethod }]);
  await c.query('INSERT INTO studio_eligibility(project_id,entity_id,version,enabled,reason) VALUES($1,$2,$3,$4,$5)', [projectId, value.id, version.version, version.reuse.enabled, version.reuse.reason]);
  await saveEntity(c, projectId, value); return event;
}
export async function complete(c: Transaction, project: ProjectView, all: EntityView[], actor: Actor, operation: StoredIntegration): Promise<IntegrationView> {
  requireCondition(operation.status === 'prepared', 'INTEGRATION_NOT_PENDING', 'Integration is not pending');
  const input = operation.request, root = validateIntegration(project, all, actor, input);
  const ids: string[] = [];
  if (input.stage === 'prototype') {
    const eventId = newId(), baseline: BaselineView = { id: newId(), entityId: root.id, version: root.materialVersion, commitSha: input.candidateSha, confirmationId: eventId, createdAt: now() };
    await c.query("INSERT INTO studio_confirmations(id,project_id,entity_id,version,stage,data) VALUES($1,$2,$3,$4,'prototype',$5)", [eventId, project.id, root.id, root.materialVersion, { event: { id: eventId, projectId: project.id, entityId: root.id, version: root.materialVersion, fixed: input.confirmations[0]!.fixed, revision: root.revision + 1, confirmedBy: actor.id, confirmedAt: now() }, baseline, method: input.confirmations[0]!.confirmationMethod }]);
    await c.query('INSERT INTO studio_baselines(id,project_id,data) VALUES($1,$2,$3)', [baseline.id, project.id, baseline]);
    root.completions = [...(root.completions ?? []), { version: root.materialVersion, confirmationId: eventId, integrationSha: input.candidateSha, baselineId: baseline.id }];
    root.completedVersion = root.materialVersion; root.current!.prototypeBaselineId = baseline.id; root.completionConfirmationId = eventId; root.completedIntegrationSha = input.candidateSha;
    project.currentBaselineId = baseline.id; operation.baselineId = baseline.id; ids.push(eventId);
  } else {
    for (const confirmation of input.confirmations) {
      const value = entity(all, confirmation.entityId), oldScenarios = value.scenarioIds;
      const event = await confirmMaterial(c, project.id, value, confirmation, actor, value.id === root.id); ids.push(event.id);
      for (const sceneId of new Set([...oldScenarios, ...value.scenarioIds])) { const scene = entity(all, sceneId); scene.associationRevision++; await saveEntity(c, project.id, scene); }
    }
  }
  await finishOccupation(c, project.id, all, root, 'completed');
  operation.status = 'accepted'; operation.confirmationIds = ids;
  await c.query('UPDATE studio_integrations SET status=$2,data=$3 WHERE id=$1', [operation.id, operation.status, operation]);
  project.recognizedHead = input.candidateSha; project.revision++;
  await saveProject(c, project);
  return publicIntegration(operation);
}
