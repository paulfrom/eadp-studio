import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, mock, test } from 'node:test';
import { DomainError, parseMaterial, parseProjectManifest } from '@eadp/asset-domain';
import Fastify from 'fastify';
import type { TSchema } from '@eadp/contracts';
import { ConfirmationInputSchema, ReserveEntitySchema, SubmitConsistencyComparisonSchema, reviewInputText } from '@eadp/contracts';
import type { EntityView, MaterialMetadata, MaterialIntegrationRequest, TemplateIntegrationRequest, ProjectManifest, ProjectView } from '@eadp/contracts';
import { GitLab } from './auth/gitlab.js';
import type { Actor } from './auth/session.js';
import { loadConfig } from './config.js';
import { GitLabContent } from './gitlab-content.js';
import { validateIntegration } from './modules/integration.js';

const config = loadConfig({ DATABASE_URL: 'postgresql://synthetic', PG_SSL: 'disable', GITLAB_URL: 'http://gitlab.test', GITLAB_ALLOW_HTTP: 'true', SEI_GITLAB_TOKEN: 'synthetic-management-credential' });
const actor: Actor = { id: 1, name: 'Author', username: 'author', email: 'author@example.test', admin: false, gitlabUserId: 42, gitlabUsername: 'author', sessionHash: 'synthetic-session' };
const fixedSha = 'a'.repeat(40), head = 'b'.repeat(40), candidate = 'c'.repeat(40), sourceSha = 'd'.repeat(40);
const code = (expected: string) => (error: unknown) => error instanceof DomainError && error.code === expected;
afterEach(() => mock.restoreAll());

