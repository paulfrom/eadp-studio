import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { canonical, DomainError, requireCondition } from '@eadp/asset-domain';
import { isBuiltinScenarioMetadata } from '@eadp/contracts';
import type { BaselineView, BuiltinScenarioMetadata, ConfirmationEvent, ConfirmationInput, EntityView, FixedReference, FixedVersion, IntegrationView, LegacyFixedVersion, MaterialMetadata, OccupationView, ProjectView, ReserveEntityRequest } from '@eadp/contracts';
import type { Actor } from '../auth/session.js';
import type { AdoptionRecord } from '../modules/reuse.js';
import type { StoredIntegration } from '../modules/integration.js';
import { transaction, type Database, type Transaction } from './database.js';

type Row = Record<string, unknown>;
export interface RepositoryContext {
  actor: Pick<Actor, 'id' | 'username' | 'name'>;
  loadMaterial?: (projectId: string, fixed: FixedReference) => Promise<MaterialMetadata>;
  loadBuiltin?: (projectId: string, fixed: FixedReference, entityId: string) => Promise<BuiltinScenarioMetadata>;
}
const contexts = new AsyncLocalStorage<RepositoryContext>();
/** Bind authenticated audit identity and fixed Git content to a request. */
export function withContext<T>(context: RepositoryContext, action: () => T): T { return contexts.run(context, action); }
export function context(): RepositoryContext {
  const value = contexts.getStore();
  requireCondition(value, 'REPOSITORY_CONTEXT_REQUIRED', 'Authenticated repository context is required', 500); return value;
}
function actorFields(): [number, string, string] { const actor = context().actor; return [actor.id, actor.username, actor.name]; }
export async function loadMaterial(projectId: string, fixed: FixedReference): Promise<MaterialMetadata> {
  const loader = context().loadMaterial;
  requireCondition(loader, 'FIXED_CONTENT_LOADER_REQUIRED', 'Accepted material must be read from its fixed Git version', 500);
  return loader(projectId, fixed);
}
/** 系统预置版本的严格读取通道，由持久化的接受途径选择，不作普通解析失败后的兜底。 */
export async function loadBuiltin(projectId: string, fixed: FixedReference, entityId: string): Promise<BuiltinScenarioMetadata> {
  const loader = context().loadBuiltin;
  requireCondition(loader, 'FIXED_CONTENT_LOADER_REQUIRED', 'Accepted material must be read from its fixed Git version', 500);
  return loader(projectId, fixed, entityId);
}
export const newId = () => randomUUID();
export const now = () => new Date().toISOString();
export function requestHash(input: unknown) { return createHash('sha256').update(canonical(input)).digest('hex'); }
const date = (value: unknown): string => value instanceof Date ? value.toISOString() : String(value);
const auditColumns = 'creator_id,creator_account,creator_name,last_editor_id,last_editor_account,last_editor_name';
const actorColumns = 'creator_id,creator_account,creator_name';
function snapshot(row: Row, prefix: 'creator' | 'last_editor') {
  return { id: Number(row[`${prefix}_id`]), account: String(row[`${prefix}_account`]), name: String(row[`${prefix}_name`]), at: date(row[prefix === 'creator' ? 'created_date' : 'last_edited_date']) };
}
function projectView(row: Row): Omit<ProjectView, 'generalScenario'> {
  return { id: String(row.id), gitlabProjectId: Number(row.gitlab_project_id), repositoryUrl: String(row.repository_url), stableBranch: String(row.stable_branch), name: String(row.name), namespaceId: Number(row.namespace_id), namespacePath: String(row.namespace_path), initializationStatus: row.state === 'ready' ? 'ready' : 'pending', recognizedHead: row.recognized_head as string | null, revision: Number(row.revision),
    ...(row.current_baseline_id ? { currentBaselineId: String(row.current_baseline_id) } : {}),
    ...(row.deployment_url ? { deployment: { baselineId: String(row.deployment_baseline_id), url: String(row.deployment_url), artifactSha256: String(row.deployment_artifact_sha256), deployedAt: date(row.deployed_at) } } : {}),
  };
}
async function withGeneralScenario(c: Transaction, view: Omit<ProjectView, 'generalScenario'>): Promise<ProjectView> {
  const reserved = (await c.query<Row>("SELECT entity_id,code FROM studio_entity_numbers WHERE project_id=$1 AND kind='scenario' AND operation_key='general-scenario'", [view.id])).rows[0];
  return { ...view, ...(reserved ? { generalScenario: { entityId: String(reserved.entity_id), code: String(reserved.code) } } : {}) };
}
export async function project(c: Transaction, id: string, lock = false): Promise<ProjectView> {
  const row = (await c.query<Row>(`SELECT * FROM studio_projects WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0];
  requireCondition(row && row.gitlab_project_id !== null, 'PROJECT_NOT_FOUND', 'Project was not found', 404);
  return withGeneralScenario(c, projectView(row));
}
export async function listProjects(c: Transaction): Promise<ProjectView[]> {
  const result: ProjectView[] = [];
  for (const row of (await c.query<Row>("SELECT * FROM studio_projects WHERE state IN ('assigned','ready') ORDER BY id")).rows) result.push(await withGeneralScenario(c, projectView(row)));
  return result;
}
export async function saveProject(c: Transaction, value: ProjectView) {
  await c.query(`UPDATE studio_projects SET name=$2,stable_branch=$3,revision=$4,recognized_head=$5,state=CASE WHEN $6 THEN 'ready'::studio_project_state ELSE state END,current_baseline_id=$7,deployment_baseline_id=$8,deployment_url=$9,deployment_artifact_sha256=$10,deployed_at=$11,last_editor_id=$12,last_editor_account=$13,last_editor_name=$14,last_edited_date=clock_timestamp() WHERE id=$1`, [value.id, value.name, value.stableBranch, value.revision, value.recognizedHead, value.initializationStatus === 'ready', value.currentBaselineId ?? null, value.deployment?.baselineId ?? null, value.deployment?.url ?? null, value.deployment?.artifactSha256 ?? null, value.deployment?.deployedAt ?? null, ...actorFields()]);
}
export interface EntityNumber { id: string; sequence: number; code: string }
/** Commit a stable allocation before business writes so rollback never recycles a number. */
export async function reserveEntityNumber(database: Database, projectId: string, kind: 'scenario' | 'requirement', actor: Actor, input: ReserveEntityRequest): Promise<EntityNumber> {
  return transaction(database, async c => {
    await c.query('INSERT INTO studio_project_counters(project_id,kind) VALUES($1,$2) ON CONFLICT(project_id,kind) DO NOTHING', [projectId, kind]);
    await c.query('SELECT project_id FROM studio_project_counters WHERE project_id=$1 AND kind=$2 FOR UPDATE', [projectId, kind]);
    const completed = (await c.query<Row>('SELECT creator_id,action,request_hash FROM studio_operations WHERE project_id=$1 AND key=$2', [projectId, input.idempotencyKey])).rows[0];
    if (completed) requireCondition(Number(completed.creator_id) === actor.id && completed.action === 'entity.reserve' && completed.request_hash === requestHash(input), 'IDEMPOTENCY_CONFLICT', 'The creation operation already belongs to another request', 409);
    const previous = (await c.query<Row>('SELECT * FROM studio_entity_numbers WHERE project_id=$1 AND operation_key=$2', [projectId, input.idempotencyKey])).rows[0];
    if (previous) {
      requireCondition(Number(previous.creator_id) === actor.id && previous.kind === kind && previous.request_hash === requestHash(input), 'IDEMPOTENCY_CONFLICT', 'The creation operation already belongs to another request', 409);
      return { id: String(previous.entity_id), sequence: Number(previous.sequence), code: String(previous.code) };
    }
    const sequence = Number((await c.query<{ sequence: string }>('UPDATE studio_project_counters SET next_sequence=next_sequence+1 WHERE project_id=$1 AND kind=$2 RETURNING next_sequence-1 AS sequence', [projectId, kind])).rows[0]!.sequence);
    requireCondition(Number.isSafeInteger(sequence), 'ENTITY_NUMBER_EXHAUSTED', 'Entity numbering exceeds the supported range', 409);
    const value = { id: newId(), sequence, code: `${kind === 'scenario' ? 'SC' : 'REQ'}-${String(sequence).padStart(4, '0')}` };
    await c.query(`INSERT INTO studio_entity_numbers(project_id,kind,sequence,code,operation_key,entity_id,request_hash,${actorColumns}) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [projectId, kind, sequence, value.code, input.idempotencyKey, value.id, requestHash(input), actor.id, actor.username, actor.name]);
    return value;
  });
}
export function entity(all: EntityView[], id: string): EntityView { const value = all.find(e => e.id === id); requireCondition(value, 'ENTITY_NOT_FOUND', 'Entity was not found', 404); return value; }
/** Control-row read without fixed-material hydration; comparison paths must not touch Git. */
export async function entityRow(c: Transaction, projectId: string, id: string): Promise<Row> {
  const row = (await c.query<Row>('SELECT * FROM studio_entities WHERE project_id=$1 AND id=$2', [projectId, id])).rows[0];
  requireCondition(row, 'ENTITY_NOT_FOUND', 'Entity was not found', 404); return row;
}
export async function entities(c: Transaction, projectId: string): Promise<EntityView[]> {
  const rows = (await c.query<Row>('SELECT * FROM studio_entities WHERE project_id=$1 ORDER BY last_edited_date DESC,sequence NULLS LAST,id', [projectId])).rows;
  const relationships = (await c.query<Row>('SELECT * FROM studio_scenario_requirements WHERE project_id=$1', [projectId])).rows;
  const prerequisites = (await c.query<Row>('SELECT * FROM studio_prerequisites WHERE project_id=$1', [projectId])).rows;
  const files = (await c.query<{ entity_id: string; path: string }>('SELECT entity_id,path FROM studio_entity_files WHERE project_id=$1 ORDER BY path', [projectId])).rows;
  const sources = (await c.query<Row>('SELECT s.entity_id,f.entity_id AS scenario_id,f.version FROM studio_entity_scenario_sources s JOIN studio_confirmations f ON f.id=s.scenario_confirmation_id WHERE s.project_id=$1', [projectId])).rows;
  const occupations = (await c.query<Row>('SELECT * FROM studio_occupations WHERE project_id=$1 AND active', [projectId])).rows;
  const baselines = await listBaselines(c, projectId);
  const result: EntityView[] = [];
  for (const row of rows) {
    const id = String(row.id), occupation = occupations.find(o => o.entity_id === id);
    const value: EntityView = { id, kind: row.kind as EntityView['kind'], ...(row.builtin_key ? { builtinKey: row.builtin_key as 'general' } : {}), title: String(row.title), summary: String(row.summary), ...(row.sequence !== null ? { sequence: Number(row.sequence), code: String(row.code) } : {}), ...(row.template_ref ? { templateRef: row.template_ref as FixedReference, templateId: String(row.template_id) } : {}), revision: Number(row.revision), generation: Number(row.generation), materialVersion: Number(row.material_version), confirmationStatus: row.confirmation_status as EntityView['confirmationStatus'], taskStatus: row.task_status as EntityView['taskStatus'], scenarioIds: relationships.filter(r => r.requirement_id === id).map(r => String(r.scenario_id)), prerequisites: prerequisites.filter(r => r.entity_id === id).map(r => ({ requirementId: String(r.requirement_id), version: Number(r.version) })), authorId: Number(row.creator_id), creator: snapshot(row, 'creator'), lastEditor: snapshot(row, 'last_editor') };
    value.files = files.filter(file => file.entity_id === id).map(file => file.path);
    if (value.kind === 'requirement') value.scenarioSources = sources.filter(r => r.entity_id === id).map(r => ({ projectId, entityId: String(r.scenario_id), version: Number(r.version) }));
    if (occupation) value.occupation = await occupationView(c, occupation);
    if (row.current_confirmation_id) {
      const resolved = await currentVersion(c, projectId, id, value.materialVersion);
      if (resolved.current) value.current = resolved.current;
      if (resolved.legacy) value.legacyCurrent = resolved.legacy;
    }
    const completions = baselines.filter(b => b.entityId === id).map(b => ({ version: b.version, confirmationId: b.confirmationId, integrationSha: b.commitSha, baselineId: b.id }));
    if (completions.length) {
      value.completions = completions;
      const last = completions.reduce((a, b) => a.version > b.version ? a : b);
      value.completedVersion = last.version; value.completionConfirmationId = last.confirmationId; value.completedIntegrationSha = last.integrationSha;
    }
    result.push(value);
  }
  return result;
}
export async function saveEntity(c: Transaction, projectId: string, value: EntityView) {
  await c.query(`INSERT INTO studio_entities(project_id,id,kind,builtin_key,sequence,code,title,summary,template_id,template_ref,revision,generation,material_version,confirmation_status,task_status,current_confirmation_id,${auditColumns}) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$17,$18,$19) ON CONFLICT(project_id,id) DO UPDATE SET title=excluded.title,summary=excluded.summary,template_id=excluded.template_id,template_ref=excluded.template_ref,revision=excluded.revision,generation=excluded.generation,material_version=excluded.material_version,confirmation_status=excluded.confirmation_status,task_status=excluded.task_status,current_confirmation_id=excluded.current_confirmation_id,last_editor_id=excluded.last_editor_id,last_editor_account=excluded.last_editor_account,last_editor_name=excluded.last_editor_name,last_edited_date=clock_timestamp()`, [projectId, value.id, value.kind, value.builtinKey ?? null, value.sequence ?? null, value.code ?? null, value.title, value.summary ?? '', value.templateId ?? null, value.templateRef ?? null, value.revision, value.generation, value.materialVersion, value.confirmationStatus, value.taskStatus, value.current?.confirmationId ?? value.legacyCurrent?.confirmationId ?? null, ...actorFields()]);
  if (value.kind === 'requirement') {
    await c.query('DELETE FROM studio_scenario_requirements WHERE project_id=$1 AND requirement_id=$2 AND NOT(scenario_id=ANY($3::text[]))', [projectId, value.id, value.scenarioIds]);
    for (const id of value.scenarioIds) await c.query(`INSERT INTO studio_scenario_requirements(project_id,scenario_id,requirement_id,${actorColumns}) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, [projectId, id, value.id, ...actorFields()]);
    if (value.scenarioSources) {
      await c.query('DELETE FROM studio_entity_scenario_sources WHERE project_id=$1 AND entity_id=$2', [projectId, value.id]);
      for (const source of value.scenarioSources) {
        const fixed = (await c.query<{ id: string }>("SELECT f.id FROM studio_confirmations f JOIN studio_entities e ON e.project_id=f.project_id AND e.id=f.entity_id WHERE f.project_id=$1 AND f.entity_id=$2 AND f.version=$3 AND f.stage='material' AND e.kind='scenario'", [projectId, source.entityId, source.version])).rows[0];
        requireCondition(source.projectId === projectId && fixed, 'SCENARIO_SOURCE_UNCONFIRMED', 'Draft requirements require a confirmed scenario version in the same project', 409);
        await c.query(`INSERT INTO studio_entity_scenario_sources(project_id,entity_id,scenario_confirmation_id,${actorColumns}) VALUES($1,$2,$3,$4,$5,$6)`, [projectId, value.id, fixed.id, ...actorFields()]);
      }
    }
    await c.query('DELETE FROM studio_prerequisites WHERE project_id=$1 AND entity_id=$2', [projectId, value.id]);
    for (const prerequisite of value.prerequisites) {
      const confirmed = (await c.query<{ id: string }>("SELECT id FROM studio_confirmations WHERE project_id=$1 AND entity_id=$2 AND version=$3 AND stage='material'", [projectId, prerequisite.requirementId, prerequisite.version])).rows[0];
      requireCondition(confirmed, 'PREREQUISITE_UNCONFIRMED', 'Prerequisites must bind accepted requirement versions', 409);
      await c.query(`INSERT INTO studio_prerequisites(project_id,entity_id,requirement_id,version,confirmation_id,${actorColumns}) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [projectId, value.id, prerequisite.requirementId, prerequisite.version, confirmed.id, ...actorFields()]);
    }
  }
  if (value.occupation) await saveOccupation(c, projectId, value.occupation);
}
async function occupationView(c: Transaction, row: Row): Promise<OccupationView> {
  const inputs = (await c.query<Row>('SELECT * FROM studio_occupation_inputs WHERE occupation_id=$1', [row.id])).rows;
  return { occupationId: String(row.id), entityId: String(row.entity_id), generation: Number(row.generation), ownerId: Number(row.owner_id), purpose: row.purpose as OccupationView['purpose'], taskId: String(row.task_id), clientId: String(row.client_id), expectedRevision: Number(row.expected_revision), inputVersion: Number(row.input_version), createdAt: date(row.created_date), prerequisiteBindings: inputs.map(r => ({ requirementId: String(r.requirement_id), version: Number(r.version), confirmationId: String(r.confirmation_id), integrationSha: String(r.integration_sha) })) };
}
export async function saveOccupation(c: Transaction, projectId: string, value: OccupationView, active = true, finishStatus?: 'aborted' | 'completed') {
  const updated = await c.query('UPDATE studio_occupations SET expected_revision=$3,active=$4,finish_status=$5,last_editor_id=$6,last_editor_account=$7,last_editor_name=$8,last_edited_date=clock_timestamp() WHERE id=$1 AND project_id=$2 RETURNING id', [value.occupationId, projectId, value.expectedRevision, active, finishStatus ?? null, ...actorFields()]);
  if (!updated.rowCount) {
    requireCondition(context().actor.id === value.ownerId, 'OCCUPATION_OWNER_REQUIRED', 'A new occupation must be created by its authenticated owner', 403);
    await c.query(`INSERT INTO studio_occupations(id,project_id,entity_id,generation,owner_id,purpose,task_id,client_id,expected_revision,input_version,active,finish_status,${auditColumns},created_date) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$13,$14,$15,$16)`, [value.occupationId, projectId, value.entityId, value.generation, value.ownerId, value.purpose, value.taskId, value.clientId, value.expectedRevision, value.inputVersion, active, finishStatus ?? null, ...actorFields(), value.createdAt]);
  }
  for (const input of value.prerequisiteBindings) await c.query(`INSERT INTO studio_occupation_inputs(occupation_id,requirement_id,version,confirmation_id,integration_sha,${actorColumns}) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`, [value.occupationId, input.requirementId, input.version, input.confirmationId, input.integrationSha, ...actorFields()]);
}
export async function updateOccupation(c: Transaction, projectId: string, id: string, active: boolean, finishStatus?: 'aborted' | 'completed') {
  await c.query('UPDATE studio_occupations SET active=$3,finish_status=$4,last_editor_id=$5,last_editor_account=$6,last_editor_name=$7,last_edited_date=clock_timestamp() WHERE project_id=$1 AND id=$2', [projectId, id, active, finishStatus ?? null, ...actorFields()]);
}
export async function abortIntegrations(c: Transaction, projectId: string, occupationId?: string) {
  await c.query("UPDATE studio_integrations SET status='aborted',last_editor_id=$3,last_editor_account=$4,last_editor_name=$5,last_edited_date=clock_timestamp() WHERE project_id=$1 AND status='prepared' AND ($2::text IS NULL OR occupation_id=$2)", [projectId, occupationId ?? null, ...actorFields()]);
}
export async function saveIntegration(c: Transaction, projectId: string, value: StoredIntegration) {
  const request = stripMaterial(value.request);
  await c.query(`INSERT INTO studio_integrations(id,project_id,scope,entity_id,occupation_id,status,source_sha,expected_head,candidate_sha,allowed_paths,request,expected_project_revision,baseline_id,${auditColumns},created_date) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$14,$15,$16,$17) ON CONFLICT(id) DO UPDATE SET status=excluded.status,baseline_id=excluded.baseline_id,last_editor_id=excluded.last_editor_id,last_editor_account=excluded.last_editor_account,last_editor_name=excluded.last_editor_name,last_edited_date=clock_timestamp()`, [value.id, projectId, value.stage, value.entityId ?? null, value.occupationId ?? null, value.status, value.sourceSha, value.expectedHead, value.candidateSha, value.request.allowedPaths, request, value.request.stage === 'template' ? value.request.expectedProjectRevision : null, value.baselineId ?? null, ...actorFields(), value.createdAt]);
  for (const id of value.confirmationIds ?? []) await c.query('INSERT INTO studio_integration_confirmations(integration_id,confirmation_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [value.id, id]);
}
async function integrationView(c: Transaction, row: Row): Promise<StoredIntegration> {
  const confirmations = (await c.query<{ confirmation_id: string }>('SELECT confirmation_id FROM studio_integration_confirmations WHERE integration_id=$1 ORDER BY confirmation_id', [row.id])).rows.map(r => r.confirmation_id);
  return { id: String(row.id), ...(row.entity_id ? { entityId: String(row.entity_id) } : {}), ...(row.occupation_id ? { occupationId: String(row.occupation_id) } : {}), ownerId: Number(row.creator_id), status: row.status as IntegrationView['status'], sourceSha: String(row.source_sha), expectedHead: String(row.expected_head), candidateSha: String(row.candidate_sha), stage: row.scope as IntegrationView['stage'], createdAt: date(row.created_date), request: row.request as StoredIntegration['request'], ...(row.baseline_id ? { baselineId: String(row.baseline_id) } : {}), ...(confirmations.length ? { confirmationIds: confirmations } : {}) } as StoredIntegration;
}
export async function getIntegration(c: Transaction, projectId: string, id: string): Promise<StoredIntegration> {
  const row = (await c.query<Row>('SELECT * FROM studio_integrations WHERE project_id=$1 AND id=$2', [projectId, id])).rows[0];
  requireCondition(row, 'INTEGRATION_NOT_FOUND', 'Integration operation was not found', 404); return integrationView(c, row);
}
export async function listIntegrations(c: Transaction, projectId: string): Promise<IntegrationView[]> {
  const result: IntegrationView[] = [];
  for (const row of (await c.query<Row>('SELECT * FROM studio_integrations WHERE project_id=$1 ORDER BY id', [projectId])).rows) {
    const { request: _request, occupationId: _occupationId, ...view } = await integrationView(c, row); result.push(view);
  }
  return result;
}
/**
 * Contract violations that make an accepted document readable-only rather than
 * unreadable: integrity failures (hash, missing file, encoding) are not listed
 * and keep failing loudly.
 */
const legacyMaterialCodes = new Set(['INVALID_MATERIAL', 'INVALID_MANIFEST', 'INVALID_MATERIAL_PATH', 'CORE_UNRESOLVED', 'SCENARIO_SOURCE_REQUIRED', 'TEMPLATE_IDENTITY_MISMATCH', 'TEMPLATE_REFERENCE_MISMATCH', 'EVIDENCE_PATH_SCOPE', 'EVIDENCE_RANGE_INVALID', 'FILE_REFERENCE_CONFLICT', 'SELF_REFERENCE']);
async function versionRows(c: Transaction, projectId: string, entityId: string, version?: number): Promise<Row[]> {
  return (await c.query<Row>("SELECT f.*,e.enabled,e.reason,b.id AS baseline_id FROM studio_confirmations f LEFT JOIN studio_eligibility e USING(project_id,entity_id,version) LEFT JOIN studio_baselines b USING(project_id,entity_id,version) WHERE f.project_id=$1 AND f.entity_id=$2 AND f.stage='material' AND ($3::integer IS NULL OR f.version=$3) ORDER BY f.version DESC", [projectId, entityId, version ?? null])).rows;
}
function fixedReference(row: Row): FixedReference { return { commitSha: String(row.commit_sha), path: String(row.path), sha256: String(row.sha256) }; }
async function fixedVersionOf(projectId: string, row: Row): Promise<FixedVersion> {
  const fixed = fixedReference(row);
  const builtin = row.acceptance_kind === 'system-provisioned';
  return { version: Number(row.version), fixed,
    metadata: builtin ? await loadBuiltin(projectId, fixed, String(row.entity_id)) : await loadMaterial(projectId, fixed),
    ...(builtin ? { builtin: true } : {}),
    confirmationId: String(row.id), confirmedBy: Number(row.creator_id ?? 0), confirmedAt: date(row.created_date), title: String(row.title), summary: String(row.summary), applicability: row.applicability as 'applicable' | 'not-applicable', ...(row.applicability_reason ? { applicabilityReason: String(row.applicability_reason) } : {}), ...(row.read_hash ? { readHash: String(row.read_hash) } : {}),
    // 内置场景无 studio_eligibility 行：系统预置版本不提供复用资格
    reuse: builtin ? { enabled: false, reason: 'Built-in scenario is provisioned by initialization' } : { enabled: Boolean(row.enabled), reason: String(row.reason) }, ...(row.baseline_id ? { prototypeBaselineId: String(row.baseline_id) } : {}) };
}
export async function versions(c: Transaction, projectId: string, entityId: string, version?: number): Promise<FixedVersion[]> {
  const result: FixedVersion[] = [];
  for (const row of await versionRows(c, projectId, entityId, version)) result.push(await fixedVersionOf(projectId, row));
  return result;
}
/** The entity's accepted version either reads under the current contract or stays readable-only. */
export async function currentVersion(c: Transaction, projectId: string, entityId: string, version: number): Promise<{ current?: FixedVersion; legacy?: LegacyFixedVersion }> {
  const row = (await versionRows(c, projectId, entityId, version))[0];
  requireCondition(row, 'FIXED_VERSION_NOT_FOUND', 'Accepted fixed material version was not found', 404);
  try { return { current: await fixedVersionOf(projectId, row) }; }
  catch (error) {
    if (!(error instanceof DomainError) || !legacyMaterialCodes.has(error.code)) throw error;
    const fixed = fixedReference(row);
    return { legacy: { version: Number(row.version), fixed, confirmationId: String(row.id), confirmedBy: Number(row.creator_id), confirmedAt: date(row.created_date), title: String(row.title), ...(String(row.summary) ? { summary: String(row.summary) } : {}), reason: `${error.code}: ${error.message}` } };
  }
}
export async function fixedVersion(c: Transaction, projectId: string, entityId: string, version: number): Promise<FixedVersion> {
  const value = (await versions(c, projectId, entityId, version))[0];
  requireCondition(value, 'FIXED_VERSION_NOT_FOUND', 'Accepted fixed material version was not found', 404); return value;
}
export async function saveConfirmation(c: Transaction, projectId: string, input: { event: ConfirmationEvent; version?: FixedVersion; baseline?: BaselineView; method: ConfirmationInput; stage: 'material' | 'prototype'; integrationId: string }) {
  const { event, version, method } = input;
  const metadata = version?.metadata ?? await loadMaterial(projectId, event.fixed);
  requireCondition(!isBuiltinScenarioMetadata(metadata), 'INVALID_BUILTIN_SCENARIO', 'Built-in general scenario is provisioned by initialization, not user confirmation', 422);
  const repair = method.confirmationMethod === 'ai-repair';
  const scenarioSources = input.stage === 'material' && metadata.kind === 'requirement' ? metadata.sources.filter(s => s.projectId === projectId && metadata.scenarioIds.includes(s.entityId)) : [];
  await c.query(`INSERT INTO studio_confirmations(id,project_id,entity_id,version,stage,revision,title,summary,commit_sha,path,sha256,method,read_hash,repair_task_id,integration_id,applicability,applicability_reason,source_count,${actorColumns},created_date) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`, [event.id, projectId, event.entityId, event.version, input.stage, event.revision, metadata.title, metadata.summary ?? '', event.fixed.commitSha, event.fixed.path, event.fixed.sha256, repair ? 'repair' : 'normal', method.readHash, repair ? method.repairTaskId : null, input.integrationId, metadata.applicability ? 'not-applicable' : 'applicable', metadata.applicability?.reason ?? null, scenarioSources.length, ...actorFields(), event.confirmedAt]);
  for (const source of scenarioSources) {
    const confirmationId = (await c.query<{ id: string }>("SELECT id FROM studio_confirmations WHERE project_id=$1 AND entity_id=$2 AND version=$3 AND stage='material'", [projectId, source.entityId, source.version])).rows[0]?.id;
    requireCondition(confirmationId, 'SCENARIO_SOURCE_UNCONFIRMED', 'Requirement sources must identify an accepted scenario version', 409);
    await c.query('INSERT INTO studio_requirement_sources(project_id,confirmation_id,scenario_id,scenario_confirmation_id) VALUES($1,$2,$3,$4)', [projectId, event.id, source.entityId, confirmationId]);
  }
  if (input.stage === 'material') await setEntityFiles(c, projectId, event.entityId, (metadata.files ?? []).map(file => file.path));
  if (input.stage === 'material' && version) await setEligibility(c, projectId, event.entityId, event.version, version.reuse.enabled, version.reuse.reason);
}
/** Replace only the mutable current file directory; historical manifests stay in fixed Git material. */
export async function setEntityFiles(c: Transaction, projectId: string, entityId: string, paths: string[]) {
  await c.query('DELETE FROM studio_entity_files WHERE project_id=$1 AND entity_id=$2 AND NOT(path=ANY($3::text[]))', [projectId, entityId, paths]);
  for (const path of paths) await c.query(`INSERT INTO studio_entity_files(project_id,entity_id,path,${actorColumns}) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, [projectId, entityId, path, ...actorFields()]);
}
export async function confirmation(c: Transaction, projectId: string, id: string): Promise<{ event: ConfirmationEvent; stage: 'material' | 'prototype' }> {
  const row = (await c.query<Row>('SELECT * FROM studio_confirmations WHERE project_id=$1 AND id=$2', [projectId, id])).rows[0];
  requireCondition(row, 'CONFIRMATION_NOT_FOUND', 'Accepted confirmation was not found', 404);
  return { event: { id: String(row.id), projectId, entityId: String(row.entity_id), version: Number(row.version), fixed: { commitSha: String(row.commit_sha), path: String(row.path), sha256: String(row.sha256) }, revision: Number(row.revision), confirmedBy: Number(row.creator_id), confirmedAt: date(row.created_date) }, stage: row.stage as 'material' | 'prototype' };
}
export async function setEligibility(c: Transaction, projectId: string, entityId: string, version: number, enabled: boolean, reason: string) {
  await c.query(`INSERT INTO studio_eligibility(project_id,entity_id,version,enabled,reason,${auditColumns}) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$6,$7,$8) ON CONFLICT(project_id,entity_id,version) DO UPDATE SET enabled=excluded.enabled,reason=excluded.reason,last_editor_id=excluded.last_editor_id,last_editor_account=excluded.last_editor_account,last_editor_name=excluded.last_editor_name,last_edited_date=clock_timestamp()`, [projectId, entityId, version, enabled, reason, ...actorFields()]);
}
function baselineView(row: Row): BaselineView { return { id: String(row.id), entityId: String(row.entity_id), version: Number(row.version), commitSha: String(row.commit_sha), confirmationId: String(row.confirmation_id), createdAt: date(row.created_date) }; }
export async function listBaselines(c: Transaction, projectId: string): Promise<BaselineView[]> { return (await c.query<Row>('SELECT * FROM studio_baselines WHERE project_id=$1 ORDER BY created_date,id', [projectId])).rows.map(baselineView); }
export async function baseline(c: Transaction, projectId: string, id: string): Promise<BaselineView> {
  const value = (await listBaselines(c, projectId)).find(v => v.id === id); requireCondition(value, 'BASELINE_NOT_FOUND', 'Accepted baseline was not found', 404); return value;
}
export async function insertBaseline(c: Transaction, projectId: string, value: BaselineView) {
  await c.query(`INSERT INTO studio_baselines(id,project_id,entity_id,version,commit_sha,confirmation_id,${actorColumns},created_date) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [value.id, projectId, value.entityId, value.version, value.commitSha, value.confirmationId, ...actorFields(), value.createdAt]);
}
function adoptionView(row: Row): AdoptionRecord {
  return { id: String(row.id), source: { projectId: String(row.source_project_id), entityId: String(row.source_entity_id), version: Number(row.source_version) }, targetProjectId: String(row.target_project_id), targetEntityId: String(row.target_entity_id), targetTaskId: String(row.target_task_id), scope: row.scope as AdoptionRecord['scope'], adjustmentSummary: String(row.adjustment_summary), actorId: Number(row.creator_id), acceptedAt: date(row.created_date), status: row.status as AdoptionRecord['status'], ...(row.target_confirmation_id ? { targetConfirmationId: String(row.target_confirmation_id), targetVersion: Number(row.target_version), succeededAt: date(row.succeeded_at) } : {}) };
}
export async function listAdoptions(c: Transaction, projectId: string): Promise<AdoptionRecord[]> { return (await c.query<Row>('SELECT * FROM studio_adoptions WHERE target_project_id=$1 ORDER BY id', [projectId])).rows.map(adoptionView); }
export async function getAdoption(c: Transaction, projectId: string, id: string): Promise<AdoptionRecord> { const value = (await listAdoptions(c, projectId)).find(v => v.id === id); requireCondition(value, 'ADOPTION_NOT_FOUND', 'Adoption was not found', 404); return value; }
export async function saveAdoption(c: Transaction, value: AdoptionRecord) {
  await c.query(`INSERT INTO studio_adoptions(id,source_project_id,source_entity_id,source_version,target_project_id,target_entity_id,target_task_id,scope,adjustment_summary,status,target_confirmation_id,target_version,succeeded_at,${auditColumns},created_date) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$14,$15,$16,$17) ON CONFLICT(id) DO UPDATE SET status=excluded.status,target_confirmation_id=excluded.target_confirmation_id,target_version=excluded.target_version,succeeded_at=excluded.succeeded_at,last_editor_id=excluded.last_editor_id,last_editor_account=excluded.last_editor_account,last_editor_name=excluded.last_editor_name,last_edited_date=clock_timestamp()`, [value.id, value.source.projectId, value.source.entityId, value.source.version, value.targetProjectId, value.targetEntityId, value.targetTaskId, value.scope, value.adjustmentSummary, value.status, value.targetConfirmationId ?? null, value.targetVersion ?? null, value.succeededAt ?? null, ...actorFields(), value.acceptedAt]);
}
/** Remove material snapshots from control records; fixed references remain authoritative. */
function stripMaterial(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripMaterial);
  if (!value || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  // 系统预置版本的元数据是固定契约产物而非材料快照，随控制结果保留
  const keepMetadata = source.builtin === true;
  const result = Object.fromEntries(Object.entries(source).filter(([key]) => (keepMetadata && key === 'metadata') || !['metadata', 'body', 'businessEvidence', 'openQuestions', 'files', 'evidence', 'coreRulesPresent', 'acceptanceCriteriaPresent'].includes(key)).map(([key, item]) => [key, stripMaterial(item)]));
  if (typeof source.id === 'string' && typeof source.kind === 'string' && Array.isArray(source.files)) result.fileProjectionFromCurrent = true;
  return result;
}
async function hydrateResult(value: unknown, projectId: string): Promise<unknown> {
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (const item of value) result.push(await hydrateResult(item, projectId));
    return result;
  }
  if (!value || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>, result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) result[key] = await hydrateResult(item, projectId);
  if (source.fixed && source.version && source.confirmationId && source.builtin !== true) result.metadata = await loadMaterial(projectId, source.fixed as FixedReference);
  if (source.fileProjectionFromCurrent === true) {
    const current = result.current as { metadata: MaterialMetadata } | undefined;
    result.files = current?.metadata.files?.map(file => file.path) ?? [];
    delete result.fileProjectionFromCurrent;
  }
  return result;
}
export async function audit(c: Transaction, projectId: string, actor: Pick<Actor, 'id' | 'username' | 'name'>, action: string, data: unknown) {
  await c.query(`INSERT INTO studio_audit(project_id,action,data,${actorColumns}) VALUES($1,$2,$3,$4,$5,$6)`, [projectId, action, stripMaterial(data), actor.id, actor.username, actor.name]);
}
export async function previous(c: Transaction, projectId: string, actor: Pick<Actor, 'id'>, action: string, input: { idempotencyKey: string }): Promise<{ found: boolean; result?: unknown }> {
  const row = (await c.query<Row>('SELECT creator_id,action,request_hash,result FROM studio_operations WHERE project_id=$1 AND key=$2', [projectId, input.idempotencyKey])).rows[0];
  if (!row) {
    const allocation = (await c.query<Row>('SELECT creator_id,request_hash FROM studio_entity_numbers WHERE project_id=$1 AND operation_key=$2', [projectId, input.idempotencyKey])).rows[0];
    if (allocation) requireCondition(action === 'entity.reserve' && Number(allocation.creator_id) === actor.id && allocation.request_hash === requestHash(input), 'IDEMPOTENCY_CONFLICT', 'Idempotency key is reserved by a different entity creation request', 409);
    return { found: false };
  }
  requireCondition(Number(row.creator_id) === actor.id && row.action === action && row.request_hash === requestHash(input), 'IDEMPOTENCY_CONFLICT', 'Idempotency key has already been used for another request', 409);
  return { found: true, result: await hydrateResult(row.result, projectId) };
}
export async function remember(c: Transaction, projectId: string, actor: Actor, action: string, input: { idempotencyKey: string }, result: unknown) {
  await c.query(`INSERT INTO studio_operations(project_id,key,action,request_hash,result,${actorColumns}) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [projectId, input.idempotencyKey, action, requestHash(input), stripMaterial(result), actor.id, actor.username, actor.name]);
  await audit(c, projectId, actor, action, { idempotencyKey: input.idempotencyKey });
}
export async function operation(c: Transaction, projectId: string, key: string, actor: Pick<Actor, 'id'>): Promise<{ action: string; result: unknown }> {
  const row = (await c.query<Row>('SELECT creator_id,action,result FROM studio_operations WHERE project_id=$1 AND key=$2', [projectId, key])).rows[0];
  requireCondition(row && Number(row.creator_id) === actor.id, 'OPERATION_NOT_FOUND', 'Operation result is not known for this actor', 404);
  return { action: String(row.action), result: await hydrateResult(row.result, projectId) };
}
export type ReadyProject = ProjectView & { initializationStatus: 'ready'; recognizedHead: string };
export function assertProjectReady(value: ProjectView): asserts value is ReadyProject {
  requireCondition(value.initializationStatus === 'ready' && typeof value.recognizedHead === 'string' && /^[a-f0-9]{40}$/.test(value.recognizedHead), 'PROJECT_NOT_INITIALIZED', 'Initialize and push the project before starting business operations', 409);
}
