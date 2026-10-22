import { requireCondition } from '@eadp/asset-domain';
import type { ConfirmationInput, EntityView, RepairEventRequest, RepairStartRequest, RepairTaskView } from '@eadp/contracts';
import type { Actor } from '../auth/session.js';
import type { Transaction } from '../persistence/database.js';
import { audit, newId } from '../persistence/repository.js';
import { assertOccupation } from './occupations.js';

interface RepairRow {
  id: string; entity_id: string; occupation_id: string; user_action_id: string; start_hash: string;
  status: RepairTaskView['status']; rounds_used: number; termination_reason: RepairTaskView['terminationReason'] | null;
  creator_id: string; created_date: Date | string; current_hash: string;
}

function view(row: RepairRow): RepairTaskView {
  return { id: row.id, entityId: row.entity_id, occupationId: row.occupation_id, userActionId: row.user_action_id,
    startHash: row.start_hash, currentHash: row.current_hash, status: row.status, roundsUsed: row.rounds_used,
    ...(row.termination_reason ? { terminationReason: row.termination_reason } : {}),
    createdBy: Number(row.creator_id), createdAt: new Date(row.created_date).toISOString() };
}

/** Load only authorization control state; local prompts, business answers and material bytes stay on the Host. */
export async function task(c: Transaction, projectId: string, id: string): Promise<RepairTaskView> {
  const row = (await c.query<RepairRow>(`SELECT t.*, COALESCE((SELECT e.hash_after FROM studio_repair_task_events e
    WHERE e.task_id=t.id AND e.hash_after IS NOT NULL ORDER BY e.seq DESC LIMIT 1),t.start_hash) AS current_hash
    FROM studio_repair_tasks t WHERE t.project_id=$1 AND t.id=$2`, [projectId, id])).rows[0];
  requireCondition(row, 'REPAIR_NOT_FOUND', 'Repair authorization was not found', 404);
  return view(row);
}

function assertOwner(value: EntityView, repair: RepairTaskView, actor: Actor) {
  requireCondition(value.id === repair.entityId && value.occupation?.occupationId === repair.occupationId && repair.createdBy === actor.id,
    'REPAIR_AUTHORITY_CHANGED', 'Repair authorization must belong to the current user and active occupation');
}

export async function start(c: Transaction, projectId: string, value: EntityView, actor: Actor, input: RepairStartRequest) {
  const occupation = assertOccupation(value, input.token, actor);
  requireCondition(value.kind === 'scenario' && !value.builtinKey && occupation.purpose === 'design',
    'REPAIR_DESIGN_REQUIRED', 'Scenario repair requires the current design occupation');
  requireCondition(!(await c.query('SELECT id FROM studio_repair_tasks WHERE project_id=$1 AND entity_id=$2 AND user_action_id=$3', [projectId, value.id, input.userActionId])).rowCount,
    'REPAIR_ACTION_REUSED', 'A new repair authorization requires a new explicit user action');
  requireCondition(!(await c.query("SELECT id FROM studio_repair_tasks WHERE project_id=$1 AND entity_id=$2 AND status IN ('active','paused')", [projectId, value.id])).rowCount,
    'REPAIR_ALREADY_ACTIVE', 'Finish or terminate the existing repair authorization first');
  requireCondition(!(await c.query("SELECT id FROM studio_integrations WHERE project_id=$1 AND status='prepared'", [projectId])).rowCount,
    'INTEGRATION_PENDING', 'Reconcile the prepared integration before starting repair');
  const id = newId();
  await c.query(`INSERT INTO studio_repair_tasks(id,project_id,entity_id,occupation_id,user_action_id,start_hash,status,
    creator_id,creator_account,creator_name,last_editor_id,last_editor_account,last_editor_name)
    VALUES($1,$2,$3,$4,$5,$6,'active',$7,$8,$9,$7,$8,$9)`,
  [id, projectId, value.id, occupation.occupationId, input.userActionId, input.startHash, actor.id, actor.username, actor.name]);
  await audit(c, projectId, actor, 'repair.authorized', { repairTaskId: id, entityId: value.id, userActionId: input.userActionId, startHash: input.startHash });
  return task(c, projectId, id);
}

async function append(c: Transaction, id: string, actor: Actor, type: string, hash: string | null, detail: Record<string, string | boolean>) {
  await c.query(`INSERT INTO studio_repair_task_events(task_id,seq,type,hash_after,detail,creator_id,creator_account,creator_name)
    SELECT $1,COALESCE(MAX(seq),0)+1,$2,$3,$4,$5,$6,$7 FROM studio_repair_task_events WHERE task_id=$1`,
  [id, type, hash, detail, actor.id, actor.username, actor.name]);
}

