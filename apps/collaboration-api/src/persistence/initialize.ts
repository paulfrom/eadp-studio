import { readFile } from 'node:fs/promises';
import { createDatabase, transaction } from './database.js';
import { loadConfig } from '../config.js';
const database = createDatabase(loadConfig());
try {
  const schema = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8');
  await transaction(database, async c => { await c.query(schema); });
  console.log('Created the current collaboration schema.');
} catch { console.error('Schema initialization failed; check database reachability and whether the schema already exists.'); process.exitCode = 1; }
finally { await database.end(); }
