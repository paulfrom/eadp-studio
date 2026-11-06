import { Service, type Context } from '@deepseek-ai/cordis'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { EadpRequirementsSlotProps, EadpRequirementsClient } from '@eadp/contracts'
import { EADP_SLOTS } from '@eadp/contracts'
import type {} from '@eadp/contracts/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'

const NS = 'eadp.requirements'
const zh = { title: '需求', empty: '暂无需求文件' }
const en = { title: 'Requirements', empty: 'No requirement files yet' }

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'eadp.requirements': keyof typeof zh }
}

export const inject = ['slots', 'locale']

/** Empty editor lifecycle before requirement editing is installed. */
class RequirementsClientService extends Service implements EadpRequirementsClient {
  constructor(ctx: Context) { super(ctx, 'eadpRequirementsClient') }
  async flushActive(): Promise<{ ok: boolean; message?: string }> { return { ok: true } }
  hasUnsaved(): boolean { return false }
}

function EmptyView({ active, t }: EadpRequirementsSlotProps & PropsLocale<typeof NS>) {
  if (!active) return null
  return <section style={{ padding: '1.5rem', color: 'inherit' }} aria-label={t('title')}>
    <h2>{t('title')}</h2><p>{t('empty')}</p>
  </section>
}

/** Register only through the Shell-owned child slot, independently of load order. */
export function apply(ctx: Context): void {
  ctx.plugin(RequirementsClientService)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }))
  ctx.slots.inject(EADP_SLOTS.requirements, () => ctx.slots.register({
    name: EADP_SLOTS.requirements, locale: NS,
  }, EmptyView))
}
