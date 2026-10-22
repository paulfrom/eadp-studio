// Runs only on an explicitly named empty disposable database; fixed records are
// retained for inspection and the caller owns dropping the disposable database.
import assert from 'node:assert/strict';
import type { ClaimRequest, EntityView, ProjectView, ReserveEntityRequest } from '@eadp/contracts';
import { createDatabase, transaction, type Transaction } from './database.js';
import { applySchema } from './schema.js';
import { loadConfig } from '../config.js';
import type { Actor } from '../auth/session.js';
import * as occupations from '../modules/occupations.js';
import * as repository from './repository.js';

const databaseUrl = process.env.SCENARIO_TRANSACTION_TEST_DATABASE_URL;
assert.ok(databaseUrl, 'Set SCENARIO_TRANSACTION_TEST_DATABASE_URL to an empty disposable database');
assert.match(new URL(databaseUrl).pathname, /^\/eadp_scenario_transaction_check_[a-z0-9_]+$/);
const config = { ...loadConfig(), databaseUrl }, database = createDatabase(config), projectId = 'transaction-check-project';
const actor: Actor = { id: 1, username: 'transaction-test', name: 'Transaction Test', email: 'test@example.invalid', gitlabUserId: 1, gitlabUsername: 'transaction-test', sessionHash: '', admin: true };
const templateRef = (id: string) => ({ commitSha: '0'.repeat(40), path: `.template/${id}.md`, sha256: '0'.repeat(64) });
const reserve = (kind: 'scenario' | 'requirement', key: string): ReserveEntityRequest => kind === 'scenario'
  ? { idempotencyKey: `${kind}-${key}`, kind, title: 'Number check' }
  : { idempotencyKey: `${kind}-${key}`, kind, title: 'Number check', templateId: 'requirement', templateRef: templateRef('requirement'), sources: [{ projectId, entityId: 'scenario', version: 1 }] };
