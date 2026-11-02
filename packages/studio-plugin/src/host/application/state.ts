import type { LocalScenarioRepair } from './scenario-repairs.ts'
import type { ScenarioRecord } from './scenario-workspaces.ts'
import type { TemplateOperation } from './scenario-templates.ts'
import type { LocalConsistencyComparison } from './consistency-comparisons.ts'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { localDatabasePath, readLocalRecord, writeLocalRecords, type LocalRecordWrite } from '../adapters/local-state/sqlite-state.ts'
import { randomUUID } from 'node:crypto'
import type { AdoptRequest, AssetSource, FixedReference, IntegrationView, MaterialMetadata } from '@eadp/contracts'
import type { LocalReview } from './reviews.ts'
import type { Candidate, LocalProject, TaskView } from '../../shared/studio.ts'

const recordKey = 'studio-state'
/** Only this format carries the task and request identities required for safe recovery. */
const formatVersion = 3
/** Collections every current-version record carries; a record missing one is a previous version's. */
const collections = ['projects', 'tasks', 'candidates', 'operations', 'reviews', 'adoptions', 'projectInitializations', 'materialReservations', 'templateOperations', 'scenarios', 'scenarioRepairs', 'consistencyComparisons'] as const
const projectCollections = ['tasks', 'candidates', 'operations', 'reviews', 'adoptions', 'materialReservations', 'templateOperations', 'scenarios', 'scenarioRepairs', 'consistencyComparisons'] as const

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Pending local proposals are rendered directly and must retain their chapter changes. */
function scenarioProposalHasChanges(value: unknown): boolean {
  if (!isObjectRecord(value)) return false
  const proposal = value.writeProposal
  return proposal === undefined || (isObjectRecord(proposal) && Array.isArray(proposal.changes))
}

export interface PendingOperation {
  id: string; projectId: string; entityId: string; phase: 'fixed' | 'prepared' | 'pushed' | 'accepted' | 'unknown' | 'rejected' | 'superseded';
  /** The account and exact task that own this candidate, independent of the current selection. */
  accountId: number; task: Pick<TaskView, 'projectId' | 'entityId' | 'worktree' | 'purpose' | 'sessionId' | 'inputHash'>;
  candidateSha: string; expectedHead: string; fixedPath: string; sha256: string; integrationId?: string;
  prepare: object; token: object; message?: string; adoptionIds?: string[]; mergeOriginalBranch?: string; mergeAiFiles?: string[]; mergeFailed?: boolean;
  /** Accepted business facts survive failures in independently delivered follow-up work. */
  accepted?: IntegrationView; deliveryMessage?: string;
}
export interface AdoptionOperation {
  id: string; projectId: string; entityId: string; worktree: string; request: AdoptRequest; sourceFixed: FixedReference;
  targetHash: string; phase: 'requesting' | 'accepted' | 'succeeded'; adoptionId?: string; applied?: boolean; message?: string;
  success?: { idempotencyKey: string; targetConfirmationId: string };
}
export interface MaterialReservation {
  id: string; projectId: string; kind: 'scenario' | 'requirement' | 'handoff'; title: string; templateId?: string; templateRef?: FixedReference; scenarioIds: string[]; sources: AssetSource[];
  phase: 'reserving' | 'unknown' | 'reserved' | 'materialized'; entityId?: string; message?: string;
  initialContent?: { body: string; summary: string; quality: Pick<Extract<MaterialMetadata, { kind: 'requirement' }>, 'coreRulesPresent' | 'acceptanceCriteriaPresent' | 'openQuestions'> };
}
export interface ProjectInitialization {
  id: string; name: string; namespaceId: number; path: string; projectId?: string;
  workspaceDirectory?: string; directory?: string; directoryOwned?: boolean; commitSha?: string;
  phase: 'creating' | 'initializing' | 'pushing' | 'verifying' | 'ready' | 'unknown'; message?: string;
}
export interface LocalState {
  formatVersion: 3; clientId: string; selectedProjectId?: string; projects: LocalProject[]; tasks: TaskView[];
  candidates: Candidate[]; operations: PendingOperation[]; reviews: LocalReview[]; adoptions: AdoptionOperation[]; projectInitializations: ProjectInitialization[];
  materialReservations: MaterialReservation[]; templateOperations: TemplateOperation[]; scenarios: ScenarioRecord[]; scenarioStructureCheck: boolean; scenarioRepairs: LocalScenarioRepair[];
  consistencyComparisons: LocalConsistencyComparison[];
}