/** Record one explicit Host action. A pause never creates a fresh round budget. */
export async function event(c: Transaction, projectId: string, value: EntityView, id: string, actor: Actor, input: RepairEventRequest) {
  assertOccupation(value, input.token, actor);
  const current = await task(c, projectId, id); assertOwner(value, current, actor);
  requireCondition(['active', 'paused'].includes(current.status), 'REPAIR_FINISHED', 'Completed or terminated repair authorization cannot be resumed');
  requireCondition(input.expectedHash === current.currentHash, 'REPAIR_HASH_CHANGED', 'Repair action does not bind the current recorded file hash');
  let status = current.status, rounds = current.roundsUsed, reason: string | null = null;
  if (input.type === 'round') {
    requireCondition(status === 'active' && rounds < 3, 'REPAIR_ROUND_LIMIT', 'Repair must be active and has at most three rounds');
    rounds++;
    if (!input.improved || input.hashAfter === current.currentHash) { status = 'terminated'; reason = 'no-improvement'; }
    await append(c, id, actor, 'round', input.hashAfter, { improved: input.improved });
  } else if (input.type === 'pause') {
    requireCondition(status === 'active', 'REPAIR_NOT_ACTIVE', 'Only an active repair can pause');
    status = rounds >= 3 ? 'terminated' : 'paused'; reason = rounds >= 3 ? 'round-limit' : null;
    await append(c, id, actor, status === 'terminated' ? 'terminate' : 'pause', null, { reason: reason ?? input.reason });
  } else if (input.type === 'resume') {
    requireCondition(status === 'paused' && rounds < 3, 'REPAIR_NOT_PAUSED', 'Only a paused repair with remaining rounds can resume');
    requireCondition(input.userActionId !== current.userActionId, 'REPAIR_RESUME_ACTION_REQUIRED', 'Resume requires a new explicit user action');
    requireCondition(!(await c.query("SELECT seq FROM studio_repair_task_events WHERE task_id=$1 AND type='resume' AND detail->>'userActionId'=$2", [id, input.userActionId])).rowCount,
      'REPAIR_RESUME_ACTION_REUSED', 'Every continuation requires a fresh explicit user action');
    status = 'active'; await append(c, id, actor, 'resume', null, { userActionId: input.userActionId });
  } else {
    status = 'terminated'; reason = input.reason;
    await append(c, id, actor, 'terminate', null, { reason });
  }
  await c.query(`UPDATE studio_repair_tasks SET status=$2,rounds_used=$3,termination_reason=$4,
    last_editor_id=$5,last_editor_account=$6,last_editor_name=$7,last_edited_date=now() WHERE id=$1`,
  [id, status, rounds, reason, actor.id, actor.username, actor.name]);
  await audit(c, projectId, actor, 'repair.control', { repairTaskId: id, type: input.type, status, roundsUsed: rounds });
  return task(c, projectId, id);
}

export async function assertRepairConfirmation(c: Transaction, projectId: string, value: EntityView, confirmation: ConfirmationInput, actor: Actor) {
  if (confirmation.confirmationMethod !== 'ai-repair') return;
  const current = await task(c, projectId, confirmation.repairTaskId); assertOwner(value, current, actor);
  requireCondition(current.status === 'active' && current.roundsUsed > 0 && current.roundsUsed <= 3,
    'REPAIR_NOT_ACTIVE', 'Repair confirmation requires an active authorization with a recorded repair round');
  requireCondition(confirmation.fixed.sha256 === current.currentHash && confirmation.readHash === current.currentHash,
    'REPAIR_HASH_CHANGED', 'Repair confirmation must bind the final recorded file hash');
}

export async function completeRepair(c: Transaction, id: string, actor: Actor) {
  await append(c, id, actor, 'complete', null, {});
  await c.query(`UPDATE studio_repair_tasks SET status='completed',last_editor_id=$2,last_editor_account=$3,
    last_editor_name=$4,last_edited_date=now() WHERE id=$1 AND status='active'`, [id, actor.id, actor.username, actor.name]);
}

/** Ending an occupation revokes every authorization that has not already completed. */
async function terminate(c: Transaction, rows: Array<{ id: string }>, actor: Actor, reason: string) {
  for (const row of rows) {
    await append(c, row.id, actor, 'terminate', null, { reason });
    await c.query(`UPDATE studio_repair_tasks SET status='terminated',termination_reason=$2,last_editor_id=$3,
      last_editor_account=$4,last_editor_name=$5,last_edited_date=now() WHERE id=$1`, [row.id, reason, actor.id, actor.username, actor.name]);
  }
}

export async function finishOccupationRepairs(c: Transaction, projectId: string, occupationId: string, actor: Actor, reason: 'occupation-ended' | 'completed') {
  const rows = (await c.query<{ id: string }>("SELECT id FROM studio_repair_tasks WHERE project_id=$1 AND occupation_id=$2 AND status IN ('active','paused')", [projectId, occupationId])).rows;
  await terminate(c, rows, actor, reason);
}

/** A user edit invalidates the previous autonomous repair authorization. */
export async function invalidateEntityRepairs(c: Transaction, projectId: string, entityId: string, actor: Actor) {
  const rows = (await c.query<{ id: string }>("SELECT id FROM studio_repair_tasks WHERE project_id=$1 AND entity_id=$2 AND status IN ('active','paused')", [projectId, entityId])).rows;
  await terminate(c, rows, actor, 'concurrent-edit');
}