function fixture(stage: MaterialIntegrationRequest['stage'] = 'material') {
  const kind = 'requirement' as const;
  const evidenceBytes = Buffer.from('用户提供的业务依据。\n第二行明确规则。\n');
  const evidencePath = '.eadp/evidence/source.txt';
  const templateBytes = Buffer.from('# 默认场景模板\n\n## 自定义章节\n');
  const templateRef = { commitSha: fixedSha, path: '.template/default.md', sha256: createHash('sha256').update(templateBytes).digest('hex') };
  const requirementTemplateBytes = Buffer.from('# 默认需求模板\n\n## 自定义章节\n');
  const requirementTemplateRef = { commitSha: fixedSha, path: '.template/requirement-default.md', sha256: createHash('sha256').update(requirementTemplateBytes).digest('hex') };
  const common = { entityId: 'asset-1', title: 'Accepted input', scenarioIds: ['source-1'], prerequisites: [], sources: [{ projectId: 'project-1', entityId: 'source-1', version: 1 }], businessEvidence: [{ label: 'Author', reference: 'synthetic-acceptance', files: [{ path: evidencePath, sha256: createHash('sha256').update(evidenceBytes).digest('hex') }], ranges: [{ path: evidencePath, startLine: 1, endLine: 1 }] }], openQuestions: [], referencedAssets: [] };
  const metadata: MaterialMetadata = { ...common, kind, coreRulesPresent: true, acceptanceCriteriaPresent: true, templateId: 'requirement-default', templateRef: requirementTemplateRef };
  const materialPath = `需求/${metadata.title}.md`;
  const body = Buffer.from('# Accepted input\n\n```eadp-metadata\n' + JSON.stringify(metadata) + '\n```\n\n## 核心业务规则\n\n明确的业务规则。\n\n## 验收条件\n\n明确的验收条件。\n');
  const fixed = { commitSha: fixedSha, path: materialPath, sha256: createHash('sha256').update(body).digest('hex') };
  const token = { occupationId: 'occupation-1', generation: 1, taskId: 'task-1', clientId: 'client-1', expectedRevision: 1, entityId: 'asset-1', ownerId: actor.id, purpose: 'design' as const, inputVersion: 1, createdAt: '' };
  const entity: EntityView = { id: 'asset-1', kind, title: metadata.title, revision: 1, generation: 1, materialVersion: 1, confirmationStatus: 'confirmed', taskStatus: 'active', scenarioIds: [], prerequisites: [], authorId: actor.id, templateId: metadata.templateId, templateRef: metadata.templateRef, occupation: token, current: { version: 1, confirmationId: 'confirmation-1', confirmedBy: actor.id, confirmedAt: '', fixed, metadata, reuse: { enabled: true, reason: 'accepted' } } };
  const project: ProjectView = { id: 'project-1', gitlabProjectId: 7, repositoryUrl: 'http://gitlab.test/team/project.git', stableBranch: 'main', name: 'Project', namespaceId: 2, namespacePath: 'team', initializationStatus: 'ready', recognizedHead: head, revision: 1 };
  const changedPath = materialPath;
  const diff = (path: string, text = '+accepted change') => ({ old_path: path, new_path: path, deleted_file: false, renamed_file: false, diff: text });
  const input: MaterialIntegrationRequest = { idempotencyKey: 'integration-1', entityId: entity.id, token, stage, sourceSha: candidate, candidateSha: candidate, expectedHead: head, allowedPaths: [changedPath], checks: { candidateSha: candidate, passed: true, checks: ['materials', 'relations'].map(name => ({ name, passed: true, evidenceHash: 'e'.repeat(64) })) }, confirmations: [{ entityId: entity.id, expectedRevision: entity.revision, fixed: { ...fixed, commitSha: candidate }, readHash: fixed.sha256, confirmationMethod: 'direct', authorConfirmed: true }] };
  const controls = { candidateManifest: undefined as ProjectManifest | undefined, projectManifest: { schemaVersion: 1, projectId: project.id, gitlabProjectId: 7, repositoryUrl: project.repositoryUrl, stableBranch: 'main', directories: ['场景', '需求', '交接', '原型代码'], scenarioTemplates: { defaultTemplateId: 'default', templates: [{ id: 'default', name: 'Default', path: templateRef.path }] }, requirementTemplates: { defaultTemplateId: 'requirement-default', templates: [{ id: 'requirement-default', name: 'Default requirement', path: requirementTemplateRef.path }] } } as ProjectManifest, files: new Map([[evidencePath, evidenceBytes]]), previousMaterials: new Map<string, Uint8Array>(), candidateBody: body, fixedBody: body, candidateDiffs: [diff(changedPath)], sourceDiffs: [diff(changedPath)], denied: false };
  const reads: Array<{ path: string; ref: string | null }> = [];
  mock.method(globalThis, 'fetch', async (url: string | URL | Request, request: RequestInit) => {
    const parsed = new URL(String(url)), path = decodeURIComponent(parsed.pathname.replace(/^\/api\/v4/, ''));
    assert.equal(request.method, 'GET');
    assert.equal((request.headers as Record<string, string>)['PRIVATE-TOKEN'], config.gitlabToken);
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    if (path === '/users/42') return json({ id: 42, username: 'author', state: 'active' });
    if (path === '/projects/7/members/all/42') return controls.denied ? json({}, 404) : json({ id: 42, state: 'active', access_level: 40, expires_at: null });
    if (path === '/projects/7') return json({ id: 7, name: 'Project', path: 'project', path_with_namespace: 'team/project', http_url_to_repo: project.repositoryUrl, namespace: { id: 2, full_path: 'team' }, visibility: 'private', default_branch: 'main', description: '' });
    if (path === `/projects/7/repository/commits/${candidate}`) return json({ id: candidate, parent_ids: [head] });
    if (path === '/projects/7/repository/compare') return json({ compare_timeout: false, compare_same_ref: false, diffs: parsed.searchParams.get('to') === sourceSha ? controls.sourceDiffs : controls.candidateDiffs });
    if (path === '/projects/7/repository/merge_base') return json({ id: fixedSha });
    if (path === '/projects/7/repository/files/project.assets.json/raw') return json(parsed.searchParams.get('ref') === candidate && controls.candidateManifest ? controls.candidateManifest : controls.projectManifest);
    if (path === '/projects/7/repository/files/.template/default.md/raw') return new Response(templateBytes);
    if (path === '/projects/7/repository/files/.template/requirement-default.md/raw') return new Response(requirementTemplateBytes);
    const filePath = path.match(/^\/projects\/7\/repository\/files\/(.+)\/raw$/)?.[1];
    if (filePath && controls.previousMaterials.has(filePath)) {
      reads.push({ path: filePath, ref: parsed.searchParams.get('ref') });
      return new Response(new Uint8Array(controls.previousMaterials.get(filePath)!));
    }
    if (filePath && (controls.files.has(filePath) || filePath.startsWith('.eadp/evidence/'))) return controls.files.has(filePath) ? new Response(controls.files.get(filePath)) : new Response('{}', { status: 404 });
    if (path === `/projects/7/repository/files/${materialPath}/raw`) {
      const ref = parsed.searchParams.get('ref'); reads.push({ path: materialPath, ref });
      assert.equal(parsed.searchParams.get('lfs'), 'false');
      assert.ok(ref === fixedSha || ref === candidate, 'the verified ref must be the exact accepted input or candidate');
      return new Response(ref === candidate ? controls.candidateBody : controls.fixedBody);
    }
    throw new Error(`Unexpected synthetic GitLab request ${path}`);
  });
  const content = new GitLabContent(new GitLab(config));
  const materials: Map<string, MaterialMetadata> = new Map([[metadata.entityId, structuredClone(metadata)]]);
  const sourceEntity: EntityView = { ...entity, id: 'source-1', kind: 'scenario', scenarioIds: [], occupation: undefined, current: { ...entity.current!, metadata: { ...common, entityId: 'source-1', kind: 'scenario', flowComplete: true, templateId: 'default', templateRef, scenarioIds: [], sources: [] } } };
  const all = [entity, sourceEntity];
  const verify = async () => { validateIntegration(project, all, actor, input, materials); await content.verifyCandidate(actor, project.gitlabProjectId, input); };
  return { input, entity, project, content, controls, reads, body, metadata, materialPath, diff, verify, all, materials };
}

