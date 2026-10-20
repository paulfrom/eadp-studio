import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, mock, test } from 'node:test';
import { DomainError, parseMaterial, parseProjectManifest } from '@eadp/asset-domain';
import Fastify from 'fastify';
import type { TSchema } from '@eadp/contracts';
import { ConfirmationInputSchema, ReserveEntitySchema, reviewInputText } from '@eadp/contracts';
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

function fixture(stage: MaterialIntegrationRequest['stage'] = 'prototype') {
  const kind = stage === 'scenario-batch' ? 'scenario' : 'requirement';
  const evidenceBytes = Buffer.from('用户提供的业务依据。\n第二行明确规则。\n');
  const evidencePath = '.eadp/evidence/source.txt';
  const templateBytes = Buffer.from('# 默认场景模板\n\n## 自定义章节\n');
  const templateRef = { commitSha: fixedSha, path: '.template/default.md', sha256: createHash('sha256').update(templateBytes).digest('hex') };
  const common = { entityId: 'asset-1', title: 'Accepted input', scenarioIds: kind === 'requirement' ? ['source-1'] : [], prerequisites: [], sources: kind === 'requirement' ? [{ projectId: 'project-1', entityId: 'source-1', version: 1 }] : [], businessEvidence: [{ label: 'Author', reference: 'synthetic-acceptance', files: [{ path: evidencePath, sha256: createHash('sha256').update(evidenceBytes).digest('hex') }], ranges: [{ path: evidencePath, startLine: 1, endLine: 1 }] }], coreRulesPresent: true, acceptanceCriteriaPresent: true, openQuestions: [], referencedAssets: [] };
  const metadata: MaterialMetadata = kind === 'scenario' ? { ...common, kind, templateId: 'default', templateRef } : { ...common, kind, categoryId: 'business' };
  const materialPath = `${kind === 'scenario' ? '场景' : '需求'}/asset-1.md`;
  const body = Buffer.from('# Accepted input\n\n```eadp-metadata\n' + JSON.stringify(metadata) + '\n```\n\n## 核心业务规则\n\n明确的业务规则。\n\n## 验收条件\n\n明确的验收条件。\n');
  const fixed = { commitSha: fixedSha, path: materialPath, sha256: createHash('sha256').update(body).digest('hex') };
  const token = { occupationId: 'occupation-1', generation: 1, taskId: 'task-1', clientId: 'client-1', expectedRevision: 1, entityId: 'asset-1', ownerId: actor.id, purpose: stage === 'prototype' ? 'prototype' as const : stage === 'scenario-batch' ? 'scenario-batch' as const : 'design' as const, inputVersion: 1, prerequisiteBindings: [], createdAt: '' };
  const entity: EntityView = { id: 'asset-1', kind, title: metadata.title, categoryId: metadata.categoryId, revision: 1, generation: 1, materialVersion: 1, confirmationStatus: 'confirmed', taskStatus: 'active', scenarioIds: [], prerequisites: [], authorId: actor.id, frozenBy: [], associationRevision: 0, templateId: metadata.templateId, templateRef: metadata.templateRef, occupation: token, current: { version: 1, confirmationId: 'confirmation-1', confirmedBy: actor.id, confirmedAt: '', fixed, metadata, reuse: { enabled: true, reason: 'accepted' } } };
  const project: ProjectView = { id: 'project-1', gitlabProjectId: 7, repositoryUrl: 'http://gitlab.test/team/project.git', stableBranch: 'main', name: 'Project', namespaceId: 2, namespacePath: 'team', initializationStatus: 'ready', recognizedHead: head, revision: 1, categories: [{ id: 'business', name: 'Business' }] };
  const changedPath = stage === 'prototype' ? '原型代码/src/pages/index.tsx' : materialPath;
  const diff = (path: string, text = '+accepted change') => ({ old_path: path, new_path: path, deleted_file: false, renamed_file: false, diff: text });
  const input: MaterialIntegrationRequest = { idempotencyKey: 'integration-1', entityId: entity.id, token, stage, sourceSha: candidate, candidateSha: candidate, expectedHead: head, allowedPaths: [changedPath], checks: { candidateSha: candidate, passed: true, checks: (stage === 'prototype' ? ['engineering', 'mock', 'browser', 'relations'] : ['materials', 'relations']).map(name => ({ name, passed: true, evidenceHash: 'e'.repeat(64) })) }, confirmations: [{ entityId: entity.id, expectedRevision: entity.revision, fixed: stage === 'prototype' ? { ...fixed } : { ...fixed, commitSha: candidate }, readHash: fixed.sha256, confirmationMethod: 'direct', authorConfirmed: true }], ...(stage === 'scenario-batch' ? { expectedAssociationRevision: 0, batchRequirementIds: [] } : {}) };
  const controls = { candidateManifest: undefined as ProjectManifest | undefined, projectManifest: { schemaVersion: 1, projectId: project.id, gitlabProjectId: 7, repositoryUrl: project.repositoryUrl, stableBranch: 'main', directories: ['场景', '需求', '原型代码'], scenarioTemplates: { defaultTemplateId: 'default', templates: [{ id: 'default', name: 'Default', path: templateRef.path }] } }, files: new Map([[evidencePath, evidenceBytes]]), candidateBody: body, fixedBody: body, candidateDiffs: [diff(changedPath)], sourceDiffs: [diff(changedPath)], denied: false };
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
    const filePath = path.match(/^\/projects\/7\/repository\/files\/(.+)\/raw$/)?.[1];
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
  const materials = new Map([[metadata.entityId, structuredClone(metadata)]]);
  const sourceEntity: EntityView = { ...entity, id: 'source-1', kind: 'scenario', scenarioIds: [], occupation: undefined, frozenBy: [], current: { ...entity.current!, metadata: { ...common, entityId: 'source-1', kind: 'scenario', templateId: 'default', templateRef, scenarioIds: [], sources: [] } } };
  const all = [entity, sourceEntity];
  const verify = async () => { validateIntegration(project, all, actor, input, materials); await content.verifyCandidate(actor, project.gitlabProjectId, input); };
  return { input, entity, project, content, controls, reads, body, metadata, materialPath, diff, verify, all, materials };
}

