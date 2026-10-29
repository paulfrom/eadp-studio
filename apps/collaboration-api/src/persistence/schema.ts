import { readFile } from 'node:fs/promises';
import { requireCondition } from '@eadp/asset-domain';
import type { Transaction } from './database.js';

export async function schemaApplied(c: Transaction): Promise<boolean> {
  const present = ((await c.query("SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='studio_users'")).rowCount ?? 0) > 0;
  if (!present) return false;
  const columns = (await c.query<{ table_name: string; column_name: string; is_nullable: string }>("SELECT table_name,column_name,is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name LIKE 'studio_%'")).rows;
  const has = (table: string, column: string) => columns.some(row => row.table_name === table && row.column_name === column);
  const claimTaskNullable = columns.some(row => row.table_name === 'studio_prototype_development_claims' && row.column_name === 'task_id' && row.is_nullable === 'YES');
  requireCondition(has('studio_projects', 'state') && has('studio_entities', 'code') && has('studio_entity_numbers', 'request_hash') && has('studio_confirmations', 'stage') && has('studio_entity_scenario_sources', 'scenario_confirmation_id') && has('studio_prototype_task_requirements', 'task_id') && has('studio_prototype_development_claims', 'commit_id') && has('studio_prototype_development_claims', 'remote_ref') && claimTaskNullable && !has('studio_entities', 'data') && !has('studio_projects', 'data') && !has('studio_confirmations', 'metadata'), 'SCHEMA_MODEL_MISMATCH', 'The database does not use the current relational model; initialize a new database with the maintained schema', 500);
  return true;
}

export async function applySchema(c: Transaction): Promise<void> {
  const schema = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8');
  await c.query(schema);
}
