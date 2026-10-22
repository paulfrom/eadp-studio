import type { GitProgress } from '../adapters/workspace/git.ts'
import type { ProjectProgress, ProjectProgressPhase } from '../../shared/studio.ts'

/** Where a clone and a push land in the bar, leaving room for the verification and binding around them. */
const CLONE = { from: 10, to: 80 }
const PUSH = { from: 45, to: 85 }

const share = (percent: number, from: number, to: number): number => from + (Math.min(100, Math.max(0, percent)) / 100) * (to - from)

/**
 * Map one Git clone report onto the bar. Git counts objects, receives them,
 * resolves deltas and then updates the worktree, each with its own percentage;
 * the stages are ordered and weighted so the overall bar only moves forward.
 * @param progress - the stage and percentage Git last printed.
 * @returns the percent of the whole operation.
 */
export function clonePercent(progress: GitProgress): number {
  switch (progress.stage) {
    case 'counting': case 'compressing': return share(progress.percent, CLONE.from, CLONE.from + 5)
    case 'receiving': return share(progress.percent, CLONE.from + 5, CLONE.from + 55)
    case 'resolving': return share(progress.percent, CLONE.from + 55, CLONE.to - 5)
    case 'checking': case 'updating': return share(progress.percent, CLONE.to - 5, CLONE.to)
    case 'enumerating': case 'writing': return CLONE.from
  }
}

/**
 * Map one Git push report onto the bar. The remote side keeps reporting after
 * the objects were written, so `writing` owns the end of the window.
 * @param progress - the stage and percentage Git last printed.
 * @returns the percent of the whole operation.
 */
export function pushPercent(progress: GitProgress): number {
  switch (progress.stage) {
    case 'enumerating': case 'counting': case 'compressing': return share(progress.percent, PUSH.from, PUSH.from + 10)
    case 'writing': return share(progress.percent, PUSH.from + 10, PUSH.to)
    case 'receiving': case 'resolving': case 'checking': case 'updating': return PUSH.from
  }
}

/**
 * Progress of the project operations the background lane is running. The lane
 * owns the work; this record only describes it, so it lives in memory: a
 * restarted Host restarts the bar as the lane resumes the same recorded
 * operation, and the authoritative outcome stays the recorded initialization.
 */
export class ProjectProgressTracker {
  private readonly entries = new Map<string, ProjectProgress>()
  /** Start reporting one operation. Repeating it restarts the bar for a retried operation. */
  begin(operationId: string, projectName: string): void { this.entries.set(operationId, { operationId, projectName, phase: 'matching', percent: 0, label: '正在核对本地项目与后台登记' }) }
  /** Report the current step; the bar never moves backwards inside one operation. */
  report(operationId: string, phase: ProjectProgressPhase, percent: number, label: string): void {
    const entry = this.entries.get(operationId)
    if (!entry) return
    entry.phase = phase; entry.percent = Math.max(entry.percent, Math.min(100, Math.round(percent))); entry.label = label
  }
  /** Keep the stopped operation visible with its reason; a retry calls `begin` again. */
  fail(operationId: string, label: string): void { const entry = this.entries.get(operationId); if (entry) { entry.phase = 'failed'; entry.label = label } }
  /** The operation reached its recorded verdict, so its bar goes away. */
  end(operationId: string): void { this.entries.delete(operationId) }
  views(): ProjectProgress[] { return [...this.entries.values()].map(entry => ({ ...entry })) }
}
