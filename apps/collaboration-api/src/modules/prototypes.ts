import { createHash, randomUUID } from 'node:crypto';
import { canonical, requireCondition } from '@eadp/asset-domain';
import type { CancelPrototypeTaskRequest, CreatePrototypeTaskRequest, DevelopmentClaimToken, EntityView, ProjectPrototypeView, ProjectView, PrototypeTaskToken, PrototypeTaskView, StudioUser, UpdatePrototypeClaimsRequest, UpdatePrototypeReferencesRequest, UpdatePrototypeScopeRequest, UpdatePrototypeSourceBaseRequest } from '@eadp/contracts';
import type { Actor } from '../auth/session.js';
import type { Transaction } from '../persistence/database.js';

type TaskRow = {
  id: string; prototype_id: string; owner_id: string | number; client_id: string; generation: number; revision: number;
  status: PrototypeTaskView['status']; title: string; branch: string; start_head: string; source_base_head: string;
  write_scope: string[]; policy_hash: string; claims_digest: string;
};

/** A stable digest of the complete active development claim set. */
export function claimsDigest(claims: DevelopmentClaimToken[]): string {
  const ordered = [...claims].sort((a, b) => a.requirementId.localeCompare(b.requirementId));
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
}

/** Verify the task identity and complete active claim set for an integration operation. */
export function assertPrototypeClaims(task: PrototypeTaskView, actor: Actor, input: { token: PrototypeTaskToken; developmentClaims: DevelopmentClaimToken[]; claimsDigest: string }): void {
  const token = input.token;
  requireCondition(task.ownerId === actor.id && task.status === 'active' && task.id === token.prototypeTaskId && task.clientId === token.clientId && task.generation === token.generation && task.revision === token.expectedRevision, 'STALE_PROTOTYPE_TASK', 'Prototype task authorization has changed', 409);
  const ordered = (values: DevelopmentClaimToken[]) => [...values].sort((a, b) => a.requirementId.localeCompare(b.requirementId));
  requireCondition(task.developmentClaims.length > 0 && canonical(ordered(task.developmentClaims)) === canonical(ordered(input.developmentClaims)) && task.claimsDigest === input.claimsDigest && claimsDigest(task.developmentClaims) === input.claimsDigest, 'STALE_DEVELOPMENT_CLAIM', 'The complete active claim set has changed', 409);
}

