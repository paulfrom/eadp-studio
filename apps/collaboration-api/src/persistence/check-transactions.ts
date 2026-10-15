// Optional focused check against the configured disposable G0 database.
// It creates one synthetic project and removes all of its rows before exit.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { EntityView, ProjectView } from '@eadp/contracts';
import { createDatabase, transaction } from './database.js';
import { loadConfig } from '../config.js';
import { PublicationAuthorization } from '../auth/publication.js';
import { GitLab } from '../auth/gitlab.js';
import type { Actor } from '../auth/session.js';
import { SessionAuth } from '../auth/session.js';
import { CollaborationService } from '../service.js';
import * as occupations from '../modules/occupations.js';
import { entities, saveEntity } from './repository.js';

const config = loadConfig(), database = createDatabase(config), projectId = `transaction-check-${randomUUID()}`;
const first: Actor = { id: 910000001, username: 'synthetic-first', name: 'First', email: 'first@example.test', gitlabUserId: 810000001, gitlabUsername: 'synthetic-first', sessionHash: '', admin: true };
const second: Actor = { id: 910000002, username: 'synthetic-second', name: 'Second', email: 'second@example.test', gitlabUserId: 810000002, gitlabUsername: 'synthetic-second', sessionHash: '', admin: false };
const service = new CollaborationService(database, new GitLab(config), new PublicationAuthorization(config), new SessionAuth(database, new GitLab(config), config));
const initial: EntityView = { id: 'requirement', kind: 'requirement', title: 'Synthetic transaction check', categoryId: 'check', revision: 0, generation: 0, materialVersion: 0, confirmationStatus: 'draft', taskStatus: 'idle', scenarioIds: [], prerequisites: [], frozenBy: [], associationRevision: 0 };
try {
  await transaction(database, async c => {
    const data: ProjectView = { id: projectId, gitlabProjectId: -Date.now(), repositoryUrl: 'synthetic', stableBranch: 'check', name: 'Synthetic transaction check', namespaceId: 1, namespacePath: 'synthetic', initializationStatus: 'ready', revision: 0, recognizedHead: '0'.repeat(40), categories: [{ id: 'check', name: 'Check' }] };
    await c.query('INSERT INTO studio_projects(id,gitlab_project_id,data) VALUES($1,$2,$3)', [projectId, data.gitlabProjectId, data]);
    await saveEntity(c, projectId, initial);
  });
  const input = (key: string) => ({ idempotencyKey: key, expectedRevision: 0, taskId: key, clientId: key, purpose: 'design' as const });
  const candidates = await Promise.allSettled([first, second].map((actor, i) => {
    const request = input(`claim-${i}`);
    return service.mutate(actor, projectId, 'check.claim', request, (c, _p, all) => occupations.claim(c, projectId, all, initial.id, actor, request));
  }));
  assert.equal(candidates.filter(r => r.status === 'fulfilled').length, 1, 'Concurrent claims must have exactly one winner');
  const winner = candidates.find(r => r.status === 'fulfilled')!;
  assert.equal(winner.status, 'fulfilled');
  if (winner.status !== 'fulfilled') throw new Error('No claim succeeded');
  const claimed = winner.value, owner = claimed.occupation!.ownerId === first.id ? first : second;
  const originalKey = owner.id === first.id ? 'claim-0' : 'claim-1';
  const replay = await service.mutate(owner, projectId, 'check.claim', input(originalKey), async () => { throw new Error('Replay incorrectly executed mutation'); });
  assert.deepEqual(replay, claimed, 'Same operation must return its original result');
  await service.mutate(first, projectId, 'check.release', { idempotencyKey: 'release' }, (c, _p, all) => occupations.release(c, projectId, all, initial.id, first, { idempotencyKey: 'release', token: claimed.occupation!, reason: 'Synthetic admin release' }, true));
  const released = await transaction(database, c => entities(c, projectId));
  const request = { ...input('reclaim'), expectedRevision: released[0]!.revision };
  const reclaimed = await service.mutate(owner, projectId, 'check.reclaim', request, (c, _p, all) => occupations.claim(c, projectId, all, initial.id, owner, request));
  assert.equal(reclaimed.generation, 2, 'Reclaim must create a fresh generation');
  assert.throws(() => occupations.assertOccupation(reclaimed, claimed.occupation!, owner), /must match/, 'Old occupation must be rejected after reclaim');
  console.log('Passed: concurrent unique occupation, exact idempotent replay, stale generation rejection.');
} finally {
  await transaction(database, async c => {
    for (const table of ['studio_handoff_receipts', 'studio_operations', 'studio_audit', 'studio_baselines', 'studio_integrations', 'studio_eligibility', 'studio_confirmations', 'studio_occupations', 'studio_entities']) await c.query(`DELETE FROM ${table} WHERE project_id=$1`, [projectId]);
    await c.query('DELETE FROM studio_adoptions WHERE source_project_id=$1 OR target_project_id=$1', [projectId]);
    await c.query('DELETE FROM studio_projects WHERE id=$1', [projectId]);
  }).catch(() => { console.error('Synthetic fixture cleanup failed; inspect the transaction-check project before running again.'); });
  await database.end();
}
