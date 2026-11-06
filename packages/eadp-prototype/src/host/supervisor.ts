import { createServer } from 'node:net'
import { get } from 'node:http'
import { stripVTControlCharacters } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import type { PrototypeRunLog, PrototypeRunState } from '@eadp/contracts/prototype'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { PrototypeFiles } from './files.ts'
import { PrototypeRuntime } from './runtime.ts'

interface OwnedRun {
  state: PrototypeRunState
  handle?: SubprocessHandle
  command?: 'install' | 'start'
  abort?: AbortController
  log: PrototypeRunLog
  offsets: { stdout: number; stderr: number }
  urlObserved?: boolean
}
const LOG_BYTES = 200 * 1024
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** Allocate a loopback port without adopting an unrelated listener. */
async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') { server.close(); reject(new Error('无法分配原型端口。')); return }
      server.close(error => error ? reject(error) : resolve(address.port))
    })
  })
}
function accessible(url: string, signal: AbortSignal): Promise<boolean> {
  return new Promise(resolve => {
    const request = get(url, { signal, timeout: 1500 }, response => { const ok = (response.statusCode ?? 0) >= 200 && (response.statusCode ?? 500) < 400; response.destroy(); resolve(ok) })
    request.on('error', () => resolve(false))
    request.on('timeout', () => request.destroy())
  })
}
function pause(signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return }
    const finish = (): void => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve() }
    const timer = setTimeout(finish, 400)
    signal.addEventListener('abort', finish, { once: true })
  })
}

/** Owns handles, serializes user mutations, and keeps independent installation/run outcomes. */
export class PrototypeSupervisor {
  private readonly runs = new Map<string, OwnedRun>()
  private readonly queues = new Map<string, Promise<unknown>>()
  private runtimePromise?: Promise<PrototypeRuntime>
  private disposed = false
  constructor(private readonly ctx: Context, private readonly files: PrototypeFiles) {}