const initial: EntityView = { id: 'scenario', kind: 'scenario', title: 'Transaction check', revision: 0, generation: 0, materialVersion: 0, confirmationStatus: 'draft', taskStatus: 'idle', scenarioIds: [], prerequisites: [], authorId: actor.id };
try {
  const existing = await database.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
  assert.equal(existing.rowCount, 0, 'The disposable database must be empty');
  await transaction(database, applySchema);
  await repository.withContext({ actor }, () => transaction(database, async c => {
    await c.query('INSERT INTO studio_users(id,username,name,email,admin,password_salt,password_hash) VALUES(1,$1,$2,$3,true,$4,$5)', [actor.username, actor.name, actor.email, '0'.repeat(32), '0'.repeat(128)]);
    await c.query(`INSERT INTO studio_projects(id,key,request_hash,namespace_id,namespace_path,path,name,marker,state,gitlab_project_id,repository_url,creator_id,creator_account,creator_name,last_editor_id,last_editor_account,last_editor_name) VALUES($1,'check',$2,1,'check','check','Check','check','assigned',1,'https://example.invalid/check.git',1,$3,$4,1,$3,$4)`, [projectId, '0'.repeat(64), actor.username, actor.name]);
    const project: ProjectView = await repository.project(c, projectId);
    assert.equal(project.generalScenario, undefined, 'A project without a reserved general scenario identity exposes none');
    await repository.saveProject(c, project);
  }));
  Object.assign(initial, await repository.reserveEntityNumber(database, projectId, 'scenario', actor, reserve('scenario', 'initial-create')), { templateId: 'scenario', templateRef: templateRef('scenario') });
  assert.match(initial.code!, /^SC-0001$/, 'The first scenario number uses the SC prefix');
  await repository.withContext({ actor }, () => transaction(database, c => repository.saveEntity(c, projectId, initial)));
  for (const kind of ['scenario', 'requirement'] as const) {
    const prefix = kind === 'scenario' ? 'SC' : 'REQ';
    const failedNumber = await repository.reserveEntityNumber(database, projectId, kind, actor, reserve(kind, 'failed-create'));
    assert.match(failedNumber.code, new RegExp(`^${prefix}-\\d{4}$`), `A ${kind} number uses the ${prefix} prefix`);
    assert.deepEqual(await repository.reserveEntityNumber(database, projectId, kind, actor, reserve(kind, 'failed-create')), failedNumber, 'Replaying the same operation key must return the original identity and number');
    await assert.rejects(repository.reserveEntityNumber(database, projectId, kind, actor, { ...reserve(kind, 'failed-create'), title: 'Changed request' }), /another request/);
    const same = await Promise.all(Array.from({ length: 8 }, () => repository.reserveEntityNumber(database, projectId, kind, actor, reserve(kind, 'same-key'))));
    assert.ok(same.every(v => v.id === same[0]!.id && v.sequence === same[0]!.sequence && v.code === same[0]!.code));
    const distinct = await Promise.all(Array.from({ length: 12 }, (_, i) => repository.reserveEntityNumber(database, projectId, kind, actor, reserve(kind, `different-${i}`))));
    assert.equal(new Set(distinct.map(v => v.sequence)).size, 12, 'Concurrent independent allocations must be unique');
    assert.ok(distinct.every(v => v.code.startsWith(`${prefix}-`)), 'Every allocated code carries its kind prefix');
    assert.ok(distinct.every(v => v.sequence > failedNumber.sequence), 'Failed allocations must never be recycled');
  }
  const rolledBack = await repository.reserveEntityNumber(database, projectId, 'scenario', actor, reserve('scenario', 'rolled-back'));
  await assert.rejects(repository.withContext({ actor }, () => transaction(database, async c => {
    await repository.saveEntity(c, projectId, { ...initial, id: rolledBack.id, sequence: rolledBack.sequence, code: rolledBack.code, templateId: 'scenario', templateRef: templateRef('scenario') });
    throw new Error('Injected business failure after number allocation');
  })), /Injected business failure/);
  assert.deepEqual(await repository.reserveEntityNumber(database, projectId, 'scenario', actor, reserve('scenario', 'rolled-back')), rolledBack, 'Retry after business rollback must retain the original identity and number');
  await assert.rejects(repository.withContext({ actor }, () => transaction(database, c => repository.previous(c, projectId, actor, 'entity.update', { idempotencyKey: 'scenario-rolled-back' }))), /reserved by a different entity creation/);
  assert.equal((await transaction(database, c => repository.previous(c, projectId, actor, 'entity.reserve', reserve('scenario', 'rolled-back')))).found, false, 'The original reserved creation may retry its business writes');
  // The fixture project stays 'assigned' (the ready trigger requires the Task 4
  // initialization presets), so occupation checks replay the service mutate
  // discipline directly instead of calling the readiness-gated service.
  async function mutate<T>(action: string, input: { idempotencyKey: string }, change: (c: Transaction, all: EntityView[]) => Promise<T>): Promise<T> {
    return repository.withContext({ actor }, () => transaction(database, async c => {
      await repository.project(c, projectId, true);
      const previous = await repository.previous(c, projectId, actor, action, input);
      if (previous.found) return previous.result as T;
      const all = await repository.entities(c, projectId);
      const result = await change(c, all);
      await repository.remember(c, projectId, actor, action, input, result);
      return result;
    }));
  }
  const claimInput = (key: string, expectedRevision: number): ClaimRequest => ({ idempotencyKey: key, expectedRevision, taskId: key, clientId: key, purpose: 'design' });
  const stale = await mutate('check.stale-claim', claimInput('stale-claim', initial.revision + 100), (c, all) => occupations.claim(c, projectId, all, initial.id, actor, claimInput('stale-claim', initial.revision + 100)).then(() => 'claimed')).catch(error => error);
  assert.equal((stale as { code?: string }).code, 'REVISION_CONFLICT', 'A stale expectedRevision must be rejected');
  const requests = [0, 1].map(i => claimInput(`claim-${i}`, initial.revision));
  const candidates = await Promise.allSettled(requests.map(request =>
    mutate('check.claim', request, (c, all) => occupations.claim(c, projectId, all, initial.id, actor, request))));
  assert.equal(candidates.filter(r => r.status === 'fulfilled').length, 1, 'Concurrent claims must have exactly one occupation winner (studio_one_active_occupation)');
  const winnerIndex = candidates.findIndex(r => r.status === 'fulfilled');
  assert.ok(winnerIndex >= 0, 'One claim must succeed');
  const claimed = (candidates[winnerIndex]! as PromiseFulfilledResult<EntityView>).value;
  const replay = await mutate<EntityView>('check.claim', requests[winnerIndex]!, async (): Promise<EntityView> => { throw new Error('Replay incorrectly executed mutation'); });
  assert.equal(replay.id, claimed.id);
  assert.equal(replay.occupation?.occupationId, claimed.occupation?.occupationId, 'Replaying the same operation must return the original result');
  assert.equal(replay.revision, claimed.revision);
  await mutate('check.release', { idempotencyKey: 'release' }, (c, all) => occupations.release(c, projectId, all, initial.id, actor, { idempotencyKey: 'release', token: claimed.occupation!, reason: 'Transaction test release' }, false));
  const released = await repository.withContext({ actor }, () => transaction(database, c => repository.entities(c, projectId)));
  const reclaimRequest = claimInput('reclaim', released[0]!.revision);
  const reclaimed = await mutate('check.reclaim', reclaimRequest, (c, all) => occupations.claim(c, projectId, all, initial.id, actor, reclaimRequest));
  assert.equal(reclaimed.generation, claimed.generation + 1, 'Reclaim after release must advance the generation');
  assert.throws(() => occupations.assertOccupation(reclaimed, claimed.occupation!, actor), /must match/, 'The released occupation must be rejected after reclaim');
  console.log('Passed: independent durable dual-kind number allocation, SC/REQ prefixes, parallel uniqueness, rollback retention, exact operation-key replay, single-winner concurrent claims, stale revision rejection and generation increment after release.');
} finally { await database.end(); }