test('a display projection reads accepted material once while acceptance keeps reading it', async () => {
  const f = fixture('material'), confirmation = f.input.confirmations[0]!;
  const reads = f.reads.length;
  const projected = await f.content.loadMaterial(actor, 7, confirmation.fixed);
  assert.equal(f.reads.length, reads + 1, 'the first projection reads the fixed material');
  assert.deepEqual(projected, f.metadata);
  projected.title = 'mutated after projection';
  const repeated = await f.content.loadMaterial(actor, 7, confirmation.fixed);
  assert.equal(f.reads.length, reads + 1, 'a repeated projection is served without another GitLab read');
  assert.equal(repeated.title, f.metadata.title, 'a caller cannot mutate the remembered projection');
  await f.content.verify(actor, 7, confirmation.fixed);
  assert.equal(f.reads.length, reads + 2, 'acceptance still reads the exact bytes from GitLab');
});

test('a project catalog at one accepted commit is read once', async () => {
  const f = fixture('material'), first = await f.content.loadProjectTemplates(actor, 7, fixedSha);
  assert.deepEqual(first.scenarios.templates.map(template => template.id), ['default']);
  f.controls.denied = true;
  assert.deepEqual(await f.content.loadProjectTemplates(actor, 7, fixedSha), first, 'a repeated catalog read is served without touching GitLab');
  await assert.rejects(f.content.loadProjectTemplates(actor, 7, head), code('GITLAB_READ_DENIED'));
  f.controls.denied = false;
  first.scenarios.templates.pop();
  assert.equal((await f.content.loadProjectTemplates(actor, 7, fixedSha)).scenarios.templates.length, 1, 'a caller cannot mutate the remembered catalog');
});

test('material confirmations still require exact candidate paths and bytes', async () => {
  const f = fixture('material'); await f.verify();
  assert.deepEqual(f.reads, [{ path: f.materialPath, ref: candidate }]);
  f.input.confirmations[0]!.fixed.commitSha = fixedSha;
  await assert.rejects(f.content.verifyCandidate(actor, 7, f.input), code('FIXED_CANDIDATE_MISMATCH'));
  f.input.confirmations[0]!.fixed.commitSha = candidate; f.input.allowedPaths = [];
  await assert.rejects(f.content.verifyCandidate(actor, 7, f.input), code('CANDIDATE_PATH_SCOPE'));
});

for (const stage of ['material'] as const) {
  test(`${stage} AI-assisted confirmation binds the reviewed candidate and exact input`, () => {
    const f = fixture(stage), confirmation = f.input.confirmations[0]!;
    f.input.confirmations[0] = { ...confirmation, confirmationMethod: 'ai-assisted', reviewEvidence: {
      candidateSha: candidate, inputHash: createHash('sha256').update(reviewInputText(f.input)).digest('hex'),
      reportHash: '1'.repeat(64), dispositionHash: '2'.repeat(64),
    } };
    validateIntegration(f.project, f.all, actor, f.input, f.materials);
  });
  for (const field of ['candidateSha', 'inputHash'] as const) {
    test(`${stage} rejects a review for another ${field}`, () => {
      const f = fixture(stage), confirmation = f.input.confirmations[0]!;
      const reviewEvidence = { candidateSha: candidate, inputHash: createHash('sha256').update(reviewInputText(f.input)).digest('hex'),
        reportHash: '1'.repeat(64), dispositionHash: '2'.repeat(64) };
      reviewEvidence[field] = field === 'candidateSha' ? 'f'.repeat(40) : '0'.repeat(64);
      f.input.confirmations[0] = { ...confirmation, confirmationMethod: 'ai-assisted', reviewEvidence };
      assert.throws(() => validateIntegration(f.project, f.all, actor, f.input, f.materials),
        code(field === 'candidateSha' ? 'REVIEW_CANDIDATE_MISMATCH' : 'REVIEW_INPUT_MISMATCH'));
    });
  }
  test(`${stage} review digest ignores JSON property order but rejects stale control context`, () => {
    const f = fixture(stage), confirmation = f.input.confirmations[0]!;
    const hash = () => createHash('sha256').update(reviewInputText(f.input)).digest('hex');
    const original = hash();
    f.input.token = Object.fromEntries(Object.entries(f.input.token).reverse()) as typeof f.input.token;
    if (f.entity.current) f.entity.current = Object.fromEntries(Object.entries(f.entity.current).reverse()) as typeof f.entity.current;
    assert.equal(hash(), original);
    f.input.confirmations[0] = { ...confirmation, confirmationMethod: 'ai-assisted', reviewEvidence: { candidateSha: candidate, inputHash: original, reportHash: '1'.repeat(64), dispositionHash: '2'.repeat(64) } };
    validateIntegration(f.project, f.all, actor, f.input, f.materials);
    f.input.expectedHead = 'e'.repeat(40); f.project.recognizedHead = f.input.expectedHead;
    assert.throws(() => validateIntegration(f.project, f.all, actor, f.input, f.materials), code('REVIEW_INPUT_MISMATCH'));
  });
}

