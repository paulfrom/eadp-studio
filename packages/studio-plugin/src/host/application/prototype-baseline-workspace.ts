import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, lstat, rm } from 'node:fs/promises'
import path from 'node:path'
import type { ProjectState } from '@eadp/contracts'
import type { PrototypeFileCommand, PrototypeFileResult, PrototypeFileSource } from '../../shared/prototype.ts'
import type { TaskView } from '../../shared/studio.ts'
import type { CollaborationClient } from '../adapters/collaboration/client.ts'
import { PrototypeFiles, type PrototypeFileWorkspace } from '../prototype/files.ts'
import { writePrototypeSnapshot } from '../prototype/snapshot.ts'
import type { HostPorts } from './ports.ts'
import type { StudioStore } from './state.ts'

type BaselineSource = Extract<PrototypeFileSource, { kind: 'baseline' }>
type ReadCommand = Extract<PrototypeFileCommand, { action: 'listPrototypeDirectory' | 'searchPrototypeFiles' | 'readPrototypeFile' }>
interface Snapshot { directory: string; workspace: PrototypeFileWorkspace; hashes: Map<string, string> }
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/** Keeps an isolated object source and a read-only projection of an accepted prototype. */
export class PrototypeBaselineWorkspaces {
  private readonly snapshots = new Map<string, Promise<Snapshot>>()
  constructor(private readonly store: StudioStore, private readonly api: CollaborationClient, private readonly ports: HostPorts, private readonly files: PrototypeFiles) {}

  private async project(source: BaselineSource): Promise<ProjectState> {
    const account = this.store.accountId
    if (!account || !/^[a-f0-9]{40}$/.test(source.commitSha)) throw new Error('基线身份无效或账号未登录')
    const project = await this.api.request<ProjectState>('GET', `/v1/projects/${encodeURIComponent(source.projectId)}`)
    if (this.store.accountId !== account || project.project.id !== source.projectId) throw new Error('项目或账号身份已变化')
    if (!project.baselines.some(value => value.id === source.baselineId && value.commitSha === source.commitSha)) throw new Error('原型基线与固定提交不匹配或当前账号无权读取')
    return project
  }

  private async create(source: BaselineSource, project: ProjectState, account: number): Promise<Snapshot> {
    if (!this.ports.prototypeManifestPath) throw new Error('原型模板未配置')
    const base = path.join(this.store.directory, 'prototype-baseline-snapshots')
    await mkdir(base, { recursive: true, mode: 0o700 })
    const directory = await mkdtemp(path.join(base, 'snapshot-'))
    const repository = path.join(directory, 'repository'), root = path.join(directory, '原型代码')
    try {
    // A clone and its temporary objects are separate from the user's project checkout.
    await this.ports.git.cloneSnapshot(project.project.repositoryUrl, repository)
    if (!await this.ports.git.hasCommit(repository, source.commitSha)) await this.ports.git.fetchCommit(repository, source.commitSha)
    const files = await this.ports.git.prototypeSnapshot(repository, source.commitSha)
    if (this.store.accountId !== account) throw new Error('协同账号已变化，基线现场已保留')
    await mkdir(root, { mode: 0o700 })
    const hashes = await writePrototypeSnapshot(root, files)
      return { directory, workspace: { source, root, manifestPath: this.ports.prototypeManifestPath, writablePaths: [] }, hashes }
    } catch (error) {
      // A failed copy cannot prove that every byte in the directory is ours.
      // Leave the incomplete snapshot available for inspection.
      throw new Error(`基线现场未完成，已保留目录 ${directory}`, { cause: error })
    }
  }

  private async verifySource(snapshot: Snapshot): Promise<void> {
    for (const [relative, expected] of snapshot.hashes) {
      const filename = path.join(snapshot.workspace.root, ...relative.split('/')), info = await lstat(filename)
      if (info.isSymbolicLink() || !info.isFile() || hash(await readFile(filename)) !== expected) throw new Error('基线固定源码已变化，请重新打开')
    }
  }

