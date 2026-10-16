import { createDatabase, transaction } from './database.js';
import { loadConfig } from '../config.js';
import { applySchema, schemaApplied } from './schema.js';
const database = createDatabase(loadConfig());
try {
  if (await transaction(database, schemaApplied)) console.log('Collaboration schema already present; skipping initialization.');
  else {
    await transaction(database, applySchema);
    console.log('Created the current collaboration schema.');
  }
} catch (error) { console.error('Schema check failed; check database reachability and whether the schema is valid.', error); process.exitCode = 1; }
finally { await database.end(); }
