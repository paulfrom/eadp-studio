import { Service, type Context } from '@deepseek-ai/cordis'
import type { EadpPrototypeClient, PrototypeRunState } from '@eadp/contracts/prototype'
import type { PrototypeApi } from './api.ts'

/** Lets the Shell stop owned work before a project is removed or moved. */
export class PrototypeClientService extends Service implements EadpPrototypeClient {
  constructor(ctx: Context, private readonly api: PrototypeApi) { super(ctx, 'eadpPrototypeClient') }
  async stopProject(projectId: string): Promise<void> {
    const state = await this.api.stop(projectId)
    if (state.status !== 'stopped' || state.installStatus === 'installing') {
      throw new Error(state.error ?? state.installationError ?? '原型进程尚未停止，请重试。')
    }
  }
  listRuns(): Promise<PrototypeRunState[]> { return this.api.listRuns() }
}
