import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { composeStudio, type Config } from './composition.ts'
import type { StudioCommand, StudioReply } from '../shared/studio.ts'

export type { Config }
export const inject = ['tools', 'agents', 'systemPrompt', 'sessionPersistence', 'subprocess', 'sessionController']
/** Remote is a trusted UI entry; these methods are never registered as Agent tools. */
export class StudioService extends TypertRemoteService {
  private readonly application: ReturnType<typeof composeStudio>
  constructor(ctx: Context, config: Config) { super(ctx, 'studio'); this.application = composeStudio(ctx, config); void this.application.catch(() => undefined) }
  @Remote
  async command(command: StudioCommand): Promise<StudioReply> {
    try { return await (await this.application).command(command) }
    catch (error) { return { ok: false, code: 'STUDIO_UNAVAILABLE', message: error instanceof Error ? error.message : '工作台服务尚未就绪' } }
  }
}
export function apply(ctx: Context, config: Config = {}): void { ctx.plugin(StudioService, config) }
