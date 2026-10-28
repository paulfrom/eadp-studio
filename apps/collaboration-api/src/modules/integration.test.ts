import assert from 'node:assert/strict';
import test from 'node:test';
import type { EntityView, MaterialIntegrationRequest, MaterialMetadata, ProjectView, TemplateIntegrationRequest } from '@eadp/contracts';
import type { Actor } from '../auth/session.js';
import { validateIntegration } from './integration.js';
import { visibleEntity } from './visibility.js';

const sha = 'a'.repeat(40), hash = 'b'.repeat(64);
const actor: Actor = { id: 1, username: 'author', name: 'Author', email: 'author@example.test', admin: false, gitlabUserId: 1, gitlabUsername: 'author', sessionHash: hash };
const project: ProjectView = { id: 'project', gitlabProjectId: 1, repositoryUrl: 'https://example.test/project.git', stableBranch: 'main', name: 'Project', namespaceId: 1, namespacePath: 'group', initializationStatus: 'ready', revision: 2, recognizedHead: sha };
const fixed = { commitSha: sha, path: '场景/scenario.md', sha256: hash };
function scenario(version = 0): EntityView {
  return { id: 'scenario', kind: 'scenario', title: 'Scenario', code: 'SC-0001', sequence: 1, templateId: 'default', templateRef: { ...fixed, path: '.template/default.md' }, authorId: 1, revision: 1, generation: 1, materialVersion: version, confirmationStatus: version ? 'confirmed' : 'draft', taskStatus: 'active', scenarioIds: [], prerequisites: [], occupation: { occupationId: 'occupation', entityId: 'scenario', ownerId: 1, generation: 1, taskId: 'task', clientId: 'client', expectedRevision: 1, inputVersion: version, purpose: 'design', createdAt: '2026-10-20T00:00:00.000Z' } };
}
function metadata(value: EntityView): MaterialMetadata {
  const common = { entityId: value.id, title: value.title, scenarioIds: value.scenarioIds, prerequisites: [], sources: [], businessEvidence: [{ label: 'Business source', reference: 'Archived evidence', files: [{ path: '.eadp/evidence/source.txt', sha256: hash }], ranges: [{ path: '.eadp/evidence/source.txt', startLine: 1, endLine: 1 }] }], openQuestions: [], referencedAssets: [] };
  return value.kind === 'scenario' ? { ...common, kind: 'scenario', flowComplete: true, templateId: value.templateId!, templateRef: value.templateRef! } : { ...common, kind: 'requirement', coreRulesPresent: true, acceptanceCriteriaPresent: true, templateId: 'requirement-default', templateRef: { commitSha: fixed.commitSha, path: '.template/requirement-default.md', sha256: '0'.repeat(64) } };
}
function request(value: EntityView): MaterialIntegrationRequest {
  return { idempotencyKey: 'prepare', entityId: value.id, token: value.occupation!, stage: 'material', sourceSha: sha, expectedHead: sha, candidateSha: sha, allowedPaths: [fixed.path], checks: { candidateSha: sha, passed: true, checks: [{ name: 'material', passed: true, evidenceHash: hash }] }, confirmations: [{ entityId: value.id, expectedRevision: value.revision, fixed, readHash: hash, authorConfirmed: true, confirmationMethod: 'direct' }] };
}
function rejectsCode(action: () => unknown, code: string) {
  assert.throws(action, error => (error as { code?: string }).code === code);
}

test('a confirmed scenario is revised through an ordinary design occupation without a batch', () => {
  const value = scenario(1), input = request(value);
  assert.equal(validateIntegration(project, [value], actor, input, new Map([[value.id, metadata(value)]])), value);
});

test('confirmation binds the read hash and exact selected template', () => {
  const value = scenario(), input = request(value), material = metadata(value), materials = new Map([[value.id, material]]);
  input.confirmations[0]!.readHash = 'c'.repeat(64);
  rejectsCode(() => validateIntegration(project, [value], actor, input, materials), 'READ_VERSION_MISMATCH');
  input.confirmations[0]!.readHash = hash;
  material.templateRef = { ...value.templateRef!, sha256: 'd'.repeat(64) };
  rejectsCode(() => validateIntegration(project, [value], actor, input, materials), 'TEMPLATE_BINDING_CHANGED');
});

test('requirements cannot confirm without a fixed version for every related scenario', () => {
  const source = scenario(1); delete source.occupation;
  const value: EntityView = { ...scenario(), id: 'requirement', kind: 'requirement', templateId: 'requirement-default', templateRef: { commitSha: sha, path: '.template/requirement-default.md', sha256: '0'.repeat(64) }, scenarioIds: [source.id] };
  value.occupation = { ...value.occupation!, entityId: value.id };
  const input = request(value), material = metadata(value), materials = new Map([[value.id, material]]);
  rejectsCode(() => validateIntegration(project, [source, value], actor, input, materials), 'SCENARIO_SOURCE_REQUIRED');
  material.sources = [{ projectId: project.id, entityId: source.id, version: 1 }];
  assert.equal(validateIntegration(project, [source, value], actor, input, materials), value);
  material.sources[0]!.version = 2;
  rejectsCode(() => validateIntegration(project, [source, value], actor, input, materials), 'SCENARIO_VERSION_MISMATCH');
});

test('template publication uses project revision without an entity occupation', () => {
  const { idempotencyKey, sourceSha, expectedHead, candidateSha, checks } = request(scenario());
  const input: TemplateIntegrationRequest = { idempotencyKey, sourceSha, expectedHead, candidateSha, checks, allowedPaths: ['.template/default.md'], stage: 'template', expectedProjectRevision: project.revision };
  assert.equal(validateIntegration(project, [], actor, input, new Map()), undefined);
  input.expectedProjectRevision--;
  rejectsCode(() => validateIntegration(project, [], actor, input, new Map()), 'REVISION_CONFLICT');
});

test('other members see a draft directory card without local material', () => {
  const draft = scenario();
  const view = visibleEntity(draft, { ...actor, id: 2 });
  assert.equal('title' in view && view.title, draft.title);
  assert.equal('code' in view && view.code, draft.code);
  assert.equal('current' in view, false);
  assert.equal('prerequisites' in view, false);
});
