/** Typed Studio command channel shared by the workbench panel and the settings sections. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { StudioCommand, StudioReply } from '../shared/studio.ts'
import { within } from '../shared/deadline.ts'

/**
 * Longest a surface waits for one command before it reports a failure. The first
 * projection read after the Host starts legitimately takes tens of seconds here
 * (measured: 52s for a cold workbench with a restored session and an opened
 * project), and the Host's own collaboration calls accept up to 60s by default
 * and 180s for the namespace catalogue. Past that ceiling the UI must say the
 * read failed instead of rendering the state it had before the call, which is
 * indistinguishable from being signed out.
 */
const COMMAND_DEADLINE_MS = 180_000

/**
 * Build the shared command channel. Every call is bounded: a Remote namespace
 * that never answers becomes a typed failure the caller can show and retry.
 * @param ctx - Client context that declares `remote.studio`.
 * @returns a function that sends one command and resolves its reply.
 */
export function studioCall(ctx: ClientContext): (command: StudioCommand) => Promise<StudioReply> {
  return async command => {
    const result = await within(ctx.remote.studio.command(command), COMMAND_DEADLINE_MS, '工作台命令在限定时间内没有完成；请重新同步状态。')
    if (!result.ok) return { ok: false, code: result.error.code, message: result.error.message }
    return result.value
  }
}
