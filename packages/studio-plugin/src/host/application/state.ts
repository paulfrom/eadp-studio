import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AdoptRequest, FixedReference } from '@eadp/contracts'
import type { LocalReview } from './reviews.ts'
import type { Candidate, LocalProject, TaskView } from '../../shared/studio.ts'

export interface PendingOperation {
  id: string; projectId: string; entityId: string; phase: 'fixed' | 'prepared' | 'pushed' | 'accepted' | 'unknown';
  candidateSha: string; expectedHead: string; fixedPath: string; sha256: string; integrationId?: string;
  prepare: object; token: object; message?: string; adoptionIds?: string[];
}
export interface AdoptionOperation {
  id: string; projectId: string; entityId: string; worktree: string; request: AdoptRequest; sourceFixed: FixedReference;
  targetHash: string; phase: 'requesting' | 'accepted' | 'succeeded'; adoptionId?: string; applied?: boolean; message?: string;
  success?: { idempotencyKey: string; targetConfirmationId: string };
}
export interface ProjectInitialization {
  id: string; name: string; namespaceId: number; path: string; projectId?: string;
  directory?: string; directoryOwned?: boolean; commitSha?: string;
  phase: 'creating' | 'initializing' | 'pushing' | 'verifying' | 'ready' | 'unknown'; message?: string;
}
export interface LocalState {
  clientId: string; selectedProjectId?: string; projects: LocalProject[]; tasks: TaskView[];
  candidates: Candidate[]; operations: PendingOperation[]; reviews: LocalReview[]; adoptions: AdoptionOperation[]; projectInitializations: ProjectInitialization[];
}
export class StudioStore {
  private value: LocalState | undefined
  private loading: Promise<LocalState> | undefined
  private userId: number | undefined
  constructor(private readonly root: string) {}
  get directory(): string { if (!this.userId) throw new Error('请先登录协同工作台。'); return path.join(this.root, 'users', String(this.userId)) }
  get scoped(): boolean { return this.userId !== undefined }
  useUser(userId?: number): void {
    if (userId !== undefined && (!Number.isSafeInteger(userId) || userId <= 0)) throw new Error('协同用户身份无效。')
    if (userId !== this.userId) { this.userId = userId; this.value = undefined; this.loading = undefined }
  }
  async read(): Promise<LocalState> {
    if (this.value) return this.value
    if (this.loading) return this.loading
    const directory = this.directory, userId = this.userId
    this.loading = (async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      let value: LocalState
      try { value = JSON.parse(await readFile(path.join(directory, 'studio-state.json'), 'utf8')) as LocalState }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('本地恢复记录无法读取，请保留现场并修复')
        value = { clientId: randomUUID(), projects: [], tasks: [], candidates: [], operations: [], reviews: [], adoptions: [], projectInitializations: [] }
      }
      if (userId !== this.userId) throw new Error('协同登录身份已变化，请重新查询。')
      this.value = value; return value
    })().finally(() => { if (userId === this.userId) this.loading = undefined })
    return this.loading
  }
  async save(): Promise<void> {
    const value = await this.read()
    const temp = path.join(this.directory, `studio-state.${randomUUID()}.tmp`)
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    await rename(temp, path.join(this.directory, 'studio-state.json'))
  }
}
