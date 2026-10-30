/** EADP Studio client half: the full-window main panel, its sidebar return row, and the settings sections inside the host settings dialog. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the `settings.section` / `sidebar.panellist` slot declarations
// and the ctx.uiWorkspace merge into this program.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { studioCall, studioProgressCall } from './command.ts'
import { StudioPanel } from './studio/StudioPanel.tsx'
import { StudioPanelIcon } from './panelIcon.tsx'
import { MaterialAttachmentButton } from './components/MaterialAttachments.tsx'
import { MaterialDecisionQuestionDock } from './components/MaterialDecisionQuestions.tsx'
import { settingsSections, type StudioSettingsFaces } from './settings/sections.tsx'
import { createStudioSession, type StudioSession } from './session.ts'
import type { ThemeFace } from './theme.ts'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ProjectProgressReply, StudioCommand, StudioReply } from '../shared/studio.ts'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import studioRemote from '@eadp-studio/studio-plugin/remote'

declare module '@deepseek-ai/dsh-client-ui-slots' { interface SlotMap { 'studio.session': { kind: 'single'; scope: 'session' } } }
declare module '@deepseek-ai/dsh-api-session-controller/client' { interface SessionReferenceSourceMap { studio: unknown } }
declare module '@deepseek-ai/dsh-typert-protocol' { interface TypertRemoteNamespaceMap { studio: { command(command: StudioCommand): Promise<RemoteResult<StudioReply>>; progress(): Promise<RemoteResult<ProjectProgressReply>> } } }

/** The layout service, the slot registry, the native session navigator and the theme are the services this slice needs. */
export const inject = ['slots', 'layout', 'sessions', 'remote', 'theme', 'uiWorkspace']

const PANEL_ID = 'studio' as MainPanelId

function themeFace(ctx: ClientContext): ThemeFace {
  return {
    getSnapshot: () => ctx.theme.getTheme(),
    setPreference: id => ctx.theme.setTheme(id),
    subscribe: listener => ctx.on('theme/change', listener),
  }
}

/** Open the host settings dialog (bridged by the product settings edit; a no-op where it is absent). */
function openSettings(section?: string): void {
  window.dispatchEvent(new CustomEvent('eadp:open-settings', { detail: section ? { section } : {} }))
}

/**
 * Studio sections inside the host settings dialog — the single settings surface
 * (design 00, 2026-10-20 revision). Every registration declares the same pinned
 * store handle the workbench panel uses, so both surfaces read one projection.
 */
function registerSettingsSections(ctx: ClientContext, session: StudioSession, theme: ThemeFace): void {
  const faces: StudioSettingsFaces = { login: session.login, logout: session.logout, sync: session.sync, run: session.run, theme, pickDirectory: () => ctx.uiWorkspace.pickDirectory() }
  for (const section of settingsSections) {
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: section.id,
      order: section.order,
      label: section.label,
      store: session.store,
      inject: () => faces,
    }, section.component))
  }
}

/** The native sidebar's global panel row: the way back to the workbench from the host UI. */
function registerPanelRow(ctx: ClientContext): void {
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 0,
    label: 'EADP Studio',
  }, StudioPanelIcon))
}

/** Mount the Studio panel and make it the selected main panel. */
function registerStudio(ctx: ClientContext, session: StudioSession, theme: ThemeFace): () => void {
  const retainSession = (id: string) => ctx.sessions.retain(id as SessionId, { source: 'studio' })
  const startSession = () => ctx.uiWorkspace.startSession()
  const dispose = ctx.slots.register({ name: 'main', key: PANEL_ID,
    store: session.store,
    children: { 'studio.session': { kind: 'single', scope: 'session' } },
    inject: () => ({ run: session.run, sync: session.sync, progress: session.progress, retainSession, openSettings, startSession, theme, pickDirectory: () => ctx.uiWorkspace.pickDirectory() }),
  }, StudioPanel)
  ctx.layout.selectPanel(PANEL_ID)
  return dispose
}

/** Mount the generated namespace before waiting for the UI's Remote dependency. */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(studioRemote)
  registerPanelRow(ctx)
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left', id: 'studio-material-attachments', order: 0,
  }, MaterialAttachmentButton))
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'studio-material-question-answer', order: 10,
  }, MaterialDecisionQuestionDock))
  // `remote.studio` is only addressable inside a fiber that declares it, so the
  // command channel and the one projection session both belong to that fiber.
  const ui = ctx.inject(['remote.studio'], (injected: ClientContext) => {
    const session = createStudioSession(studioCall(injected), studioProgressCall(injected))
    const theme = themeFace(injected)
    registerSettingsSections(injected, session, theme)
    return registerStudio(injected, session, theme)
  })
  try { await ui } catch (error) { await ui.dispose(); await disposeRemote(); throw error }
  return async () => { await ui.dispose(); await disposeRemote() }
}
