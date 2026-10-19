/** Open the shared settings dialog from a product main panel; replay only into the disposable fixed DSH tree. */

const pairs = [
  [
    `  ctx.slots.inject('sidebar.settings', () => {
    const shellHandle = createSettingsShellStore()
    const shellInstance = shellHandle.create()`,
    `  // Product bridge: the settings dialog state lives at plugin-activation scope
  // so a fullscreen main panel can open it while the shell sidebar (and this
  // slot) is unmounted. Like the keyboard shortcut, the event only flips the
  // local dialog state; untrusted content cannot reach past that.
  const shellHandle = createSettingsShellStore()
  const shellInstance = shellHandle.create()
  const openFromEvent = (event: Event): void => {
    const section = (event as CustomEvent<{ section?: unknown }>).detail?.section
    if (typeof section === 'string' && section) shellInstance.actions.openSection(section)
    else shellInstance.actions.open()
  }
  window.addEventListener('eadp:open-settings', openFromEvent)
  ctx.slots.inject('sidebar.settings', () => {`,
  ],
]

/** Wire the `eadp:open-settings` CustomEvent to the settings shell store; replay idempotently. */
export const STUDIO_SETTINGS_BRIDGE_EDIT = {
  file: 'packages/client/ui-settings-general/src/client/index.ts',
  pairs,
  apply(source) {
    for (const [before, after] of pairs) {
      if (source.includes(after)) continue
      if (source.split(before).length !== 2) throw new Error('Studio settings bridge edit anchor missing or duplicated')
      source = source.replace(before, after)
    }
    return source
  },
}
