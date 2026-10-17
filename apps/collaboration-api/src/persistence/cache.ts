import { createClient } from 'redis';

/** Serialized GitLab reads. PostgreSQL remains the collaboration authority. */
export interface CacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
}

/** A cache outage degrades to remote reads; it never fails or blocks the operation. */
export class ReadThrough {
  constructor(private readonly store?: CacheStore) {}
  async load<T>(key: string, ttlSeconds: number, read: () => Promise<T>): Promise<T> {
    if (this.store) try {
      const hit = await this.store.get(key);
      if (hit !== null) return JSON.parse(hit) as T;
    } catch { /* The remote read below remains authoritative. */ }
    const value = await read();
    if (this.store) try { await this.store.set(key, JSON.stringify(value), ttlSeconds); } catch { /* The next read repopulates. */ }
    return value;
  }
  async invalidate(key: string): Promise<void> {
    if (this.store) try { await this.store.del(key); } catch { /* The TTL still bounds staleness. */ }
  }
}

export function createRedisCache(url: string): { cache: CacheStore; connect(): Promise<void>; close(): Promise<void> } {
  const client = createClient({ url, socket: { connectTimeout: 3_000 } });
  let warned = false;
  client.on('error', error => { if (!warned) { warned = true; console.warn(`Redis cache unavailable; GitLab reads are uncached. ${(error as Error).message}`); } });
  return {
    cache: {
      get: async key => client.isReady ? await client.get(key) : null,
      set: async (key, value, ttlSeconds) => { if (client.isReady) await client.set(key, value, { EX: ttlSeconds }); },
      del: async key => { if (client.isReady) await client.del(key); },
    },
    connect: async () => { try { await client.connect(); } catch { /* The error listener reports it; reads degrade to uncached. */ } },
    close: async () => { if (client.isOpen) client.destroy(); },
  };
}
