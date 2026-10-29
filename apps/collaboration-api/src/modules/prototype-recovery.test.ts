import assert from 'node:assert/strict';
import test from 'node:test';
import type { CompletePrototypeIntegrationRequest, ProjectView, PrototypeIntegrationRequest } from '@eadp/contracts';
import type { GitLab } from '../auth/gitlab.js';
import type { Actor, SessionAuth } from '../auth/session.js';
import type { PublicationAuthorization } from '../auth/publication.js';
import type { Database, Transaction } from '../persistence/database.js';
import { GitLabContent } from '../gitlab-content.js';
import { CollaborationService } from '../service.js';
import { complete, getIntegration } from './prototype-integration.js';
import { prototypePolicy } from '../prototype-policy.js';
import { claimsDigest } from './prototypes.js';

const actor: Actor = { id: 1, username: 'author', name: 'Author', email: 'author@example.test', admin: false, gitlabUserId: 1, gitlabUsername: 'author', sessionHash: 'session' };
const expectedHead = 'a'.repeat(40), candidateSha = 'b'.repeat(40), correctedHead = 'c'.repeat(40), hash = 'd'.repeat(64);
const project = { id: 'project', gitlabProjectId: 1, repositoryUrl: 'https://example.test/project.git', stableBranch: 'main', name: 'Project', namespaceId: 1, namespacePath: 'group', initializationStatus: 'ready', revision: 2, recognizedHead: expectedHead } satisfies ProjectView;
const request: PrototypeIntegrationRequest = {
  idempotencyKey: 'prepare', stage: 'prototype', prototypeId: 'prototype',
  token: { prototypeTaskId: 'task', clientId: 'client', generation: 1, expectedRevision: 2 },
  sourceSha: candidateSha, sourceBaseHead: expectedHead, expectedHead, candidateSha,
  allowedPaths: ['原型代码/src/pages/index.tsx'], sourceRef: 'refs/heads/studio-private/task/operation/source', candidateRef: 'refs/heads/studio-private/task/operation/candidate',
  developmentRequirementIds: ['r1', 'r2'], developmentClaims: [{ requirementId: 'r1', claimId: 'claim1', generation: 1 }, { requirementId: 'r2', claimId: 'claim2', generation: 2 }], claimsDigest: hash,
  evidence: { sourceTreeHash: hash, rulesHash: hash, buildArtifactSha256: hash, candidateSha, checks: ['engineering', 'mock', 'browser'].map(name => ({ name: name as 'engineering' | 'mock' | 'browser', passed: true, evidenceHash: hash })) },
  authorConfirmation: { confirmationId: 'confirmation', sourceSha: candidateSha, authorConfirmed: true, claimsDigest: hash, mergePolicy: 'clean-merge-and-recheck' },
};
const recoveryInput = (): CompletePrototypeIntegrationRequest => ({ idempotencyKey: 'recover', token: { ...request.token }, developmentClaims: structuredClone(request.developmentClaims), claimsDigest: request.claimsDigest });
const prototypeTask = (policyHash: string) => ({
  id: 'task', prototypeId: 'prototype', ownerId: actor.id, clientId: 'client', generation: 1, revision: 2, status: 'active', title: 'Prototype task', branch: 'studio/task', startHead: expectedHead, sourceBaseHead: expectedHead,
  developmentRequirementIds: request.developmentRequirementIds, referenceRequirementIds: [], developmentClaims: request.developmentClaims, claimsDigest: claimsDigest(request.developmentClaims), writeScope: ['src/pages/'], policyHash,
});
const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;

/** A read-only persistence fixture: recovery may read fixed facts but cannot recreate them. */
function connection(status: 'accepted' | 'aborted', gitRecovery: 'pending' | 'reconciled' | null = null): Transaction {
  return { query: async (sql: string) => {
    if (sql.startsWith('SELECT * FROM studio_prototype_integrations')) return { rows: [{ id: 'integration', owner_id: actor.id, status, git_recovery: gitRecovery, request, created_date: '2026-10-28T00:00:00Z' }] };
    if (sql.startsWith('SELECT a.id,b.id AS baseline_id')) return { rows: status === 'accepted' ? [{ id: 'acceptance', baseline_id: 'baseline' }] : [] };
    assert.fail(`Recovery must not mutate fixed facts or require a live task: ${sql}`);
  } } as unknown as Transaction;
}

test('accepted recovery uses the original claims despite a later project head and reordered claims', async () => {
  const input = recoveryInput(); input.developmentClaims.reverse();
  const result = await complete(connection('accepted'), { ...project, recognizedHead: correctedHead }, actor, 'integration', input);
  assert.equal(result.status, 'accepted'); assert.equal(result.candidateSha, candidateSha);
  assert.equal(result.acceptanceId, 'acceptance'); assert.equal(result.baselineId, 'baseline');
  assert.equal(result.gitRecovery, undefined);
});

for (const [label, change] of [
  ['task generation', (input: CompletePrototypeIntegrationRequest) => { input.token.generation++; }],
  ['claim identity', (input: CompletePrototypeIntegrationRequest) => { input.developmentClaims[0]!.claimId = 'another'; }],
  ['claim generation', (input: CompletePrototypeIntegrationRequest) => { input.developmentClaims[0]!.generation++; }],
  ['claim set', (input: CompletePrototypeIntegrationRequest) => { input.developmentClaims.pop(); }],
  ['claims digest', (input: CompletePrototypeIntegrationRequest) => { input.claimsDigest = 'e'.repeat(64); }],
] as const) {
  test(`accepted recovery rejects a changed ${label}`, async () => {
    const input = recoveryInput(); change(input);
    await assert.rejects(complete(connection('accepted'), project, actor, 'integration', input), code('STALE_DEVELOPMENT_CLAIM'));
  });
}

