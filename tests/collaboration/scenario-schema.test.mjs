import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from '../../apps/collaboration-api/node_modules/pg/lib/index.js';
import { audit, comparison, createEntity, createProject, confirm, fixed, initialize, inTransaction, insert, treatFinding } from './schema-test-helpers.mjs';

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
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM studio_baselines WHERE entity_id='requirement-large'")).rows[0].n, 0);
    // DAG validation belongs to the relationship service transaction, not this DDL test.
  });

  await t.test('prototype inputs bind completion baseline SHA while preserving the different original material SHA', async () => {
    const completionSha = '4'.repeat(40);
    assert.notEqual(completionSha, fixed.commitSha);
    await inTransaction(pool, async c => {
      await c.query("UPDATE studio_occupations SET active=false,finish_status='completed' WHERE id='occupation-requirement-large'");
      await insert(c, 'studio_occupations', { id: 'prototype-occupation', project_id: 'project-a', entity_id: 'requirement-large', generation: 2, owner_id: 1, purpose: 'prototype', task_id: 'prototype-large', client_id: 'schema-test', expected_revision: 1, input_version: 1, ...audit.mutable });
      await insert(c, 'studio_integrations', { id: 'prototype-integration', project_id: 'project-a', scope: 'prototype', entity_id: 'requirement-large', occupation_id: 'prototype-occupation', status: 'accepted', source_sha: fixed.commitSha, expected_head: fixed.commitSha, candidate_sha: completionSha, allowed_paths: ['prototype/requirement-large'], request: {}, ...audit.mutable });
      await insert(c, 'studio_confirmations', { id: 'prototype-completed', project_id: 'project-a', entity_id: 'requirement-large', version: 1, stage: 'prototype', revision: 1, title: 'requirement-large', summary: 'Completed', commit_sha: fixed.commitSha, path: 'requirement-large.md', sha256: fixed.contentHash, method: 'normal', read_hash: fixed.contentHash, integration_id: 'prototype-integration', ...audit.created });
      await insert(c, 'studio_baselines', { id: 'completed-baseline', project_id: 'project-a', entity_id: 'requirement-large', version: 1, commit_sha: completionSha, confirmation_id: 'prototype-completed', ...audit.created });
      await c.query("UPDATE studio_occupations SET active=false,finish_status='completed' WHERE id='occupation-requirement-a'");
      await insert(c, 'studio_occupations', { id: 'consumer-prototype-occupation', project_id: 'project-a', entity_id: 'requirement-a', generation: 2, owner_id: 1, purpose: 'prototype', task_id: 'prototype-a', client_id: 'schema-test', expected_revision: 1, input_version: 1, ...audit.mutable });
    });
    const input = { project_id: 'project-a', occupation_id: 'consumer-prototype-occupation', requirement_id: 'requirement-large', version: 1, confirmation_id: 'prototype-completed', integration_sha: completionSha, ...audit.created };
    await assert.rejects(insert(pool, 'studio_occupation_inputs', { ...input, confirmation_id: 'requirement-large-confirmed' }), { code: '23503' });
    await assert.rejects(insert(pool, 'studio_occupation_inputs', { ...input, integration_sha: fixed.commitSha }), { code: '23503' });
    await assert.rejects(insert(pool, 'studio_occupation_inputs', { ...input, project_id: 'project-b' }), /requirement in the same project/);
    await insert(pool, 'studio_occupation_inputs', input);
  });

  await t.test('comparison execution, coverage, bounded input identities and line ranges are independently validated', async () => {
    await comparison(pool, 'comparison-main', { withFinding: true });
    await comparison(pool, 'comparison-partial', { coverage: 'partial', uncovered: true });
    await comparison(pool, 'comparison-failed', { result: 'failed', coverage: 'partial', failureCode: 'model-failed', summary: 'Model unavailable' });
    await comparison(pool, 'comparison-cancelled', { result: 'cancelled', coverage: 'partial', failureCode: 'cancelled' });
    await assert.rejects(comparison(pool, 'cancelled-null', { result: 'cancelled', coverage: 'partial' }), { code: '23514' });
    await assert.rejects(comparison(pool, 'complete-missing', { uncovered: true }), { code: '23514' });
    await assert.rejects(comparison(pool, 'too-many-inputs', { fields: { input_count: 101 } }), { code: '23514' });
    await assert.rejects(comparison(pool, 'ordinal-101', { input: { ordinal: 101 } }), { code: '23514' });
    await assert.rejects(comparison(pool, 'invalid-hash', { input: { sha256: 'unread' } }), { code: '23514' });
    await assert.rejects(comparison(pool, 'absolute-path', { input: { path: 'C:/private/requirement.md' } }), { code: '23514' });
    await assert.rejects(comparison(pool, 'parent-path', { input: { path: '../private/requirement.md' } }), { code: '23514' });
    await assert.rejects(comparison(pool, 'reversed-range', { range: { start_line: 10, end_line: 2 } }), { code: '23514' });
    await assert.rejects(comparison(pool, 'line-zero', { range: { start_line: 0 } }), { code: '23514' });
    await assert.rejects(comparison(pool, 'input-project', { input: { entity_id: 'requirement-b' } }), { code: '23503' });
    await assert.rejects(comparison(pool, 'oversized-summary', { summary: 'x'.repeat(501) }), { code: '22001' });
    await assert.rejects(comparison(pool, 'missing-declared-input', { fields: { input_count: 2 } }), /count|collection/i);
    await assert.rejects(insert(pool, 'studio_consistency_finding_inputs', { project_id: 'project-a', comparison_id: 'comparison-main', finding_id: 'finding-comparison-main', input_id: 'input-comparison-partial', ordinal: 2 }), { code: '23503' });
    await assert.rejects(insert(pool, 'studio_consistency_inputs', { project_id: 'project-a', comparison_id: 'comparison-main', id: 'late-input', ordinal: 2, entity_id: 'scenario-a', path: '场景/scenario-a.md', sha256: fixed.contentHash, local_state: 'current' }), /count|collection/i);
    await assert.rejects(comparison(pool, 'operation-replay', { fields: { operation_key: 'compare-comparison-main' } }), { code: '23505' });
  });

  await t.test('automatic comparison acceptance is unique per real confirmation; manual retries keep distinct histories', async () => {
    await comparison(pool, 'automatic-first', { fields: { trigger: 'confirmation', confirmation_id: 'requirement-confirmed' } });
    await assert.rejects(comparison(pool, 'automatic-duplicate', { fields: { trigger: 'confirmation', confirmation_id: 'requirement-confirmed' } }), { code: '23505' });
    await assert.rejects(comparison(pool, 'automatic-foreign-target', { fields: { trigger: 'confirmation', confirmation_id: 'scenario-confirmed' } }), { code: '23503' });
    await comparison(pool, 'manual-again', { withFinding: true });
    assert.equal((await pool.query("SELECT status FROM studio_consistency_findings WHERE id='finding-manual-again'")).rows[0].status, 'pending');
  });

  await t.test('concurrent finding actions use their own revision and keep exactly one idempotent audit event', async () => {
    const findingId = 'finding-comparison-main';
    const before = (await pool.query("SELECT revision,material_version FROM studio_entities WHERE id='requirement-a'")).rows[0];
    await assert.rejects(pool.query("UPDATE studio_consistency_findings SET revision=revision+1,status='handled' WHERE id=$1", [findingId]), /matching treatment event/);
    const results = await Promise.all([treatFinding(pool, findingId, 0, 'concurrent-a'), treatFinding(pool, findingId, 0, 'concurrent-b', { action: 'ignore', status: 'ignored' })]);
    assert.deepEqual(results.sort(), [false, true]);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM studio_consistency_finding_events WHERE finding_id=$1', [findingId])).rows[0].n, 1);
    const event = (await pool.query('SELECT * FROM studio_consistency_finding_events WHERE finding_id=$1', [findingId])).rows[0];
    assert.equal(await treatFinding(pool, findingId, 0, event.operation_key), false);
    await assert.rejects(treatFinding(pool, findingId, 1, event.operation_key, { action: 'remind', status: event.status, reminder: true }), { code: '23505' });
    assert.equal((await pool.query('SELECT revision FROM studio_consistency_findings WHERE id=$1', [findingId])).rows[0].revision, 1);
    assert.equal(await treatFinding(pool, findingId, 1, 'remind-once', { action: 'remind', status: event.status, reminder: true }), true);
    await assert.rejects(pool.query("DELETE FROM studio_consistency_finding_events WHERE finding_id=$1", [findingId]), /immutable/);
    await assert.rejects(pool.query("UPDATE studio_consistency_findings SET revision=revision+1,summary='Rewritten observation' WHERE id=$1", [findingId]), /immutable/);
    assert.deepEqual((await pool.query("SELECT revision,material_version FROM studio_entities WHERE id='requirement-a'")).rows[0], before);
    assert.equal((await pool.query('SELECT status FROM studio_consistency_findings WHERE id=$1', ['finding-manual-again'])).rows[0].status, 'pending');
  });
});
