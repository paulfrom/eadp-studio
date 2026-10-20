import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from '../../apps/collaboration-api/node_modules/pg/lib/index.js';

// An explicitly supplied fresh disposable database is required. Never load the
// target design over the existing collaboration API's runtime schema.
const databaseUrl = process.env.SCENARIO_SCHEMA_TEST_DATABASE_URL;

test('stage-one scenario schema on PostgreSQL', { skip: !databaseUrl }, async t => {
  assert.match(new URL(databaseUrl).pathname, /^\/eadp_scenario_schema_check_[a-z0-9_]+$/);
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 16 });
  t.after(() => pool.end());
  const existing = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
  assert.equal(existing.rowCount, 0, 'the disposable database must be empty');
  const sql = await readFile(new URL('../../docs/design/scenarios/schema.sql', import.meta.url), 'utf8');

  await t.test('DDL applies to an empty database in one transaction', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  await t.test('the script refuses a second application', async () => {
    await assert.rejects(pool.query(sql), error => error.code === '42P07' || error.code === '42710');
  });

  await t.test('scenario data has no category, plaintext body, conversation or local preference column', async () => {
    const result = await pool.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public'");
    assert.ok(result.rowCount > 0);
    for (const row of result.rows) {
      assert.doesNotMatch(row.column_name, /^(body|content|messages|prompt|conversation|structure_check_enabled)$/);
      if (/scenario/.test(row.table_name)) assert.doesNotMatch(row.column_name, /category/);
    }
    assert.ok(!result.rows.some(row => row.table_name === 'studio_confirmations' && row.column_name === 'metadata'));
    const removed = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename IN ('studio_project_creations','studio_confirmation_evidence','studio_confirmation_files')");
    assert.equal(removed.rowCount, 0);
  });

  await pool.query(`INSERT INTO studio_users(id,username,name,email,admin,password_salt,password_hash)
    VALUES(1,'schema-test','Schema Test','schema-test@example.invalid',true,$1,$2)`, ['0'.repeat(32), '0'.repeat(128)]);
  const fingerprint = '1'.repeat(64), commitSha = '2'.repeat(40), contentHash = '3'.repeat(64);
  const insertProject = (id, key, path, marker) => pool.query(`INSERT INTO studio_projects
    (id,key,request_hash,namespace_id,namespace_path,path,name,marker,creator_id,creator_account,creator_name,last_editor_id,last_editor_account,last_editor_name)
    VALUES($1,$2,$3,10,'schema-tests',$4,'Schema Test',$5,1,'schema-test','Schema Test',1,'schema-test','Schema Test')`, [id, key, fingerprint, path, marker]);

  await t.test('one project record preserves reservation uniqueness and verifies lifecycle stages', async () => {
    await insertProject('project-a', 'creation-a', 'project-a', 'marker-a');
    assert.equal((await pool.query("SELECT state FROM studio_projects WHERE id='project-a'")).rows[0].state, 'reserved');
    await assert.rejects(insertProject('duplicate-key', 'creation-a', 'another-path', 'another-marker'), { code: '23505' });
    await assert.rejects(insertProject('duplicate-path', 'another-key', 'project-a', 'another-marker'), { code: '23505' });
    await assert.rejects(insertProject('duplicate-marker', 'another-key', 'another-path', 'marker-a'), { code: '23505' });
    await assert.rejects(pool.query("UPDATE studio_projects SET state='created' WHERE id='project-a'"), { code: '23514' });
    await assert.rejects(pool.query("UPDATE studio_projects SET gitlab_project_id=101,repository_url='https://example.invalid/project-a.git' WHERE id='project-a'"), { code: '23514' });
    await pool.query("UPDATE studio_projects SET state='creating' WHERE id='project-a'");
    await pool.query("UPDATE studio_projects SET state='created',gitlab_project_id=101,repository_url='https://example.invalid/project-a.git' WHERE id='project-a'");
    await pool.query("UPDATE studio_projects SET state='assigned' WHERE id='project-a'");
    await assert.rejects(pool.query("UPDATE studio_projects SET state='ready' WHERE id='project-a'"), { code: '23514' });
    await pool.query("UPDATE studio_projects SET state='ready',recognized_head=$1 WHERE id='project-a'", [commitSha]);
    await pool.query("UPDATE studio_projects SET name='Renamed Project' WHERE id='project-a'");
    assert.equal((await pool.query("SELECT request_hash FROM studio_projects WHERE id='project-a'")).rows[0].request_hash, fingerprint);
    await assert.rejects(pool.query("UPDATE studio_projects SET request_hash=$1 WHERE id='project-a'", ['4'.repeat(64)]), /original request fingerprint are immutable/);
    await assert.rejects(pool.query("UPDATE studio_projects SET state='assigned',recognized_head=NULL WHERE id='project-a'"), /cannot move backwards/);
    await assert.rejects(pool.query("UPDATE studio_projects SET gitlab_project_id=102 WHERE id='project-a'"), /repository binding is immutable/);
    await insertProject('project-b', 'creation-b', 'project-b', 'marker-b');
    await assert.rejects(pool.query("UPDATE studio_projects SET state='created',gitlab_project_id=101,repository_url='https://example.invalid/project-b.git' WHERE id='project-b'"), { code: '23505' });
  });

  const insertEntity = async (id, kind, sequence) => {
    const code = `SC-${String(sequence).padStart(4, '0')}`;
    await pool.query('INSERT INTO studio_entity_numbers(project_id,sequence,code) VALUES($1,$2,$3)', ['project-a', sequence, code]);
    await pool.query(`INSERT INTO studio_entities(project_id,id,kind,sequence,code,title,template_ref,creator_id,creator_account,creator_name,last_editor_id,last_editor_account,last_editor_name)
      VALUES('project-a',$1,$2,$3,$4,$1,$5,1,'schema-test','Schema Test',1,'schema-test','Schema Test')`, [id, kind, sequence, code, kind === 'scenario' ? { commitSha, path: '.template/scenario.md', sha256: contentHash } : null]);
    await pool.query(`INSERT INTO studio_occupations(id,project_id,entity_id,generation,owner_id,purpose,task_id,client_id,expected_revision,input_version,creator_id,creator_account,creator_name,last_editor_id,last_editor_account,last_editor_name)
      VALUES($1,'project-a',$2,1,1,'design',$1,'schema-test',0,0,1,'schema-test','Schema Test',1,'schema-test','Schema Test')`, [`occupation-${id}`, id]);
    await pool.query(`INSERT INTO studio_integrations(id,project_id,scope,entity_id,occupation_id,status,source_sha,expected_head,candidate_sha,allowed_paths,request,creator_id,creator_account,creator_name,last_editor_id,last_editor_account,last_editor_name)
      VALUES($1,'project-a','material',$2,$3,'accepted',$4,$4,$4,$5,'{}',1,'schema-test','Schema Test',1,'schema-test','Schema Test')`, [`integration-${id}`, id, `occupation-${id}`, commitSha, [`${kind}/${id}.md`]]);
  };
  const confirm = async (id, entityId, { applicability, reason = null, sources = [], version = 1 } = {}) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO studio_confirmations(id,project_id,entity_id,version,revision,title,summary,commit_sha,path,sha256,method,read_hash,integration_id,applicability,applicability_reason,creator_id,creator_account,creator_name)
        VALUES($1,'project-a',$2,$3,1,$2,'Schema test',$4,$5,$6,'normal',$6,$7,COALESCE($8::studio_applicability,'applicable'),$9,1,'schema-test','Schema Test')`,
      [id, entityId, version, commitSha, `${entityId}.md`, contentHash, `integration-${entityId}`, applicability ?? null, reason]);
      for (const source of sources) await client.query('INSERT INTO studio_requirement_sources(confirmation_id,scenario_confirmation_id) VALUES($1,$2)', [id, source]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };

  await t.test('confirmation uses fixed Git references and explicit applicability without backend material lists', async () => {
    await insertEntity('scenario-a', 'scenario', 1);
    await insertEntity('requirement-a', 'requirement', 2);
    await confirm('scenario-confirmed', 'scenario-a');
    assert.equal((await pool.query("SELECT applicability FROM studio_confirmations WHERE id='scenario-confirmed'")).rows[0].applicability, 'applicable');
    await assert.rejects(confirm('scenario-invalid', 'scenario-a', { version: 2, applicability: 'not-applicable', reason: 'Only requirements may be inapplicable' }), /must be applicable/);
    await assert.rejects(confirm('requirement-no-source', 'requirement-a'), /requires at least one confirmed scenario source/);
    await assert.rejects(confirm('requirement-no-reason', 'requirement-a', { applicability: 'not-applicable', sources: ['scenario-confirmed'] }), { code: '23514' });
    await assert.rejects(confirm('requirement-blank-reason', 'requirement-a', { applicability: 'not-applicable', reason: '   ', sources: ['scenario-confirmed'] }), { code: '23514' });
    await assert.rejects(confirm('requirement-unexpected-reason', 'requirement-a', { reason: 'Applicable versions have no exception reason', sources: ['scenario-confirmed'] }), { code: '23514' });
    await confirm('requirement-confirmed', 'requirement-a', { applicability: 'not-applicable', reason: 'The changed scenario excludes this scope', sources: ['scenario-confirmed'] });
    await assert.rejects(confirm('requirement-wrong-source', 'requirement-a', { version: 2, sources: ['requirement-confirmed'] }), /sources must be confirmed scenario versions/);
    await assert.rejects(pool.query("UPDATE studio_confirmations SET applicability_reason='changed' WHERE id='requirement-confirmed'"), /immutable fixed records/);
  });
});
