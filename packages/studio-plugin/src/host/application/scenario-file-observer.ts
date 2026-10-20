import { watch, type FSWatcher } from 'node:fs'
import path from 'node:path'
import type { TaskView } from '../../shared/studio.ts'
import { materialPath } from '../adapters/assets/materials.ts'

export type ScenarioObservedTask = Pick<TaskView, 'projectId' | 'entityId' | 'worktree'>
export type ScenarioFileEvent = { kind: 'changed'; task: ScenarioObservedTask } | { kind: 'unavailable'; task: ScenarioObservedTask; message: string }
interface Observation { task: ScenarioObservedTask; watcher: FSWatcher; timer?: ReturnType<typeof setTimeout> }

/** Watches parent directories so an atomic replacement never detaches the scenario observation. */
export class ScenarioFileObserver {
  private readonly observations = new Map<string, Observation>()
  private disposed = false
  constructor(private readonly onEvent: (event: ScenarioFileEvent) => void) {}

  observe(input: ScenarioObservedTask): boolean {
    const task = { ...input, worktree: path.resolve(input.worktree) }, key = this.key(task)
    if (this.disposed) { this.unavailable(task, '场景文件观察器已关闭'); return false }
    if (this.observations.has(key)) return true
    if (this.observations.size >= 128) { this.unavailable(task, '场景文件观察数量已达上限（128）'); return false }
    try {
      const relative = materialPath('scenario', task.entityId), filename = path.basename(relative)
      const watcher = watch(path.dirname(path.join(task.worktree, relative)), { persistent: false }, (_event, changed) => {
        if (changed !== null && changed.toString() !== filename) return
        const observation = this.observations.get(key)
        if (!observation) return
        if (observation.timer) clearTimeout(observation.timer)
        observation.timer = setTimeout(() => {
          delete observation.timer
          if (this.observations.get(key) === observation && !this.disposed) this.onEvent({ kind: 'changed', task: observation.task })
        }, 30)
        observation.timer.unref()
      })
      const observation: Observation = { task, watcher }
      this.observations.set(key, observation)
      watcher.on('error', error => {
        if (this.observations.get(key) !== observation) return
        this.close(key, observation)
        this.unavailable(task, error.message)
      })
      return true
    } catch (error) {
      this.unavailable(task, error instanceof Error ? error.message : '无法观察场景文件')
      return false
    }
  }

  unobserve(task: ScenarioObservedTask): void {
    const key = this.key(task), observation = this.observations.get(key)
    if (observation) this.close(key, observation)
  }

  dispose(): void {
    this.disposed = true
    for (const [key, observation] of this.observations) this.close(key, observation)
  }

  private key(task: ScenarioObservedTask): string { return `${path.resolve(task.worktree)}\0${task.entityId}` }
  private close(key: string, observation: Observation): void {
    this.observations.delete(key)
    if (observation.timer) clearTimeout(observation.timer)
    observation.watcher.close()
  }
  private unavailable(task: ScenarioObservedTask, reason: string): void { this.onEvent({ kind: 'unavailable', task, message: `场景文件无法持续观察：${reason}` }) }
}