const materialText = (metadata: MaterialMetadata, body = '由作者确认的业务规则与验收声明。') => '# 自定义业务材料\n\n```eadp-metadata\n' + JSON.stringify(metadata) + '\n```\n\n' + body + '\n';

function updateFixed(f: ReturnType<typeof fixture>, metadata: MaterialMetadata): void {
  const bytes = Buffer.from(materialText(metadata));
  f.controls.candidateBody = bytes; f.controls.fixedBody = bytes;
  f.input.confirmations[0]!.fixed.sha256 = createHash('sha256').update(bytes).digest('hex');
  f.input.confirmations[0]!.readHash = f.input.confirmations[0]!.fixed.sha256;
}

async function accepts(schema: TSchema, body: unknown): Promise<boolean> {
  const app = Fastify({ ajv: { customOptions: { removeAdditional: false } } });
  app.post('/', { schema: { body: schema } }, async () => ({ ok: true }));
  try { return (await app.inject({ method: 'POST', url: '/', payload: body as Record<string, unknown> })).statusCode === 200; } finally { await app.close(); }
}

test('scenario and requirement reservations follow their kind contracts', async () => {
  const input = { idempotencyKey: 'reserve-1', title: '新场景', kind: 'scenario' };
  const templateRef = { commitSha: fixedSha, path: '.template/requirement-default.md', sha256: '0'.repeat(64) };
  assert.equal(await accepts(ReserveEntitySchema, { ...input, kind: 'scenario' }), true);
  assert.equal(await accepts(ReserveEntitySchema, { ...input, kind: 'requirement', sources: [{ projectId: 'project-1', entityId: 'source-1', version: 1 }] }), false); // 缺模板绑定
  assert.equal(await accepts(ReserveEntitySchema, { ...input, kind: 'requirement', templateId: 'requirement-default', templateRef, sources: [{ projectId: 'project-1', entityId: 'source-1', version: 1 }] }), true);
  assert.equal(await accepts(ReserveEntitySchema, { ...input, kind: 'requirement', templateId: 'requirement-default', templateRef, sources: [] }), false);
  assert.equal(await accepts(ReserveEntitySchema, { ...input, kind: 'scenario', categoryId: 'x' } as never), false); // 白名单拒绝多余字段
});

test('confirmation requests contain only controls and reject uploaded business metadata', async () => {
  const f = fixture('material'), confirmation = f.input.confirmations[0]!;
  assert.equal(await accepts(ConfirmationInputSchema, confirmation), true);
  assert.equal(await accepts(ConfirmationInputSchema, { ...confirmation, metadata: f.metadata }), false);
});

