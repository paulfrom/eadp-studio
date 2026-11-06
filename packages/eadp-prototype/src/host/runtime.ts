import { createHash } from 'node:crypto'
import { readFile, readdir, realpath, lstat } from 'node:fs/promises'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'

type ToolName = 'node' | 'pnpm'
interface RuntimeFile { path: string; sha256: string }
interface RuntimeManifest {
  schemaVersion: 1; platform: NodeJS.Platform; arch: string
  tools: Record<ToolName, RuntimeFile & { version: string; source: string; license: string; script?: boolean }>
  files: RuntimeFile[]
}
const ENVIRONMENT_KEYS = ['SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE']
const VERSIONS = { node: '22.22.3', pnpm: '11.28.5' }

/** Fixed toolchain paths and hashes; ambient executable discovery is never used. */
export class PrototypeRuntime {
  private readonly handles = new Set<SubprocessHandle>()
  private readonly stopping = new Map<SubprocessHandle, Promise<void>>()
  private disposed = false
  private constructor(private readonly ctx: Context, private readonly tools: Record<ToolName, string>) {}

  static async load(ctx: Context): Promise<PrototypeRuntime> {
    const primary = process.argv[4]
    if (!primary || !path.isAbsolute(primary) || path.basename(primary) !== 'primary-runtime') throw new Error('发行工具链入口不可用；需要随包 eadp-tools。')
    const root = await realpath(path.join(path.dirname(primary), 'eadp-tools'))
    const manifest = JSON.parse(await readFile(path.join(root, 'runtime-manifest.json'), 'utf8')) as RuntimeManifest
    if (manifest.schemaVersion !== 1 || manifest.platform !== process.platform || manifest.arch !== process.arch) throw new Error('随包工具链与当前平台不匹配。')
    const checked = new Set<string>()
    const verify = async (entry: RuntimeFile): Promise<string> => {
      if (!entry || typeof entry.path !== 'string' || !entry.path || entry.path.includes('\\') || path.isAbsolute(entry.path) || entry.path.split('/').some(part => !part || part === '.' || part === '..') || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('工具链文件清单无效。')
      let filename = root
      for (const part of entry.path.split('/')) { filename = path.join(filename, part); if ((await lstat(filename)).isSymbolicLink()) throw new Error('工具链不允许链接。') }
      if (!(await lstat(filename)).isFile() || createHash('sha256').update(await readFile(filename)).digest('hex') !== entry.sha256) throw new Error(`工具链校验失败：${entry.path}`)
      checked.add(entry.path)
      return filename
    }
    const tools = {} as Record<ToolName, string>
    for (const name of ['node', 'pnpm'] as const) {
      const entry = manifest.tools?.[name]
      if (!entry || typeof entry.source !== 'string' || !entry.source || typeof entry.license !== 'string' || !entry.license || entry.version !== VERSIONS[name] || (name === 'node' && entry.script) || (name === 'pnpm' && entry.script !== true)) throw new Error(`随包 ${name} 版本或启动约定无效。`)
      tools[name] = await verify(entry)
    }
    {
      if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error('工具链完整文件清单无效。')
      const declared = new Set<string>()
      for (const entry of manifest.files) { if (!entry || entry.path === 'runtime-manifest.json' || declared.has(entry.path)) throw new Error('工具链文件清单重复。'); declared.add(entry.path); await verify(entry) }
      for (const name of ['node', 'pnpm'] as const) if (!declared.has(manifest.tools[name].path)) throw new Error('工具链完整清单缺少执行入口。')
      const walk = async (directory: string, prefix: string): Promise<void> => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const relative = prefix + entry.name
          if (entry.isSymbolicLink()) throw new Error('工具链不允许链接。')
          if (entry.isDirectory()) await walk(path.join(directory, entry.name), relative + '/')
          else if (!entry.isFile() || (relative !== 'runtime-manifest.json' && !checked.has(relative))) throw new Error(`工具链含未登记文件：${relative}`)
        }
      }
      await walk(root, '')
    }
    return new PrototypeRuntime(ctx, tools)
  }

  async start(cwd: string, command: 'install' | 'start', port?: number): Promise<SubprocessHandle> {
    if (this.disposed) throw new Error('工具链已关闭。')
    const canonical = await realpath(cwd)
    if (canonical !== cwd || !(await lstat(canonical)).isDirectory()) throw new Error('原型工作目录已变化。')
    const env: NodeJS.ProcessEnv = Object.fromEntries(Object.keys(process.env).map(key => [key, undefined]))
    for (const key of ENVIRONMENT_KEYS) if (process.env[key]) env[key] = process.env[key]
    env.PATH = [...new Set(Object.values(this.tools).map(value => path.dirname(value)))].join(path.delimiter)
    env.BROWSER = 'none'; env.HOST = '127.0.0.1'; env.NO_COLOR = '1'
    if (port !== undefined) env.PORT = String(port)
    const args = command === 'install' ? ['install', '--frozen-lockfile'] : ['run', 'start']
    const handle = this.ctx.subprocess.spawn({ argv: [this.tools.node, this.tools.pnpm, ...args], cwd: canonical, env, graceMs: 3000, stdio: { stdin: 'ignore', stdout: { maxBytes: 200 * 1024 }, stderr: { maxBytes: 200 * 1024 } } })
    this.handles.add(handle)
    void handle.done.catch(() => {})
    return handle
  }
  async stop(handle: SubprocessHandle): Promise<void> {
    const pending = this.stopping.get(handle)
    if (pending) return pending
    const operation = (async () => {
      handle.terminate()
      if (!await handle.waitForExit(AbortSignal.timeout(10_000))) throw new Error('原型所属进程范围未能完全退出，请重试停止。')
      await handle.done.catch(() => undefined)
      this.handles.delete(handle)
    })()
    this.stopping.set(handle, operation)
    try { await operation } finally { if (this.stopping.get(handle) === operation) this.stopping.delete(handle) }
  }
  async dispose(): Promise<void> { this.disposed = true; await Promise.all([...this.handles].map(handle => this.stop(handle))) }
}
