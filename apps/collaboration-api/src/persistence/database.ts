import pg, { type PoolClient } from 'pg';
import type { Config } from '../config.js';
export type Transaction = PoolClient;
export function createDatabase(config: Config) {
  return new pg.Pool({ connectionString: config.databaseUrl, ssl: config.databaseSsl ? { rejectUnauthorized: true } : false, max: 10, connectionTimeoutMillis: 5000, statement_timeout: 10000, application_name: 'eadp-collaboration-api' });
}
export type Database = ReturnType<typeof createDatabase>;
export async function transaction<T>(database: Database, action: (connection: Transaction) => Promise<T>): Promise<T> {
  const connection = await database.connect();
  try { await connection.query('BEGIN'); const result = await action(connection); await connection.query('COMMIT'); return result; }
  catch (error) { await connection.query('ROLLBACK'); throw error; }
  finally { connection.release(); }
}
