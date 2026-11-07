import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, remoteErrorOf, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-subprocess'
import type { PrototypeContent, PrototypeErrorCode, PrototypeFileList, PrototypeRunLog, PrototypeRunState } from '@eadp/contracts/prototype'
import { failureMessage, mapFailureCode } from '@eadp/contracts'
import { PrototypeBoundary } from './boundary.ts'
import { PrototypeFiles } from './files.ts'
import { PrototypeSupervisor } from './supervisor.ts'
import { createPrototype } from './template.ts'

export const name = 'eadp-prototype'
export const inject = ['typert', 'workspaceRegistry', 'fs', 'subprocess']

/** Trusted user actions only; project execution is never exposed as an Agent tool. */
export class PrototypeService extends TypertRemoteService {
  private readonly boundary: PrototypeBoundary
  private readonly files: PrototypeFiles
  private readonly supervisor: PrototypeSupervisor
  constructor(ctx: Context) {
    super(ctx, 'eadpPrototype', { namespace: 'eadpPrototype' })
    this.boundary = new PrototypeBoundary(ctx)
    this.files = new PrototypeFiles(ctx, this.boundary)
    this.supervisor = new PrototypeSupervisor(ctx, this.files)
    ctx.effect(() => () => this.supervisor.dispose())
  }
  @Remote
  async listFiles(projectId: string, directory: string): Promise<PrototypeFileList> { return this.run(() => this.files.list(projectId, directory)) }
  @Remote
  async readFile(projectId: string, relativePath: string): Promise<PrototypeContent> { return this.run(() => this.files.read(projectId, relativePath)) }
  @Remote
  async createProject(projectId: string): Promise<PrototypeRunState> {
    return this.run(() => this.supervisor.serial(projectId, async () => {
      await this.boundary.target(projectId, '')
      if (this.supervisor.hasProcess(projectId)) throw new RemoteError('eadp/prototype', '请先停止原型进程。', { code: 'RUN_FAILED' })
      await createPrototype(this.ctx, this.boundary, projectId)
      return this.supervisor.state(projectId)
    }))
  }
  @Remote
  async installDependencies(projectId: string): Promise<PrototypeRunState> { return this.run(async () => { await this.boundary.target(projectId, ''); return this.supervisor.install(projectId) }) }
  @Remote
  async start(projectId: string): Promise<PrototypeRunState> { return this.run(async () => { await this.boundary.target(projectId, ''); return this.supervisor.start(projectId) }) }
  @Remote
  async stop(projectId: string): Promise<PrototypeRunState> { return this.run(() => this.supervisor.stop(projectId)) }
  @Remote
  async status(projectId: string): Promise<PrototypeRunState> { return this.run(async () => { await this.boundary.target(projectId, ''); return this.supervisor.state(projectId) }) }
  @Remote
  async listRuns(): Promise<PrototypeRunState[]> { return this.supervisor.listRuns() }
  @Remote
  async logs(projectId: string): Promise<PrototypeRunLog> { return this.run(async () => this.supervisor.logs(projectId)) }
  @Remote
  async openBrowser(projectId: string): Promise<string> {
    return this.run(async () => {
      await this.boundary.target(projectId, '')
      const state = this.supervisor.state(projectId)
      if (state.status !== 'running' || !state.port || state.url !== `http://127.0.0.1:${state.port}/`) throw new RemoteError('eadp/prototype', '原型尚未就绪。', { code: 'RUN_NOT_READY' })
      return state.url
    })
  }
  /** Preserve actionable domain codes over the official Typert error transport. */
  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation() } catch (error) {
      const remote = remoteErrorOf(error)
      if (remote) throw remote
      const codes: Record<string, PrototypeErrorCode> = {
        PROJECT_NOT_FOUND: 'PROJECT_NOT_FOUND', ENOENT: 'NOT_FOUND', FS_NOT_FOUND: 'NOT_FOUND', FS_SANDBOX_DENIED: 'OUTSIDE_PROJECT',
        FS_PERMISSION_DENIED: 'PERMISSION_DENIED', EACCES: 'PERMISSION_DENIED', EPERM: 'PERMISSION_DENIED',
        EEXIST: 'EXISTS', FS_NOT_DIRECTORY: 'INVALID_PATH', FS_NOT_REGULAR_FILE: 'INVALID_PATH',
        FS_TOO_LARGE: 'TOO_LARGE', FS_NOT_TEXT: 'NOT_TEXT', FS_STALE_VERSION: 'STALE_VERSION',
      }
      throw new RemoteError('eadp/prototype', failureMessage(error, '原型操作失败。'), { code: mapFailureCode(error, codes, 'IO_ERROR') })
    }
  }
}
export function apply(ctx: Context): void { ctx.plugin(PrototypeService) }
