/** EADP Studio client half: registers the full-window Studio main panel. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { StudioPanel } from './StudioPanel.tsx'
import type { ThemeFace } from './theme.ts'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { StudioCommand, StudioReply } from '../shared/studio.ts'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import studioRemote from '@eadp-studio/studio-plugin/remote'

declare module '@deepseek-ai/dsh-client-ui-slots' { interface SlotMap { 'studio.session': { kind: 'single'; scope: 'session' } } }
declare module '@deepseek-ai/dsh-api-session-controller/client' { interface SessionReferenceSourceMap { studio: unknown } }
declare module '@deepseek-ai/dsh-typert-protocol' { interface TypertRemoteNamespaceMap { studio: { command(command: StudioCommand): Promise<RemoteResult<StudioReply>> } } }

/** The layout service and the slot registry are the only services this slice needs. */
export const inject = ['slots', 'layout', 'sessions', 'remote', 'uiSession', 'uiConversation', 'theme']

const PANEL_ID = 'studio' as MainPanelId

/** Mount the Studio panel and make it the selected main panel. */
function registerStudio(ctx: ClientContext): void {
  ctx.slots.inject('main', () => {
    const call = async (command: StudioCommand): Promise<StudioReply> => {
      const result = await ctx.remote.studio.command(command)
      if (!result.ok) return { ok: false, code: result.error.code, message: result.error.message }
      return result.value
    }
    const retainSession = (id: string) => ctx.sessions.retain(id as SessionId, { source: 'studio' })
    const theme: ThemeFace = {
      getSnapshot: () => ctx.theme.getTheme(),
      setPreference: id => ctx.theme.setTheme(id),
      subscribe: listener => ctx.on('theme/change', listener),
    }
    const dispose = ctx.slots.register({ name: 'main', key: PANEL_ID,
      children: { 'studio.session': { kind: 'single', scope: 'session' } },
      inject: () => ({ call, retainSession, theme }),
    }, StudioPanel)
    ctx.layout.selectPanel(PANEL_ID)
    return dispose
  })
}

/** Mount the generated namespace before waiting for the UI's Remote dependency. */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(studioRemote)
  const ui = ctx.inject(['remote.studio'], registerStudio)
  try { await ui } catch (error) { await ui.dispose(); await disposeRemote(); throw error }
  return async () => { await ui.dispose(); await disposeRemote() }
}
