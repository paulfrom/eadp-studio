import { canonical, requireCondition, validatePrerequisites } from '@eadp/asset-domain';
import { createHash } from 'node:crypto';
import { reviewInputText } from '@eadp/contracts';
import type { BaselineView, ConfirmationEvent, ConfirmationInput, EntityView, FixedVersion, IntegrationView, MaterialMetadata, PrepareIntegrationRequest, ProjectView } from '@eadp/contracts';
import type { Actor } from '../auth/session.js';
import type { Transaction } from '../persistence/database.js';
import * as repository from '../persistence/repository.js';
import { assertOccupation, checkBoundInputs, finishOccupation } from './occupations.js';
import { assertRepairConfirmation, completeRepair } from './repairs.js';

/** Prepared integrations retain recovery controls; fixed business material is read from Git. */
export interface StoredIntegration extends IntegrationView { occupationId?: string; request: PrepareIntegrationRequest }
export type VerifiedMaterials = Map<string, MaterialMetadata>;

type MaterialRequest = Exclude<PrepareIntegrationRequest, { stage: 'template' }>;
function materialFor(input: ConfirmationInput, materials: VerifiedMaterials): MaterialMetadata {
  const metadata = materials.get(input.entityId);
  requireCondition(metadata, 'FIXED_MATERIAL_UNVERIFIED', 'Confirmation requires material verified from the exact candidate');
  requireCondition(metadata.entityId === input.entityId, 'CONFIRMATION_IDENTITY_MISMATCH', 'Fixed material identity must match the confirmation');
  return metadata;
}
function validateSources(project: ProjectView, value: EntityView, all: EntityView[], metadata: MaterialMetadata): void {
  requireCondition(!metadata.sources.some(s => s.projectId === project.id && s.entityId === value.id), 'SELF_REFERENCE', 'Asset source cannot reference itself');
  if (value.kind !== 'requirement') return;
  requireCondition(metadata.scenarioIds.length > 0, 'SCENARIO_SOURCE_REQUIRED', 'A requirement must bind at least one confirmed scenario version');
  const scenarioSources = metadata.sources.filter(source => source.projectId === project.id && metadata.scenarioIds.includes(source.entityId));
  requireCondition(scenarioSources.length === metadata.scenarioIds.length && new Set(scenarioSources.map(source => source.entityId)).size === scenarioSources.length, 'SCENARIO_SOURCE_REQUIRED', 'Every related scenario requires exactly one fixed source version');
  for (const source of scenarioSources) {
    const scenario = repository.entity(all, source.entityId);
    requireCondition(scenario.kind === 'scenario' && source.version <= scenario.materialVersion && source.version > 0, 'SCENARIO_VERSION_MISMATCH', 'Requirement source must bind an accepted scenario version');
  }
}
function validateConfirmation(project: ProjectView, all: EntityView[], prospective: EntityView[], root: EntityView, input: MaterialRequest, confirmation: ConfirmationInput, materials: VerifiedMaterials): void {
  const value = repository.entity(prospective, confirmation.entityId), metadata = materialFor(confirmation, materials);
  requireCondition(confirmation.readHash === confirmation.fixed.sha256, 'READ_VERSION_MISMATCH', 'Confirmation must bind the exact final material hash');
  if (confirmation.confirmationMethod === 'ai-assisted') {
    requireCondition(confirmation.reviewEvidence.candidateSha === input.candidateSha, 'REVIEW_CANDIDATE_MISMATCH', 'AI review must bind the exact author-confirmed candidate');
    requireCondition(confirmation.reviewEvidence.inputHash === createHash('sha256').update(reviewInputText(input, root)).digest('hex'), 'REVIEW_INPUT_MISMATCH', 'AI review must bind the exact confirmed input and control context');
  }
  requireCondition(value.revision === confirmation.expectedRevision && metadata.kind === value.kind, 'CONFIRMATION_REVISION_CONFLICT', 'Confirmation entity, kind and revision must match');
  requireCondition(!metadata.applicability || value.kind === 'requirement', 'INVALID_APPLICABILITY', 'Only a requirement may be marked not applicable', 422);
  if (value.kind === 'scenario' || value.kind === 'requirement') requireCondition(value.templateId === metadata.templateId && canonical(value.templateRef) === canonical(metadata.templateRef), 'TEMPLATE_BINDING_CHANGED', 'Material confirmation must bind its selected fixed template');
  if (input.stage === 'prototype') {
    requireCondition(value.current && value.completedVersion !== value.materialVersion && canonical(value.current.metadata) === canonical(metadata) && canonical(value.current.fixed) === canonical(confirmation.fixed), 'PROTOTYPE_INPUT_CHANGED', 'Prototype completion must bind its confirmed requirement material');
  } else {
    if (value.kind !== 'requirement') requireCondition(metadata.prerequisites.length === 0 && metadata.scenarioIds.length === 0, 'INVALID_RELATIONS', 'Only requirements may declare scenarios and prerequisites', 422);
    for (const scenarioId of metadata.scenarioIds) {
      const scenario = repository.entity(prospective, scenarioId);
      requireCondition(scenario.kind === 'scenario', 'SCENARIO_SOURCE_REQUIRED', 'Requirement sources must identify scenarios');
    }
    value.scenarioIds = metadata.scenarioIds; value.prerequisites = metadata.prerequisites;
  }
  validateSources(project, value, all, metadata);
  for (const reference of metadata.referencedAssets) {
    requireCondition(reference.projectId === project.id && reference.entityId !== value.id, 'INVALID_MANIFEST_REFERENCE', 'Manifest references must identify other fixed assets in this project');
    const referenced = repository.entity(all, reference.entityId);
    requireCondition(reference.version > 0 && reference.version <= referenced.materialVersion, 'FIXED_REFERENCE_UNAVAILABLE', 'Manifest fixed version is not currently available');
    if (value.kind === 'baseline' || value.kind === 'handoff') requireCondition(referenced.completions?.some(completion => completion.version === reference.version), 'COMPLETED_REFERENCE_REQUIRED', 'Baseline and handoff manifests can only aggregate accepted completed requirements');
  }
  if (value.kind === 'baseline' || value.kind === 'handoff') requireCondition(metadata.referencedAssets.length > 0, 'EMPTY_MANIFEST', 'Baseline and handoff require accepted fixed references');
}
export function validateIntegration(project: ProjectView, all: EntityView[], actor: Actor, input: PrepareIntegrationRequest, materials: VerifiedMaterials): EntityView | undefined {
  requireCondition(project.recognizedHead === input.expectedHead, 'INTEGRATION_HEAD_CHANGED', 'Recognized integration head changed; rebuild and recheck the candidate');
  if (input.stage === 'template') {
    requireCondition(project.revision === input.expectedProjectRevision, 'REVISION_CONFLICT', 'Project revision changed; preview the template changes again');
    return;
  }
  const root = repository.entity(all, input.entityId), occupation = assertOccupation(root, input.token, actor);
  requireCondition(input.stage === 'prototype' ? occupation.purpose === 'prototype' : occupation.purpose === 'design', 'OCCUPATION_PURPOSE_MISMATCH', 'Integration stage does not match occupation purpose');
  checkBoundInputs(root, all);
  requireCondition(input.confirmations.length === 1 && input.confirmations[0]!.entityId === root.id, 'SINGLE_ENTITY_REQUIRED', 'Integration confirms exactly its occupied entity', 422);
  const prospective = structuredClone(all);
  for (const confirmation of input.confirmations) validateConfirmation(project, all, prospective, root, input, confirmation, materials);
  for (const value of prospective) if (value.kind === 'requirement') validatePrerequisites(value.id, value.prerequisites, prospective);
  return root;
}
async function validateRepairs(c: Transaction, projectId: string, all: EntityView[], input: PrepareIntegrationRequest, actor: Actor) {
  if (input.stage === 'template') return;
  for (const confirmation of input.confirmations) if (confirmation.confirmationMethod === 'ai-repair') await assertRepairConfirmation(c, projectId, repository.entity(all, confirmation.entityId), confirmation, actor);
}
export async function prepare(c: Transaction, project: ProjectView, all: EntityView[], actor: Actor, input: PrepareIntegrationRequest, materials: VerifiedMaterials): Promise<IntegrationView> {
  const root = validateIntegration(project, all, actor, input, materials);
  await validateRepairs(c, project.id, all, input, actor);
  requireCondition(!(await repository.listIntegrations(c, project.id)).some(operation => operation.status === 'prepared'), 'INTEGRATION_PENDING', 'An integration is pending; query and reconcile it before accepting another');
  const operation: StoredIntegration = { id: repository.newId(), ...(root ? { entityId: root.id, occupationId: root.occupation!.occupationId } : {}), ownerId: actor.id, status: 'prepared', sourceSha: input.sourceSha, expectedHead: input.expectedHead, candidateSha: input.candidateSha, stage: input.stage, createdAt: repository.now(), request: input };
  await repository.saveIntegration(c, project.id, operation);
  return publicIntegration(operation);
}
export function publicIntegration(value: StoredIntegration): IntegrationView {
  const { request: _request, occupationId: _occupationId, ...view } = value; return view;
}
export const getIntegration = repository.getIntegration;
async function confirmMaterial(c: Transaction, projectId: string, value: EntityView, input: ConfirmationInput, metadata: MaterialMetadata, actor: Actor, occupied: boolean, integrationId: string): Promise<ConfirmationEvent> {
  const event: ConfirmationEvent = { id: repository.newId(), projectId, entityId: value.id, version: value.materialVersion + 1, fixed: input.fixed, revision: value.revision + 1, confirmedBy: actor.id, confirmedAt: repository.now() };
  const version: FixedVersion = { version: event.version, fixed: input.fixed, metadata, title: metadata.title, summary: metadata.summary ?? '', readHash: input.readHash, applicability: metadata.applicability ? 'not-applicable' : 'applicable', ...(metadata.applicability ? { applicabilityReason: metadata.applicability.reason } : {}), confirmationId: event.id, confirmedBy: actor.id, confirmedAt: event.confirmedAt, reuse: { enabled: (value.kind === 'scenario' || value.kind === 'requirement') && !metadata.applicability, reason: metadata.applicability?.reason ?? 'Confirmed material accepted' } };
  value.materialVersion = version.version; value.current = version; value.title = metadata.title; value.summary = metadata.summary ?? ''; value.scenarioIds = metadata.scenarioIds; value.scenarioSources = metadata.sources.filter(source => source.projectId === projectId && metadata.scenarioIds.includes(source.entityId)); value.prerequisites = metadata.prerequisites; value.confirmationStatus = 'confirmed'; if (!occupied) value.revision++;
  await repository.saveConfirmation(c, projectId, { event, version, method: input, stage: 'material', integrationId });
  await repository.saveEntity(c, projectId, value); return event;
}
async function completePrototype(c: Transaction, project: ProjectView, root: EntityView, actor: Actor, operation: StoredIntegration, input: MaterialRequest): Promise<string> {
  const eventId = repository.newId(), baseline: BaselineView = { id: repository.newId(), entityId: root.id, version: root.materialVersion, commitSha: input.candidateSha, confirmationId: eventId, createdAt: repository.now() };
  const confirmation = input.confirmations[0]!;
  await repository.saveConfirmation(c, project.id, { event: { id: eventId, projectId: project.id, entityId: root.id, version: root.materialVersion, fixed: confirmation.fixed, revision: root.revision + 1, confirmedBy: actor.id, confirmedAt: repository.now() }, baseline, method: confirmation, stage: 'prototype', integrationId: operation.id });
  await repository.insertBaseline(c, project.id, baseline);
  root.completions = [...(root.completions ?? []), { version: root.materialVersion, confirmationId: eventId, integrationSha: input.candidateSha, baselineId: baseline.id }];
  root.completedVersion = root.materialVersion; root.current!.prototypeBaselineId = baseline.id; root.completionConfirmationId = eventId; root.completedIntegrationSha = input.candidateSha;
  project.currentBaselineId = baseline.id; operation.baselineId = baseline.id;
  return eventId;
}
export async function complete(c: Transaction, project: ProjectView, all: EntityView[], actor: Actor, operation: StoredIntegration, materials: VerifiedMaterials): Promise<IntegrationView> {
  requireCondition(operation.status === 'prepared', 'INTEGRATION_NOT_PENDING', 'Integration is not pending');
  requireCondition(operation.ownerId === actor.id, 'INTEGRATION_OWNER_REQUIRED', 'Only the integration author can complete the prepared operation', 403);
  const input = operation.request, root = validateIntegration(project, all, actor, input, materials);
  await validateRepairs(c, project.id, all, input, actor);
  const ids: string[] = [];
  if (input.stage !== 'template') {
    requireCondition(root, 'ROOT_CONFIRMATION_REQUIRED', 'Material integration requires its occupied entity');
    if (input.stage === 'prototype') ids.push(await completePrototype(c, project, root, actor, operation, input));
    else {
      const confirmation = input.confirmations[0]!;
      const value = repository.entity(all, confirmation.entityId);
      const event = await confirmMaterial(c, project.id, value, confirmation, materialFor(confirmation, materials), actor, value.id === root.id, operation.id); ids.push(event.id);
      if (confirmation.confirmationMethod === 'ai-repair') await completeRepair(c, confirmation.repairTaskId, actor);
    }
    await finishOccupation(c, project.id, all, root, 'completed', actor);
  }
  operation.status = 'accepted'; if (input.stage !== 'template') operation.confirmationIds = ids;
  await repository.saveIntegration(c, project.id, operation);
  project.recognizedHead = input.candidateSha; project.revision++;
  await repository.saveProject(c, project);
  return publicIntegration(operation);
}
