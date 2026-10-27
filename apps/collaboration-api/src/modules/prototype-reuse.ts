import { randomUUID } from 'node:crypto';
import { requireCondition } from '@eadp/asset-domain';
import type { PrototypeAdoptRequest, PrototypeAdoptionSuccessRequest } from '@eadp/contracts';
import type { Actor } from '../auth/session.js';
import type { Transaction } from '../persistence/database.js';
import * as repository from '../persistence/repository.js';
import { getTask } from './prototypes.js';

interface AdoptionRow { id: string; source_project_id: string; source_baseline_id: string; target_task_id: string; target_baseline_id: string | null; adjustment_summary: string; status: 'accepted' | 'succeeded'; creator_id: string | number; created_date: Date | string; succeeded_at: Date | string | null }
function view(row: AdoptionRow) {
  return { id: row.id, source: { projectId: row.source_project_id, baselineId: row.source_baseline_id }, targetTaskId: row.target_task_id,
    adjustmentSummary: row.adjustment_summary, status: row.status, actorId: Number(row.creator_id), acceptedAt: new Date(row.created_date).toISOString(),
    ...(row.target_baseline_id ? { targetBaselineId: row.target_baseline_id, succeededAt: new Date(row.succeeded_at!).toISOString() } : {}) };
}
async function adoption(c: Transaction, projectId: string, id: string): Promise<AdoptionRow> {
  const row = (await c.query<AdoptionRow>('SELECT * FROM studio_prototype_adoptions WHERE target_project_id=$1 AND id=$2', [projectId, id])).rows[0];
  requireCondition(row, 'ADOPTION_NOT_FOUND', 'Prototype adoption was not found', 404); return row;
}
export async function list(c: Transaction, projectId: string) {
  return (await c.query<AdoptionRow>('SELECT * FROM studio_prototype_adoptions WHERE target_project_id=$1 ORDER BY created_date,id', [projectId])).rows.map(view);
}
export async function adopt(c: Transaction, projectId: string, actor: Actor, input: PrototypeAdoptRequest) {
  const source = (await c.query('SELECT id FROM studio_prototype_baselines WHERE project_id=$1 AND id=$2', [input.source.projectId, input.source.baselineId])).rows[0];
  requireCondition(source, 'BASELINE_NOT_FOUND', 'The source prototype baseline was not found', 404);
  const task = await getTask(c, projectId, input.targetTaskId, actor);
  requireCondition(task.ownerId === actor.id && task.status === 'active', 'TARGET_TASK_REQUIRED', 'Prototype adoption belongs to the current active task', 409);
  const id = randomUUID();
  await c.query("INSERT INTO studio_prototype_adoptions(id,source_project_id,source_baseline_id,target_project_id,target_task_id,adjustment_summary,status,creator_id) VALUES($1,$2,$3,$4,$5,$6,'accepted',$7)", [id, input.source.projectId, input.source.baselineId, projectId, input.targetTaskId, input.adjustmentSummary, actor.id]);
  await repository.audit(c, projectId, actor, 'prototype.reuse.adopt', { adoptionId: id, source: input.source, targetTaskId: input.targetTaskId });
  return view(await adoption(c, projectId, id));
}
export async function success(c: Transaction, projectId: string, id: string, actor: Actor, input: PrototypeAdoptionSuccessRequest) {
  const row = await adoption(c, projectId, id);
  requireCondition(Number(row.creator_id) === actor.id, 'ADOPTION_OWNER_REQUIRED', 'Only the adoption author can record its result', 403);
  const accepted = await c.query('SELECT b.id FROM studio_prototype_baselines b JOIN studio_prototype_acceptances a ON a.id=b.acceptance_id WHERE b.project_id=$1 AND b.id=$2 AND a.task_id=$3', [projectId, input.targetBaselineId, row.target_task_id]);
  requireCondition(accepted.rowCount, 'TARGET_BASELINE_REQUIRED', 'The target baseline must be accepted from the adoption task', 409);
  await c.query("UPDATE studio_prototype_adoptions SET status='succeeded',target_baseline_id=$3,succeeded_at=clock_timestamp() WHERE target_project_id=$1 AND id=$2", [projectId, id, input.targetBaselineId]);
  await repository.audit(c, projectId, actor, 'prototype.reuse.succeeded', { adoptionId: id, targetBaselineId: input.targetBaselineId });
  return view(await adoption(c, projectId, id));
}
