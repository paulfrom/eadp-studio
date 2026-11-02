import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { appendLocalActivity } from '../local-state/sqlite-state.ts'
import { homedir } from 'node:os'
import path from 'node:path'

export function studioStateDirectory(directory?: string): string {
  return directory ?? path.join(process.env.APPDATA ?? path.join(homedir(), '.local/share'), 'eadp-studio', 'studio')
}

/** Host-only structured activity journal; payloads, headers and error messages never enter it. */
export class ActivityLog {
  private readonly context = new AsyncLocalStorage<string>()
  private pending = Promise.resolve()
  private warned = false
  constructor(private readonly directory: string) {}

  async run<T>(area: 'command' | 'http', operation: string, execute: () => Promise<T>, outcome: (value: T) => Record<string, string | number | boolean> = () => ({})): Promise<T> {
    const id = randomUUID(), parentId = this.context.getStore(), started = Date.now()
    const base = { id, parentId, area, operation }
    await this.write({ ...base, phase: 'start' })
    return this.context.run(id, async () => {
      try {
        const value = await execute()
        await this.write({ ...base, phase: 'end', durationMs: Date.now() - started, ...outcome(value) })
        return value
      } catch (error) {
        // Error text can contain passwords, request bodies or upstream response content.
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined
        await this.write({ ...base, phase: 'end', durationMs: Date.now() - started, ok: false, error: error instanceof Error ? error.name : 'UnknownError', ...(code && /^[A-Z0-9_]{1,80}$/.test(code) ? { code } : {}) })
        throw error
      }
    })
  }

  private write(event: Record<string, unknown>): Promise<void> {
    const record = { time: new Date().toISOString(), pid: process.pid, ...event }
    this.pending = this.pending.then(() => appendLocalActivity(this.directory, record)).catch(() => {
      if (!this.warned) { this.warned = true; console.warn('Studio activity log could not be written; check the application database.') }
    })
    return this.pending
  }
}
