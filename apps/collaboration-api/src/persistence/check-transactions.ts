// Runs only on an explicitly named empty disposable database; fixed records are
// retained for inspection and the caller owns dropping the disposable database.
import assert from 'node:assert/strict';
import type { EntityView, ProjectView, ReserveEntityRequest } from '@eadp/contracts';
import { createDatabase, transaction } from './database.js';
import { applySchema } from './schema.js';
import { loadConfig } from '../config.js';
import { PublicationAuthorization } from '../auth/publication.js';
import { GitLab } from '../auth/gitlab.js';
import type { Actor } from '../auth/session.js';
import { SessionAuth } from '../auth/session.js';
import { CollaborationService } from '../service.js';
import * as occupations from '../modules/occupations.js';
import * as repository from './repository.js';

const databaseUrl = process.env.SCENARIO_TRANSACTION_TEST_DATABASE_URL;
assert.ok(databaseUrl, 'Set SCENARIO_TRANSACTION_TEST_DATABASE_URL to an empty disposable database');
assert.match(new URL(databaseUrl).pathname, /^\/eadp_scenario_transaction_check_[a-z0-9_]+$/);
const config = { ...loadConfig(), databaseUrl }, database = createDatabase(config), projectId = 'transaction-check-project';
const actor: Actor = { id: 1, username: 'transaction-test', name: 'Transaction Test', email: 'test@example.invalid', gitlabUserId: 1, gitlabUsername: 'transaction-test', sessionHash: '', admin: true };
const gitlab = new GitLab(config);
const service = new CollaborationService(database, gitlab, new PublicationAuthorization(config), new SessionAuth(database, gitlab, config));
const initial: EntityView = { id: 'scenario', kind: 'scenario', title: 'Transaction check', revision: 0, generation: 0, materialVersion: 0, confirmationStatus: 'draft', taskStatus: 'idle', scenarioIds: [], prerequisites: [], authorId: actor.id, frozenBy: [], associationRevision: 0 };
try {
  const existing = await database.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
  assert.equal(existing.rowCount, 0, 'The disposable database must be empty');
  await transaction(database, applySchema);
  await repository.withContext({ actor }, () => transaction(database, async c => {
    await c.query('INSERT INTO studio_users(id,username,name,email,admin,password_salt,password_hash) VALUES(1,$1,$2,$3,true,$4,$5)', [actor.username, actor.name, actor.email, '0'.repeat(32), '0'.repeat(128)]);
    await c.query(`INSERT INTO studio_projects(id,key,request_hash,namespace_id,namespace_path,path,name,marker,state,gitlab_project_id,repository_url,recognized_head,creator_id,creator_account,creator_name,last_editor_id,last_editor_account,last_editor_name) VALUES($1,'check',$2,1,'check','check','Check','check','ready',1,'https://example.invalid/check.git',$3,1,$4,$5,1,$4,$5)`, [projectId, '0'.repeat(64), '0'.repeat(40), actor.username, actor.name]);
    const project: ProjectView = await repository.project(c, projectId);
    project.categories = [{ id: 'check', name: 'Check' }];
    await repository.saveProject(c, project);
  }));
  const reserve = (key: string): ReserveEntityRequest => ({ idempotencyKey: key, kind: 'scenario', title: 'Number check' });
  Object.assign(initial, await repository.reserveScenarioNumber(database, projectId, actor, reserve('initial-create')), { templateId: 'scenario', templateRef: { commitSha: '0'.repeat(40), path: '.template/scenario.md', sha256: '0'.repeat(64) } });
  await repository.withContext({ actor }, () => transaction(database, c => repository.saveEntity(c, projectId, initial)));
  const failedNumber = await repository.reserveScenarioNumber(database, projectId, actor, reserve('failed-create'));
  await assert.rejects(repository.withContext({ actor }, () => transaction(database, async c => {
    await repository.saveEntity(c, projectId, { ...initial, ...failedNumber, kind: 'scenario', categoryId: undefined, templateId: 'scenario', templateRef: { commitSha: '0'.repeat(40), path: '.template/scenario.md', sha256: '0'.repeat(64) } });
    throw new Error('Injected business failure after number allocation');
  })), /Injected business failure/);
  assert.deepEqual(await repository.reserveScenarioNumber(database, projectId, actor, reserve('failed-create')), failedNumber, 'Retry after business rollback must retain the original identity and number');
  await assert.rejects(repository.reserveScenarioNumber(database, projectId, actor, { ...reserve('failed-create'), title: 'Changed request' }), /another request/);
  await assert.rejects(repository.withContext({ actor }, () => transaction(database, c => repository.previous(c, projectId, actor, 'category.write', { idempotencyKey: 'failed-create' }))), /reserved by a different entity creation/);
  assert.equal((await transaction(database, c => repository.previous(c, projectId, actor, 'entity.reserve', reserve('failed-create')))).found, false, 'The original reserved creation may retry its business writes');
  const same = await Promise.all(Array.from({ length: 8 }, () => repository.reserveScenarioNumber(database, projectId, actor, reserve('same-key'))));
  assert.ok(same.every(v => v.id === same[0]!.id && v.sequence === same[0]!.sequence));
  const distinct = await Promise.all(Array.from({ length: 12 }, (_, i) => repository.reserveScenarioNumber(database, projectId, actor, reserve(`different-${i}`))));
  assert.equal(new Set(distinct.map(v => v.sequence)).size, 12, 'Concurrent independent allocations must be unique');
  assert.ok(distinct.every(v => v.sequence > failedNumber.sequence), 'Failed allocations must never be recycled');
  const input = (key: string) => ({ idempotencyKey: key, expectedRevision: 0, taskId: key, clientId: key, purpose: 'design' as const });
  const candidates = await Promise.allSettled([0, 1].map(i => {
    const request = input(`claim-${i}`);
    return service.mutate(actor, projectId, 'check.claim', request, (c, _p, all) => occupations.claim(c, projectId, all, initial.id, actor, request));
  }));
  assert.equal(candidates.filter(r => r.status === 'fulfilled').length, 1, 'Concurrent tasks must have exactly one occupation winner');
  const winner = candidates.find(r => r.status === 'fulfilled')!;
  if (winner.status !== 'fulfilled') throw new Error('No claim succeeded');
  const claimed = winner.value, originalKey = claimed.occupation!.taskId;
  const replay = await service.mutate(actor, projectId, 'check.claim', input(originalKey), async () => { throw new Error('Replay incorrectly executed mutation'); });
  assert.deepEqual(replay, claimed, 'Same operation must return its original result');
  await service.mutate(actor, projectId, 'check.release', { idempotencyKey: 'release' }, (c, _p, all) => occupations.release(c, projectId, all, initial.id, actor, { idempotencyKey: 'release', token: claimed.occupation!, reason: 'Transaction test release' }, false));
  const released = await transaction(database, c => repository.entities(c, projectId));
  const request = { ...input('reclaim'), expectedRevision: released[0]!.revision };
  const reclaimed = await service.mutate(actor, projectId, 'check.reclaim', request, (c, _p, all) => occupations.claim(c, projectId, all, initial.id, actor, request));
  assert.equal(reclaimed.generation, 2, 'Reclaim must create a fresh generation');
  assert.throws(() => occupations.assertOccupation(reclaimed, claimed.occupation!, actor), /must match/, 'Old occupation must be rejected after reclaim');
  console.log('Passed: independent durable number allocation, parallel uniqueness, exact operation replay and stale occupation rejection.');
} finally { await database.end(); }
