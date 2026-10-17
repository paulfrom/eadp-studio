import assert from 'node:assert/strict';
import test from 'node:test';
import { createRedisCache, ReadThrough, type CacheStore } from './cache.js';

test('read-through serves hits, keeps cached nulls, repopulates after invalidation and survives an outage', async () => {
  const values = new Map<string, string>(), ttls: number[] = [];
  const store: CacheStore = {
    get: async key => values.get(key) ?? null,
    set: async (key, value, ttlSeconds) => { values.set(key, value); ttls.push(ttlSeconds); },
    del: async key => { values.delete(key); },
  };
  let reads = 0;
  const read = async () => ({ value: ++reads });
  const cache = new ReadThrough(store);
  assert.deepEqual(await cache.load('key', 30, read), { value: 1 });
  assert.deepEqual(await cache.load('key', 30, read), { value: 1 });
  assert.deepEqual(ttls, [30]);
  await cache.invalidate('key');
  assert.deepEqual(await cache.load('key', 30, read), { value: 2 });
  values.set('absent-member', 'null');
  assert.equal(await cache.load('absent-member', 30, async () => { throw new Error('A cached miss must not reach GitLab'); }), null);
  const broken: CacheStore = {
    get: async () => { throw new Error('cache down'); }, set: async () => { throw new Error('cache down'); }, del: async () => { throw new Error('cache down'); },
  };
  const degraded = new ReadThrough(broken);
  assert.deepEqual(await degraded.load('key', 30, read), { value: 3 });
  await degraded.invalidate('key');
});

test('an unreachable Redis degrades to cache misses without blocking the caller', async () => {
  const redis = createRedisCache('redis://127.0.0.1:1');
  void redis.connect();
  assert.equal(await redis.cache.get('key'), null);
  await redis.cache.set('key', 'value', 30);
  await redis.cache.del('key');
  await redis.close();
});
