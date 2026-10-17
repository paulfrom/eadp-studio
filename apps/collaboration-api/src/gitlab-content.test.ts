import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, mock, test } from 'node:test';
import { DomainError } from '@eadp/asset-domain';
import type { EntityView, MaterialMetadata, PrepareIntegrationRequest, ProjectView } from '@eadp/contracts';
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

function fixture(stage: PrepareIntegrationRequest['stage'] = 'prototype') {
  const kind = stage === 'scenario-batch' ? 'scenario' : 'requirement';
  const metadata: MaterialMetadata = { entityId: 'asset-1', kind, title: 'Accepted input', categoryId: 'business', scenarioIds: [], prerequisites: [], sources: [], businessEvidence: [{ label: 'Author', reference: 'synthetic-acceptance' }], coreRulesPresent: true, acceptanceCriteriaPresent: true, openQuestions: [], referencedAssets: [] };
  const materialPath = `${kind === 'scenario' ? '场景' : '需求'}/asset-1.md`;
  const body = Buffer.from('# Accepted input\n\n```eadp-metadata\n' + JSON.stringify(metadata) + '\n```\n\n## 核心业务规则\n\n明确的业务规则。\n\n## 验收条件\n\n明确的验收条件。\n');
  const fixed = { commitSha: fixedSha, path: materialPath, sha256: createHash('sha256').update(body).digest('hex') };
  const token = { occupationId: 'occupation-1', generation: 1, taskId: 'task-1', clientId: 'client-1', expectedRevision: 1, entityId: 'asset-1', ownerId: actor.id, purpose: stage === 'prototype' ? 'prototype' as const : stage === 'scenario-batch' ? 'scenario-batch' as const : 'design' as const, inputVersion: 1, prerequisiteBindings: [], createdAt: '' };
  const entity: EntityView = { id: 'asset-1', kind, title: metadata.title, categoryId: metadata.categoryId, revision: 1, generation: 1, materialVersion: 1, confirmationStatus: 'confirmed', taskStatus: 'active', scenarioIds: [], prerequisites: [], authorId: actor.id, frozenBy: [], associationRevision: 0, occupation: token, current: { version: 1, confirmationId: 'confirmation-1', confirmedBy: actor.id, confirmedAt: '', fixed, metadata, reuse: { enabled: true, reason: 'accepted' } } };
  const project: ProjectView = { id: 'project-1', gitlabProjectId: 7, repositoryUrl: 'http://gitlab.test/team/project.git', stableBranch: 'main', name: 'Project', namespaceId: 2, namespacePath: 'team', initializationStatus: 'ready', recognizedHead: head, revision: 1, categories: [{ id: 'business', name: 'Business' }] };
  const changedPath = stage === 'prototype' ? '原型代码/src/pages/index.tsx' : materialPath;
  const diff = (path: string, text = '+accepted change') => ({ old_path: path, new_path: path, deleted_file: false, renamed_file: false, diff: text });
  const input: PrepareIntegrationRequest = { idempotencyKey: 'integration-1', entityId: entity.id, token, stage, sourceSha: candidate, candidateSha: candidate, expectedHead: head, allowedPaths: [changedPath], checks: { candidateSha: candidate, passed: true, checks: (stage === 'prototype' ? ['engineering', 'mock', 'browser', 'relations'] : ['materials', 'relations']).map(name => ({ name, passed: true, evidenceHash: 'e'.repeat(64) })) }, confirmations: [{ entityId: entity.id, expectedRevision: entity.revision, fixed: stage === 'prototype' ? { ...fixed } : { ...fixed, commitSha: candidate }, metadata: structuredClone(metadata), confirmationMethod: 'direct', authorConfirmed: true }], ...(stage === 'scenario-batch' ? { expectedAssociationRevision: 0, batchRequirementIds: [] } : {}) };
  const controls = { candidateBody: body, fixedBody: body, candidateDiffs: [diff(changedPath)], sourceDiffs: [diff(changedPath)], denied: false };
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
    if (path === `/projects/7/repository/files/${materialPath}/raw`) {
      const ref = parsed.searchParams.get('ref'); reads.push({ path: materialPath, ref });
      assert.equal(parsed.searchParams.get('lfs'), 'false');
      assert.ok(ref === fixedSha || ref === candidate, 'the verified ref must be the exact accepted input or candidate');
      return new Response(ref === candidate ? controls.candidateBody : controls.fixedBody);
    }
    throw new Error(`Unexpected synthetic GitLab request ${path}`);
  });
  const content = new GitLabContent(new GitLab(config));
  const verify = async () => { validateIntegration(project, [entity], actor, input); await content.verifyCandidate(actor, project.gitlabProjectId, input); };
  return { input, entity, project, content, controls, reads, body, metadata, materialPath, diff, verify };
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
  assert.throws(() => validateIntegration(f.project, [f.entity], actor, f.input), code('PROTOTYPE_INPUT_CHANGED'));
  f.input.confirmations[0]!.fixed = { ...f.entity.current!.fixed, path: '需求/other.md' };
  assert.throws(() => validateIntegration(f.project, [f.entity], actor, f.input), code('PROTOTYPE_INPUT_CHANGED'));
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
  assert.throws(() => validateIntegration(f.project, [f.entity], actor, f.input), code('PROTOTYPE_INPUT_CHANGED'));
  f.input.confirmations[0]!.fixed = { ...f.entity.current!.fixed };
  f.input.confirmations[0]!.metadata.title = 'unconfirmed title';
  assert.throws(() => validateIntegration(f.project, [f.entity], actor, f.input), code('PROTOTYPE_INPUT_CHANGED'));
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
  assert.throws(() => validateIntegration(f.project, [f.entity], actor, f.input), code('PROTOTYPE_INPUT_CHANGED'));
});

for (const stage of ['material', 'prototype'] as const) {
  test(`${stage} AI-assisted confirmation binds the reviewed candidate and exact input`, () => {
    const f = fixture(stage), confirmation = f.input.confirmations[0]!;
    f.input.confirmations[0] = { ...confirmation, confirmationMethod: 'ai-assisted', reviewEvidence: {
      candidateSha: candidate, inputHash: confirmation.fixed.sha256,
      reportHash: '1'.repeat(64), dispositionHash: '2'.repeat(64),
    } };
    validateIntegration(f.project, [f.entity], actor, f.input);
  });
  for (const field of ['candidateSha', 'inputHash'] as const) {
    test(`${stage} rejects a review for another ${field}`, () => {
      const f = fixture(stage), confirmation = f.input.confirmations[0]!;
      const reviewEvidence = { candidateSha: candidate, inputHash: confirmation.fixed.sha256,
        reportHash: '1'.repeat(64), dispositionHash: '2'.repeat(64) };
      reviewEvidence[field] = field === 'candidateSha' ? 'f'.repeat(40) : '0'.repeat(64);
      f.input.confirmations[0] = { ...confirmation, confirmationMethod: 'ai-assisted', reviewEvidence };
      assert.throws(() => validateIntegration(f.project, [f.entity], actor, f.input),
        code(field === 'candidateSha' ? 'REVIEW_CANDIDATE_MISMATCH' : 'REVIEW_INPUT_MISMATCH'));
    });
  }
}