test('comparison submissions follow the whitelist contract and sealed result rules', async () => {
  const valid = { idempotencyKey: 'op-1', id: 'comparison-1', entityId: 'asset-1', trigger: 'manual', result: 'completed', coverage: 'complete', summary: '结论一致', conflicts: [] };
  const conflict = { id: 'conflict-1', ordinal: 1, summary: '规则冲突', relation: 'formal', entities: ['asset-1'] };
  assert.equal(await accepts(SubmitConsistencyComparisonSchema, valid), true);
  assert.equal(await accepts(SubmitConsistencyComparisonSchema, { ...valid, conflicts: [conflict, { ...conflict, id: 'conflict-2', ordinal: 2, relation: 'potential', entities: ['asset-1', 'asset-2'] }] }), true);
  assert.equal(await accepts(SubmitConsistencyComparisonSchema, { ...valid, trigger: 'confirmation', confirmationId: 'confirmation-1' }), true);
  // 白名单与协议上限：多余字段、超限摘要、超限冲突与涉及材料、非法序号与非法标识一律拒绝
  assert.equal(await accepts(SubmitConsistencyComparisonSchema, { ...valid, body: '材料正文' }), false);
  assert.equal(await accepts(SubmitConsistencyComparisonSchema, { ...valid, summary: '长'.repeat(501) }), false);
  assert.equal(await accepts(SubmitConsistencyComparisonSchema, { ...valid, conflicts: Array.from({ length: 101 }, (_, index) => ({ ...conflict, id: `conflict-${index}`, ordinal: index + 1 })) }), false);
  assert.equal(await accepts(SubmitConsistencyComparisonSchema, { ...valid, conflicts: [{ ...conflict, entities: Array.from({ length: 101 }, (_, index) => `entity-${index}`) }] }), false);
  assert.equal(await accepts(SubmitConsistencyComparisonSchema, { ...valid, conflicts: [{ ...conflict, ordinal: 0 }] }), false);
  assert.equal(await accepts(SubmitConsistencyComparisonSchema, { ...valid, id: 'illegal id!' }), false);
  // 结果与失败码组合：failed 需要非空摘要与非 cancelled 失败码，cancelled 必须为 cancelled，completed 不得携带失败码
  assert.equal(await accepts(SubmitConsistencyComparisonSchema, { ...valid, result: 'failed', summary: '读取失败', failureCode: 'read-failed' }), true);
  assert.equal(await accepts(SubmitConsistencyComparisonSchema, { ...valid, result: 'failed', summary: '', failureCode: 'read-failed' }), false);
  assert.equal(await accepts(SubmitConsistencyComparisonSchema, { ...valid, result: 'failed', summary: '读取失败', failureCode: 'cancelled' }), false);
  assert.equal(await accepts(SubmitConsistencyComparisonSchema, { ...valid, result: 'cancelled', summary: '', failureCode: 'cancelled' }), true);
  assert.equal(await accepts(SubmitConsistencyComparisonSchema, { ...valid, result: 'cancelled', summary: '', failureCode: 'timeout' }), false);
  assert.equal(await accepts(SubmitConsistencyComparisonSchema, { ...valid, failureCode: 'timeout' }), false);
  // 手动提交不得携带确认引用，确认触发必须携带
  assert.equal(await accepts(SubmitConsistencyComparisonSchema, { ...valid, confirmationId: 'confirmation-1' }), false);
  assert.equal(await accepts(SubmitConsistencyComparisonSchema, { ...valid, trigger: 'confirmation' }), false);
});

test('explicit business checks accept custom headings and short author-confirmed text', () => {
  const f = fixture('material');
  assert.deepEqual(parseMaterial(materialText(f.metadata, '规则。验收。')), f.metadata);
  for (const changed of [{ ...f.metadata, coreRulesPresent: false }, { ...f.metadata, acceptanceCriteriaPresent: false }, { ...f.metadata, openQuestions: [{ blocking: true, limitation: '未解决', excludedScope: '核心流程' }] }]) {
    assert.throws(() => parseMaterial(materialText(changed)), code('CORE_UNRESOLVED'));
  }
  assert.throws(() => parseMaterial(materialText({ ...f.metadata, sources: [] })), code('SCENARIO_SOURCE_REQUIRED'));
  assert.throws(() => parseMaterial(materialText({ ...f.metadata, businessEvidence: [] })), code('INVALID_MATERIAL'));
  assert.throws(() => parseMaterial(materialText({ ...f.metadata, flowComplete: true } as MaterialMetadata)), code('INVALID_MATERIAL'));
});

