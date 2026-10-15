import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'

/** Only minimal recovery metadata belongs here; secrets and business bodies do not. */
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
      try { await rename(temporary, this.filename) } finally { await rm(temporary, { force: true }) }
    })
    this.pending = write
    return write
  }
}