const emptyState = (): LocalState => ({ formatVersion, clientId: randomUUID(), projects: [], tasks: [], candidates: [], operations: [], reviews: [], adoptions: [], projectInitializations: [], materialReservations: [], templateOperations: [], scenarios: [], scenarioStructureCheck: false, scenarioRepairs: [], consistencyComparisons: [] })

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
  if (record.formatVersion !== formatVersion || typeof record.clientId !== 'string' || typeof record.scenarioStructureCheck !== 'boolean') return undefined
  if (collections.some(name => !Array.isArray(record[name]))) return undefined
  if ((record.scenarios as unknown[]).some(scenario => !scenarioProposalHasChanges(scenario))) return undefined
  if ((record.operations as Array<Partial<PendingOperation>>).some(operation => !operation || !Number.isSafeInteger(operation.accountId) || !operation.task || typeof operation.task.worktree !== 'string' || typeof operation.task.sessionId !== 'string')) return undefined
  return value as LocalState
}

/** One local writer per user: the Host's recovery record of attributable local work. */
export class StudioStore {
  private value: LocalState | undefined
  private loading: Promise<LocalState> | undefined
  private userId: number | undefined
  constructor(private readonly root: string) {}
  get rootDirectory(): string { return this.root }
  get directory(): string { if (!this.userId) throw new Error('请先登录协同工作台。'); return path.join(this.root, 'users', String(this.userId)) }
  get accountId(): number | undefined { return this.userId }
  get scoped(): boolean { return this.userId !== undefined }
  useUser(userId?: number): void {
    if (userId !== undefined && (!Number.isSafeInteger(userId) || userId <= 0)) throw new Error('协同用户身份无效。')
    if (userId !== this.userId) { this.userId = userId; this.value = undefined; this.loading = undefined }
  }
  /** Read the account index and project snapshots without rebuilding damaged state. */
  async read(): Promise<LocalState> {
    if (this.value) return this.value
    if (this.loading) return this.loading
    const directory = this.directory, userId = this.userId
    this.loading = (async () => {
      const stored = await readLocalRecord<LocalState>(localDatabasePath(directory), recordKey)
      if (userId !== this.userId) throw new Error('协同登录身份已变化，请重新查询。')
      if (stored) {
        if (!parseRecord(JSON.stringify(stored))) throw new Error('本地状态无效，请保留数据库并检查。')
        if (projectCollections.some(key => stored[key].length > 0)) throw new Error('程序索引含有项目正文，请保留现场。')
        await this.hydrateProjects(stored)
        this.value = stored
        return stored
      }
      const legacy = await stat(path.join(directory, 'studio-state.json')).then(() => true, error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error })
      if (legacy) throw new Error('检测到尚未导入的本地状态，请关闭桌面并执行一次性 SQLite 导入；原文件已保留。')
      const initial = emptyState()
      await writeLocalRecords([{ database: localDatabasePath(directory), key: recordKey, value: initial }])
      if (userId !== this.userId) throw new Error('协同登录身份已变化，请重新查询。')
      this.value = initial
      return initial
    })().finally(() => { if (userId === this.userId) this.loading = undefined })
    return this.loading
  }
  /** Private project files belong to the selected project folder, never program data. */
  async projectDirectory(projectId: string): Promise<string> {
    const value = await this.read()
    const project = value.projects.find(item => item.id === projectId)
    const root = project?.workspaceDirectory ?? value.projectInitializations.find(item => item.projectId === projectId)?.workspaceDirectory
    if (!root || !path.isAbsolute(root)) throw new Error('项目尚未登记有效的本地文件夹。')
    return path.join(root, '.eadp', 'users', String(this.userId))
  }
  private projectPath(project: LocalProject): string {
    if (!project.workspaceDirectory || !path.isAbsolute(project.workspaceDirectory)) throw new Error('项目文件夹登记无效，请重新打开项目。')
    return localDatabasePath(path.join(project.workspaceDirectory, '.eadp', 'users', String(this.userId)))
  }
  /** Rebinds an orphaned project record before publishing its program index. */
  async registerProject(project: LocalProject): Promise<void> {
    const accountId = this.userId, value = await this.read()
    if (value.projects.some(item => item.id === project.id)) throw new Error('项目已在本机登记。')
    const stored = await readLocalRecord<Record<string, unknown>>(this.projectPath(project), 'local-state')
    if (accountId !== this.userId) throw new Error('协同身份已变化，项目登记已停止')
    if (stored) {
      const hydrated = { ...emptyState(), clientId: value.clientId, projects: [project] }
      await this.hydrateProjects(hydrated)
      if (accountId !== this.userId) throw new Error('协同身份已变化，项目登记已停止')
      for (const key of projectCollections) {
        if ((value[key] as Array<{ projectId: string }>).some(item => item.projectId === project.id)) throw new Error('项目已存在尚未登记的过程数据，请保留现场。')
      }
      for (const key of projectCollections) (value[key] as unknown[]).push(...hydrated[key])
    }
    value.projects.push(project)
    await this.save()
  }
  private async workspaceExists(project: LocalProject): Promise<boolean> {
    try { return (await stat(project.workspaceDirectory)).isDirectory() }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
  }
  private async hydrateProjects(value: LocalState): Promise<void> {
    const accountId = this.userId
    for (const project of value.projects) {
      const file = this.projectPath(project)
      if (!await this.workspaceExists(project)) continue
      if (accountId !== this.userId) throw new Error('协同身份已变化，旧读取已停止')
      const stored = await readLocalRecord<Record<string, unknown>>(file, 'local-state')
      if (!stored || stored.projectId !== project.id || stored.accountId !== this.userId || projectCollections.some(key => !Array.isArray(stored[key]))) throw new Error(`项目本地记录缺失或损坏，请保留现场并重新打开项目：${project.name}`)
      for (const key of projectCollections) {
        const entries = stored[key] as Array<{ projectId?: string }>
        if (entries.some(item => item.projectId !== project.id)) throw new Error('项目本地记录包含其他项目的数据，请保留现场。')
        ;(value[key] as unknown[]).push(...entries)
      }
    }
    if (!parseRecord(JSON.stringify(value))) throw new Error('项目本地恢复记录无效，请保留现场。')
  }
  private async projectWrites(value: LocalState): Promise<LocalRecordWrite[]> {
    const writes: LocalRecordWrite[] = []
    const accountId = this.userId
    const known = new Set(value.projects.map(project => project.id))
    for (const key of projectCollections) if ((value[key] as Array<{ projectId: string }>).some(item => !known.has(item.projectId))) throw new Error('项目过程数据缺少对应的本地项目登记。')
    for (const project of value.projects) {
      if (!await this.workspaceExists(project)) continue
      if (accountId !== this.userId) throw new Error('协同身份已变化，旧保存已停止')
      const data: Record<string, unknown> = { projectId: project.id, accountId: this.userId }
      for (const key of projectCollections) data[key] = (value[key] as Array<{ projectId: string }>).filter(item => item.projectId === project.id)
      writes.push({ database: this.projectPath(project), key: 'local-state', value: data })
      if (accountId !== this.userId) throw new Error('协同身份已变化，旧保存已停止')
    }
    return writes
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
  /** Commit project snapshots and their account index as one durable transaction. */
  private async persist(): Promise<void> {
    const userId = this.userId, directory = this.directory
    const value = await this.read()
    const writes = await this.projectWrites(value)
    const index = { ...value }
    for (const key of projectCollections) (index[key] as unknown[]) = []
    writes.push({ database: localDatabasePath(directory), key: recordKey, value: index })
    if (this.userId !== userId) throw new Error('协同身份已变化，旧保存已停止')
    await writeLocalRecords(writes)
  }
}
