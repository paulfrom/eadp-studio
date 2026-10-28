import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'

export type ToolName = 'node' | 'pnpm' | 'git' | 'ssh'
export interface RuntimeManifest {
  schemaVersion: 1
  platform: NodeJS.Platform
  arch: string
  tools: Record<ToolName, { path: string; version: string; sha256: string; source: string; license: string; script?: boolean }>
}
/** Structural subset of the fixed DSH subprocess service; its provider owns Windows Jobs. */
export interface SubprocessProvider {
  spawn(spec: {
    argv: readonly string[]; cwd: string; env: NodeJS.ProcessEnv; graceMs: number
    stdio: { stdin: 'ignore' | { data: string }; stdout: 'pipe'; stderr: 'pipe' }; signal?: AbortSignal
  }): {
      readonly stdout: Readable | undefined; readonly stderr: Readable | undefined; readonly stdin: Writable | undefined
    readonly done: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>
    terminate(): void; waitForExit(signal?: AbortSignal): Promise<boolean>
  }
}
export interface RunOptions {
  cwd: string; signal?: AbortSignal; env?: Record<string, string>; timeoutMs?: number; input?: string; maxOutputBytes?: number
  /** Only WorkspaceGit opts in to the machine user's trusted Git configuration and credential helpers. */
  gitUserCredentials?: true
}
export interface ProcessResult { stdout: string; stderr: string; stdoutBytes: Buffer; exitCode: number }
export interface ManagedProcess {
  readonly done: Promise<ProcessResult>
  stop(): Promise<void>
  onOutput(listener: (channel: 'stdout' | 'stderr', text: string) => void): () => void
}

