import { createHash, randomUUID } from 'node:crypto';
import { canonical, requireCondition } from '@eadp/asset-domain';
import type { AdminPrototypeDevelopmentClaimRequest, CancelPrototypeTaskRequest, ClaimPrototypeDevelopmentRequest, CreatePrototypeTaskRequest, DevelopmentClaimToken, DevelopmentClaimView, EntityView, ProjectPrototypeView, ProjectView, PrototypeTaskToken, PrototypeTaskView, StudioUser, SynchronizePrototypeDevelopmentRequest, UpdatePrototypeReferencesRequest, UpdatePrototypeScopeRequest, UpdatePrototypeSourceBaseRequest } from '@eadp/contracts';
import type { Actor } from '../auth/session.js';
import type { Transaction } from '../persistence/database.js';
import * as repository from '../persistence/repository.js';

type TaskRow = {
  id: string; prototype_id: string; owner_id: string | number; client_id: string; generation: number; revision: number;
  status: PrototypeTaskView['status']; title: string; branch: string; start_head: string; source_base_head: string;
  write_scope: string[]; policy_hash: string; claims_digest: string;
};
type ClaimRow = {
  id: string; task_id: string | null; requirement_id: string; generation: number;
  commit_id: string; remote_ref: string; active: boolean;
};

/** A stable digest of the latest development claim generation for every task requirement. */
export function claimsDigest(claims: DevelopmentClaimToken[]): string {
  const ordered = [...claims].sort((a, b) => a.requirementId.localeCompare(b.requirementId));
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
}

/** Verify the task identity and latest claim generation of every requirement for an integration operation. */
export function assertPrototypeClaims(task: PrototypeTaskView, actor: Actor, input: { token: PrototypeTaskToken; developmentClaims: DevelopmentClaimToken[]; claimsDigest: string }): void {
  const token = input.token;
  requireCondition(task.ownerId === actor.id && task.status === 'active' && task.id === token.prototypeTaskId && task.clientId === token.clientId && task.generation === token.generation && task.revision === token.expectedRevision, 'STALE_PROTOTYPE_TASK', 'Prototype task authorization has changed', 409);
  const ordered = (values: DevelopmentClaimToken[]) => [...values].sort((a, b) => a.requirementId.localeCompare(b.requirementId));
  const complete = task.developmentClaims.length === task.developmentRequirementIds.length && task.developmentRequirementIds.every(id => task.developmentClaims.some(claim => claim.requirementId === id));
  requireCondition(complete && canonical(ordered(task.developmentClaims)) === canonical(ordered(input.developmentClaims)) && task.claimsDigest === input.claimsDigest && claimsDigest(task.developmentClaims) === input.claimsDigest, 'STALE_DEVELOPMENT_CLAIM', 'The latest claim generation set has changed', 409);
}

/** Verify that no other task or administrative action superseded any claim. */
export async function assertLatestPrototypeClaims(c: Transaction, projectId: string, task: PrototypeTaskView): Promise<void> {
  const rows = await c.query<{ id: string; requirement_id: string; generation: number }>(`SELECT DISTINCT ON (requirement_id) id,requirement_id,generation FROM studio_prototype_development_claims
    WHERE project_id=$1 AND requirement_id=ANY($2::text[]) ORDER BY requirement_id,generation DESC`, [projectId, task.developmentRequirementIds]);
  const latest = new Map(rows.rows.map(row => [row.requirement_id, row]));
  requireCondition(latest.size === task.developmentClaims.length && task.developmentClaims.every(claim => {
    const row = latest.get(claim.requirementId);
    return row?.id === claim.claimId && Number(row.generation) === claim.generation;
  }), 'STALE_DEVELOPMENT_CLAIM', 'A requirement has a newer development claim', 409);
}

