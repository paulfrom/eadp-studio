/** Requirement editing is mounted into the Shell-owned slot through generated Remote. */
import type { Context } from '@deepseek-ai/cordis'
import { EADP_SLOTS } from '@eadp/contracts'
import type {} from '@eadp/contracts/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import requirementsRemote from '@eadp/requirements/remote'
import { requirementsApi } from './api.ts'
import { RequirementsClientService } from './service.ts'
import { RequirementsPanel } from './panel.tsx'
import { NS, zh, en } from './locales.ts'

export const inject = ['slots', 'locale', 'remote']

export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(requirementsRemote)
  const editors = new RequirementsClientService(ctx)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }))
  const ui = ctx.inject(['remote.eadpRequirements', 'eadpShellClient'], (scope: Context) => {
    const api = requirementsApi(scope)
    return scope.slots.inject(EADP_SLOTS.requirements, () => scope.slots.register({
      name: EADP_SLOTS.requirements, locale: NS,
      inject: () => ({ api, editors, setActiveDocument: (projectId: string, path: string | null) => scope.eadpShellClient.setActiveDocument(projectId, path) }),
    }, RequirementsPanel))
  })
  return async () => { await ui.dispose(); await disposeRemote() }
}
