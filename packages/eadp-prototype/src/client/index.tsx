import type { Context } from '@deepseek-ai/cordis'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { EadpPrototypeSlotProps } from '@eadp/contracts'
import { EADP_SLOTS } from '@eadp/contracts'
import type {} from '@eadp/contracts/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'

const NS = 'eadp.prototype'
const zh = { title: '原型', empty: '尚未创建原型工程' }
const en = { title: 'Prototype', empty: 'No prototype project yet' }

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'eadp.prototype': keyof typeof zh }
}

export const inject = ['slots', 'locale']

function EmptyView({ active, t }: EadpPrototypeSlotProps & PropsLocale<typeof NS>) {
  if (!active) return null
  return <section style={{ padding: '1.5rem', color: 'inherit' }} aria-label={t('title')}>
    <h2>{t('title')}</h2><p>{t('empty')}</p>
  </section>
}

/** Register only through the Shell-owned child slot, independently of load order. */
export function apply(ctx: Context): void {

  ctx.effect(() => ctx.locale.register(NS, { zh, en }))
  ctx.slots.inject(EADP_SLOTS.prototype, () => ctx.slots.register({
    name: EADP_SLOTS.prototype, locale: NS,
  }, EmptyView))
}
