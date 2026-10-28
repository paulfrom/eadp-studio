import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from '../../apps/collaboration-api/node_modules/pg/lib/index.js';
import { audit, comparison, createEntity, createProject, confirm, fixed, initialize, inTransaction, insert } from './schema-test-helpers.mjs';

// Only an explicitly supplied, empty disposable database may receive this DDL.
const databaseUrl = process.env.SCENARIO_SCHEMA_TEST_DATABASE_URL;

test('collaboration schema on PostgreSQL', { skip: !databaseUrl }, async t => {
  assert.match(new URL(databaseUrl).pathname, /^\/eadp_scenario_schema_check_[a-z0-9_]+$/);
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 16 });
  t.after(() => pool.end());
  assert.equal((await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rowCount, 0, 'the disposable database must be empty');
  const sql = await readFile(new URL('../../apps/collaboration-api/db/schema.sql', import.meta.url), 'utf8');

  await t.test('the actual API DDL applies atomically and refuses a second application', async () => {
    await inTransaction(pool, c => c.query(sql));
    await assert.rejects(inTransaction(pool, c => c.query(sql)), error => ['42P07', '42710'].includes(error.code));
  });

  await t.test('the catalog has no category, batch freeze, material body or local process state', async () => {
    const { rows } = await pool.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public'");
    for (const row of rows) assert.doesNotMatch(row.column_name, /^(category_id|body|content|metadata|messages|prompt|conversation|structure_check_enabled)$/);
    const names = new Set(rows.map(row => row.table_name));
    for (const name of ['studio_categories', 'studio_batch_freezes', 'studio_confirmation_evidence', 'studio_confirmation_files']) assert.ok(!names.has(name), name);
    const values = (await pool.query("SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname IN ('studio_occupation_purpose','studio_integration_scope')")).rows;
    assert.ok(values.every(row => row.enumlabel !== 'scenario-batch'));
  });

  await insert(pool, 'studio_users', { id: 1, username: 'schema-test', name: 'Schema Test', email: 'schema-test@example.invalid', admin: true, password_salt: '0'.repeat(32), password_hash: '0'.repeat(128) });
  await createProject(pool, 'project-a');
  await createProject(pool, 'project-b');

  await t.test('system provisioning is atomic, exclusive and has no fabricated user confirmation credentials', async () => {
    await assert.rejects(initialize(pool, 'project-a', { method: 'normal', read_hash: fixed.contentHash, ...audit.created }), { code: '23514' });
    await initialize(pool, 'project-a');
    await initialize(pool, 'project-b');
    const row = (await pool.query("SELECT acceptance_kind,method,read_hash,integration_id,creator_id FROM studio_confirmations WHERE id='general-confirmed-project-a'")).rows[0];
    assert.deepEqual(row, { acceptance_kind: 'system-provisioned', method: null, read_hash: null, integration_id: null, creator_id: null });
    await assert.rejects(insert(pool, 'studio_project_initializations', { id: 'duplicate-init', project_id: 'project-a', operation_key: 'duplicate', request_hash: fixed.fingerprint, commit_sha: fixed.commitSha, ...audit.created }), /initializ|ready|unique/i);
    await assert.rejects(pool.query("UPDATE studio_entities SET title='Edited general' WHERE id='general-project-a'"), /builtin|built-in|system|内置/i);
    await assert.rejects(insert(pool, 'studio_occupations', { id: 'general-occupation', project_id: 'project-a', entity_id: 'general-project-a', generation: 1, owner_id: 1, purpose: 'design', task_id: 'general', client_id: 'schema-test', expected_revision: 0, input_version: 1, ...audit.mutable }), /builtin|built-in|system|内置/i);
    await assert.rejects(pool.query("UPDATE studio_projects SET state='assigned',recognized_head=NULL WHERE id='project-a'"), /backwards/);
  });

  await t.test('ordinary scenarios and requirements have independent stable numbers and fixed templates', async () => {
    await createEntity(pool, 'scenario-a', 'scenario', 1);
    await confirm(pool, 'scenario-confirmed', 'scenario-a');
    await createEntity(pool, 'requirement-a', 'requirement', 1, { sources: ['scenario-confirmed'] });
    const { rows } = await pool.query("SELECT kind,sequence::int,code,template_id,template_ref FROM studio_entities WHERE id IN ('scenario-a','requirement-a') ORDER BY kind::text");
    assert.deepEqual(rows.map(({ kind, sequence, code }) => ({ kind, sequence, code })), [{ kind: 'requirement', sequence: 1, code: 'REQ-0001' }, { kind: 'scenario', sequence: 1, code: 'SC-0001' }]);
    for (const row of rows) { assert.equal(row.template_id, row.kind); assert.equal(row.template_ref.path, `.template/${row.kind}.md`); }
    await createEntity(pool, 'scenario-large', 'scenario', 10000);
    await createEntity(pool, 'requirement-large', 'requirement', 10000, { sources: ['scenario-confirmed'] });
    assert.equal((await pool.query("SELECT code FROM studio_entities WHERE id='requirement-large'")).rows[0].code, 'REQ-10000');
    await assert.rejects(pool.query("UPDATE studio_entities SET code='REQ-10001' WHERE id='requirement-large'"), /immutable/);
    await assert.rejects(pool.query("UPDATE studio_entity_numbers SET entity_id='stolen' WHERE entity_id='requirement-large'"), /cannot be modified/);
    await assert.rejects(pool.query("DELETE FROM studio_entity_numbers WHERE entity_id='requirement-large'"), /immutable/);
    await assert.rejects(pool.query("UPDATE studio_entities SET template_ref=NULL WHERE id='requirement-a'"), { code: '23514' });
  });

  await t.test('fixed confirmations enforce real sources, applicability and sealed cardinality', async () => {
    await assert.rejects(confirm(pool, 'scenario-inapplicable', 'scenario-a', { version: 2, applicability: 'not-applicable', reason: 'Excluded' }), /must be applicable/);
    await assert.rejects(confirm(pool, 'requirement-no-source', 'requirement-a'), /source|sources/i);
    await assert.rejects(confirm(pool, 'requirement-no-reason', 'requirement-a', { applicability: 'not-applicable', sources: ['scenario-confirmed'] }), { code: '23514' });
    await confirm(pool, 'requirement-confirmed', 'requirement-a', { applicability: 'not-applicable', reason: 'Scope excluded', sources: ['scenario-confirmed'] });
    await confirm(pool, 'scenario-confirmed-v2', 'scenario-a', { version: 2 });
    await confirm(pool, 'scenario-large-confirmed', 'scenario-large');
    await assert.rejects(confirm(pool, 'requirement-missing-source', 'requirement-a', { version: 2, sourceCount: 2, sources: ['scenario-confirmed'] }), /count|cardinality/i);
    await assert.rejects(confirm(pool, 'requirement-extra-source', 'requirement-a', { version: 2, sourceCount: 1, sources: ['scenario-confirmed', 'scenario-large-confirmed'] }), /count|cardinality/i);
    await assert.rejects(confirm(pool, 'requirement-two-versions', 'requirement-a', { version: 2, sources: ['scenario-confirmed', 'scenario-confirmed-v2'] }), { code: '23505' });
    await assert.rejects(insert(pool, 'studio_requirement_sources', { project_id: 'project-a', confirmation_id: 'requirement-confirmed', scenario_id: 'scenario-large', scenario_confirmation_id: 'scenario-large-confirmed' }), /count|cardinality/i);
    await assert.rejects(pool.query("UPDATE studio_requirement_sources SET scenario_confirmation_id='scenario-confirmed-v2' WHERE confirmation_id='requirement-confirmed'"), /immutable/);
    await assert.rejects(pool.query("DELETE FROM studio_requirement_sources WHERE confirmation_id='requirement-confirmed'"), /immutable/);
  });

  await t.test('draft source relationships remain nonempty, typed and independent from old fixed confirmations', async () => {
    await assert.rejects(createEntity(pool, 'orphan-draft', 'requirement', 2), /requires at least one|source/i);
    await assert.rejects(pool.query("DELETE FROM studio_entity_scenario_sources WHERE entity_id='requirement-a'"), /requires at least one/);
    await assert.rejects(pool.query("DELETE FROM studio_scenario_requirements WHERE requirement_id='requirement-a'"), /relations must match/);
    await assert.rejects(insert(pool, 'studio_entity_scenario_sources', { project_id: 'project-a', entity_id: 'requirement-a', scenario_confirmation_id: 'scenario-confirmed-v2', ...audit.created }), /one fixed version per scenario/);
    await assert.rejects(createEntity(pool, 'cross-project-source', 'requirement', 1, { projectId: 'project-b', sources: ['scenario-confirmed'] }), /same project|foreign key/i);
    await inTransaction(pool, async c => {
      await c.query("DELETE FROM studio_entity_scenario_sources WHERE entity_id='requirement-a'");
      await c.query("DELETE FROM studio_scenario_requirements WHERE requirement_id='requirement-a'");
      await insert(c, 'studio_entity_scenario_sources', { project_id: 'project-a', entity_id: 'requirement-a', scenario_confirmation_id: 'scenario-large-confirmed', ...audit.created });
      await insert(c, 'studio_scenario_requirements', { project_id: 'project-a', scenario_id: 'scenario-large', requirement_id: 'requirement-a', ...audit.created });
    });
    assert.equal((await pool.query("SELECT scenario_confirmation_id FROM studio_requirement_sources WHERE confirmation_id='requirement-confirmed'")).rows[0].scenario_confirmation_id, 'scenario-confirmed');
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM studio_occupations WHERE active AND entity_id IN ('scenario-a','requirement-a')")).rows[0].n, 2);
    await assert.rejects(pool.query("UPDATE studio_entities SET current_confirmation_id='scenario-confirmed' WHERE id='requirement-a'"), { code: '23503' });
  });

  await t.test('prerequisites bind exact material versions without requiring prototype completion', async () => {
    await confirm(pool, 'requirement-large-confirmed', 'requirement-large', { sources: ['scenario-confirmed'] });
    const prerequisite = { project_id: 'project-a', entity_id: 'requirement-a', requirement_id: 'requirement-large', version: 1, confirmation_id: 'requirement-large-confirmed', ...audit.created };
    await assert.rejects(insert(pool, 'studio_prerequisites', { ...prerequisite, version: 2 }), { code: '23503' });
    await assert.rejects(insert(pool, 'studio_prerequisites', { ...prerequisite, confirmation_id: 'scenario-confirmed' }), { code: '23503' });
    await assert.rejects(insert(pool, 'studio_prerequisites', { ...prerequisite, entity_id: 'requirement-large' }), { code: '23514' });
    await createEntity(pool, 'requirement-b', 'requirement', 1, { projectId: 'project-b', sources: ['general-confirmed-project-b'] });
    await confirm(pool, 'requirement-b-confirmed', 'requirement-b', { projectId: 'project-b', sources: ['general-confirmed-project-b'] });
    await assert.rejects(insert(pool, 'studio_prerequisites', { ...prerequisite, requirement_id: 'requirement-b', confirmation_id: 'requirement-b-confirmed' }), /requirement in the same project/);
    await insert(pool, 'studio_prerequisites', prerequisite);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM studio_prototype_baseline_requirements WHERE requirement_id='requirement-large'")).rows[0].n, 0);
    // DAG validation belongs to the relationship service transaction, not this DDL test.
  });

  await t.test('prototype development claims exclude concurrent tasks for the same requirement', async () => {
    await insert(pool, 'studio_prototypes', { id: 'prototype-a', project_id: 'project-a', creator_id: 1 });
    const task = { project_id: 'project-a', prototype_id: 'prototype-a', owner_id: 1, client_id: 'schema-test', generation: 1, revision: 0, status: 'active', title: '事项', start_head: fixed.commitSha, source_base_head: fixed.commitSha, write_scope: ['src/pages/'], policy_hash: 'a'.repeat(64), claims_digest: 'b'.repeat(64), instruction: {} };
    await insert(pool, 'studio_prototype_tasks', { ...task, id: 'prototype-task-a', branch: 'studio/a' });
    await insert(pool, 'studio_prototype_tasks', { ...task, id: 'prototype-task-b', branch: 'studio/b' });
    await insert(pool, 'studio_prototype_development_claims', { id: 'claim-a', project_id: 'project-a', task_id: 'prototype-task-a', requirement_id: 'requirement-large', generation: 1 });
    const second = { id: 'claim-b', project_id: 'project-a', task_id: 'prototype-task-b', requirement_id: 'requirement-large', generation: 2 };
    await assert.rejects(insert(pool, 'studio_prototype_development_claims', second), { code: '23505' });
    await pool.query("UPDATE studio_prototype_development_claims SET active=false,ended_reason='cancelled' WHERE id='claim-a'");
    await insert(pool, 'studio_prototype_development_claims', second);
    await assert.rejects(insert(pool, 'studio_prototype_task_references', { project_id: 'project-b', task_id: 'prototype-task-b', requirement_id: 'requirement-large' }), { code: '23503' });
  });

  await t.test('comparison results, coverage and sealed conflict sets are independently validated', async () => {
    await comparison(pool, 'comparison-main', { conflicts: 1 });
    await comparison(pool, 'comparison-partial', { coverage: 'partial' });
    await comparison(pool, 'comparison-failed', { result: 'failed', coverage: 'partial', failureCode: 'model-failed', summary: 'Model unavailable' });
    await comparison(pool, 'comparison-cancelled', { result: 'cancelled', coverage: 'partial', failureCode: 'cancelled' });
    await assert.rejects(comparison(pool, 'cancelled-null', { result: 'cancelled', coverage: 'partial' }), { code: '23514' });
    await assert.rejects(comparison(pool, 'completed-with-code', { failureCode: 'model-failed' }), { code: '23514' });
    await assert.rejects(comparison(pool, 'failed-without-code', { result: 'failed', summary: 'No code' }), { code: '23514' });
    await assert.rejects(comparison(pool, 'too-many-conflicts', { fields: { conflict_count: 101 } }), { code: '23514' });
    await assert.rejects(comparison(pool, 'ordinal-101', { conflicts: 1, conflict: { ordinal: 101 } }), { code: '23514' });
    await assert.rejects(comparison(pool, 'blank-conflict', { conflicts: 1, conflict: { summary: '  ' } }), { code: '23514' });
    await assert.rejects(comparison(pool, 'conflict-without-entity', { conflicts: 1, conflict: { entity_count: 0 } }), { code: '23514' });
    await assert.rejects(comparison(pool, 'oversized-summary', { summary: 'x'.repeat(501) }), { code: '22001' });
    await assert.rejects(comparison(pool, 'missing-declared-conflict', { fields: { conflict_count: 2 } }), /count|collection/i);
    await assert.rejects(comparison(pool, 'missing-declared-entity', { conflicts: 1, conflict: { entity_count: 2 } }), /count|collection/i);
    await assert.rejects(comparison(pool, 'foreign-conflict-entity', { conflicts: 1, involved: 'requirement-b' }), { code: '23503' });
    await assert.rejects(insert(pool, 'studio_consistency_conflicts', { project_id: 'project-a', comparison_id: 'comparison-partial', id: 'late-conflict', ordinal: 1, summary: 'Late', relation: 'formal', entity_count: 1 }), /count|collection/i);
    await assert.rejects(insert(pool, 'studio_consistency_conflicts', { project_id: 'project-b', comparison_id: 'comparison-main', id: 'cross-project', ordinal: 1, summary: 'Cross', relation: 'formal', entity_count: 1 }), { code: '23503' });
    await assert.rejects(comparison(pool, 'operation-replay', { fields: { operation_key: 'compare-comparison-main' } }), { code: '23505' });
    assert.equal((await pool.query("SELECT summary FROM studio_consistency_conflicts WHERE comparison_id='comparison-main'")).rows[0].summary, 'Scope differs');
    await assert.rejects(pool.query("UPDATE studio_consistency_comparisons SET conflict_count=0 WHERE id='comparison-main'"), /immutable/);
    await assert.rejects(pool.query("UPDATE studio_consistency_conflicts SET summary='rewritten' WHERE comparison_id='comparison-main'"), /immutable/);
    await assert.rejects(pool.query("DELETE FROM studio_consistency_conflicts WHERE comparison_id='comparison-main'"), /immutable/);
    await assert.rejects(pool.query("UPDATE studio_consistency_conflict_entities SET entity_id='scenario-large' WHERE comparison_id='comparison-main'"), /immutable/);
  });

  await t.test('automatic comparison acceptance is unique per real confirmation and conflict ids stay comparison-scoped', async () => {
    await comparison(pool, 'automatic-first', { fields: { trigger: 'confirmation', confirmation_id: 'requirement-confirmed' } });
    await assert.rejects(comparison(pool, 'automatic-duplicate', { fields: { trigger: 'confirmation', confirmation_id: 'requirement-confirmed' } }), { code: '23505' });
    await assert.rejects(comparison(pool, 'automatic-foreign-target', { fields: { trigger: 'confirmation', confirmation_id: 'scenario-confirmed' } }), { code: '23503' });
    await assert.rejects(comparison(pool, 'automatic-without-confirmation', { fields: { trigger: 'confirmation' } }), { code: '23514' });
    await comparison(pool, 'manual-again', { conflicts: 1 });
    assert.deepEqual((await pool.query("SELECT comparison_id FROM studio_consistency_conflicts WHERE id='conflict-manual-again'")).rows, [{ comparison_id: 'manual-again' }]);
    const counts = (await pool.query("SELECT x.id,conflict_count::int AS sealed,(SELECT count(*)::int FROM studio_consistency_conflicts c WHERE c.project_id=x.project_id AND c.comparison_id=x.id) AS actual FROM studio_consistency_comparisons x ORDER BY x.id")).rows;
    assert.ok(counts.every(row => row.sealed === row.actual), JSON.stringify(counts));
  });
});