test('scenario fixed content accepts a complete flow without evidence or detailed acceptance declarations', async () => {
  const f = fixture('material');
  const { coreRulesPresent: _rules, acceptanceCriteriaPresent: _acceptance, applicability: _applicability, ...common } = f.metadata as Extract<MaterialMetadata, { kind: 'requirement' }>;
  const metadata: Extract<MaterialMetadata, { kind: 'scenario' }> = { ...common, kind: 'scenario', flowComplete: true, templateId: 'default', templateRef: (f.all[1]!.current!.metadata as Extract<MaterialMetadata, { kind: 'scenario' }>).templateRef, scenarioIds: [], sources: [], businessEvidence: [], openQuestions: [{ blocking: false, limitation: '字段精度留待需求细化', excludedScope: '字段校验细节' }] };
  assert.deepEqual(parseMaterial(materialText(metadata, '提交后审核，通过后完成；退回后重新提交。')), metadata);
  const bytes = Buffer.from(materialText(metadata));
  const path = `场景/${metadata.title}.md`;
  f.controls.previousMaterials.set(path, bytes);
  const fixed = { commitSha: fixedSha, path, sha256: createHash('sha256').update(bytes).digest('hex') };
  assert.deepEqual(await f.content.verify(actor, 7, fixed), metadata);
  for (const changed of [{ ...metadata, flowComplete: false }, { ...metadata, openQuestions: [{ blocking: true, limitation: '审核失败后去向不明', excludedScope: '失败分支' }] }]) {
    assert.throws(() => parseMaterial(materialText(changed)), code('FLOW_UNRESOLVED'));
  }
  for (const changed of [{ ...metadata, coreRulesPresent: true }, { ...metadata, acceptanceCriteriaPresent: true }]) {
    assert.throws(() => parseMaterial(materialText(changed)), code('INVALID_MATERIAL'));
  }
  const { flowComplete: _flow, ...withoutFlow } = metadata;
  assert.throws(() => parseMaterial(materialText(withoutFlow as MaterialMetadata)), code('INVALID_MATERIAL'));
  const invalidEvidence = { ...metadata, businessEvidence: f.metadata.businessEvidence };
  const invalidBytes = Buffer.from(materialText(invalidEvidence));
  f.controls.previousMaterials.set(path, invalidBytes);
  f.controls.files.clear();
  await assert.rejects(f.content.verify(actor, 7, { ...fixed, sha256: createHash('sha256').update(invalidBytes).digest('hex') }), code('FIXED_FILE_MISSING'));
});

test('fixed formal evidence is required in the material commit and checked against its bytes', async () => {
  const f = fixture('material'), path = f.metadata.businessEvidence[0]!.files[0]!.path;
  const confirmation = f.input.confirmations[0]!;
  f.controls.files.delete(path);
  await assert.rejects(f.content.verify(actor, 7, confirmation.fixed), code('FIXED_FILE_MISSING'));
  f.controls.files.set(path, Buffer.from('different evidence'));
  await assert.rejects(f.content.verify(actor, 7, confirmation.fixed), code('FILE_HASH_MISMATCH'));
});

test('formal evidence citation ranges must select archived readable content', async () => {
  const f = fixture('material'), metadata = structuredClone(f.metadata);
  metadata.businessEvidence[0]!.ranges[0]!.endLine = 999;
  updateFixed(f, metadata);
  await assert.rejects(f.content.verify(actor, 7, f.input.confirmations[0]!.fixed), code('EVIDENCE_RANGE_INVALID'));
  metadata.businessEvidence[0]!.ranges[0]!.path = '.eadp/evidence/unselected.txt';
  updateFixed(f, metadata);
  await assert.rejects(f.content.verify(actor, 7, f.input.confirmations[0]!.fixed), code('EVIDENCE_RANGE_INVALID'));
});

test('associated files may exist unchanged in the commit and retain their own content hashes', async () => {
  const f = fixture('material'), path = '资料/接口约束.md', bytes = Buffer.from('固定接口约束。\n');
  const metadata = { ...f.metadata, files: [{ path, sha256: createHash('sha256').update(bytes).digest('hex') }] };
  f.controls.files.set(path, bytes); updateFixed(f, metadata);
  await f.content.verifyCandidate(actor, 7, f.input);
  f.controls.files.set(path, Buffer.from('changed after confirmation'));
  await assert.rejects(f.content.verifyCandidate(actor, 7, f.input), code('FILE_HASH_MISMATCH'));
});

test('material integrations may freeze the project CONTEXT.md as a declared root file', async () => {
  const f = fixture('material'), path = 'CONTEXT.md', bytes = Buffer.from('# 项目上下文\n\n业务范围与已明确规则。\n');
  const metadata = { ...f.metadata, files: [{ path, sha256: createHash('sha256').update(bytes).digest('hex') }] };
  f.controls.files.set(path, bytes); updateFixed(f, metadata);
  f.input.allowedPaths.push(path); f.controls.candidateDiffs.push(f.diff(path));
  assert.deepEqual([...(await f.content.verifyCandidate(actor, 7, f.input)).keys()], [metadata.entityId]);
});

test('material integrations cannot open unrelated project root files', async () => {
  const f = fixture('material'), path = 'README.md', bytes = Buffer.from('unrelated root file');
  const metadata = { ...f.metadata, files: [{ path, sha256: createHash('sha256').update(bytes).digest('hex') }] };
  f.controls.files.set(path, bytes); updateFixed(f, metadata);
  f.input.allowedPaths.push(path); f.controls.candidateDiffs.push(f.diff(path));
  await assert.rejects(f.content.verifyCandidate(actor, 7, f.input), code('MATERIAL_PATH_SCOPE'));
});