  /** Refuse to present changed or extra disk bytes as the accepted Git snapshot. */
  private async verify(snapshot: Snapshot): Promise<void> {
    await this.verifySource(snapshot)
    const seen = new Set<string>()
    const walk = async (directory: string, relative = ''): Promise<void> => {
      for (const name of await readdir(directory)) {
        const child = relative ? `${relative}/${name}` : name, filename = path.join(directory, name), info = await lstat(filename)
        if (info.isSymbolicLink()) throw new Error('基线现场已变化，请重新打开')
        if (info.isDirectory()) await walk(filename, child)
        else if (info.isFile() && snapshot.hashes.has(child)) seen.add(child)
        else throw new Error('基线现场包含未知内容，请重新打开')
      }
    }
    await walk(snapshot.workspace.root)
    if (seen.size !== snapshot.hashes.size) throw new Error('基线现场文件缺失，请重新打开')
  }

  async read(command: ReadCommand): Promise<PrototypeFileResult> {
    if (command.source.kind !== 'baseline') throw new Error('文件来源不是原型基线')
    const source = command.source, account = this.store.accountId
    const project = await this.project(source)
    if (!account) throw new Error('请先登录协同工作台')
    const key = `${account}:${source.projectId}:${source.baselineId}:${source.commitSha}`
    let pending = this.snapshots.get(key)
    if (!pending) { pending = this.create(source, project, account); this.snapshots.set(key, pending) }
    let snapshot: Snapshot
    try { snapshot = await pending } catch (error) { if (this.snapshots.get(key) === pending) this.snapshots.delete(key); throw error }
    try {
      await this.verify(snapshot)
      const result = await this.files.read(snapshot.workspace, command)
      await this.verify(snapshot)
      await this.project(source)
      return result
    } catch (error) { if (this.snapshots.get(key) === pending) this.snapshots.delete(key); throw error }
  }

  /** Materialize a separate fixed task for checks or preview, never the author's worktree. */
  async prepare(source: BaselineSource, operationId: string): Promise<TaskView> {
    const account = this.store.accountId
    if (!account) throw new Error('请先登录协同工作台')
    const project = await this.project(source), key = `${account}:${source.projectId}:${source.baselineId}:${source.commitSha}:${operationId}`
    const pending = this.create(source, project, account)
    this.snapshots.set(key, pending)
    const snapshot = await pending
    await this.verify(snapshot)
    return { projectId: source.projectId, entityId: source.baselineId, sessionId: `studio-baseline-${source.baselineId}`, purpose: 'prototype', inputHash: source.commitSha, worktree: snapshot.directory, baseHead: source.commitSha, writePaths: [], prototypeBaseline: { id: source.baselineId, commitSha: source.commitSha } }
  }

  /** Generated outputs may change, but every fixed input byte must remain identical after the operation. */
  async verifyTask(task: TaskView): Promise<void> {
    if (!task.prototypeBaseline) throw new Error('检查现场不是原型基线')
    for (const pending of this.snapshots.values()) {
      const snapshot = await pending
      if (snapshot.directory !== task.worktree) continue
      await this.verifySource(snapshot)
      await this.project({ kind: 'baseline', projectId: task.projectId, baselineId: task.prototypeBaseline.id, commitSha: task.prototypeBaseline.commitSha })
      return
    }
    throw new Error('基线检查现场登记不存在')
  }

  /** Only these reconstructible snapshots were created by this process. */
  async dispose(): Promise<void> {
    const pending = [...this.snapshots.values()]
    this.snapshots.clear()
    const results = await Promise.allSettled(pending)
    for (const result of results) if (result.status === 'fulfilled') {
      const snapshot = result.value
      try {
        await this.verify(snapshot)
        const top = (await readdir(snapshot.directory)).sort(), repository = await readdir(path.join(snapshot.directory, 'repository'))
        if (top.join('\0') !== ['repository', '原型代码'].join('\0') || repository.length !== 1 || repository[0] !== '.git') continue
        await rm(snapshot.directory, { recursive: true, force: true })
      } catch { /* Changed snapshots remain available for the user to inspect. */ }
    }
  }
}
