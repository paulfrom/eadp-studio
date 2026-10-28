import { realpathSync } from 'node:fs'
import path from 'node:path'

/** Resolve existing ancestors so paths to the same file share a write lock. */
export function canonicalWritePath(value: string): string {
  const suffix: string[] = []
  let ancestor = path.resolve(value)
  while (true) {
    try {
      const resolved = path.join(realpathSync.native(ancestor), ...suffix.reverse())
      return process.platform === 'win32' ? resolved.toLowerCase() : resolved
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      const parent = path.dirname(ancestor)
      if (parent === ancestor) throw error
      suffix.push(path.basename(ancestor)); ancestor = parent
    }
  }
}

const writes = new Map<string, Promise<unknown>>()

/** Serialize all managed writes to the same canonical path until the writer settles. */
export async function withPathWriteLock<T>(target: string, work: () => Promise<T>): Promise<T> {
  const key = canonicalWritePath(target)
  const previous = writes.get(key) ?? Promise.resolve()
  const running = previous.catch(() => undefined).then(work)
  writes.set(key, running)
  try { return await running } finally { if (writes.get(key) === running) writes.delete(key) }
}
