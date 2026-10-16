import { createDatabase, transaction } from './database.js';
import { loadConfig } from '../config.js';
import { applySchema } from './schema.js';
const database = createDatabase(loadConfig());
try {
  await transaction(database, applySchema);
  console.log('Created the current collaboration schema.');
} catch { console.error('Schema initialization failed; check database reachability and whether the schema already exists.'); process.exitCode = 1; }
finally { await database.end(); }
