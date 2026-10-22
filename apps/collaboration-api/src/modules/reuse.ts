import { requireCondition } from '@eadp/asset-domain';
import { isBuiltinScenarioMetadata } from '@eadp/contracts';
import type { AdoptRequest, AdoptionSuccessRequest, EntityView } from '@eadp/contracts';
import type { Actor } from '../auth/session.js';
import type { Transaction } from '../persistence/database.js';
import { audit, confirmation, entity, fixedVersion, getAdoption, newId, now, saveAdoption, saveEntity, setEligibility } from '../persistence/repository.js';
export { fixedVersion, versions } from '../persistence/repository.js';
export interface AdoptionRecord {
  id: string; source: AdoptRequest['source']; targetProjectId: string; targetEntityId: string; targetTaskId: string;
  scope: AdoptRequest['scope']; adjustmentSummary: string; actorId: number; acceptedAt: string;
  status: 'accepted' | 'succeeded'; targetConfirmationId?: string; targetVersion?: number; succeededAt?: string;
}
export async function eligibility(c: Transaction, projectId: string, all: EntityView[], id: string, actor: Actor, version: number, enabled: boolean, reason: string) {
  const value = await fixedVersion(c, projectId, id, version);
  requireCondition(!enabled || isBuiltinScenarioMetadata(value.metadata) || !value.metadata.applicability, 'REQUIREMENT_NOT_APPLICABLE', 'An inapplicable requirement version cannot become an adoption source');
  requireCondition(value.metadata.kind === 'scenario' || value.metadata.kind === 'requirement', 'INVALID_REUSE_SOURCE', 'Only scenario and requirement packages can be reused');
  await setEligibility(c, projectId, id, version, enabled, reason);
  value.reuse = { enabled, reason };
  const current = entity(all, id); if (current.current?.version === version) { current.current.reuse = value.reuse; await saveEntity(c, projectId, current); }
  await audit(c, projectId, actor, enabled ? 'reuse.restore' : 'reuse.disable', { entityId: id, version, reason, acceptedAt: now() });
  return value;
}
export async function adopt(c: Transaction, targetProjectId: string, all: EntityView[], actor: Actor, input: AdoptRequest): Promise<AdoptionRecord> {
  const source = await fixedVersion(c, input.source.projectId, input.source.entityId, input.source.version);
  requireCondition(source.reuse.enabled, 'REUSE_DISABLED', 'Selected source version is not eligible for new adoption', 409, { reason: source.reuse.reason });
  requireCondition(input.scope !== 'prototype-package' || source.prototypeBaselineId, 'SOURCE_BASELINE_REQUIRED', 'Prototype package adoption requires an accepted completion baseline');
  const target = entity(all, input.targetEntityId);
  requireCondition(target.occupation?.ownerId === actor.id && target.occupation.taskId === input.targetTaskId && target.kind === source.metadata.kind, 'TARGET_TASK_REQUIRED', 'Adoption must bind the current owned target task of the same asset kind');
  requireCondition(!(input.source.projectId === targetProjectId && input.source.entityId === target.id), 'SELF_ADOPTION', 'Asset cannot adopt itself');
  const value: AdoptionRecord = { id: newId(), source: input.source, targetProjectId, targetEntityId: target.id, targetTaskId: input.targetTaskId, scope: input.scope, adjustmentSummary: input.adjustmentSummary, actorId: actor.id, acceptedAt: now(), status: 'accepted' };
  await saveAdoption(c, value);
  await audit(c, targetProjectId, actor, 'reuse.adopt', { adoptionId: value.id, source: value.source }); return value;
}
export async function adoptionSuccess(c: Transaction, projectId: string, id: string, actor: Actor, input: AdoptionSuccessRequest): Promise<AdoptionRecord> {
  const value = await getAdoption(c, projectId, id);
  const accepted = await confirmation(c, projectId, input.targetConfirmationId);
  requireCondition(accepted.event.entityId === value.targetEntityId, 'TARGET_CONFIRMATION_REQUIRED', 'Target confirmation must identify the adopted target');
  requireCondition(value.scope !== 'prototype-package' || accepted.stage === 'prototype', 'TARGET_BASELINE_REQUIRED', 'Prototype adoption succeeds only after accepted prototype completion');
  const target = await fixedVersion(c, projectId, value.targetEntityId, accepted.event.version);
  requireCondition(target.metadata.sources.some(s => s.projectId === value.source.projectId && s.entityId === value.source.entityId && s.version === value.source.version), 'SOURCE_EVIDENCE_REQUIRED', 'Accepted target material must retain the exact adopted source');
  value.status = 'succeeded'; value.targetConfirmationId = input.targetConfirmationId; value.targetVersion = target.version; value.succeededAt = now();
  await saveAdoption(c, value);
  await audit(c, projectId, actor, 'reuse.succeeded', { adoptionId: id, targetConfirmationId: input.targetConfirmationId }); return value;
}
