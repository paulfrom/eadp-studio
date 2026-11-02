import { DatabaseSync } from 'node:sqlite'
import { mkdir, stat } from 'node:fs/promises'
import path from 'node:path'

export interface LocalRecordWrite { database: string; key: string; value: unknown }
export const localDatabasePath = (directory: string): string => path.join(directory, 'studio.sqlite')
const normalized = (filename: string): string => process.platform === 'win32' ? path.resolve(filename).toLowerCase() : path.resolve(filename)

function checkSchema(database: DatabaseSync, schema: string, initialize: boolean): void {
  const version = database.prepare(`PRAGMA ${schema}.user_version`).get() as { user_version: number }
  if (version.user_version === 0 && initialize) {
    const tables = database.prepare(`SELECT name FROM ${schema}.sqlite_master WHERE type='table'`).all()
    if (tables.length) throw new Error('本地数据库结构无效，请保留现场。')
    database.exec('BEGIN IMMEDIATE')
    try {
      database.exec(`CREATE TABLE ${schema}.local_records (key TEXT PRIMARY KEY, value TEXT NOT NULL CHECK(json_valid(value))) STRICT; CREATE TABLE ${schema}.local_activity (id INTEGER PRIMARY KEY, event TEXT NOT NULL CHECK(json_valid(event)), bytes INTEGER NOT NULL CHECK(bytes>0)) STRICT; PRAGMA ${schema}.user_version=1`)
      database.exec('COMMIT')
    } catch (error) { database.exec('ROLLBACK'); throw error }
  } else if (version.user_version !== 1) throw new Error('本地数据库版本不受支持，请保留现场。')
}

/** Read existing state; a writable connection lets SQLite recover a hot rollback journal after a crash. */
export async function readLocalRecord<T>(filename: string, key: string): Promise<T | undefined> {
  try { await stat(filename) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  const database = new DatabaseSync(filename)
  try {
    database.exec('PRAGMA busy_timeout=5000')
    checkSchema(database, 'main', false)
    const row = database.prepare('SELECT value FROM local_records WHERE key=?').get(key) as { value: string } | undefined
    return row ? JSON.parse(row.value) as T : undefined
  } finally { database.close() }
}

/** Commit project snapshots and account scheduling metadata together using rollback journals. */
export async function writeLocalRecords(writes: LocalRecordWrite[]): Promise<void> {
  if (!writes.length) return
  const snapshots = writes.map(write => ({ ...write, database: normalized(write.database), text: JSON.stringify(write.value) }))
  if (snapshots.some(entry => entry.text === undefined)) throw new Error('本地记录不可序列化。')
  const entries: typeof snapshots = []
  for (const entry of snapshots) if (JSON.stringify(await readLocalRecord(entry.database, entry.key)) !== entry.text) entries.push(entry)
  if (!entries.length) return
  const files = [...new Set(entries.map(entry => entry.database))]
  await Promise.all(files.map(file => mkdir(path.dirname(file), { recursive: true, mode: 0o700 })))
  const database = new DatabaseSync(files[0]!)
  let transaction = false
  try {
    database.exec('PRAGMA busy_timeout=5000')
    for (const [index, file] of files.entries()) {
      const schema = index ? `project${index}` : 'main'
      if (index) database.prepare(`ATTACH DATABASE ? AS ${schema}`).run(file)
      configureDatabase(database, schema)
    }
    database.exec('BEGIN IMMEDIATE'); transaction = true
    for (const [index] of files.entries()) checkSchema(database, index ? `project${index}` : 'main', true)
    for (const entry of entries) {
      const index = files.indexOf(entry.database), schema = index ? `project${index}` : 'main'
      database.prepare(`INSERT INTO ${schema}.local_records(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE value<>excluded.value`).run(entry.key, entry.text!)
    }
    database.exec('COMMIT'); transaction = false
  } finally { try { if (transaction) database.exec('ROLLBACK') } finally { database.close() } }
}




function configureDatabase(database: DatabaseSync, schema: string): void {
  const mode = database.prepare(`PRAGMA ${schema}.journal_mode=DELETE`).get() as { journal_mode: string }
  if (mode.journal_mode !== 'delete') throw new Error('本地数据库无法启用原子提交日志。')
  database.exec(`PRAGMA ${schema}.synchronous=FULL`)
  checkSchema(database, schema, true)
}

/** Append bounded diagnostic events without writing rotating filesystem journals. */
export async function appendLocalActivity(directory: string, event: Record<string, unknown>): Promise<void> {
  const text = JSON.stringify(event), bytes = Buffer.byteLength(text, 'utf8')
  const limit = 20 * 1024 * 1024
  if (bytes > limit) throw new Error('诊断事件超过本地日志容量。')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const database = new DatabaseSync(localDatabasePath(directory))
  let transaction = false
  try {
    database.exec('PRAGMA busy_timeout=5000')
    configureDatabase(database, 'main')
    database.exec('BEGIN IMMEDIATE'); transaction = true
    database.prepare('INSERT INTO local_activity(event,bytes) VALUES(?,?)').run(text, bytes)
    const total = (database.prepare('SELECT COALESCE(SUM(bytes),0) AS size FROM local_activity').get() as { size: number }).size
    if (total > limit) {
      let removed = 0, cutoff = 0
      for (const row of database.prepare('SELECT id,bytes FROM local_activity ORDER BY id').iterate() as Iterable<{ id: number; bytes: number }>) {
        removed += row.bytes; cutoff = row.id
        if (total - removed <= limit) break
      }
      database.prepare('DELETE FROM local_activity WHERE id<=?').run(cutoff)
    }
    database.exec('COMMIT'); transaction = false
  } finally { try { if (transaction) database.exec('ROLLBACK') } finally { database.close() } }
}
