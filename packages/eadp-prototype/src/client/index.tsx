import type { Context } from '@deepseek-ai/cordis'
import { EADP_SLOTS } from '@eadp/contracts'
import type {} from '@eadp/contracts/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import prototypeRemote from '@eadp/prototype/remote'
import { prototypeApi } from './api.ts'
import { PrototypeClientService } from './service.ts'
import { PrototypePanel } from './panel.tsx'
import { NS, zh, en } from './locales.ts'

export const inject = ['slots', 'locale', 'remote']

/** Mounts only within the Shell-owned prototype slot. */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(prototypeRemote)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }))
  const ui = ctx.inject(['remote.eadpPrototype'], (scope: Context) => {
    const api = prototypeApi(scope)
    new PrototypeClientService(scope, api)
    return scope.slots.inject(EADP_SLOTS.prototype, () => scope.slots.register({
      name: EADP_SLOTS.prototype, locale: NS, inject: () => ({ api }),
    }, PrototypePanel))
  })
  return async () => { await ui.dispose(); await disposeRemote() }
}