test('material confirmations cannot whitelist unselected drafts or arbitrary attachments', async () => {
  const f = fixture('material'), path = '场景/unselected.md';
  f.input.allowedPaths.push(path); f.controls.candidateDiffs.push(f.diff(path));
  await assert.rejects(f.content.verifyCandidate(actor, 7, f.input), code('MATERIAL_PATH_SCOPE'));
});

test('a fixed material path follows its business title instead of its entity ID', async () => {
  const f = fixture('material'), confirmation = f.input.confirmations[0]!;
  const idPath = `需求/${f.metadata.entityId}.md`;
  f.controls.previousMaterials.set(idPath, f.body);
  await assert.rejects(f.content.verify(actor, 7, { ...confirmation.fixed, path: idPath }), code('INVALID_MATERIAL_PATH'));
  await f.content.verify(actor, 7, confirmation.fixed);
});

test('a title edit may remove the confirmed previous path and nothing else', async () => {
  const f = fixture('material'), previous = f.materialPath, confirmation = f.input.confirmations[0]!;
  const metadata = { ...f.metadata, title: 'Renamed input' } as MaterialMetadata;
  const body = Buffer.from('# Renamed input\n\n```eadp-metadata\n' + JSON.stringify(metadata) + '\n```\n\n## 核心业务规则\n\n明确的业务规则。\n\n## 验收条件\n\n明确的验收条件。\n');
  const renamed = '需求/Renamed input.md', sha = createHash('sha256').update(body).digest('hex');
  f.controls.previousMaterials.set(previous, f.body); f.controls.previousMaterials.set(renamed, body);
  f.materials.set(metadata.entityId, metadata);
  f.input.confirmations[0]!.fixed = { ...confirmation.fixed, path: renamed, sha256: sha };
  f.input.confirmations[0]!.readHash = sha;
  const removed = { old_path: previous, new_path: previous, deleted_file: true, renamed_file: false, diff: '' };
  f.input.allowedPaths = [previous, renamed]; f.controls.candidateDiffs = [removed, f.diff(renamed)];
  assert.deepEqual([...(await f.content.verifyCandidate(actor, 7, f.input)).keys()], [metadata.entityId]);
  f.controls.previousMaterials.set(previous, Buffer.from('# 其他材料\n\n```eadp-metadata\n' + JSON.stringify({ ...metadata, entityId: 'other-1', kind: 'requirement' }) + '\n```\n\n正文\n'));
  await assert.rejects(f.content.verifyCandidate(actor, 7, f.input), code('MATERIAL_PATH_SCOPE'));
});

test('templates are fixed catalog references verified against the accepted project catalog', async () => {
  const f = fixture('material');
  await f.content.verifyCandidate(actor, 7, f.input);
  assert.throws(() => parseMaterial(materialText({ ...f.metadata, categoryId: 'business' } as unknown as MaterialMetadata)), code('INVALID_MATERIAL'));
  assert.ok(f.metadata.kind === 'requirement');
  const changed = { ...f.metadata, templateRef: { ...f.metadata.templateRef, sha256: '0'.repeat(64) } };
  updateFixed(f, changed);
  await assert.rejects(f.content.verify(actor, 7, f.input.confirmations[0]!.fixed), code('TEMPLATE_REFERENCE_MISMATCH'));
});

test('template catalogs reject missing defaults, duplicate identities and paths outside their directory', () => {
  const f = fixture('material'), manifest = f.controls.projectManifest, catalog = manifest.scenarioTemplates!;
  for (const scenarioTemplates of [
    { ...catalog, defaultTemplateId: 'absent' },
    { ...catalog, templates: [catalog.templates[0], catalog.templates[0]] },
    { ...catalog, templates: [{ id: 'default', name: 'Default', path: '需求/default.md' }] },
  ]) assert.throws(() => parseProjectManifest(JSON.stringify({ ...manifest, scenarioTemplates })), error => error instanceof DomainError);
});

for (const path of ['project.assets.json', '.template/default.md', '场景/unselected.md', '需求/unselected.md', '交接/unselected.md', 'baseline.unselected.json']) {
  test(`declaring ${path} as an attachment cannot bypass its protected write scope`, async () => {
    const f = fixture('material'), bytes = Buffer.from('declared as an attachment');
    // Scope protection is independent of file verification, which is covered above.
    mock.method(f.content, 'verify', async () => ({ ...f.metadata, files: [{ path, sha256: createHash('sha256').update(bytes).digest('hex') }] }));
    f.input.allowedPaths.push(path); f.controls.candidateDiffs.push(f.diff(path));
    await assert.rejects(f.content.verifyCandidate(actor, 7, f.input), code('MATERIAL_PATH_SCOPE'));
  });
}

