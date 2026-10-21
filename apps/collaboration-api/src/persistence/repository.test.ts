import assert from 'node:assert/strict';
import test from 'node:test';
import { DomainError } from '@eadp/asset-domain';
import type { Transaction } from './database.js';
import { currentVersion, withContext } from './repository.js';

const row = { id: 'confirmation-1', version: '1', commit_sha: 'a'.repeat(40), path: '场景/scenario.md', sha256: 'b'.repeat(64), creator_id: '1', created_date: new Date(0), title: '旧场景', summary: '', applicability: 'applicable', applicability_reason: null, read_hash: 'b'.repeat(64), enabled: true, reason: 'accepted', baseline_id: null };
const transaction = { query: async () => ({ rows: [row] }) } as unknown as Transaction;
const actor = { id: 1, username: 'author', name: 'Author' };
const read = (loadMaterial: () => Promise<never>) => withContext({ actor, loadMaterial }, () => currentVersion(transaction, 'project', 'entity', 1));

test('an accepted document that violates the current contract becomes a readable-only version', async () => {
  const result = await read(async () => { throw new DomainError('INVALID_MATERIAL', 'Material metadata does not match the confirmation contract', 422) });
  assert.equal(result.current, undefined);
  assert.deepEqual({ version: result.legacy!.version, path: result.legacy!.fixed.path, sha256: result.legacy!.fixed.sha256, title: result.legacy!.title, confirmedBy: result.legacy!.confirmedBy },
    { version: 1, path: '场景/scenario.md', sha256: 'b'.repeat(64), title: '旧场景', confirmedBy: 1 });
  assert.match(result.legacy!.reason, /INVALID_MATERIAL/);
});

test('an integrity failure still fails the read instead of hiding behind a readable-only version', async () => {
  for (const code of ['FILE_HASH_MISMATCH', 'FIXED_FILE_MISSING', 'INVALID_MATERIAL_ENCODING']) {
    await assert.rejects(read(async () => { throw new DomainError(code, 'fixed content cannot be read', 422) }), new RegExp('fixed content cannot be read'));
  }
});

test('a version the caller cannot read as the current contract is not silently invented', async () => {
  const empty = { query: async () => ({ rows: [] }) } as unknown as Transaction;
  await assert.rejects(withContext({ actor, loadMaterial: async () => { throw new Error('must not read') } }, () => currentVersion(empty, 'project', 'entity', 1)), /Accepted fixed material version was not found/);
});
