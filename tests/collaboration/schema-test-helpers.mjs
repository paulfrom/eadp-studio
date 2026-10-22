export const audit = {
  created: { creator_id: 1, creator_account: 'schema-test', creator_name: 'Schema Test' },
  mutable: { creator_id: 1, creator_account: 'schema-test', creator_name: 'Schema Test', last_editor_id: 1, last_editor_account: 'schema-test', last_editor_name: 'Schema Test' }
};
export const fixed = { fingerprint: '1'.repeat(64), commitSha: '2'.repeat(40), contentHash: '3'.repeat(64) };

/** Executes the complete deferred-constraint transaction and releases its client. */
export async function inTransaction(pool, action) {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const result = await action(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

/** Inserts test-authored fixture identifiers with parameterized field values. */
export function insert(client, table, fields) {
  const entries = Object.entries(fields);
  return client.query(`INSERT INTO ${table} (${entries.map(([name]) => name).join(',')}) VALUES (${entries.map((_, i) => `$${i + 1}`).join(',')})`, entries.map(([, value]) => value));
}

export function createProject(client, id) {
  return insert(client, 'studio_projects', { id, key: `creation-${id}`, request_hash: fixed.fingerprint, namespace_id: 10, namespace_path: 'schema-tests', path: id, name: id, marker: `marker-${id}`, ...audit.mutable });
}

/** Atomically accepts the real general-scenario identity and project initialization. */
export function initialize(pool, projectId, overrides = {}) {
  return inTransaction(pool, async c => {
    const entityId = `general-${projectId}`, confirmationId = `general-confirmed-${projectId}`;
    await c.query("UPDATE studio_projects SET state='assigned',gitlab_project_id=$1,repository_url=$2 WHERE id=$3", [projectId === 'project-a' ? 101 : 102, `https://example.invalid/${projectId}.git`, projectId]);
    await insert(c, 'studio_project_initializations', { id: `init-${projectId}`, project_id: projectId, operation_key: `initialize-${projectId}`, request_hash: fixed.fingerprint, commit_sha: fixed.commitSha, ...audit.created });
    await insert(c, 'studio_entity_numbers', { project_id: projectId, kind: 'scenario', sequence: 99, code: 'SC-0099', operation_key: `create-${entityId}`, entity_id: entityId, request_hash: fixed.fingerprint, ...audit.created });
    await insert(c, 'studio_entities', { project_id: projectId, id: entityId, kind: 'scenario', builtin_key: 'general', sequence: 99, code: 'SC-0099', title: 'General', ...audit.mutable });
    await insert(c, 'studio_confirmations', { id: confirmationId, project_id: projectId, entity_id: entityId, version: 1, revision: 1, title: 'General', summary: 'System scope', commit_sha: fixed.commitSha, path: `场景/${entityId}.md`, sha256: fixed.contentHash, acceptance_kind: 'system-provisioned', initialization_id: `init-${projectId}`, ...overrides });
    await c.query("UPDATE studio_entities SET current_confirmation_id=$1,material_version=1,confirmation_status='confirmed' WHERE project_id=$2 AND id=$3", [confirmationId, projectId, entityId]);
    await c.query("UPDATE studio_projects SET state='ready',recognized_head=$1 WHERE id=$2", [fixed.commitSha, projectId]);
  });
}

/** Builds an ordinary numbered material with fixed sources and its own occupation. */
export function createEntity(pool, id, kind, sequence, { projectId = 'project-a', sources = [] } = {}) {
  return inTransaction(pool, async c => {
    const code = `${kind === 'scenario' ? 'SC' : 'REQ'}-${String(sequence).padStart(4, '0')}`;
    await insert(c, 'studio_entity_numbers', { project_id: projectId, kind, sequence, code, operation_key: `create-${id}`, entity_id: id, request_hash: fixed.fingerprint, ...audit.created });
    await insert(c, 'studio_entities', { project_id: projectId, id, kind, sequence, code, title: id, template_id: kind, template_ref: { commitSha: fixed.commitSha, path: `.template/${kind}.md`, sha256: fixed.contentHash }, ...audit.mutable });
    for (const source of sources) {
      const scenarioId = (await c.query('SELECT entity_id FROM studio_confirmations WHERE id=$1', [source])).rows[0].entity_id;
      await insert(c, 'studio_scenario_requirements', { project_id: projectId, scenario_id: scenarioId, requirement_id: id, ...audit.created });
      await insert(c, 'studio_entity_scenario_sources', { project_id: projectId, entity_id: id, scenario_confirmation_id: source, ...audit.created });
    }
    await insert(c, 'studio_occupations', { id: `occupation-${id}`, project_id: projectId, entity_id: id, generation: 1, owner_id: 1, purpose: 'design', task_id: id, client_id: 'schema-test', expected_revision: 0, input_version: 0, ...audit.mutable });
    await insert(c, 'studio_integrations', { id: `integration-${id}`, project_id: projectId, scope: 'material', entity_id: id, occupation_id: `occupation-${id}`, status: 'accepted', source_sha: fixed.commitSha, expected_head: fixed.commitSha, candidate_sha: fixed.commitSha, allowed_paths: [`${kind}/${id}.md`], request: {}, ...audit.mutable });
  });
}

/** Accepts one immutable fixed version and the entire declared source set together. */
export function confirm(pool, id, entityId, { projectId = 'project-a', applicability = 'applicable', reason = null, sources = [], sourceCount = sources.length, version = 1, stage = 'material', integrationId = `integration-${entityId}` } = {}) {
  return inTransaction(pool, async c => {
    await insert(c, 'studio_confirmations', { id, project_id: projectId, entity_id: entityId, version, stage, revision: version, title: entityId, summary: 'Schema test', commit_sha: fixed.commitSha, path: `${entityId}.md`, sha256: fixed.contentHash, method: 'normal', read_hash: fixed.contentHash, integration_id: integrationId, applicability, applicability_reason: reason, source_count: sourceCount, ...audit.created });
    for (const source of sources) {
      const scenarioId = (await c.query('SELECT entity_id FROM studio_confirmations WHERE id=$1', [source])).rows[0].entity_id;
      await insert(c, 'studio_requirement_sources', { project_id: projectId, confirmation_id: id, scenario_id: scenarioId, scenario_confirmation_id: source });
    }
    if (stage === 'material') await c.query("UPDATE studio_entities SET current_confirmation_id=$1,material_version=$2,confirmation_status='confirmed',revision=$2 WHERE project_id=$3 AND id=$4", [id, version, projectId, entityId]);
  });
}

/** Accepts a finite comparison observation, its inputs and initial findings together. */
export function comparison(pool, id, { result = 'completed', coverage = 'complete', failureCode = null, summary = '', withFinding = false, uncovered = false, fields = {}, input = {}, range = {} } = {}) {
  return inTransaction(pool, async c => {
    await insert(c, 'studio_consistency_comparisons', { id, project_id: 'project-a', entity_id: 'requirement-a', trigger: 'manual', operation_key: `compare-${id}`, request_hash: fixed.fingerprint, result, coverage, failure_code: failureCode, summary, input_count: 1, uncovered_count: uncovered ? 1 : 0, finding_count: withFinding ? 1 : 0, ...audit.created, ...fields });
    await insert(c, 'studio_consistency_inputs', { project_id: 'project-a', comparison_id: id, id: `input-${id}`, ordinal: 1, entity_id: 'requirement-a', path: '需求/requirement-a.md', sha256: fixed.contentHash, local_state: 'draft', range_count: 1, ...input });
    await insert(c, 'studio_consistency_input_ranges', { project_id: 'project-a', comparison_id: id, input_id: `input-${id}`, ordinal: 1, start_line: 1, end_line: 5, ...range });
    if (uncovered) await insert(c, 'studio_consistency_uncovered', { project_id: 'project-a', comparison_id: id, id: `missing-${id}`, ordinal: 1, path: '需求/missing.md', reason: 'missing' });
    if (withFinding) {
      await insert(c, 'studio_consistency_findings', { project_id: 'project-a', comparison_id: id, id: `finding-${id}`, ordinal: 1, summary: 'Scope differs', relation: 'formal', input_count: 1, range_count: 1, ...audit.mutable });
      await insert(c, 'studio_consistency_finding_inputs', { project_id: 'project-a', comparison_id: id, finding_id: `finding-${id}`, input_id: `input-${id}`, ordinal: 1 });
      await insert(c, 'studio_consistency_finding_ranges', { project_id: 'project-a', comparison_id: id, finding_id: `finding-${id}`, input_id: `input-${id}`, ordinal: 1, start_line: 2, end_line: 3 });
    }
  });
}

/** Applies a conditional revision change and its treatment audit as one transaction. */
export function treatFinding(pool, findingId, expectedRevision, operationKey, { action = 'handle', status = 'handled', reminder = false } = {}) {
  return inTransaction(pool, async c => {
    const update = await c.query('UPDATE studio_consistency_findings SET status=$1,reminder=$2,revision=revision+1,last_editor_id=1,last_editor_account=$3,last_editor_name=$4 WHERE project_id=$5 AND id=$6 AND revision=$7 RETURNING revision', [status, reminder, 'schema-test', 'Schema Test', 'project-a', findingId, expectedRevision]);
    if (update.rowCount === 0) return false;
    await insert(c, 'studio_consistency_finding_events', { project_id: 'project-a', id: `event-${operationKey}`, finding_id: findingId, revision: update.rows[0].revision, operation_key: operationKey, request_hash: fixed.fingerprint, action, status, reminder, note: 'Registered by user', ...audit.created });
    return true;
  });
}