function validateRequirements(all: EntityView[], actor: Actor, ids: string[]) {
  for (const id of ids) {
    const entity = all.find(value => value.id === id);
    requireCondition(entity?.kind === 'requirement' && (entity.authorId === actor.id || entity.current || entity.legacyCurrent), 'INVALID_REQUIREMENT_SCOPE', 'The requirement is not readable in this project', 422);
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
async function claims(c: Transaction, projectId: string, taskId: string): Promise<DevelopmentClaimToken[]> {
  const rows = await c.query<{ id: string; requirement_id: string; generation: number }>('SELECT id,requirement_id,generation FROM studio_prototype_development_claims WHERE project_id=$1 AND task_id=$2 AND active ORDER BY requirement_id', [projectId, taskId]);
  return rows.rows.map(row => ({ requirementId: row.requirement_id, claimId: row.id, generation: Number(row.generation) }));
}
async function taskView(c: Transaction, projectId: string, row: TaskRow): Promise<PrototypeTaskView> {
  const developmentClaims = await claims(c, projectId, row.id);
  const refs = await c.query<{ requirement_id: string }>('SELECT requirement_id FROM studio_prototype_task_references WHERE project_id=$1 AND task_id=$2 ORDER BY requirement_id', [projectId, row.id]);
  return { id: row.id, prototypeId: row.prototype_id, ownerId: Number(row.owner_id), clientId: row.client_id,
    generation: Number(row.generation), revision: Number(row.revision), status: row.status, title: row.title, branch: row.branch,
    startHead: row.start_head, sourceBaseHead: row.source_base_head, developmentRequirementIds: developmentClaims.map(claim => claim.requirementId),
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
async function addClaims(c: Transaction, projectId: string, taskId: string, ids: string[]) {
  for (const id of [...ids].sort()) {
    const occupied = await c.query('SELECT id FROM studio_prototype_development_claims WHERE project_id=$1 AND requirement_id=$2 AND active', [projectId, id]);
    requireCondition(!occupied.rowCount, 'REQUIREMENT_ALREADY_CLAIMED', 'A requirement is already being developed by another task', 409, { requirementId: id });
    const generation = await c.query<{ next: number }>('SELECT COALESCE(MAX(generation),0)+1 AS next FROM studio_prototype_development_claims WHERE project_id=$1 AND requirement_id=$2', [projectId, id]);
    await c.query('INSERT INTO studio_prototype_development_claims(id,project_id,task_id,requirement_id,generation) VALUES($1,$2,$3,$4,$5)', [randomUUID(), projectId, taskId, id, generation.rows[0]!.next]);
  }
}
async function replaceReferences(c: Transaction, projectId: string, taskId: string, ids: string[]) {
  await c.query('DELETE FROM studio_prototype_task_references WHERE project_id=$1 AND task_id=$2', [projectId, taskId]);
  for (const id of ids) await c.query('INSERT INTO studio_prototype_task_references(project_id,task_id,requirement_id) VALUES($1,$2,$3)', [projectId, taskId, id]);
}
export async function createTask(c: Transaction, project: ProjectView, all: EntityView[], actor: Actor, input: CreatePrototypeTaskRequest): Promise<PrototypeTaskView> {
  validateRequirements(all, actor, [...input.developmentRequirementIds, ...input.referenceRequirementIds]);
  validateReferences(input.developmentRequirementIds, input.referenceRequirementIds); validatePaths(input.writeScope);
  const prototype = (await c.query<{ id: string }>('SELECT id FROM studio_prototypes WHERE project_id=$1', [project.id])).rows[0];
  requireCondition(prototype && project.recognizedHead, 'PROJECT_NOT_INITIALIZED', 'Project prototype is not initialized', 409);
  const id = randomUUID(), branch = `studio/prototype/${id}`;
  await c.query(`INSERT INTO studio_prototype_tasks(id,project_id,prototype_id,owner_id,client_id,generation,revision,status,title,branch,start_head,source_base_head,write_scope,policy_hash,claims_digest,instruction)
    VALUES($1,$2,$3,$4,$5,1,0,'active',$6,$7,$8,$8,$9,$10,$11,$12)`, [id, project.id, prototype.id, actor.id, input.clientId, input.title, branch, project.recognizedHead, input.writeScope, input.policyHash, claimsDigest([]), input.instruction]);
  await addClaims(c, project.id, id, input.developmentRequirementIds);
  await replaceReferences(c, project.id, id, input.referenceRequirementIds);
  const digest = claimsDigest(await claims(c, project.id, id));
  await c.query('UPDATE studio_prototype_tasks SET claims_digest=$3 WHERE project_id=$1 AND id=$2', [project.id, id, digest]);
  return getTask(c, project.id, id, actor);
}
export async function extendClaims(c: Transaction, projectId: string, all: EntityView[], actor: Actor, taskId: string, input: UpdatePrototypeClaimsRequest): Promise<PrototypeTaskView> {
  const row = await taskRow(c, projectId, taskId); assertToken(row, input.token, actor);
  await assertNoPreparedIntegration(c, projectId, taskId);
  validateRequirements(all, actor, input.developmentRequirementIds);
  const current = await claims(c, projectId, taskId);
  requireCondition(current.every(claim => input.developmentRequirementIds.includes(claim.requirementId)), 'DEVELOPMENT_SCOPE_SHRINK_FORBIDDEN', 'Active development claims cannot be removed', 409);
  const added = input.developmentRequirementIds.filter(id => !current.some(claim => claim.requirementId === id));
  await addClaims(c, projectId, taskId, added);
  await c.query('DELETE FROM studio_prototype_task_references WHERE project_id=$1 AND task_id=$2 AND requirement_id=ANY($3::text[])', [projectId, taskId, added]);
  const digest = claimsDigest(await claims(c, projectId, taskId));
  await c.query('UPDATE studio_prototype_tasks SET revision=revision+1,claims_digest=$3,instruction=$4,last_edited_date=clock_timestamp() WHERE project_id=$1 AND id=$2', [projectId, taskId, digest, input.instruction]);
  return getTask(c, projectId, taskId, actor);
}
export async function updateReferences(c: Transaction, projectId: string, all: EntityView[], actor: Actor, taskId: string, input: UpdatePrototypeReferencesRequest): Promise<PrototypeTaskView> {
  const row = await taskRow(c, projectId, taskId); assertToken(row, input.token, actor);
  await assertNoPreparedIntegration(c, projectId, taskId);
  validateRequirements(all, actor, input.referenceRequirementIds);
  validateReferences((await claims(c, projectId, taskId)).map(claim => claim.requirementId), input.referenceRequirementIds);
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
  await c.query('UPDATE studio_prototype_development_claims SET active=false,ended_reason=$3 WHERE project_id=$1 AND task_id=$2 AND active', [projectId, taskId, input.reason]);
  await c.query('UPDATE studio_prototype_tasks SET status=$3,generation=generation+1,revision=revision+1,claims_digest=$4,last_edited_date=clock_timestamp() WHERE project_id=$1 AND id=$2', [projectId, taskId, status, claimsDigest([])]);
  return getTask(c, projectId, taskId, actor);
}
