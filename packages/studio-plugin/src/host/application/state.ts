import type { LocalScenarioRepair } from './scenario-repairs.ts'
import type { ScenarioRecord } from './scenario-workspaces.ts'
import type { TemplateOperation } from './scenario-templates.ts'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AdoptRequest, AssetSource, FixedReference } from '@eadp/contracts'
import type { LocalReview } from './reviews.ts'
import type { Candidate, LocalProject, TaskView, StudioRecovery } from '../../shared/studio.ts'

const recordName = 'studio-state.json'
/** Collections every current-version record carries; a record missing one is a previous version's. */
const collections = ['projects', 'tasks', 'candidates', 'operations', 'reviews', 'adoptions', 'projectInitializations', 'materialReservations', 'templateOperations', 'scenarios', 'scenarioRepairs'] as const
const timestamp = (): string => new Date().toISOString().replace(/[:.]/g, '-')

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
export interface MaterialReservation {
  id: string; projectId: string; kind: 'scenario' | 'requirement' | 'handoff'; title: string; categoryId?: string; scenarioIds: string[]; sources: AssetSource[];
  phase: 'reserving' | 'unknown' | 'reserved' | 'materialized'; entityId?: string; message?: string;
}
export interface ProjectInitialization {
  id: string; name: string; namespaceId: number; path: string; projectId?: string;
  directory?: string; directoryOwned?: boolean; commitSha?: string;
  phase: 'creating' | 'initializing' | 'pushing' | 'verifying' | 'ready' | 'unknown'; message?: string;
}
export interface LocalState {
  clientId: string; selectedProjectId?: string; projects: LocalProject[]; tasks: TaskView[];
  candidates: Candidate[]; operations: PendingOperation[]; reviews: LocalReview[]; adoptions: AdoptionOperation[]; projectInitializations: ProjectInitialization[];
  materialReservations: MaterialReservation[]; templateOperations: TemplateOperation[]; scenarios: ScenarioRecord[]; scenarioStructureCheck: boolean; scenarioRepairs: LocalScenarioRepair[];
}

const emptyState = (): LocalState => ({ clientId: randomUUID(), projects: [], tasks: [], candidates: [], operations: [], reviews: [], adoptions: [], projectInitializations: [], materialReservations: [], templateOperations: [], scenarios: [], scenarioStructureCheck: false, scenarioRepairs: [] })

/**
 * Read one stored record as the current version.
 * @param text - raw file contents.
 * @returns the record, or undefined when it was written by another version or is malformed.
 */
function parseRecord(text: string): LocalState | undefined {
  let value: unknown
  try { value = JSON.parse(text) } catch (error) { if (!(error instanceof SyntaxError)) throw error; return undefined }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.clientId !== 'string' || typeof record.scenarioStructureCheck !== 'boolean') return undefined
  if (collections.some(name => !Array.isArray(record[name]))) return undefined
  return value as LocalState
}

/**
 * Read the client identity an unusable record still names.
 * Occupations on the collaboration backend are bound to this identity, so a
 * rebuilt record keeps it: the local work is lost, but tasks this device still
 * holds stay reachable instead of becoming unreleasable.
 * @param text - raw file contents of the record being preserved.
 * @returns the stored client identity, or undefined when the bytes do not name one.
 */
function carriedIdentity(text: string): string | undefined {
  try {
    const value = JSON.parse(text) as { clientId?: unknown }
    return typeof value.clientId === 'string' && value.clientId.length > 0 ? value.clientId : undefined
  } catch (error) { if (error instanceof SyntaxError) return undefined; throw error }
}

/** One local writer per user: the Host's recovery record of attributable local work. */
export class StudioStore {
  private value: LocalState | undefined
  private loading: Promise<LocalState> | undefined
  private userId: number | undefined
  private preserved: StudioRecovery | undefined
  constructor(private readonly root: string) {}
  get directory(): string { if (!this.userId) throw new Error('请先登录协同工作台。'); return path.join(this.root, 'users', String(this.userId)) }
  get accountId(): number | undefined { return this.userId }
  get scoped(): boolean { return this.userId !== undefined }
  /** The record this session rebuilt from, until another user is scoped. */
  get preservedRecord(): StudioRecovery | undefined { return this.preserved }
  useUser(userId?: number): void {
    if (userId !== undefined && (!Number.isSafeInteger(userId) || userId <= 0)) throw new Error('协同用户身份无效。')
    if (userId !== this.userId) { this.userId = userId; this.value = undefined; this.loading = undefined; this.preserved = undefined }
  }
  /**
   * Read the current user's record, rebuilding it when the stored file was
   * written by another version. Rebuilding preserves the unusable file beside
   * the record and writes the current version, so a previous version never
   * blocks the workbench: it starts from empty local work and reports where the
   * old bytes were kept. The client identity the old bytes name is kept, since
   * occupations on the backend are bound to it.
   * @returns the current-version local state.
   */
  async read(): Promise<LocalState> {
    if (this.value) return this.value
    if (this.loading) return this.loading
    const directory = this.directory, userId = this.userId
    this.loading = (async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const file = path.join(directory, recordName)
      const text = await readFile(file, 'utf8').catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new Error('本地恢复记录无法读取，请保留现场并修复') })
      const stored = text === undefined ? undefined : parseRecord(text)
      if (userId !== this.userId) throw new Error('协同登录身份已变化，请重新查询。')
      if (stored) { this.value = stored; return stored }
      const identity = text === undefined ? undefined : carriedIdentity(text)
      if (text !== undefined) this.preserved = { preservedPath: await this.preserve(file) }
      const rebuilt = { ...emptyState(), ...(identity ? { clientId: identity } : {}) }
      this.value = rebuilt
      await this.persist()
      return rebuilt
    })().finally(() => { if (userId === this.userId) this.loading = undefined })
    return this.loading
  }
  private saving: Promise<void> = Promise.resolve()
  save(): Promise<void> {
    const userId = this.userId
    const running = this.saving.catch(() => undefined).then(async () => {
      if (this.userId !== userId) throw new Error('协同身份已变化，旧保存已停止')
      await this.persist()
    })
    this.saving = running
    return running
  }
  /** Rename an unusable record aside so nothing is deleted and the name states what it holds. */
  private async preserve(file: string): Promise<string> {
    const preserved = path.join(this.directory, `${recordName}.invalid-${timestamp()}`)
    await rename(file, preserved)
    return preserved
  }
  private async persist(): Promise<void> {
    const value = await this.read()
    const temp = path.join(this.directory, `${recordName}.${randomUUID()}.tmp`)
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    await rename(temp, path.join(this.directory, recordName))
  }
}