function templateInput(f: ReturnType<typeof fixture>): TemplateIntegrationRequest {
  f.controls.candidateDiffs = [f.diff('.template/default.md')];
  return { idempotencyKey: 'template-publish', stage: 'template', expectedProjectRevision: f.project.revision, expectedHead: head, candidateSha: candidate, sourceSha: candidate, allowedPaths: ['.template/default.md'], checks: { candidateSha: candidate, passed: true, checks: [{ name: 'templates', passed: true, evidenceHash: 'a'.repeat(64) }] } };
}

test('template publication validates its own checks and never confirms a business material', async () => {
  const f = fixture('material'), input = templateInput(f);
  assert.equal((await f.content.verifyCandidate(actor, 7, input)).size, 0);
  assert.deepEqual(f.reads, []);
  input.checks.checks = [{ name: 'materials', passed: true, evidenceHash: 'a'.repeat(64) }];
  await assert.rejects(f.content.verifyCandidate(actor, 7, input), code('CHECKS_REQUIRED'));
});

test('template publication cannot change project identity or include a material draft', async () => {
  const f = fixture('material'), input = templateInput(f);
  f.controls.candidateManifest = { ...f.controls.projectManifest, schemaVersion: 1, directories: ['场景', '需求', '交接', '原型代码'], projectId: 'forged-project' };
  await assert.rejects(f.content.verifyCandidate(actor, 7, input), code('TEMPLATE_MANIFEST_SCOPE'));
  f.controls.candidateManifest = undefined;
  input.allowedPaths.push(f.materialPath); f.controls.candidateDiffs.push(f.diff(f.materialPath));
  await assert.rejects(f.content.verifyCandidate(actor, 7, input), code('TEMPLATE_PATH_SCOPE'));
});

test('template publication preserves historical catalog identities and refuses deletion', async () => {
  const f = fixture('material'), input = templateInput(f);
  f.controls.candidateManifest = { ...f.controls.projectManifest, schemaVersion: 1, directories: ['场景', '需求', '交接', '原型代码'], scenarioTemplates: { defaultTemplateId: 'replacement', templates: [{ id: 'replacement', name: 'Replacement', path: '.template/replacement.md' }] } };
  await assert.rejects(f.content.verifyCandidate(actor, 7, input), code('TEMPLATE_DELETE_FORBIDDEN'));
  f.controls.candidateManifest = undefined; f.controls.candidateDiffs[0]!.deleted_file = true;
  await assert.rejects(f.content.verifyCandidate(actor, 7, input), code('TEMPLATE_PATH_SCOPE'));
});

test('a project accepted without template catalogs reads empty catalogs instead of failing', async () => {
  const f = fixture('material'), { scenarioTemplates: _scenarios, requirementTemplates: _requirements, ...legacy } = f.controls.projectManifest;
  f.controls.projectManifest = legacy;
  assert.deepEqual(await f.content.loadProjectTemplates(actor, 7, head), { scenarios: { templates: [] }, requirements: { templates: [] } });
});

test('the first template publication may declare the catalog of a project accepted without one', async () => {
  const f = fixture('material'), input = templateInput(f), { scenarioTemplates: _catalog, ...legacy } = f.controls.projectManifest;
  f.controls.projectManifest = legacy;
  f.controls.candidateManifest = { ...legacy, scenarioTemplates: { defaultTemplateId: 'default', templates: [{ id: 'default', name: 'Default', path: '.template/default.md' }] } };
  assert.equal((await f.content.verifyCandidate(actor, 7, input)).size, 0);
});

test('controlled configuration publication may update only the project CONTEXT.md', async () => {
  const f = fixture('material'), input = templateInput(f);
  f.controls.candidateDiffs = [f.diff('CONTEXT.md')];
  input.allowedPaths = ['CONTEXT.md'];
  assert.equal((await f.content.verifyCandidate(actor, 7, input)).size, 0);
});

test('a CONTEXT.md-only configuration change does not require republishing a template catalog', async () => {
  const f = fixture('material'), input = templateInput(f), { scenarioTemplates: _catalog, ...legacy } = f.controls.projectManifest;
  f.controls.projectManifest = legacy;
  f.controls.candidateDiffs = [f.diff('CONTEXT.md')];
  input.allowedPaths = ['CONTEXT.md'];
  assert.equal((await f.content.verifyCandidate(actor, 7, input)).size, 0);
});

test('controlled configuration publication cannot open unrelated project root files', async () => {
  const f = fixture('material'), input = templateInput(f);
  f.controls.candidateDiffs = [f.diff('README.md')];
  input.allowedPaths = ['README.md'];
  await assert.rejects(f.content.verifyCandidate(actor, 7, input), code('TEMPLATE_PATH_SCOPE'));
});
