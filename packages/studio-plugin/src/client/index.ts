/** EADP Studio client half: registers the full-window Studio main panel. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { StudioPanel } from './StudioPanel.tsx'

/** The layout service and the slot registry are the only services this slice needs. */
export const inject = ['slots', 'layout']

const PANEL_ID = 'studio' as MainPanelId

/** Mount the Studio panel and make it the selected main panel. */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('main', () => {
    const dispose = ctx.slots.register({ name: 'main', key: PANEL_ID }, StudioPanel)
    ctx.layout.selectPanel(PANEL_ID)
    return dispose
  })
}
