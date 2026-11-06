import type { Context } from '@deepseek-ai/cordis'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { EadpKnowledgeSlotProps } from '@eadp/contracts'
import { EADP_SLOTS } from '@eadp/contracts'
import type {} from '@eadp/contracts/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'

const NS = 'eadp.knowledge'
const zh = { title: '知识库', empty: '暂无知识卡' }
const en = { title: 'Knowledge', empty: 'No knowledge cards yet' }

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'eadp.knowledge': keyof typeof zh }
}

export const inject = ['slots', 'locale']

function EmptyView({ active, t }: EadpKnowledgeSlotProps & PropsLocale<typeof NS>) {
  if (!active) return null
  return <section style={{ padding: '1.5rem', color: 'inherit' }} aria-label={t('title')}>
    <h2>{t('title')}</h2><p>{t('empty')}</p>
  </section>
}

/** Register only through the Shell-owned child slot, independently of load order. */
export function apply(ctx: Context): void {

  ctx.effect(() => ctx.locale.register(NS, { zh, en }))
  ctx.slots.inject(EADP_SLOTS.knowledge, () => ctx.slots.register({
    name: EADP_SLOTS.knowledge, locale: NS,
  }, EmptyView))
}
