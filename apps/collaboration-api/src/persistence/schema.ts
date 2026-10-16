import { readFile } from 'node:fs/promises';
import type { Transaction } from './database.js';

export async function schemaApplied(c: Transaction): Promise<boolean> {
  return ((await c.query("SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='studio_users'")).rowCount ?? 0) > 0;
}

export async function applySchema(c: Transaction): Promise<void> {
  const schema = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8');
  await c.query(schema);
}
