import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

/** Windows file scanners can briefly deny replacement; every retry keeps the same atomic rename. */
async function replaceStateFile(temporary: string, filename: string): Promise<void> {
  const waits = [10, 20, 40, 80, 160, 320, 640, 1000]
  for (let attempt = 0; ; attempt++) {
    try { await rename(temporary, filename); return }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || attempt >= waits.length) throw error
      await delay(waits[attempt])
    }
  }
}

/** Atomically persists local JSON; callers own its project or application storage boundary. */
export class AtomicState<T> {
  private pending: Promise<unknown> = Promise.resolve()
  constructor(private readonly filename: string) {}
  async read(): Promise<T | undefined> {
    try { return JSON.parse(await readFile(this.filename, 'utf8')) as T }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  }
  write(value: T): Promise<void> {
    const write = this.pending.catch(() => {}).then(async () => {
      await mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 })
      const temporary = `${this.filename}.${randomUUID()}.tmp`
      const file = await open(temporary, 'wx', 0o600)
      try { await file.writeFile(`${JSON.stringify(value)}\n`); await file.sync() } finally { await file.close() }
      try { await replaceStateFile(temporary, this.filename) } finally { await rm(temporary, { force: true }) }
    })
    this.pending = write
    return write
  }
}
