import { randomUUID } from 'node:crypto';
import { canonical, requireCondition } from '@eadp/asset-domain';
import type { AbortPrototypeIntegrationRequest, CompletePrototypeIntegrationRequest, DevelopmentClaimToken, ProjectView, PrototypeBaselineView, PrototypeIntegrationRequest } from '@eadp/contracts';
import type { Actor } from '../auth/session.js';
import type { Transaction } from '../persistence/database.js';
import * as repository from '../persistence/repository.js';
import { withinPrototypeScope } from '../prototype-policy.js';
import { assertPrototypeClaims, getTask } from './prototypes.js';

type IntegrationRow = { id: string; owner_id: string | number; status: 'prepared' | 'accepted' | 'aborted'; git_recovery: 'pending' | 'reconciled' | null; request: PrototypeIntegrationRequest; created_date: Date | string };
export interface PrototypeIntegrationView { id: string; prototypeTaskId: string; status: 'prepared' | 'accepted' | 'aborted'; sourceSha: string; expectedHead: string; candidateSha: string; createdAt: string; gitRecovery?: 'pending' | 'reconciled'; baselineId?: string; acceptanceId?: string }

async function integrationRow(c: Transaction, projectId: string, id: string): Promise<IntegrationRow> {
  const row = (await c.query<IntegrationRow>('SELECT * FROM studio_prototype_integrations WHERE project_id=$1 AND id=$2', [projectId, id])).rows[0];
  requireCondition(row, 'INTEGRATION_NOT_FOUND', 'Prototype integration was not found', 404);
  return row;
}
/** The fixed request is retained for rechecking the same candidate at completion. */
export async function integrationRequest(c: Transaction, projectId: string, id: string, actor: Actor): Promise<PrototypeIntegrationRequest> {
  const row = await integrationRow(c, projectId, id);
  requireCondition(Number(row.owner_id) === actor.id || actor.admin, 'INTEGRATION_NOT_FOUND', 'Prototype integration was not found', 404);
  return row.request;
}
export async function getIntegration(c: Transaction, projectId: string, id: string, actor: Actor): Promise<PrototypeIntegrationView> {
  const row = await integrationRow(c, projectId, id);
  requireCondition(Number(row.owner_id) === actor.id || actor.admin, 'INTEGRATION_NOT_FOUND', 'Prototype integration was not found', 404);
  const accepted = (await c.query<{ id: string; baseline_id: string }>('SELECT a.id,b.id AS baseline_id FROM studio_prototype_acceptances a JOIN studio_prototype_baselines b ON b.acceptance_id=a.id WHERE a.project_id=$1 AND a.integration_id=$2', [projectId, id])).rows[0];
  return { id, prototypeTaskId: row.request.token.prototypeTaskId, status: row.status, sourceSha: row.request.sourceSha,
    expectedHead: row.request.expectedHead, candidateSha: row.request.candidateSha, createdAt: new Date(row.created_date).toISOString(),
    ...(row.status === 'aborted' ? { gitRecovery: row.git_recovery! } : {}),
    ...(accepted ? { acceptanceId: accepted.id, baselineId: accepted.baseline_id } : {}) };
}
export async function prepare(c: Transaction, project: ProjectView, actor: Actor, input: PrototypeIntegrationRequest): Promise<PrototypeIntegrationView> {
  const task = await getTask(c, project.id, input.token.prototypeTaskId, actor); assertPrototypeClaims(task, actor, input);
  requireCondition(task.ownerId === actor.id && task.prototypeId === input.prototypeId && task.sourceBaseHead === input.sourceBaseHead, 'STALE_PROTOTYPE_TASK', 'Prototype task identity or source base has changed', 409);
  requireCondition(project.recognizedHead === input.expectedHead, 'INTEGRATION_HEAD_CHANGED', 'Recognized project head has changed', 409);
  requireCondition(canonical([...input.developmentRequirementIds].sort()) === canonical([...task.developmentRequirementIds].sort()), 'STALE_DEVELOPMENT_CLAIM', 'Development scope must match the complete active claim set', 409);
  requireCondition(input.authorConfirmation.sourceSha === input.sourceSha && input.authorConfirmation.claimsDigest === input.claimsDigest, 'CONFIRMATION_SOURCE_MISMATCH', 'Confirmation must bind the source and claims', 409);
  requireCondition(input.evidence.candidateSha === input.candidateSha && new Set(input.evidence.checks.map(check => check.name)).size === 3, 'CHECK_CANDIDATE_MISMATCH', 'Evidence must describe the candidate and all three checks', 422);
  requireCondition(input.allowedPaths.length > 0 && input.allowedPaths.every(path => withinPrototypeScope(path, task.writeScope)), 'PROTOTYPE_PATH_SCOPE', 'Candidate paths must be within the task write scope', 422);
  const pending = await c.query("SELECT id FROM studio_prototype_integrations WHERE project_id=$1 AND status='prepared' UNION ALL SELECT id FROM studio_integrations WHERE project_id=$1 AND status='prepared'", [project.id]);
  requireCondition(!pending.rowCount, 'INTEGRATION_PENDING', 'An integration is already prepared', 409);
  const id = randomUUID();
  await c.query(`INSERT INTO studio_prototype_integrations(id,project_id,prototype_id,task_id,owner_id,status,source_sha,expected_head,candidate_sha,request) VALUES($1,$2,$3,$4,$5,'prepared',$6,$7,$8,$9)`,
    [id, project.id, input.prototypeId, task.id, actor.id, input.sourceSha, input.expectedHead, input.candidateSha, input]);
  return getIntegration(c, project.id, id, actor);
}
export async function complete(c: Transaction, project: ProjectView, actor: Actor, id: string, input: CompletePrototypeIntegrationRequest): Promise<PrototypeIntegrationView> {
  const row = await integrationRow(c, project.id, id), request = row.request;
  if (row.status === 'accepted') {
    requireCondition(Number(row.owner_id) === actor.id, 'INTEGRATION_NOT_PENDING', 'Only the original author can recover the accepted integration', 409);
    const ordered = (claims: DevelopmentClaimToken[]) => [...claims].sort((a, b) => a.requirementId.localeCompare(b.requirementId));
    requireCondition(canonical(input.token) === canonical(request.token) && canonical(ordered(input.developmentClaims)) === canonical(ordered(request.developmentClaims)) && input.claimsDigest === request.claimsDigest, 'STALE_DEVELOPMENT_CLAIM', 'Recovery must identify the original task and claims', 409);
    return getIntegration(c, project.id, id, actor);
  }
  requireCondition(row.status === 'prepared' && Number(row.owner_id) === actor.id, 'INTEGRATION_NOT_PENDING', 'The original author must complete a prepared integration', 409);
  const task = await getTask(c, project.id, request.token.prototypeTaskId, actor); assertPrototypeClaims(task, actor, input);
  requireCondition(canonical(input.token) === canonical(request.token) && input.claimsDigest === request.claimsDigest, 'STALE_DEVELOPMENT_CLAIM', 'Acceptance must use the originally confirmed task and claims', 409);
  requireCondition(project.recognizedHead === request.expectedHead, 'INTEGRATION_HEAD_CHANGED', 'Recognized project head has changed', 409);
  const acceptanceId = randomUUID(), baselineId = randomUUID();
  const prototype = (await c.query<{ current_baseline_id: string | null }>('SELECT current_baseline_id FROM studio_prototypes WHERE project_id=$1 AND id=$2', [project.id, request.prototypeId])).rows[0];
  requireCondition(prototype, 'PROTOTYPE_NOT_FOUND', 'Project prototype was not found', 404);
  const sequence = (await c.query<{ next: number }>('SELECT COALESCE(MAX(sequence),0)+1 AS next FROM studio_prototype_baselines WHERE project_id=$1 AND prototype_id=$2', [project.id, request.prototypeId])).rows[0]!.next;
  await c.query(`INSERT INTO studio_prototype_acceptances(id,project_id,prototype_id,task_id,integration_id,confirmation_id,source_sha,candidate_sha,confirmed_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [acceptanceId, project.id, request.prototypeId, task.id, id, request.authorConfirmation.confirmationId, request.sourceSha, request.candidateSha, actor.id]);
  await c.query('INSERT INTO studio_prototype_baselines(id,project_id,prototype_id,sequence,acceptance_id,commit_sha) VALUES($1,$2,$3,$4,$5,$6)', [baselineId, project.id, request.prototypeId, sequence, acceptanceId, request.candidateSha]);
  if (prototype.current_baseline_id) await c.query('INSERT INTO studio_prototype_baseline_requirements(project_id,baseline_id,requirement_id) SELECT project_id,$3,requirement_id FROM studio_prototype_baseline_requirements WHERE project_id=$1 AND baseline_id=$2', [project.id, prototype.current_baseline_id, baselineId]);
  for (const requirementId of task.developmentRequirementIds) {
    await c.query('INSERT INTO studio_prototype_acceptance_requirements(project_id,acceptance_id,requirement_id) VALUES($1,$2,$3)', [project.id, acceptanceId, requirementId]);
    await c.query('INSERT INTO studio_prototype_baseline_requirements(project_id,baseline_id,requirement_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [project.id, baselineId, requirementId]);
  }
  await c.query('UPDATE studio_prototype_development_claims SET active=false,ended_reason=$3 WHERE project_id=$1 AND task_id=$2 AND active', [project.id, task.id, 'accepted']);
  await c.query("UPDATE studio_prototype_tasks SET status='accepted',revision=revision+1,last_edited_date=clock_timestamp() WHERE project_id=$1 AND id=$2", [project.id, task.id]);
  await c.query("UPDATE studio_prototype_integrations SET status='accepted' WHERE project_id=$1 AND id=$2", [project.id, id]);
  await c.query('UPDATE studio_prototypes SET current_baseline_id=$2 WHERE project_id=$1', [project.id, baselineId]);
  project.recognizedHead = request.candidateSha; project.revision++;
  await repository.saveProject(c, project);
  return getIntegration(c, project.id, id, actor);
}
export async function abort(c: Transaction, project: ProjectView, actor: Actor, id: string, input: AbortPrototypeIntegrationRequest): Promise<PrototypeIntegrationView> {
  const row = await integrationRow(c, project.id, id), request = row.request;
  requireCondition(row.status === 'prepared' && Number(row.owner_id) === actor.id, 'INTEGRATION_NOT_PENDING', 'The original author must abort a prepared integration', 409);
  const task = await getTask(c, project.id, request.token.prototypeTaskId, actor);
  assertPrototypeClaims(task, actor, { token: input.token, developmentClaims: request.developmentClaims, claimsDigest: request.claimsDigest });
  requireCondition(canonical(input.token) === canonical(request.token) && project.recognizedHead === request.expectedHead, 'INTEGRATION_HEAD_CHANGED', 'The original integration state has changed', 409);
  await c.query("UPDATE studio_prototype_integrations SET status='aborted',git_recovery='pending' WHERE project_id=$1 AND id=$2", [project.id, id]);
  return getIntegration(c, project.id, id, actor);
}
export async function baselines(c: Transaction, projectId: string, limit = 100, offset = 0): Promise<PrototypeBaselineView[]> {
  const rows = await c.query<{ id: string; prototype_id: string; sequence: number; acceptance_id: string; integration_id: string; task_id: string; commit_sha: string; confirmed_by: string | number; accepted_at: Date | string }>(`SELECT b.*,a.integration_id,a.task_id,a.confirmed_by,a.accepted_at FROM studio_prototype_baselines b JOIN studio_prototype_acceptances a ON a.id=b.acceptance_id WHERE b.project_id=$1 ORDER BY b.sequence DESC LIMIT $2 OFFSET $3`, [projectId, limit, offset]);
  const result: PrototypeBaselineView[] = [];
  for (const row of rows.rows) {
    const refs = await c.query<{ requirement_id: string }>('SELECT requirement_id FROM studio_prototype_baseline_requirements WHERE project_id=$1 AND baseline_id=$2 ORDER BY requirement_id', [projectId, row.id]);
    result.push({ id: row.id, prototypeId: row.prototype_id, sequence: Number(row.sequence), acceptanceId: row.acceptance_id, integrationId: row.integration_id, prototypeTaskId: row.task_id, commitSha: row.commit_sha, relatedRequirementIds: refs.rows.map(ref => ref.requirement_id), confirmedBy: Number(row.confirmed_by), acceptedAt: new Date(row.accepted_at).toISOString() });
  }
  return result;
}