  async serial<T>(projectId: string, action: () => Promise<T>): Promise<T> {
    if (this.disposed) throw new Error('原型运行服务已关闭。')
    const previous = this.queues.get(projectId) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(action)
    this.queues.set(projectId, current)
    try { return await current } finally { if (this.queues.get(projectId) === current) this.queues.delete(projectId) }
  }
  private runtime(): Promise<PrototypeRuntime> {
    if (!this.runtimePromise) this.runtimePromise = PrototypeRuntime.load(this.ctx).catch(error => { delete this.runtimePromise; throw error })
    return this.runtimePromise
  }
  private record(projectId: string): OwnedRun {
    let record = this.runs.get(projectId)
    if (!record) {
      record = { state: { projectId, status: 'stopped', installStatus: 'unknown' }, log: { items: [], truncated: false }, offsets: { stdout: 0, stderr: 0 } }
      this.runs.set(projectId, record)
    }
    return record
  }
  private append(record: OwnedRun, stream: 'stdout' | 'stderr' | 'host', text: string): void {
    if (!text) return
    record.log.items.push({ stream, text })
    let bytes = record.log.items.reduce((sum, item) => sum + Buffer.byteLength(item.text), 0)
    while (bytes > LOG_BYTES && record.log.items.length) {
      const first = record.log.items[0]!
      const original = Buffer.from(first.text)
      const remove = Math.min(bytes - LOG_BYTES, original.byteLength)
      if (remove === original.byteLength) record.log.items.shift()
      else {
        let start = remove
        while (start < original.length && (original[start]! & 0xc0) === 0x80) start++
        first.text = original.subarray(start).toString('utf8')
      }
      record.log.truncated = true
      bytes = record.log.items.reduce((sum, item) => sum + Buffer.byteLength(item.text), 0)
    }
  }
  private collect(record: OwnedRun): void {
    for (const stream of ['stdout', 'stderr'] as const) {
      const next = record.handle?.collected[stream]?.readFrom(record.offsets[stream])
      if (!next) continue
      record.offsets[stream] = next.nextOffset
      record.log.truncated ||= next.lossy
      this.append(record, stream, next.text)
    }
  }
  hasProcess(projectId: string): boolean { return this.record(projectId).handle !== undefined }
  state(projectId: string): PrototypeRunState { return { ...this.record(projectId).state } }
  listRuns(): PrototypeRunState[] {
    return [...this.runs.values()].filter(record => record.handle || record.state.status !== 'stopped' || record.state.installStatus === 'failed').map(record => ({ ...record.state }))
  }
  logs(projectId: string): PrototypeRunLog {
    const record = this.record(projectId)
    this.collect(record)
    return { items: record.log.items.map(item => ({ ...item })), truncated: record.log.truncated }
  }
  private reset(record: OwnedRun, command: 'install' | 'start'): void {
    record.offsets = { stdout: 0, stderr: 0 }
    record.urlObserved = false
    record.command = command
    record.abort = new AbortController()
    this.append(record, 'host', `\n[${new Date().toISOString()}] ${command === 'install' ? '安装依赖' : '启动原型'}\n`)
  }
  async install(projectId: string): Promise<PrototypeRunState> {
    return this.serial(projectId, async () => {
      const record = this.record(projectId)
      if (record.command === 'install' && record.handle && record.state.installStatus === 'installing') return this.state(projectId)
      if (record.handle) throw new RemoteError('eadp/prototype', '请先停止当前原型进程。', { code: 'RUN_FAILED' })
      try {
        const cwd = await this.files.runnable(projectId, false)
        const runtime = await this.runtime()
        this.reset(record, 'install')
        record.state.installStatus = 'installing'; delete record.state.installationError
        record.handle = await runtime.start(cwd, 'install')
        this.observe(record, runtime, record.handle, 'install')
      } catch (error) {
        record.state.installStatus = 'failed'; record.state.installationError = message(error)
        this.append(record, 'host', message(error) + '\n')
      }
      return this.state(projectId)
    })
  }
  async start(projectId: string): Promise<PrototypeRunState> {
    return this.serial(projectId, async () => {
      const record = this.record(projectId)
      if (record.handle && (record.state.status === 'starting' || record.state.status === 'running')) return this.state(projectId)
      if (record.handle) throw new RemoteError('eadp/prototype', '请先停止当前原型进程。', { code: 'RUN_FAILED' })
      try {
        const cwd = await this.files.runnable(projectId, true)
        const runtime = await this.runtime()
        const port = await availablePort()
        this.reset(record, 'start')
        record.state = { ...record.state, status: 'starting', port, startedAt: new Date().toISOString() }
        delete record.state.url; delete record.state.error
        record.handle = await runtime.start(cwd, 'start', port)
        this.observe(record, runtime, record.handle, 'start')
        void this.ready(record, runtime, record.handle, port, record.abort!.signal).catch(error => this.ctx.logger.error(`原型就绪检查失败：${message(error)}`))
      } catch (error) {
        record.state.status = 'failed'; record.state.error = message(error); delete record.state.url
        this.append(record, 'host', message(error) + '\n')
        if (error instanceof RemoteError) throw error
      }
      return this.state(projectId)
    })
  }
  /** Observe actual exit first, then empty the complete provider-managed range. */
  private observe(record: OwnedRun, runtime: PrototypeRuntime, handle: SubprocessHandle, command: 'install' | 'start'): void {
    void (async () => {
      let error: string | undefined
      try {
        const result = await handle.done
        if (result.exitCode !== 0) error = `进程退出（退出码 ${result.exitCode ?? '无'}，信号 ${result.signal ?? '无'}）。`
        else if (command === 'start') error = '原型运行进程已退出。'
      } catch (failure) { error = message(failure) }
      if (record.handle !== handle) return
      this.collect(record)
      record.abort?.abort()
      const stopping = record.state.status === 'stopping'
      if (command === 'start' && !stopping) { record.state.error = (record.state.status === 'failed' ? record.state.error : undefined) ?? error ?? '原型运行进程已退出。'; record.state.status = 'failed'; delete record.state.url }
      if (command === 'install') {
        if (error || stopping) { record.state.installStatus = 'failed'; record.state.installationError = error ?? '依赖安装已停止。' }
      }
      try {
        await runtime.stop(handle)
        if (record.handle !== handle) return
        this.collect(record)
        if (command === 'install' && !error && !stopping && record.state.installStatus === 'installing') record.state.installStatus = 'ready'
        delete record.handle; delete record.command
      } catch (failure) {
        const cleanup = message(failure)
        if (command === 'start') { record.state.status = 'failed'; record.state.error = cleanup }
        else { record.state.installStatus = 'failed'; record.state.installationError = cleanup }
        this.append(record, 'host', cleanup + '\n')
      }
      if (error && !stopping) this.append(record, 'host', error + '\n')
    })().catch(error => this.ctx.logger.error(`原型进程收尾失败：${message(error)}`))
  }
  private async ready(record: OwnedRun, runtime: PrototypeRuntime, handle: SubprocessHandle, port: number, signal: AbortSignal): Promise<void> {
    const url = `http://127.0.0.1:${port}/`
    const deadline = Date.now() + 120_000
    const probeSignal = AbortSignal.any([signal, AbortSignal.timeout(120_000)])
    while (!signal.aborted && record.handle === handle && record.state.status === 'starting' && Date.now() < deadline) {
      this.collect(record)
      const stdout = stripVTControlCharacters(handle.collected.stdout?.readFrom(0).text ?? '')
      record.urlObserved ||= [...stdout.matchAll(/(?:^|\n)[^\r\n]*\bLocal:[ \t]*http:\/\/(?:127\.0\.0\.1|localhost):(\d+)(?=\/|[ \t\r\n]|$)/g)].some(match => Number(match[1]) === port)
      if (record.urlObserved && await accessible(url, probeSignal)) {
        if (signal.aborted || record.handle !== handle || record.state.status !== 'starting') return
        record.state.status = 'running'; record.state.url = url
        this.append(record, 'host', `原型 HTTP 已就绪：${url}\n`)
        return
      }
      await pause(signal)
    }
    if (signal.aborted || record.handle !== handle || record.state.status !== 'starting') return
    record.state.status = 'failed'; record.state.error = '原型在 120 秒内未就绪，请查看日志。'; delete record.state.url
    this.append(record, 'host', record.state.error + '\n')
    try { await runtime.stop(handle); if (record.handle === handle) { this.collect(record); delete record.handle; delete record.command } }
    catch (error) { record.state.error += ' ' + message(error); this.append(record, 'host', message(error) + '\n') }
  }
  async stop(projectId: string): Promise<PrototypeRunState> {
    return this.serial(projectId, async () => {
      const record = this.record(projectId)
      record.abort?.abort()
      if (!record.handle) { record.state.status = 'stopped'; delete record.state.url; delete record.state.port; return this.state(projectId) }
      const handle = record.handle
      record.state.status = 'stopping'; delete record.state.url
      try {
        await (await this.runtime()).stop(handle)
        if (record.handle === handle) { this.collect(record); delete record.handle; delete record.command }
        record.state.status = 'stopped'; delete record.state.error; delete record.state.port
        if (record.state.installStatus === 'installing') { record.state.installStatus = 'failed'; record.state.installationError = '依赖安装已停止。' }
      } catch (error) { record.state.status = 'failed'; record.state.error = message(error); this.append(record, 'host', message(error) + '\n') }
      return this.state(projectId)
    })
  }
  async dispose(): Promise<void> {
    this.disposed = true
    for (const record of this.runs.values()) { record.abort?.abort(); if (record.handle) record.state.status = 'stopping' }
    await Promise.allSettled([...this.queues.values()])
    if (this.runtimePromise) await (await this.runtimePromise).dispose()
  }
}
