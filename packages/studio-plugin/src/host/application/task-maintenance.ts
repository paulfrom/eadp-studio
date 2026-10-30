import { lstat, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { LocalProject, TaskCleanup, TaskView } from '../../shared/studio.ts'
import { containedFile, digest } from '../adapters/assets/materials.ts'
import type { HostPorts } from './ports.ts'
import type { StudioStore } from './state.ts'

/** One audited working-tree path; `reason` states why a path was not copied. */
interface ArchiveEntry { path: string; kind: 'file' | 'missing' | 'skipped'; sha256?: string; size?: number; reason?: string }
/** Per-file and total limits keep dependencies and build output out of the archive. */
const fileLimit = 4 * 1024 * 1024, totalLimit = 64 * 1024 * 1024
const skippedSegments = new Set(['.git', 'node_modules', 'dist'])

const message = (error: unknown): string => error instanceof Error ? error.message : '未知原因'
const exists = (target: string): Promise<boolean> => stat(target).then(() => true, error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return false })
const emptySteps = (): TaskCleanup['steps'] => ({ resources: false, archive: false, worktree: false, branch: false, history: false })
const archiveRef = (projectId: string, name: string): string => `refs/eadp/archive/${projectId}/${name}`

/**
 * Settles one accepted task on this machine: the main checkout is synchronized,
 * the task's live resources are released, and its worktree bytes are archived
 * before the worktree, branch and live registration are removed. The task row
 * itself becomes a history record.
 *
 * Every destructive step is recorded on the task before the next one starts, so
 * a failure resumes without repeating a step and never treats a missing
 * directory as proof of a completed cleanup.
 */