test('a normal prototype candidate verifies unchanged accepted requirement bytes at both fixed and candidate refs', async () => {
  const f = fixture(); await f.verify();
  assert.deepEqual(f.reads, [{ path: f.materialPath, ref: fixedSha }, { path: f.materialPath, ref: candidate }]);
  assert.ok(!f.input.allowedPaths.includes(f.materialPath), 'accepted input must not be added to the prototype write scope');
});

for (const stage of ['material', 'scenario-batch'] as const) test(`${stage} confirmations still require exact candidate paths and bytes`, async () => {
  const f = fixture(stage); await f.verify();
  assert.deepEqual(f.reads, [{ path: f.materialPath, ref: candidate }]);
  f.input.confirmations[0]!.fixed.commitSha = fixedSha;
  await assert.rejects(f.content.verifyCandidate(actor, 7, f.input), code('FIXED_CANDIDATE_MISMATCH'));
  f.input.confirmations[0]!.fixed.commitSha = candidate; f.input.allowedPaths = [];
  await assert.rejects(f.content.verifyCandidate(actor, 7, f.input), code('CANDIDATE_PATH_SCOPE'));
});

test('prototype input must match the exact current fixed commit and path even when content hashes match', async () => {
  const f = fixture();
  f.input.confirmations[0]!.fixed.commitSha = 'f'.repeat(40);
  assert.throws(() => validateIntegration(f.project, f.all, actor, f.input, f.materials), code('PROTOTYPE_INPUT_CHANGED'));
  f.input.confirmations[0]!.fixed = { ...f.entity.current!.fixed, path: '需求/other.md' };
  assert.throws(() => validateIntegration(f.project, f.all, actor, f.input, f.materials), code('PROTOTYPE_INPUT_CHANGED'));
});

test('prototype rejects substituted accepted or candidate requirement bytes even if comparison hides the MD change', async () => {
  const f = fixture();
  f.controls.fixedBody = Buffer.from('substituted accepted requirement');
  await assert.rejects(f.verify(), code('CONTENT_HASH_MISMATCH'));
  f.controls.fixedBody = f.body; f.controls.candidateBody = Buffer.from('substituted candidate requirement');
  await assert.rejects(f.verify(), code('CONTENT_HASH_MISMATCH'));
});

test('prototype rejects wrong confirmed hash and metadata before accepting any candidate', async () => {
  const f = fixture();
  f.input.confirmations[0]!.fixed.sha256 = '0'.repeat(64);
  assert.throws(() => validateIntegration(f.project, f.all, actor, f.input, f.materials), code('READ_VERSION_MISMATCH'));
  f.input.confirmations[0]!.fixed = { ...f.entity.current!.fixed };
  f.materials.get(f.entity.id)!.title = 'unconfirmed title';
  assert.throws(() => validateIntegration(f.project, f.all, actor, f.input, f.materials), code('PROTOTYPE_INPUT_CHANGED'));
});