test('even an administrator cannot recover acceptance as another author', async () => {
  await assert.rejects(complete(connection('accepted'), project, { ...actor, id: 2, admin: true }, 'integration', recoveryInput()), code('INTEGRATION_NOT_PENDING'));
});

test('aborted integrations keep pending recovery and cannot become accepted through completion', async () => {
  const c = connection('aborted', 'pending');
  assert.equal((await getIntegration(c, project.id, 'integration', actor)).gitRecovery, 'pending');
  await assert.rejects(complete(c, project, actor, 'integration', recoveryInput()), code('INTEGRATION_NOT_PENDING'));
});

test('ordinary users cannot reconcile even when the repository authorization succeeds', async () => {
  const service = new CollaborationService({} as Database, {} as GitLab, {} as PublicationAuthorization, {} as SessionAuth);
  service.authorize = async () => project;
  service.replay = async () => { assert.fail('administrator authorization must precede replay'); };
  await assert.rejects(service.reconcile(actor, project.id, { idempotencyKey: 'reconcile', expectedHead, correctedHead, reason: 'restore recognized tree' }), code('ADMIN_REQUIRED'));
});

for (const scenario of ['valid', 'rewritten-history', 'changed-tree', 'incomplete-comparison'] as const) {
  test(`correction verification: ${scenario}`, async () => {
    const gitlab = {
      authorize: async () => undefined,
      mergeBase: async () => scenario === 'rewritten-history' ? candidateSha : expectedHead,
      json: async (endpoint: string) => endpoint.includes('/commits/') ? { parent_ids: [candidateSha] } : { compare_timeout: scenario === 'incomplete-comparison', diffs: scenario === 'changed-tree' ? [{}] : [] },
    } as unknown as GitLab;
    const result = new GitLabContent(gitlab).verifyCorrection(actor, project.gitlabProjectId, expectedHead, correctedHead);
    if (scenario === 'valid') await result;
    else await assert.rejects(result, code(scenario === 'rewritten-history' ? 'CORRECTION_ANCESTRY_MISMATCH' : 'CORRECTION_TREE_MISMATCH'));
  });
}

test('source-base registration observes only the stable head and original source ref', async () => {
  const policy = await prototypePolicy(), task = prototypeTask(policy.hash), stateProject = { ...project, recognizedHead: correctedHead };
  const endpoints: string[] = [];
  const gitlab = {
    branchHead: async () => correctedHead,
    json: async (endpoint: string) => { endpoints.push(endpoint); return { id: candidateSha }; },
  } as unknown as GitLab;
  const service = new CollaborationService({} as Database, gitlab, {} as PublicationAuthorization, {} as SessionAuth);
  service.authorize = async () => stateProject;
  service.replay = async () => ({ found: false });
  const internals = service as unknown as { transact: (action: unknown) => Promise<unknown>; mutate: (...args: unknown[]) => Promise<unknown> };
  internals.transact = async () => task;
  internals.mutate = async () => undefined;
  await service.updatePrototypeSourceBase(actor, project.id, task.id, {
    idempotencyKey: 'source-base', token: request.token, sourceOperationId: 'operation', sourceRef: request.sourceRef, sourceSha: candidateSha, newBaseHead: correctedHead,
    developmentClaims: request.developmentClaims, claimsDigest: task.claimsDigest,
  });
  assert.equal(endpoints.length, 1);
  assert.ok(endpoints[0]!.includes(`/commits/${encodeURIComponent(request.sourceRef)}`));
  assert.ok(endpoints.every(endpoint => !/merge_base|trees|blobs/.test(endpoint)));
});

test('prototype preparation observes only project state and uploaded refs', async () => {
  const policy = await prototypePolicy(), task = prototypeTask(policy.hash), endpoints: string[] = [];
  const gitlab = {
    branchHead: async () => expectedHead,
    json: async (endpoint: string) => { endpoints.push(endpoint); return { id: candidateSha }; },
  } as unknown as GitLab;
  const service = new CollaborationService({} as Database, gitlab, {} as PublicationAuthorization, {} as SessionAuth);
  service.authorize = async () => project;
  service.replay = async () => ({ found: false });
  const internals = service as unknown as { transact: (action: unknown) => Promise<unknown>; mutate: (...args: unknown[]) => Promise<unknown> };
  internals.transact = async () => task;
  internals.mutate = async () => ({ status: 'prepared' });
  assert.deepEqual(await service.preparePrototypeIntegration(actor, project.id, request), { status: 'prepared' });
  assert.equal(endpoints.length, 2);
  assert.ok(endpoints.some(endpoint => endpoint.includes(`/commits/${encodeURIComponent(request.sourceRef)}`)));
  assert.ok(endpoints.some(endpoint => endpoint.includes(`/commits/${encodeURIComponent(request.candidateRef)}`)));
  assert.ok(endpoints.every(endpoint => !/merge_base|trees|blobs/.test(endpoint)));
});
