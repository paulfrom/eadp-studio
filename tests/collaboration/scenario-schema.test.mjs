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

  await pool.query("INSERT INTO studio_categories(project_id,id,name,creator_id,creator_account,creator_name,last_editor_id,last_editor_account,last_editor_name) VALUES('project-a','requirements','Requirements',1,'schema-test','Schema Test',1,'schema-test','Schema Test')");

  const insertEntity = async (id, kind, sequence) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
    const code = `SC-${String(sequence).padStart(4, '0')}`;
    if (kind === 'scenario') await client.query("INSERT INTO studio_entity_numbers(project_id,sequence,code,operation_key,entity_id,request_hash,creator_id,creator_account,creator_name) VALUES($1,$2,$3,$4,$5,$6,1,'schema-test','Schema Test')", ['project-a', sequence, code, `create-${id}`, id, fingerprint]);
    await client.query(`INSERT INTO studio_entities(project_id,id,kind,sequence,code,title,template_ref,category_id,template_id,creator_id,creator_account,creator_name,last_editor_id,last_editor_account,last_editor_name)
      VALUES('project-a',$1,$2,$3,$4,$1,$5,$6,$7,1,'schema-test','Schema Test',1,'schema-test','Schema Test')`, [id, kind, kind === 'scenario' ? sequence : null, kind === 'scenario' ? code : null, kind === 'scenario' ? { commitSha, path: '.template/scenario.md', sha256: contentHash } : null, kind === 'scenario' ? null : 'requirements', kind === 'scenario' ? 'scenario' : null]);
    await client.query(`INSERT INTO studio_occupations(id,project_id,entity_id,generation,owner_id,purpose,task_id,client_id,expected_revision,input_version,creator_id,creator_account,creator_name,last_editor_id,last_editor_account,last_editor_name)
      VALUES($1,'project-a',$2,1,1,'design',$1,'schema-test',0,0,1,'schema-test','Schema Test',1,'schema-test','Schema Test')`, [`occupation-${id}`, id]);
    await client.query(`INSERT INTO studio_integrations(id,project_id,scope,entity_id,occupation_id,status,source_sha,expected_head,candidate_sha,allowed_paths,request,creator_id,creator_account,creator_name,last_editor_id,last_editor_account,last_editor_name)
      VALUES($1,'project-a','material',$2,$3,'accepted',$4,$4,$4,$5,'{}',1,'schema-test','Schema Test',1,'schema-test','Schema Test')`, [`integration-${id}`, id, `occupation-${id}`, commitSha, [`${kind}/${id}.md`]]);
    if (kind === 'requirement') {
      await client.query("INSERT INTO studio_scenario_requirements(project_id,scenario_id,requirement_id,creator_id,creator_account,creator_name) VALUES('project-a','scenario-a',$1,1,'schema-test','Schema Test')", [id]);
      await client.query("INSERT INTO studio_entity_scenario_sources(project_id,entity_id,scenario_confirmation_id,creator_id,creator_account,creator_name) VALUES('project-a',$1,'scenario-confirmed',1,'schema-test','Schema Test')", [id]);
    }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
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
    await confirm('scenario-confirmed', 'scenario-a');
    await insertEntity('requirement-a', 'requirement', 2);
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

  await t.test('only scenarios have immutable allocated numbers, including more than four digits', async () => {
    await insertEntity('scenario-large', 'scenario', 10000);
    assert.equal((await pool.query("SELECT code FROM studio_entities WHERE project_id='project-a' AND id='scenario-large'")).rows[0].code, 'SC-10000');
    const requirement = (await pool.query("SELECT sequence,code,category_id FROM studio_entities WHERE project_id='project-a' AND id='requirement-a'")).rows[0];
    assert.deepEqual(requirement, { sequence: null, code: null, category_id: 'requirements' });
    await assert.rejects(pool.query("UPDATE studio_entities SET code='SC-10001' WHERE project_id='project-a' AND id='scenario-large'"), /identity, kind, sequence and code are immutable/);
    await assert.rejects(pool.query("UPDATE studio_entity_numbers SET entity_id='stolen' WHERE project_id='project-a' AND sequence=10000"), /cannot be modified/);
    await assert.rejects(pool.query("DELETE FROM studio_entity_numbers WHERE project_id='project-a' AND sequence=10000"), /immutable fixed records/);
    await assert.rejects(pool.query("UPDATE studio_entities SET category_id='requirements' WHERE project_id='project-a' AND id='scenario-large'"), { code: '23514' });
  });


  const inTransaction = async action => {
    const client = await pool.connect();
    try { await client.query('BEGIN'); await action(client); await client.query('COMMIT'); }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  };
  const insertDraft = (client, projectId, id) => client.query(`INSERT INTO studio_entities
    (project_id,id,kind,title,category_id,creator_id,creator_account,creator_name,last_editor_id,last_editor_account,last_editor_name)
    VALUES($1,$2,'requirement','Draft requirement','requirements',1,'schema-test','Schema Test',1,'schema-test','Schema Test')`, [projectId, id]);

  await t.test('draft fixed sources are mandatory, typed and equal the current scenario relationship set', async () => {
    await assert.rejects(inTransaction(c => insertDraft(c, 'project-a', 'orphan-draft')), /requires at least one confirmed scenario source/);
    await assert.rejects(pool.query("DELETE FROM studio_entity_scenario_sources WHERE project_id='project-a' AND entity_id='requirement-a'"), /requires at least one confirmed scenario source/);
    await assert.rejects(pool.query("DELETE FROM studio_scenario_requirements WHERE project_id='project-a' AND requirement_id='requirement-a'"), /relations must match its fixed sources/);
    await assert.rejects(pool.query("UPDATE studio_entity_scenario_sources SET scenario_confirmation_id='requirement-confirmed' WHERE project_id='project-a' AND entity_id='requirement-a'"), /fixed scenario material versions/);
    await confirm('scenario-confirmed-v2', 'scenario-a', { version: 2 });
    await assert.rejects(pool.query(`INSERT INTO studio_entity_scenario_sources(project_id,entity_id,scenario_confirmation_id,creator_id,creator_account,creator_name)
      VALUES('project-a','requirement-a','scenario-confirmed-v2',1,'schema-test','Schema Test')`), /one fixed version per scenario/);
    await confirm('scenario-large-confirmed', 'scenario-large');
    await inTransaction(async c => {
      await c.query("DELETE FROM studio_entity_scenario_sources WHERE project_id='project-a' AND entity_id='requirement-a'");
      await c.query("DELETE FROM studio_scenario_requirements WHERE project_id='project-a' AND requirement_id='requirement-a'");
      await c.query(`INSERT INTO studio_entity_scenario_sources(project_id,entity_id,scenario_confirmation_id,creator_id,creator_account,creator_name)
        VALUES('project-a','requirement-a','scenario-large-confirmed',1,'schema-test','Schema Test')`);
      await c.query(`INSERT INTO studio_scenario_requirements(project_id,scenario_id,requirement_id,creator_id,creator_account,creator_name)
        VALUES('project-a','scenario-large','requirement-a',1,'schema-test','Schema Test')`);
    });
    assert.equal((await pool.query("SELECT scenario_confirmation_id FROM studio_entity_scenario_sources WHERE entity_id='requirement-a'")).rows[0].scenario_confirmation_id, 'scenario-large-confirmed');
  });

  await t.test('cross-project and cross-entity control references are rejected by the database', async () => {
    await pool.query(`INSERT INTO studio_categories(project_id,id,name,creator_id,creator_account,creator_name,last_editor_id,last_editor_account,last_editor_name)
      VALUES('project-b','requirements','Requirements',1,'schema-test','Schema Test',1,'schema-test','Schema Test')`);
    await assert.rejects(inTransaction(async c => {
      await insertDraft(c, 'project-b', 'foreign-source-draft');
      await c.query(`INSERT INTO studio_entity_scenario_sources(project_id,entity_id,scenario_confirmation_id,creator_id,creator_account,creator_name)
        VALUES('project-b','foreign-source-draft','scenario-confirmed',1,'schema-test','Schema Test')`);
    }), /same project/);
    await assert.rejects(pool.query("UPDATE studio_entities SET current_confirmation_id='scenario-confirmed' WHERE project_id='project-a' AND id='requirement-a'"), { code: '23503' });
    await assert.rejects(pool.query("UPDATE studio_entities SET project_id='project-b' WHERE project_id='project-a' AND id='scenario-large'"), /identity, kind, sequence and code are immutable/);
    await assert.rejects(pool.query("UPDATE studio_integrations SET project_id='project-b' WHERE id='integration-scenario-large'"), { code: '23503' });
    await assert.rejects(pool.query(`INSERT INTO studio_repair_tasks(id,project_id,entity_id,occupation_id,user_action_id,start_hash,status,creator_id,creator_account,creator_name,last_editor_id,last_editor_account,last_editor_name)
      VALUES('wrong-occupation','project-a','requirement-a','occupation-scenario-a','wrong-occupation',$1,'terminated',1,'schema-test','Schema Test',1,'schema-test','Schema Test')`, [contentHash]), { code: '23503' });
  });

  await t.test('a repair authorization action cannot start a second task after termination', async () => {
    const insertRepair = id => pool.query(`INSERT INTO studio_repair_tasks(id,project_id,entity_id,occupation_id,user_action_id,start_hash,status,creator_id,creator_account,creator_name,last_editor_id,last_editor_account,last_editor_name)
      VALUES($1,'project-a','scenario-a','occupation-scenario-a','one-authorization',$2,'terminated',1,'schema-test','Schema Test',1,'schema-test','Schema Test')`, [id, contentHash]);
    await insertRepair('first-authorization');
    await assert.rejects(insertRepair('reused-authorization'), { code: '23505' });
  });

});