test('prototype candidate path and source equality checks remain strict', async () => {
  const f = fixture();
  f.controls.candidateDiffs.push(f.diff(f.materialPath));
  await assert.rejects(f.verify(), code('CANDIDATE_PATH_SCOPE'));
  f.controls.candidateDiffs.pop(); f.input.sourceSha = sourceSha;
  f.controls.sourceDiffs = [f.diff(f.input.allowedPaths[0]!, '+different source change')];
  await assert.rejects(f.verify(), code('SOURCE_CANDIDATE_MISMATCH'));
});

test('prototype fixed input reads retain current GitLab authorization', async () => {
  const f = fixture(); f.controls.denied = true;
  await assert.rejects(f.verify(), code('GITLAB_READ_DENIED'));
  assert.deepEqual(f.reads, []);
});

test('prototype cannot whitelist a requirement MD to turn it into newly confirmed material', async () => {
  const f = fixture();
  f.input.allowedPaths.push(f.materialPath);
  f.controls.candidateDiffs.push(f.diff(f.materialPath));
  await assert.rejects(f.verify(), code('PROTOTYPE_PATH_SCOPE'));
  assert.deepEqual(f.reads, []);
  f.input.allowedPaths = [f.input.allowedPaths[0]!];
  f.controls.candidateDiffs.pop();
  f.input.confirmations[0]!.fixed.commitSha = candidate;
  assert.throws(() => validateIntegration(f.project, f.all, actor, f.input, f.materials), code('PROTOTYPE_INPUT_CHANGED'));
});

