/** Studio sections inside the host settings dialog get real nav glyphs; replay only into the disposable fixed DSH tree. */

const pairs = [
  [
    `  IconPersonalizationOutlineMedium, IconSettingsOutlineMedium, IconUserOutlineMedium,
} from '@deepseek-ai/dsh-client-ui-primitives'`,
    `  IconInfoOutlineMedium, IconPersonalizationOutlineMedium, IconRefreshOutlineMedium, IconSettingsOutlineMedium, IconUserOutlineMedium,
} from '@deepseek-ai/dsh-client-ui-primitives'`,
  ],
  [
    `function navIcon(id: string) {
  if (id === 'account') return <IconUserOutlineMedium className={css.navIcon} size={16} />`,
    `function navIcon(id: string) {
  // Product bridge: the Studio plugin registers its sections (collab account,
  // appearance, connection, about) into settings.section; map them to real
  // glyphs instead of the gear fallback.
  if (id === 'studio-collab') return <IconUserOutlineMedium className={css.navIcon} size={16} />
  if (id === 'studio-appearance') return <IconPersonalizationOutlineMedium className={css.navIcon} size={16} />
  if (id === 'studio-connection') return <IconRefreshOutlineMedium className={css.navIcon} size={16} />
  if (id === 'studio-about') return <IconInfoOutlineMedium className={css.navIcon} size={16} />
  if (id === 'account') return <IconUserOutlineMedium className={css.navIcon} size={16} />`,
  ],
]

/** Map Studio settings-section ids to host nav glyphs; replay idempotently. */
export const STUDIO_SETTINGS_SECTIONS_EDIT = {
  file: 'packages/client/ui-settings-general/src/client/SettingsRoot.tsx',
  pairs,
  apply(source) {
    for (const [before, after] of pairs) {
      if (source.includes(after)) continue
      if (source.split(before).length !== 2) throw new Error('Studio settings sections edit anchor missing or duplicated')
      source = source.replace(before, after)
    }
    return source
  },
}