export class TaskMaintenance {
  private readonly active = new Set<string>()
  constructor(private readonly store: StudioStore, private readonly ports: HostPorts,
    private readonly deps: { sync(projectId: string, commit: string): Promise<void>; release(task: TaskView): Promise<void> }) {}
  /**
   * Drive one accepted task (and its review snapshots) to a settled state.
   * A worktree already being settled is left to the running attempt.
   * @param task - the accepted task recorded in local state.
   * @param commit - the accepted head the main checkout must contain.
   */
  async settle(task: TaskView, commit: string): Promise<void> {
    const key = path.resolve(task.worktree)
    if (this.active.has(key)) return
    this.active.add(key)
    try { await this.settleOnce(task, commit) } finally { this.active.delete(key) }
  }
  private async settleOnce(task: TaskView, commit: string): Promise<void> {
    const local = await this.store.read(), project = local.projects.find(value => value.id === task.projectId)
    if (!project) throw new Error('任务所属项目未在本机登记')
    const cleanup = task.cleanup ??= { status: 'pending', steps: emptySteps() }
    if (cleanup.status === 'done') return
    delete cleanup.message
    try {
      try { await this.deps.sync(task.projectId, commit) }
      catch (error) { cleanup.message = `主目录同步待重试：${message(error)}` }
      await this.deps.release(task)
      cleanup.steps.resources = true; await this.store.save()
      await this.clean(task, project)
      // Review snapshots describe a candidate that is now accepted; their
      // worktrees carry no further value and are never cleaned elsewhere.
      for (const review of local.tasks.filter(value => value.purpose === 'review' && value.projectId === task.projectId && value.entityId === task.entityId)) { await this.clean(review, project); if (review.cleanup) review.cleanup.status = 'done' }
      cleanup.status = cleanup.message ? 'blocked' : 'done'
      await this.store.save()
    } catch (error) {
      cleanup.status = 'blocked'; cleanup.message = `本机收整待重试：${message(error)}`
      await this.store.save(); throw error
    }
  }
  /**
   * Archive and remove one task worktree. Steps already recorded complete are
   * skipped, so a retry after any interruption continues from the same place.
   */
  private async clean(task: TaskView, project: LocalProject): Promise<void> {
    const cleanup = task.cleanup ??= { status: 'pending', steps: emptySteps() }
    if (cleanup.status === 'done') return
    const directory = path.resolve(task.worktree), present = await exists(directory)
    if (!present && !cleanup.steps.archive) throw new Error('任务目录不存在且没有归档记录，已保留原状态')
    if (present) {
      const state = await this.ports.git.state(directory)
      // Identity is the canonical worktree root plus the branch this task kind
      // creates, so a recreated path owned by another task keeps its scene.
      const expected = task.purpose === 'review' ? `studio-review/${task.reviewId ?? ''}` : `studio/${task.entityId}/`
      if (path.resolve(state.root) !== directory || !state.branch.startsWith(expected)) throw new Error('任务目录身份不符，保留现场')
      cleanup.head = state.head; cleanup.branch = state.branch
      if (!cleanup.steps.archive) {
        cleanup.archive = await this.archive(task, directory)
        cleanup.steps.archive = true
      }
      await this.store.save()
    }
    if (!cleanup.steps.worktree) {
      if (present) await this.ports.git.removeWorktree(project.directory, directory, true)
      cleanup.steps.worktree = true; await this.store.save()
    }
    if (!cleanup.steps.branch && cleanup.head) {
      // The commit stays reachable under an archive ref even after its branch goes.
      await this.ports.git.keepRef(project.directory, archiveRef(project.id, path.basename(directory)), cleanup.head)
      if (cleanup.branch?.startsWith('studio')) await this.ports.git.deleteBranch(project.directory, cleanup.branch, cleanup.head)
      cleanup.steps.branch = true; await this.store.save()
    }
    if (!cleanup.steps.history) {
      // The rows become history records: they no longer name a live worktree, so
      // past sessions and attachments stay listable without a deleted directory.
      // Sibling rows (a frozen requirement shares the scenario worktree) are
      // settled together, never left claiming a live directory.
      const local = await this.store.read(), settled = (): TaskCleanup => ({ status: 'done', steps: { resources: true, archive: true, worktree: true, branch: true, history: true } })
      for (const value of local.tasks) if (value.projectId === task.projectId && path.resolve(value.worktree) === directory && value.cleanup !== cleanup) value.cleanup = settled()
      cleanup.steps.history = true
      await this.store.save()
    }
  }
  /** Copy every readable change the worktree still holds, with a manifest of what was skipped and why. */
  private async archive(task: TaskView, directory: string): Promise<string> {
    const target = path.join(await this.store.projectDirectory(task.projectId), 'archive', path.basename(directory))
    await mkdir(target, { recursive: true, mode: 0o700 })
    const entries: ArchiveEntry[] = []
    let total = 0
    for (const relative of await this.changedPaths(directory)) {
      if (relative.split('/').some(part => skippedSegments.has(part))) { entries.push({ path: relative, kind: 'skipped', reason: '依赖或构建产物不归档' }); continue }
      const file = await containedFile(directory, relative, true)
      const info = await lstat(file).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error })
      if (!info) { entries.push({ path: relative, kind: 'missing', reason: '路径已删除' }); continue }
      if (info.isSymbolicLink()) { entries.push({ path: relative, kind: 'skipped', reason: '符号链接不归档' }); continue }
      if (!info.isFile()) { entries.push({ path: relative, kind: 'skipped', reason: '目录不归档' }); continue }
      if (info.size > fileLimit || total + info.size > totalLimit) { entries.push({ path: relative, kind: 'skipped', reason: '超过归档大小上限' }); continue }
      const bytes = await readFile(file), destination = path.join(target, relative)
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
      await writeFile(destination, bytes, { mode: 0o600 })
      entries.push({ path: relative, kind: 'file', sha256: digest(bytes), size: bytes.length })
      total += bytes.length
    }
    const manifest = { projectId: task.projectId, entityId: task.entityId, worktree: directory, head: task.cleanup?.head, branch: task.cleanup?.branch, createdAt: new Date().toISOString(), entries }
    await writeFile(path.join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
    return target
  }
  /** Every path the worktree still reports, including ignored files and both sides of a rename. */
  private async changedPaths(directory: string): Promise<string[]> {
    const entries = (await this.ports.gitLocal(['status', '--porcelain=v1', '-z', '--ignored=matching', '--untracked-files=all'], directory)).split('\0').filter(Boolean)
    const paths = new Set<string>()
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]!, name = entry.slice(3)
      paths.add(name)
      // A rename record's second entry is the original path; it is audited but cannot be copied.
      if (/[RC]/.test(entry.slice(0, 2))) { const source = entries[++index]; if (source) paths.add(source) }
    }
    return [...paths]
  }
}