for (const stage of ['material', 'prototype'] as const) {
  test(`${stage} AI-assisted confirmation binds the reviewed candidate and exact input`, () => {
    const f = fixture(stage), confirmation = f.input.confirmations[0]!;
    f.input.confirmations[0] = { ...confirmation, confirmationMethod: 'ai-assisted', reviewEvidence: {
      candidateSha: candidate, inputHash: createHash('sha256').update(reviewInputText(f.input, f.entity)).digest('hex'),
      reportHash: '1'.repeat(64), dispositionHash: '2'.repeat(64),
    } };
    validateIntegration(f.project, f.all, actor, f.input, f.materials);
  });
  for (const field of ['candidateSha', 'inputHash'] as const) {
    test(`${stage} rejects a review for another ${field}`, () => {
      const f = fixture(stage), confirmation = f.input.confirmations[0]!;
      const reviewEvidence = { candidateSha: candidate, inputHash: createHash('sha256').update(reviewInputText(f.input, f.entity)).digest('hex'),
        reportHash: '1'.repeat(64), dispositionHash: '2'.repeat(64) };
      reviewEvidence[field] = field === 'candidateSha' ? 'f'.repeat(40) : '0'.repeat(64);
      f.input.confirmations[0] = { ...confirmation, confirmationMethod: 'ai-assisted', reviewEvidence };
      assert.throws(() => validateIntegration(f.project, f.all, actor, f.input, f.materials),
        code(field === 'candidateSha' ? 'REVIEW_CANDIDATE_MISMATCH' : 'REVIEW_INPUT_MISMATCH'));
    });
  }
  test(`${stage} review digest ignores JSON property order but rejects stale control context`, () => {
    const f = fixture(stage), confirmation = f.input.confirmations[0]!;
    const hash = () => createHash('sha256').update(reviewInputText(f.input, f.entity)).digest('hex');
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

test('scenario reservations reject category fields and requirements require fixed scenario sources', async () => {
  const input = { idempotencyKey: 'reserve-1', title: '新场景', kind: 'scenario' };
  assert.equal(await accepts(ReserveEntitySchema, input), true);
  assert.equal(await accepts(ReserveEntitySchema, { ...input, categoryId: 'business' }), false);
  assert.equal(await accepts(ReserveEntitySchema, { ...input, kind: 'requirement', categoryId: 'business', sources: [] }), false);
  assert.equal(await accepts(ReserveEntitySchema, { ...input, kind: 'requirement', categoryId: 'business', sources: [{ projectId: 'project-1', entityId: 'source-1', version: 1 }] }), true);
});

test('confirmation requests contain only controls and reject uploaded business metadata', async () => {
  const f = fixture('material'), confirmation = f.input.confirmations[0]!;
  assert.equal(await accepts(ConfirmationInputSchema, confirmation), true);
  assert.equal(await accepts(ConfirmationInputSchema, { ...confirmation, metadata: f.metadata }), false);
});

test('explicit business checks accept custom headings and short author-confirmed text', () => {
  const f = fixture('material');
  assert.deepEqual(parseMaterial(materialText(f.metadata, '规则。验收。')), f.metadata);
  for (const changed of [{ ...f.metadata, coreRulesPresent: false }, { ...f.metadata, acceptanceCriteriaPresent: false }, { ...f.metadata, openQuestions: [{ blocking: true, limitation: '未解决', excludedScope: '核心流程' }] }]) {
    assert.throws(() => parseMaterial(materialText(changed)), code('CORE_UNRESOLVED'));
  }
  assert.throws(() => parseMaterial(materialText({ ...f.metadata, sources: [] })), code('SCENARIO_SOURCE_REQUIRED'));
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

test('material confirmations cannot whitelist unselected drafts or arbitrary attachments', async () => {
  const f = fixture('material'), path = '场景/unselected.md';
  f.input.allowedPaths.push(path); f.controls.candidateDiffs.push(f.diff(path));
  await assert.rejects(f.content.verifyCandidate(actor, 7, f.input), code('MATERIAL_PATH_SCOPE'));
});

test('scenario templates are fixed catalog references and business metadata has no category', async () => {
  const f = fixture('scenario-batch');
  await f.content.verifyCandidate(actor, 7, f.input);
  assert.throws(() => parseMaterial(materialText({ ...f.metadata, categoryId: 'business' } as MaterialMetadata)), code('INVALID_MATERIAL'));
  assert.ok(f.metadata.kind === 'scenario');
  const changed = { ...f.metadata, templateRef: { ...f.metadata.templateRef, sha256: '0'.repeat(64) } };
  updateFixed(f, changed);
  await assert.rejects(f.content.verify(actor, 7, f.input.confirmations[0]!.fixed), code('TEMPLATE_REFERENCE_MISMATCH'));
});

test('template catalogs reject missing defaults, duplicate identities and paths outside their directory', () => {
  const f = fixture('material'), manifest = f.controls.projectManifest;
  for (const scenarioTemplates of [
    { ...manifest.scenarioTemplates, defaultTemplateId: 'absent' },
    { ...manifest.scenarioTemplates, templates: [manifest.scenarioTemplates.templates[0], manifest.scenarioTemplates.templates[0]] },
    { ...manifest.scenarioTemplates, templates: [{ id: 'default', name: 'Default', path: '需求/default.md' }] },
  ]) assert.throws(() => parseProjectManifest(JSON.stringify({ ...manifest, scenarioTemplates })), error => error instanceof DomainError);
});

for (const path of ['project.assets.json', '.template/default.md', '场景/unselected.md', '需求/unselected.md', 'baseline.unselected.json', 'handoff.unselected.md']) {
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
  f.controls.candidateManifest = { ...f.controls.projectManifest, schemaVersion: 1, directories: ['场景', '需求', '原型代码'], projectId: 'forged-project' };
  await assert.rejects(f.content.verifyCandidate(actor, 7, input), code('TEMPLATE_MANIFEST_SCOPE'));
  f.controls.candidateManifest = undefined;
  input.allowedPaths.push(f.materialPath); f.controls.candidateDiffs.push(f.diff(f.materialPath));
  await assert.rejects(f.content.verifyCandidate(actor, 7, input), code('TEMPLATE_PATH_SCOPE'));
});

test('template publication preserves historical catalog identities and refuses deletion', async () => {
  const f = fixture('material'), input = templateInput(f);
  f.controls.candidateManifest = { ...f.controls.projectManifest, schemaVersion: 1, directories: ['场景', '需求', '原型代码'], scenarioTemplates: { defaultTemplateId: 'replacement', templates: [{ id: 'replacement', name: 'Replacement', path: '.template/replacement.md' }] } };
  await assert.rejects(f.content.verifyCandidate(actor, 7, input), code('TEMPLATE_DELETE_FORBIDDEN'));
  f.controls.candidateManifest = undefined; f.controls.candidateDiffs[0]!.deleted_file = true;
  await assert.rejects(f.content.verifyCandidate(actor, 7, input), code('TEMPLATE_PATH_SCOPE'));
});
