import assert from 'node:assert/strict';
import test from 'node:test';
import type { BindTemplateRequest, EntityView, ProjectView } from '@eadp/contracts';
import type { GitLab } from '../auth/gitlab.js';
import type { PublicationAuthorization } from '../auth/publication.js';
import type { Actor, SessionAuth } from '../auth/session.js';
import type { GitLabContent } from '../gitlab-content.js';
import type { Database, Transaction } from '../persistence/database.js';
import { withContext } from '../persistence/repository.js';
import { CollaborationService } from '../service.js';
import { bind, verifyBinding } from './templates.js';

const actor: Actor = { id: 1, username: 'author', name: 'Author', email: 'author@example.test', admin: false, gitlabUserId: 1, gitlabUsername: 'author', sessionHash: 'a'.repeat(64) };
const project = { id: 'project', gitlabProjectId: 1, repositoryUrl: 'https://example.test/project.git', stableBranch: 'main', name: 'Project', namespaceId: 1, namespacePath: 'group', initializationStatus: 'ready', revision: 2, recognizedHead: 'a'.repeat(40) } satisfies ProjectView;
const fixed = { commitSha: 'a'.repeat(40), path: '.template/default.md', sha256: 'b'.repeat(64) };

function material(kind: 'scenario' | 'requirement'): EntityView {
  return { id: kind, kind, title: 'Material', templateId: 'default', templateRef: fixed, authorId: actor.id, revision: 1, generation: 1, materialVersion: 0, confirmationStatus: 'draft', taskStatus: 'active', scenarioIds: [], prerequisites: [], occupation: { occupationId: 'occupation', entityId: kind, ownerId: actor.id, generation: 1, taskId: 'task', clientId: 'client', expectedRevision: 1, inputVersion: 0, purpose: 'design', createdAt: '2026-10-24T00:00:00Z' } };
}

function request(value: EntityView): BindTemplateRequest {
  return { idempotencyKey: 'bind', token: { ...value.occupation! }, templateId: 'special', templateRef: { ...fixed, path: '.template/special.md' } };
}

test('a requirement keeps its selected template without writing or advancing its occupation', async () => {
  const value = material('requirement'), before = structuredClone(value);
  const connection = { query: async () => { assert.fail('a forbidden template change must not issue persistence queries'); } } as unknown as Transaction;
  await assert.rejects(bind(connection, project.id, value, actor, request(value)), error => (error as { code?: string }).code === 'REQUIREMENT_TEMPLATE_FIXED');
  assert.deepEqual(value, before);
});

test('a requirement template switch is rejected before any cached result or Git lookup can bypass the rule', async () => {
  const connection = {
    query: async (sql: string) => ({ rows: sql.startsWith('SELECT * FROM studio_entities') ? [{ kind: 'requirement' }] : [], rowCount: 0 }),
    release: () => {},
  } as unknown as Transaction;
  const database = { connect: async () => connection } as unknown as Database;
  const gitlab = { json: async () => { assert.fail('a requirement template switch must not read Git'); } } as unknown as GitLab;
  const service = new CollaborationService(database, gitlab, {} as PublicationAuthorization, {} as SessionAuth);
  service.authorize = async () => project;
  service.replay = async () => { assert.fail('an old cached template switch must not bypass the fixed requirement template'); };
  await assert.rejects(service.bindTemplate(actor, project.id, 'requirement', request(material('requirement'))), error => (error as { code?: string }).code === 'REQUIREMENT_TEMPLATE_FIXED');
});

test('an owned scenario can still select a verified historical template and persist its new revision', async () => {
  const value = material('scenario'), input = request(value);
  const verified: unknown[][] = [], writes: Array<{ sql: string; values: unknown[] }> = [];
  const gitlab = { json: async () => ({ id: input.templateRef.commitSha }) } as unknown as GitLab;
  const content = { verifyTemplate: async (...args: unknown[]) => { verified.push(args); } } as unknown as GitLabContent;
  await verifyBinding(gitlab, content, actor, project, input);
  assert.deepEqual(verified, [[actor, project.gitlabProjectId, 'scenario', input.templateRef, input.templateId]]);
  const connection = { query: async (sql: string, values: unknown[] = []) => {
    writes.push({ sql, values });
    return { rows: [], rowCount: sql.startsWith('SELECT') ? 0 : 1 };
  } } as unknown as Transaction;
  const result = await withContext({ actor }, () => bind(connection, project.id, value, actor, input));
  assert.equal(result.templateId, input.templateId);
  assert.deepEqual(result.templateRef, input.templateRef);
  assert.equal(result.revision, 2);
  assert.equal(result.occupation?.expectedRevision, 2);
  assert.ok(writes.some(write => write.sql.startsWith('INSERT INTO studio_entities') && write.values[8] === input.templateId));
  assert.ok(writes.some(write => write.sql.startsWith('INSERT INTO studio_audit') && write.values[1] === 'material.template-bound'));
});
