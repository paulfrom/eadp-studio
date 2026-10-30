import path from 'node:path'
import { stat } from 'node:fs/promises'
import { AtomicState } from './local-state/atomic-state.ts'
import type { StudioStore } from '../application/state.ts'

/** Aggregates project records in memory while retaining project payloads in their workspace. */
export class ProjectRecord<T> {
  constructor(private readonly store: StudioStore, private readonly filename: string, private readonly empty: () => T,
    private readonly split: (value: T, projectId: string) => T, private readonly join: (values: T[]) => T,
    private readonly metadata?: { select(value: T): T; merge(value: T, metadata: T): T }) {}
  async read(): Promise<T> {
    const account = this.store.accountId, projects = (await this.store.read()).projects
    const values = await Promise.all(projects.map(async project => await new AtomicState<T>(path.join(await this.store.projectDirectory(project.id), this.filename)).read() ?? this.empty()))
    let value = this.join(values)
    if (this.metadata) { const meta = await new AtomicState<T>(path.join(this.store.directory, this.filename)).read(); if (meta) value = this.metadata.merge(value, meta) }
    if (this.store.accountId !== account) throw new Error('协同账号已变化')
    return value
  }
  async write(value: T): Promise<void> {
    const account = this.store.accountId, projects = (await this.store.read()).projects
    for (const project of projects) {
      const exists = await stat(project.workspaceDirectory).then(value => value.isDirectory(), error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error })
      if (!exists) continue
      const directory = await this.store.projectDirectory(project.id)
      if (this.store.accountId !== account) throw new Error('协同账号已变化')
      await new AtomicState<T>(path.join(directory, this.filename)).write(this.split(value, project.id))
    }
    if (this.store.accountId !== account) throw new Error('协同账号已变化')
    if (this.metadata) await new AtomicState<T>(path.join(this.store.directory, this.filename)).write(this.metadata.select(value))
  }
}
