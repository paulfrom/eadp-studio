import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { composeStudio, type Config } from './composition.ts'
import type { StudioApplication } from './application/studio.ts'
import { within } from '../shared/deadline.ts'
import type { ProjectProgressReply, StudioCommand, StudioReply } from '../shared/studio.ts'

export type { Config }
/** Plugin id; matches the `studio-plugin` row in `cordis.patch.yml`. */
export const name = 'studio-plugin'
export const inject = ['tools', 'agents', 'llm', 'systemPrompt', 'subprocess', 'sessionController', 'agentPresets', 'sessionProjections', 'agentDefaultModel', 'attachments', 'sessions']
/**
 * Longest a command waits for composition. Composition runs once per Host
 * process and loads the platform runtime, so it is allowed the same order of
 * time as a cold projection read; past this deadline the caller is told the
 * workbench is not ready instead of holding a promise that may never settle.
 */
const COMPOSE_DEADLINE_MS = 60_000

/** Remote is a trusted UI entry; these methods are never registered as Agent tools. */
export class StudioService extends TypertRemoteService {
  private readonly application: Promise<StudioApplication>
  constructor(ctx: Context, config: Config) {
    super(ctx, 'studio')
    // Composition settles once for the process lifetime: a stalled or failed
    // composition must make every command fail loudly on its own deadline.
    this.application = composeStudio(ctx, config)
    void this.application.catch(() => undefined)
  }
  @Remote
  async command(command: StudioCommand): Promise<StudioReply> {
    try { return await (await within(this.application, COMPOSE_DEADLINE_MS, '工作台服务尚未就绪，请稍后重试。')).command(command) }
    catch (error) { return { ok: false, code: 'STUDIO_UNAVAILABLE', message: error instanceof Error ? error.message : '工作台服务尚未就绪' } }
  }
  /** Progress is advisory: an uncomposed or failed workbench reports nothing running. */
  @Remote
  async progress(): Promise<ProjectProgressReply> {
    try { return (await within(this.application, COMPOSE_DEADLINE_MS, '工作台服务尚未就绪，请稍后重试。')).projectProgress() }
    catch { return { operations: [] } }
  }
}
export function apply(ctx: Context, config: Config = {}): void { ctx.plugin(StudioService, config) }
