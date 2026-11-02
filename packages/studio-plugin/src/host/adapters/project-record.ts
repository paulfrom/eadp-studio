import { stat } from 'node:fs/promises'
import { localDatabasePath, readLocalRecord, writeLocalRecords, type LocalRecordWrite } from './local-state/sqlite-state.ts'
import type { StudioStore } from '../application/state.ts'

/** Aggregates project records in memory while retaining project payloads in their workspace. */
export class ProjectRecord<T> {
  constructor(private readonly store: StudioStore, private readonly key: string, private readonly empty: () => T,
    private readonly split: (value: T, projectId: string) => T, private readonly join: (values: T[]) => T,
    private readonly metadata?: { select(value: T): T; merge(value: T, metadata: T): T }) {}
  async read(): Promise<T> {
    const account = this.store.accountId, projects = (await this.store.read()).projects
    const values = await Promise.all(projects.map(async project => await readLocalRecord<T>(localDatabasePath(await this.store.projectDirectory(project.id)), this.key) ?? this.empty()))
    let value = this.join(values)
    if (this.metadata) { const meta = await readLocalRecord<T>(localDatabasePath(this.store.directory), this.key); if (meta) value = this.metadata.merge(value, meta) }
    if (this.store.accountId !== account) throw new Error('协同账号已变化')
    return value
  }
  async write(value: T): Promise<void> {
    const account = this.store.accountId, projects = (await this.store.read()).projects
    const writes: LocalRecordWrite[] = []
    for (const project of projects) {
      const exists = await stat(project.workspaceDirectory).then(value => value.isDirectory(), error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error })
      if (!exists) continue
      const directory = await this.store.projectDirectory(project.id)
      if (this.store.accountId !== account) throw new Error('协同账号已变化')
      writes.push({ database: localDatabasePath(directory), key: this.key, value: this.split(value, project.id) })
    }
    if (this.store.accountId !== account) throw new Error('协同账号已变化')
    if (this.metadata) writes.push({ database: localDatabasePath(this.store.directory), key: this.key, value: this.metadata.select(value) })
    await writeLocalRecords(writes)
  }
}