function validateRequirements(all: EntityView[], actor: Actor, ids: string[]) {
  for (const id of ids) {
    const entity = all.find(value => value.id === id);
    requireCondition(entity?.kind === 'requirement' && (entity.authorId === actor.id || !!entity.current), 'INVALID_REQUIREMENT_SCOPE', 'The requirement is not readable in this project', 422);
  }
}
function validateReferences(development: string[], references: string[]) {
  requireCondition(references.every(id => !development.includes(id)), 'INVALID_REQUIREMENT_SCOPE', 'Development and reference requirements must be distinct', 422);
}
function validatePaths(paths: string[]) {
  for (const path of paths) {
    const segments = (path.endsWith('/') ? path.slice(0, -1) : path).split('/');
    requireCondition(!path.startsWith('/') && !path.includes('\\') && !path.includes('\0') && segments.every(part => part && part !== '.' && part !== '..'), 'PROTOTYPE_PATH_SCOPE', 'Prototype paths must be normalized project-relative paths', 422);
  }
}
function claimView(row: ClaimRow): DevelopmentClaimView {
  return { requirementId: row.requirement_id, taskId: row.task_id, claimId: row.id, generation: Number(row.generation), active: row.active, commitId: row.commit_id, remoteRef: row.remote_ref };
}
async function claims(c: Transaction, projectId: string, taskId: string): Promise<DevelopmentClaimToken[]> {
  const rows = await c.query<{ id: string; requirement_id: string; generation: number }>(`SELECT DISTINCT ON (requirement_id) id,requirement_id,generation FROM studio_prototype_development_claims
    WHERE project_id=$1 AND task_id=$2 ORDER BY requirement_id,generation DESC`, [projectId, taskId]);
  return rows.rows.map(row => ({ requirementId: row.requirement_id, claimId: row.id, generation: Number(row.generation) }));
}
async function developmentScope(c: Transaction, projectId: string, taskId: string): Promise<string[]> {
  const rows = await c.query<{ requirement_id: string }>('SELECT requirement_id FROM studio_prototype_task_requirements WHERE project_id=$1 AND task_id=$2 ORDER BY requirement_id', [projectId, taskId]);
  return rows.rows.map(row => row.requirement_id);
}
async function taskView(c: Transaction, projectId: string, row: TaskRow): Promise<PrototypeTaskView> {
  const developmentClaims = await claims(c, projectId, row.id);
  const refs = await c.query<{ requirement_id: string }>('SELECT requirement_id FROM studio_prototype_task_references WHERE project_id=$1 AND task_id=$2 ORDER BY requirement_id', [projectId, row.id]);
  return { id: row.id, prototypeId: row.prototype_id, ownerId: Number(row.owner_id), clientId: row.client_id,
    generation: Number(row.generation), revision: Number(row.revision), status: row.status, title: row.title, branch: row.branch,
    startHead: row.start_head, sourceBaseHead: row.source_base_head, developmentRequirementIds: await developmentScope(c, projectId, row.id),
    referenceRequirementIds: refs.rows.map(ref => ref.requirement_id), developmentClaims, claimsDigest: row.claims_digest,
    writeScope: row.write_scope, policyHash: row.policy_hash };
}
async function taskRow(c: Transaction, projectId: string, taskId: string): Promise<TaskRow> {
  const row = (await c.query<TaskRow>('SELECT * FROM studio_prototype_tasks WHERE project_id=$1 AND id=$2', [projectId, taskId])).rows[0];
  requireCondition(row, 'PROTOTYPE_TASK_NOT_FOUND', 'Prototype task was not found', 404);
  return row;
}
/** A prepared integration fixes the task revision and its complete claim set. */
async function assertNoPreparedIntegration(c: Transaction, projectId: string, taskId: string): Promise<void> {
  const pending = await c.query("SELECT id FROM studio_prototype_integrations WHERE project_id=$1 AND task_id=$2 AND status='prepared'", [projectId, taskId]);
  requireCondition(!pending.rowCount, 'INTEGRATION_PENDING', 'Resolve the prepared integration before changing the task', 409);
}
export async function getTask(c: Transaction, projectId: string, taskId: string, actor: Actor): Promise<PrototypeTaskView> {
  const row = await taskRow(c, projectId, taskId);
  requireCondition(Number(row.owner_id) === actor.id || actor.admin, 'PROTOTYPE_TASK_NOT_FOUND', 'Prototype task was not found', 404);
  return taskView(c, projectId, row);
}
export async function projectPrototype(c: Transaction, project: ProjectView, actor: StudioUser): Promise<ProjectPrototypeView> {
  const row = (await c.query<{ id: string; current_baseline_id: string | null }>('SELECT id,current_baseline_id FROM studio_prototypes WHERE project_id=$1', [project.id])).rows[0];
  requireCondition(row && project.recognizedHead, 'PROJECT_NOT_INITIALIZED', 'Project prototype is not initialized', 409);
  const rows = await c.query<TaskRow>('SELECT * FROM studio_prototype_tasks WHERE project_id=$1 AND owner_id=$2 ORDER BY created_date,id', [project.id, actor.id]);
  const tasks: PrototypeTaskView[] = [];
  for (const task of rows.rows) tasks.push(await taskView(c, project.id, task));
  return { id: row.id, projectId: project.id, ...(row.current_baseline_id ? { currentBaselineId: row.current_baseline_id } : {}), recognizedHead: project.recognizedHead, tasks };
}
function assertToken(row: TaskRow, token: PrototypeTaskToken, actor: Actor) {
  requireCondition(Number(row.owner_id) === actor.id, 'PROTOTYPE_TASK_OWNER_REQUIRED', 'Only the task owner can change the task', 403);
  requireCondition(row.status === 'active' && row.id === token.prototypeTaskId && Number(row.generation) === token.generation && row.client_id === token.clientId, 'STALE_PROTOTYPE_TASK', 'Task authorization is no longer active', 409);
  requireCondition(Number(row.revision) === token.expectedRevision, 'TASK_REVISION_CONFLICT', 'Task revision has changed', 409);
}
function assertManagedRef(task: TaskRow, remoteRef: string): void {
  requireCondition(remoteRef === `refs/heads/${task.branch}`, 'INVALID_DEVELOPMENT_REF', 'The remote ref must be the branch managed for this prototype task', 422);
}
async function assertReadableRequirement(c: Transaction, projectId: string, requirementId: string, actor: Actor): Promise<void> {
  const requirement = (await c.query<{ kind: string; creator_id: string | number; current_confirmation_id: string | null }>('SELECT kind,creator_id,current_confirmation_id FROM studio_entities WHERE project_id=$1 AND id=$2', [projectId, requirementId])).rows[0];
  requireCondition(requirement?.kind === 'requirement' && (Number(requirement.creator_id) === actor.id || requirement.current_confirmation_id !== null), 'INVALID_REQUIREMENT_SCOPE', 'The requirement is not readable in this project', 422);
}
async function assertClaimableRequirement(c: Transaction, projectId: string, taskId: string, requirementId: string, actor: Actor): Promise<void> {
  await assertReadableRequirement(c, projectId, requirementId, actor);
  const scope = await c.query('SELECT requirement_id FROM studio_prototype_task_requirements WHERE project_id=$1 AND task_id=$2 AND requirement_id=$3', [projectId, taskId, requirementId]);
  requireCondition(scope.rowCount === 1, 'INVALID_REQUIREMENT_SCOPE', 'The requirement does not belong to this prototype task', 422);
}
async function replaceReferences(c: Transaction, projectId: string, taskId: string, ids: string[]) {
  await c.query('DELETE FROM studio_prototype_task_references WHERE project_id=$1 AND task_id=$2', [projectId, taskId]);
  for (const id of ids) await c.query('INSERT INTO studio_prototype_task_references(project_id,task_id,requirement_id) VALUES($1,$2,$3)', [projectId, taskId, id]);
}
export async function createTask(c: Transaction, project: ProjectView, actor: Actor, input: CreatePrototypeTaskRequest): Promise<PrototypeTaskView> {
  for (const requirementId of [...input.developmentRequirementIds, ...input.referenceRequirementIds]) await assertReadableRequirement(c, project.id, requirementId, actor);
  validateReferences(input.developmentRequirementIds, input.referenceRequirementIds); validatePaths(input.writeScope);
  const prototype = (await c.query<{ id: string }>('SELECT id FROM studio_prototypes WHERE project_id=$1', [project.id])).rows[0];
  requireCondition(prototype && project.recognizedHead, 'PROJECT_NOT_INITIALIZED', 'Project prototype is not initialized', 409);
  const id = input.idempotencyKey, branch = `studio/prototype/${id}`;
  await c.query(`INSERT INTO studio_prototype_tasks(id,project_id,prototype_id,owner_id,client_id,generation,revision,status,title,branch,start_head,source_base_head,write_scope,policy_hash,claims_digest,instruction)
    VALUES($1,$2,$3,$4,$5,1,0,'active',$6,$7,$8,$8,$9,$10,$11,$12)`, [id, project.id, prototype.id, actor.id, input.clientId, input.title, branch, project.recognizedHead, input.writeScope, input.policyHash, claimsDigest([]), input.instruction]);
  for (const requirementId of [...input.developmentRequirementIds].sort()) {
    await c.query('INSERT INTO studio_prototype_task_requirements(project_id,task_id,requirement_id) VALUES($1,$2,$3)', [project.id, id, requirementId]);
  }
  await replaceReferences(c, project.id, id, input.referenceRequirementIds);
  for (const requirementId of [...input.developmentRequirementIds].sort()) {
    await claimDevelopment(c, project.id, actor, id, { key: input.idempotencyKey, token: { prototypeTaskId: id, generation: 1, clientId: input.clientId, expectedRevision: 0 }, requirementId, commitId: input.commitId, remoteRef: input.remoteRef });
  }
  return getTask(c, project.id, id, actor);
}
/** Atomically claim one idle requirement without consulting Git. */
export async function claimDevelopment(c: Transaction, projectId: string, actor: Actor, taskId: string, input: ClaimPrototypeDevelopmentRequest): Promise<DevelopmentClaimView> {
  const task = await taskRow(c, projectId, taskId); assertToken(task, input.token, actor);
  await assertNoPreparedIntegration(c, projectId, taskId);
  await assertClaimableRequirement(c, projectId, taskId, input.requirementId, actor);
  assertManagedRef(task, input.remoteRef);
  const occupied = await c.query('SELECT id FROM studio_prototype_development_claims WHERE project_id=$1 AND requirement_id=$2 AND active FOR UPDATE', [projectId, input.requirementId]);
  requireCondition(!occupied.rowCount, 'REQUIREMENT_ALREADY_CLAIMED', 'The requirement is already being developed', 409, { requirementId: input.requirementId });
  const generation = await c.query<{ next: number }>('SELECT COALESCE(MAX(generation),0)+1 AS next FROM studio_prototype_development_claims WHERE project_id=$1 AND requirement_id=$2', [projectId, input.requirementId]);
  const inserted = await c.query<ClaimRow>(`INSERT INTO studio_prototype_development_claims(id,project_id,task_id,requirement_id,generation,commit_id,remote_ref)
    VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [randomUUID(), projectId, taskId, input.requirementId, generation.rows[0]!.next, input.commitId, input.remoteRef]);
  const digest = claimsDigest(await claims(c, projectId, taskId));
  await c.query('UPDATE studio_prototype_tasks SET claims_digest=$3,last_edited_date=clock_timestamp() WHERE project_id=$1 AND id=$2', [projectId, taskId, digest]);
  return claimView(inserted.rows[0]!);
}
/** Read the active generation used by Host recovery; released generations never reactivate here. */
export async function currentDevelopmentClaim(c: Transaction, projectId: string, actor: Actor, requirementId: string): Promise<DevelopmentClaimView | null> {
  const requirement = await c.query("SELECT id FROM studio_entities WHERE project_id=$1 AND id=$2 AND kind='requirement'", [projectId, requirementId]);
  requireCondition(requirement.rowCount === 1, 'INVALID_REQUIREMENT_SCOPE', 'The requirement is not readable in this project', 422);
  const row = (await c.query<ClaimRow & { owner_id: string | number | null }>(`SELECT c.*,t.owner_id FROM studio_prototype_development_claims c
    LEFT JOIN studio_prototype_tasks t ON t.project_id=c.project_id AND t.id=c.task_id
    WHERE c.project_id=$1 AND c.requirement_id=$2 AND c.active`, [projectId, requirementId])).rows[0];
  if (!row) return null;
  requireCondition(row.task_id === null || Number(row.owner_id) === actor.id || actor.admin, 'DEVELOPMENT_CLAIM_NOT_FOUND', 'Development claim was not found', 404);
  return claimView(row);
}
/** Record a Git-verified result and optionally close only the original requirement generation. */
export async function synchronizeDevelopment(c: Transaction, projectId: string, actor: Actor, taskId: string, requirementId: string, input: SynchronizePrototypeDevelopmentRequest): Promise<DevelopmentClaimView> {
  const task = await taskRow(c, projectId, taskId); assertToken(task, input.token, actor); assertManagedRef(task, input.remoteRef);
  requireCondition(input.claim.requirementId === requirementId, 'STALE_DEVELOPMENT_CLAIM', 'The claim does not belong to the synchronized requirement', 409);
  const updated = await c.query<ClaimRow>(`UPDATE studio_prototype_development_claims SET commit_id=$5,remote_ref=$6,active=$7,ended_reason=$8,last_edited_date=clock_timestamp()
    WHERE project_id=$1 AND task_id=$2 AND requirement_id=$3 AND id=$4 AND generation=$9 AND active RETURNING *`,
  [projectId, taskId, requirementId, input.claim.claimId, input.commitId, input.remoteRef, !input.release, input.release ? 'completed' : null, input.claim.generation]);
  requireCondition(updated.rowCount === 1, 'STALE_DEVELOPMENT_CLAIM', 'The original development claim is no longer active', 409, { requirementId });
  return claimView(updated.rows[0]!);
}
/** An administrator replaces the current generation independently of Git availability. */
export async function administerDevelopmentClaim(c: Transaction, projectId: string, actor: Actor, requirementId: string, input: AdminPrototypeDevelopmentClaimRequest): Promise<DevelopmentClaimView | null> {
  requireCondition(actor.admin, 'ADMIN_REQUIRED', 'Only an administrator can change a development claim', 403);
  const requirement = await c.query("SELECT id FROM studio_entities WHERE project_id=$1 AND id=$2 AND kind='requirement'", [projectId, requirementId]);
  requireCondition(requirement.rowCount === 1, 'INVALID_REQUIREMENT_SCOPE', 'The requirement is not readable in this project', 422);
  const current = (await c.query<ClaimRow & { branch: string | null }>(`SELECT c.*,t.branch FROM studio_prototype_development_claims c
    LEFT JOIN studio_prototype_tasks t ON t.project_id=c.project_id AND t.id=c.task_id
    WHERE c.project_id=$1 AND c.requirement_id=$2 AND c.active FOR UPDATE OF c`, [projectId, requirementId])).rows[0];
  let replaced: ClaimRow | undefined;
  if (current) {
    if (current.task_id) requireCondition(input.remoteRef === `refs/heads/${current.branch}`, 'INVALID_DEVELOPMENT_REF', 'The remote ref must belong to the task holding the active claim', 422);
    const next = Number(current.generation) + 1;
    const updated = await c.query<ClaimRow>(`UPDATE studio_prototype_development_claims SET generation=$3,active=$4,commit_id=$5,remote_ref=$6,ended_reason=$7,last_edited_date=clock_timestamp()
      WHERE project_id=$1 AND id=$2 AND active AND generation=$8 RETURNING *`,
    [projectId, current.id, next, input.occupied, input.commitId, input.remoteRef, input.occupied ? null : input.reason, current.generation]);
    requireCondition(updated.rowCount === 1, 'STALE_DEVELOPMENT_CLAIM', 'The development claim changed during administration', 409);
    replaced = updated.rows[0]!;
    if (current.task_id) {
      const digest = claimsDigest(await claims(c, projectId, current.task_id));
      await c.query('UPDATE studio_prototype_tasks SET claims_digest=$3,last_edited_date=clock_timestamp() WHERE project_id=$1 AND id=$2', [projectId, current.task_id, digest]);
    }
  } else {
    const generation = await c.query<{ next: number }>('SELECT COALESCE(MAX(generation),0)+1 AS next FROM studio_prototype_development_claims WHERE project_id=$1 AND requirement_id=$2', [projectId, requirementId]);
    replaced = (await c.query<ClaimRow>(`INSERT INTO studio_prototype_development_claims(id,project_id,task_id,requirement_id,generation,commit_id,remote_ref,active,ended_reason)
      VALUES($1,$2,NULL,$3,$4,$5,$6,$7,$8) RETURNING *`, [randomUUID(), projectId, requirementId, generation.rows[0]!.next, input.commitId, input.remoteRef, input.occupied, input.occupied ? null : input.reason])).rows[0]!;
  }
  await repository.audit(c, projectId, actor, 'prototype.development.claim.admin', { requirementId, occupied: input.occupied, commitId: input.commitId, remoteRef: input.remoteRef, reason: input.reason, invalidatedClaimId: current?.id, invalidatedGeneration: current ? Number(current.generation) : undefined, replacementGeneration: replaced ? Number(replaced.generation) : undefined });
  return replaced && input.occupied ? claimView(replaced) : null;
}
export async function updateReferences(c: Transaction, projectId: string, all: EntityView[], actor: Actor, taskId: string, input: UpdatePrototypeReferencesRequest): Promise<PrototypeTaskView> {
  const row = await taskRow(c, projectId, taskId); assertToken(row, input.token, actor);
  await assertNoPreparedIntegration(c, projectId, taskId);
  validateRequirements(all, actor, input.referenceRequirementIds);
  validateReferences(await developmentScope(c, projectId, taskId), input.referenceRequirementIds);
  await replaceReferences(c, projectId, taskId, input.referenceRequirementIds);
  await c.query('UPDATE studio_prototype_tasks SET revision=revision+1,last_edited_date=clock_timestamp() WHERE project_id=$1 AND id=$2', [projectId, taskId]);
  return getTask(c, projectId, taskId, actor);
}
export async function updateScope(c: Transaction, projectId: string, actor: Actor, taskId: string, input: UpdatePrototypeScopeRequest): Promise<PrototypeTaskView> {
  const row = await taskRow(c, projectId, taskId); assertToken(row, input.token, actor); validatePaths(input.writeScope);
  await assertNoPreparedIntegration(c, projectId, taskId);
  await c.query('UPDATE studio_prototype_tasks SET revision=revision+1,write_scope=$3,policy_hash=$4,instruction=$5,last_edited_date=clock_timestamp() WHERE project_id=$1 AND id=$2', [projectId, taskId, input.writeScope, input.policyHash, input.instruction]);
  return getTask(c, projectId, taskId, actor);
}
/** Record a verified conflict base only while the original task and project remain current. */
export async function updateSourceBase(c: Transaction, project: ProjectView, actor: Actor, taskId: string, input: UpdatePrototypeSourceBaseRequest, previousBaseHead: string): Promise<PrototypeTaskView> {
  const task = await getTask(c, project.id, taskId, actor);
  assertPrototypeClaims(task, actor, input);
  requireCondition(task.sourceBaseHead === previousBaseHead && project.recognizedHead === input.newBaseHead && input.newBaseHead !== previousBaseHead, 'INTEGRATION_HEAD_CHANGED', 'The task base or recognized project head changed', 409);
  const pending = await c.query("SELECT id FROM studio_prototype_integrations WHERE project_id=$1 AND (status='prepared' OR (task_id=$2 AND status='aborted' AND git_recovery='pending')) UNION ALL SELECT id FROM studio_integrations WHERE project_id=$1 AND status='prepared'", [project.id, taskId]);
  requireCondition(!pending.rowCount, 'INTEGRATION_PENDING', 'Resolve the original integration and any uncertain Git operation before changing the source base', 409);
  await c.query('UPDATE studio_prototype_tasks SET source_base_head=$3,revision=revision+1,last_edited_date=clock_timestamp() WHERE project_id=$1 AND id=$2', [project.id, taskId, input.newBaseHead]);
  return getTask(c, project.id, taskId, actor);
}
export async function endTask(c: Transaction, projectId: string, actor: Actor, taskId: string, status: 'cancelled' | 'released', input: CancelPrototypeTaskRequest | { expectedGeneration: number; expectedRevision: number; reason: string }): Promise<PrototypeTaskView> {
  const row = await taskRow(c, projectId, taskId);
  if ('token' in input) assertToken(row, input.token, actor);
  else {
    requireCondition(actor.admin, 'ADMIN_REQUIRED', 'Only an administrator can release another task', 403);
    requireCondition(row.status === 'active' && Number(row.generation) === input.expectedGeneration && Number(row.revision) === input.expectedRevision, 'STALE_PROTOTYPE_TASK', 'Task authorization has changed', 409);
  }
  // Keep the original request and SHAs so a late Git push can still be reconciled.
  await c.query("UPDATE studio_prototype_integrations SET status='aborted',git_recovery='pending' WHERE project_id=$1 AND task_id=$2 AND status='prepared'", [projectId, taskId]);
  await c.query('UPDATE studio_prototype_development_claims SET active=false,ended_reason=$3,last_edited_date=clock_timestamp() WHERE project_id=$1 AND task_id=$2 AND active', [projectId, taskId, input.reason]);
  await c.query('UPDATE studio_prototype_tasks SET status=$3,generation=generation+1,revision=revision+1,last_edited_date=clock_timestamp() WHERE project_id=$1 AND id=$2', [projectId, taskId, status]);
  return getTask(c, projectId, taskId, actor);
}
