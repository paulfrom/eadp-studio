import assert from 'node:assert/strict';
import test from 'node:test';
import type { Transaction } from './database.js';
import { schemaApplied } from './schema.js';

const requiredColumns: Array<[string, string]> = [
  ['studio_projects', 'state'], ['studio_entities', 'code'], ['studio_entity_numbers', 'request_hash'],
  ['studio_confirmations', 'stage'], ['studio_entity_scenario_sources', 'scenario_confirmation_id'],
  ['studio_prototype_task_requirements', 'task_id'], ['studio_prototype_development_claims', 'commit_id'],
  ['studio_prototype_development_claims', 'remote_ref'], ['studio_prototype_development_claims', 'task_id'],
];
function database(columns: Array<[string, string]>, claimTaskNullable = true): Transaction {
  return { query: async (text: string) => text.includes('information_schema.tables')
    ? { rows: [{}], rowCount: 1 }
    : { rows: columns.map(([table_name, column_name]) => ({ table_name, column_name, is_nullable: table_name === 'studio_prototype_development_claims' && column_name === 'task_id' && claimTaskNullable ? 'YES' : 'NO' })), rowCount: columns.length } } as Transaction;
}

test('schemaApplied accepts the current development claim model', async () => {
  assert.equal(await schemaApplied(database(requiredColumns)), true);
});

test('schemaApplied rejects a claim table that cannot represent administrative occupancy', async () => {
  await assert.rejects(schemaApplied(database(requiredColumns, false)), error => (error as { code?: string }).code === 'SCHEMA_MODEL_MISMATCH');
});

test('schemaApplied rejects a database without the current development claim fields', async () => {
  await assert.rejects(schemaApplied(database(requiredColumns.filter(([, column]) => column !== 'commit_id'))), error => (error as { code?: string }).code === 'SCHEMA_MODEL_MISMATCH');
});
