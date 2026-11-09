import type { Context } from '@deepseek-ai/cordis'
import { EADP_SLOTS } from '@eadp/contracts'
import type { EadpRequirementsClient } from '@eadp/contracts'
import type {} from '@eadp/contracts/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import knowledgeRemote from '@eadp/knowledge/remote'
import { knowledgeApi } from './api.ts'
import { KnowledgePanel } from './panel.tsx'
import { NS, zh, en } from './locales.ts'
export const inject = ['slots', 'locale', 'remote']
/** Registers the knowledge view within the Shell-owned slot. */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(knowledgeRemote)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }))
  /* The adoption entry belongs to the requirement conversation; only its call crosses packages. */
  const ui = ctx.inject(['remote.eadpKnowledge', 'eadpRequirementsClient'], (scope: Context) =>
    scope.slots.inject(EADP_SLOTS.knowledge, () =>
      scope.slots.register(
        {
          name: EADP_SLOTS.knowledge,
          locale: NS,
          inject: () => ({
            api: knowledgeApi(scope),
            adoptKnowledge: (input: Parameters<EadpRequirementsClient['adoptKnowledge']>[0]) => scope.eadpRequirementsClient.adoptKnowledge(input),
          }),
        },
        KnowledgePanel,
      ),
    ),
  )
  return async () => {
    await ui.dispose()
    await disposeRemote()
  }
}