const ENVIRONMENT_KEYS = ['SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE']
const SAFE_ADDITIONAL_ENV = /^(?:CI|NODE_ENV|PORT|HOST|BROWSER|FORCE_COLOR|NO_COLOR|GIT_INDEX_FILE|GIT_ATTR_NOSYSTEM|GIT_AUTHOR_NAME|GIT_AUTHOR_EMAIL|GIT_COMMITTER_NAME|GIT_COMMITTER_EMAIL)$/
const GIT_USER_ENVIRONMENT_KEYS = ['HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'SSH_AUTH_SOCK']

/** No PATH discovery or ambient Node/Git configuration reaches a product command. */
export class PlatformRuntime {
  private readonly live = new Set<ManagedProcess>()
  private disposed = false
  private constructor(readonly manifest: RuntimeManifest, private readonly executables: Record<ToolName, string>, private readonly subprocess: SubprocessProvider) {}

  executable(tool: ToolName): string { return this.executables[tool] }

  static async load(manifestPath: string, resourceRoot: string, subprocess: SubprocessProvider): Promise<PlatformRuntime> {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as RuntimeManifest
    if (manifest.schemaVersion !== 1 || manifest.platform !== process.platform || manifest.arch !== process.arch) throw new Error('随包工具链与当前平台不匹配。')
    const root = await realpath(resourceRoot)
    const executables = {} as Record<ToolName, string>
    for (const name of ['node', 'pnpm', 'git', 'ssh'] as const) {
      const entry = manifest.tools?.[name]
      if (!entry || !/^[a-f0-9]{64}$/.test(entry.sha256) || !entry.version || !entry.source || !entry.license || path.isAbsolute(entry.path)) throw new Error(`随包 ${name} 清单无效。`)
      const executable = await realpath(path.resolve(root, entry.path))
      const relative = path.relative(root, executable)
      if (relative.startsWith('..') || path.isAbsolute(relative) || !(await stat(executable)).isFile()) throw new Error(`随包 ${name} 路径越界。`)
      if (createHash('sha256').update(await readFile(executable)).digest('hex') !== entry.sha256) throw new Error(`随包 ${name} 校验失败。`)
      executables[name] = executable
    }
    return new PlatformRuntime(manifest, executables, subprocess)
  }

  async start(tool: ToolName, args: readonly string[], options: RunOptions): Promise<ManagedProcess> {
    if (this.disposed) throw new Error('工具链已关闭。')
    options.signal?.throwIfAborted()
    if (!Array.isArray(args) || args.some(value => typeof value !== 'string' || value.includes('\0'))) throw new Error('工具参数无效。')
    const cwd = await realpath(options.cwd)
    if (!(await stat(cwd)).isDirectory()) throw new Error('命令工作目录不存在。')
    const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).map(([key]) => [key, undefined]))
    for (const key of ENVIRONMENT_KEYS) if (process.env[key]) env[key] = process.env[key]
    env.PATH = [...new Set(Object.values(this.executables).map(value => path.dirname(value)))].join(path.delimiter)
    if (options.gitUserCredentials) {
      if (tool !== 'git') throw new Error('用户 Git 凭据仅供专用 Git 操作使用。')
      for (const key of GIT_USER_ENVIRONMENT_KEYS) if (process.env[key]) env[key] = process.env[key]
    } else {
      env.GIT_CONFIG_NOSYSTEM = '1'
      env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null'
    }
    env.GIT_TERMINAL_PROMPT = '0'
    for (const [key, value] of Object.entries(options.env ?? {})) {
      if (!SAFE_ADDITIONAL_ENV.test(key)) throw new Error(`命令环境变量不允许：${key}`)
      env[key] = value
    }
    const timeoutMs = options.timeoutMs ?? 0
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 3_600_000) throw new Error('命令超时设置无效。')
    const deadline = timeoutMs === 0 ? undefined : AbortSignal.timeout(timeoutMs)
    const signal = deadline && options.signal ? AbortSignal.any([options.signal, deadline]) : deadline ?? options.signal ?? new AbortController().signal
    const entry = this.manifest.tools[tool]
    const argv = entry.script ? [this.executables.node, this.executables[tool], ...args] : [this.executables[tool], ...args]
    const handle = this.subprocess.spawn({ argv, cwd, env, signal, graceMs: 3000, stdio: { stdin: options.input === undefined ? 'ignore' : { data: options.input }, stdout: 'pipe', stderr: 'pipe' } })
    const listeners = new Set<(channel: 'stdout' | 'stderr', text: string) => void>()
    let stdout = '', stderr = '', overflow = false
    const stdoutChunks: Buffer[] = []
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') }
    let outputBytes = 0
    const maxBytes = options.maxOutputBytes ?? 8 * 1024 * 1024
    for (const channel of ['stdout', 'stderr'] as const) handle[channel]?.on('data', (chunk: Buffer | string) => {
      if (overflow) return
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      outputBytes += bytes.byteLength
      if (outputBytes > maxBytes) { overflow = true; handle.terminate(); return }
      if (channel === 'stdout') stdoutChunks.push(bytes)
      const text = decoders[channel].write(bytes)
      if (channel === 'stdout') stdout += text; else stderr += text
      for (const listener of listeners) { try { listener(channel, text) } catch { /* Observers cannot crash the owning Host. */ } }
    })
    const done = handle.done.then(async outcome => {
      if (!await handle.waitForExit(AbortSignal.timeout(10_000))) throw new Error('命令所属进程树未能完全退出。')
      if (overflow) throw new Error('命令输出超过限制。')
      signal.throwIfAborted()
      stdout += decoders.stdout.end(); stderr += decoders.stderr.end()
      return { stdout, stderr, stdoutBytes: Buffer.concat(stdoutChunks), exitCode: outcome.exitCode ?? -1 }
    }).finally(() => this.live.delete(processHandle))
    const processHandle: ManagedProcess = {
      done,
      stop: async () => { handle.terminate(); if (!await handle.waitForExit(AbortSignal.timeout(10_000))) throw new Error('命令所属进程树清理失败。'); await done.catch(() => {}) },
      onOutput: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    }
    this.live.add(processHandle)
    // A preview may keep the process until its owner observes readiness.
    void done.catch(() => {})
    return processHandle
  }

  async run(tool: ToolName, args: readonly string[], options: RunOptions): Promise<ProcessResult> {
    const result = await (await this.start(tool, args, { ...options, timeoutMs: options.timeoutMs ?? 120_000 })).done
    // Tool stderr can contain repository contents or credentials. It is never an RPC error.
    if (result.exitCode !== 0) throw new Error(`${tool} 执行失败（退出码 ${result.exitCode}）。`)
    return result
  }
  async dispose(): Promise<void> { this.disposed = true; await Promise.all([...this.live].map(process => process.stop())) }
}
