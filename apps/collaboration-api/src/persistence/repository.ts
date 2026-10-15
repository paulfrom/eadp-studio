import { createHash, randomUUID } from 'node:crypto';
import { canonical, requireCondition } from '@eadp/asset-domain';
import type { EntityView, ProjectView } from '@eadp/contracts';
import type { Transaction } from './database.js';
import type { Actor } from '../auth/gitlab.js';
export const newId = () => randomUUID();
export const now = () => new Date().toISOString();
export async function project(c: Transaction, id: string, lock = false): Promise<ProjectView> {
  const result = await c.query<{ data: ProjectView }>(`SELECT data FROM studio_projects WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [id]);
  requireCondition(result.rows[0], 'PROJECT_NOT_FOUND', 'Project was not found', 404); return result.rows[0].data;
}
export async function saveProject(c: Transaction, value: ProjectView) { await c.query('UPDATE studio_projects SET data=$2 WHERE id=$1', [value.id, value]); }
export async function entities(c: Transaction, projectId: string): Promise<EntityView[]> {
  return (await c.query<{ data: EntityView }>('SELECT data FROM studio_entities WHERE project_id=$1 ORDER BY id', [projectId])).rows.map(r => r.data);
}
export async function saveEntity(c: Transaction, projectId: string, value: EntityView) {
  await c.query('INSERT INTO studio_entities(project_id,id,data) VALUES($1,$2,$3) ON CONFLICT(project_id,id) DO UPDATE SET data=excluded.data', [projectId, value.id, value]);
  if (value.occupation) await c.query('UPDATE studio_occupations SET data=$2 WHERE id=$1 AND active', [value.occupation.occupationId, value.occupation]);
}
export function entity(all: EntityView[], id: string): EntityView { const value = all.find(e => e.id === id); requireCondition(value, 'ENTITY_NOT_FOUND', 'Entity was not found', 404); return value; }
export async function audit(c: Transaction, projectId: string, actor: Actor, action: string, data: unknown) { await c.query('INSERT INTO studio_audit(project_id,actor_id,action,data) VALUES($1,$2,$3,$4)', [projectId, actor.id, action, data]); }
export function requestHash(input: unknown) { return createHash('sha256').update(canonical(input)).digest('hex'); }
export async function previous(c: Transaction, projectId: string, actor: Actor, action: string, input: { idempotencyKey: string }): Promise<{ found: boolean; result?: unknown }> {
  const row = (await c.query<{ actor_id: string; action: string; request_hash: string; result: unknown }>('SELECT actor_id,action,request_hash,result FROM studio_operations WHERE project_id=$1 AND key=$2', [projectId, input.idempotencyKey])).rows[0];
  if (!row) return { found: false };
  requireCondition(Number(row.actor_id) === actor.id && row.action === action && row.request_hash === requestHash(input), 'IDEMPOTENCY_CONFLICT', 'Idempotency key has already been used for another request');
  return { found: true, result: row.result };
}
export async function remember(c: Transaction, projectId: string, actor: Actor, action: string, input: { idempotencyKey: string }, result: unknown) {
  await c.query('INSERT INTO studio_operations(project_id,key,actor_id,action,request_hash,result) VALUES($1,$2,$3,$4,$5,$6)', [projectId, input.idempotencyKey, actor.id, action, requestHash(input), result]);
  await audit(c, projectId, actor, action, { idempotencyKey: input.idempotencyKey });
}
