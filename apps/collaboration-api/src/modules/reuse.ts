import { requireCondition } from '@eadp/asset-domain';
import type { AdoptRequest, AdoptionSuccessRequest, EntityView, FixedVersion } from '@eadp/contracts';
import type { Actor } from '../auth/session.js';
import type { Transaction } from '../persistence/database.js';
import { audit, entity, newId, now, saveEntity } from '../persistence/repository.js';
export interface AdoptionRecord {
  id: string; source: AdoptRequest['source']; targetProjectId: string; targetEntityId: string; targetTaskId: string;
  scope: AdoptRequest['scope']; adjustmentSummary: string; actorId: number; acceptedAt: string;
  status: 'accepted' | 'succeeded'; targetConfirmationId?: string; targetVersion?: number; succeededAt?: string;
}
export async function versions(c: Transaction, projectId: string, entityId: string): Promise<FixedVersion[]> {
  const result = await c.query<{ data: { version: FixedVersion }; enabled: boolean; reason: string }>("SELECT f.data,e.enabled,e.reason FROM studio_confirmations f JOIN studio_eligibility e USING(project_id,entity_id,version) WHERE f.project_id=$1 AND f.entity_id=$2 AND f.stage='material' ORDER BY f.version DESC", [projectId, entityId]);
  const baselines = (await c.query<{ id: string; data: { version: number } }>("SELECT id,data FROM studio_baselines WHERE project_id=$1 AND data->>'entityId'=$2", [projectId, entityId])).rows;
  return result.rows.map(row => {
    const value = row.data.version; value.reuse = { enabled: row.enabled, reason: row.reason };
    const baseline = baselines.find(b => b.data.version === value.version); if (baseline) value.prototypeBaselineId = baseline.id;
    return value;
  });
}
export async function fixedVersion(c: Transaction, projectId: string, entityId: string, version: number): Promise<FixedVersion> {
  const value = (await versions(c, projectId, entityId)).find(v => v.version === version);
  requireCondition(value, 'FIXED_VERSION_NOT_FOUND', 'Accepted fixed material version was not found', 404); return value;
}
export async function eligibility(c: Transaction, projectId: string, all: EntityView[], id: string, actor: Actor, version: number, enabled: boolean, reason: string) {
  const value = await fixedVersion(c, projectId, id, version);
  requireCondition(!enabled || !value.metadata.applicability, 'REQUIREMENT_NOT_APPLICABLE', 'An inapplicable requirement version cannot become an adoption source');
  requireCondition(value.metadata.kind === 'scenario' || value.metadata.kind === 'requirement', 'INVALID_REUSE_SOURCE', 'Only scenario and requirement packages can be reused');
  await c.query('UPDATE studio_eligibility SET enabled=$4,reason=$5 WHERE project_id=$1 AND entity_id=$2 AND version=$3', [projectId, id, version, enabled, reason]);
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
  await c.query('INSERT INTO studio_adoptions(id,source_project_id,target_project_id,data) VALUES($1,$2,$3,$4)', [value.id, value.source.projectId, targetProjectId, value]);
  await audit(c, targetProjectId, actor, 'reuse.adopt', { adoptionId: value.id, source: value.source }); return value;
}
export async function adoptionSuccess(c: Transaction, projectId: string, id: string, actor: Actor, input: AdoptionSuccessRequest): Promise<AdoptionRecord> {
  const value = (await c.query<{ data: AdoptionRecord }>('SELECT data FROM studio_adoptions WHERE id=$1 AND target_project_id=$2', [id, projectId])).rows[0]?.data;
  requireCondition(value, 'ADOPTION_NOT_FOUND', 'Adoption was not found', 404);
  const confirmation = (await c.query<{ stage: string; data: { event: { entityId: string; version: number }; version?: FixedVersion } }>('SELECT stage,data FROM studio_confirmations WHERE id=$1 AND project_id=$2', [input.targetConfirmationId, projectId])).rows[0];
  requireCondition(confirmation?.data.event.entityId === value.targetEntityId, 'TARGET_CONFIRMATION_REQUIRED', 'Target confirmation must identify the adopted target');
  requireCondition(value.scope !== 'prototype-package' || confirmation.stage === 'prototype', 'TARGET_BASELINE_REQUIRED', 'Prototype adoption succeeds only after accepted prototype completion');
  const target = await fixedVersion(c, projectId, value.targetEntityId, confirmation.data.event.version);
  requireCondition(target.metadata.sources.some(s => s.projectId === value.source.projectId && s.entityId === value.source.entityId && s.version === value.source.version), 'SOURCE_EVIDENCE_REQUIRED', 'Accepted target material must retain the exact adopted source');
  value.status = 'succeeded'; value.targetConfirmationId = input.targetConfirmationId; value.targetVersion = target.version; value.succeededAt = now();
  await c.query('UPDATE studio_adoptions SET data=$2 WHERE id=$1', [id, value]);
  await audit(c, projectId, actor, 'reuse.succeeded', { adoptionId: id, targetConfirmationId: input.targetConfirmationId }); return value;
}
