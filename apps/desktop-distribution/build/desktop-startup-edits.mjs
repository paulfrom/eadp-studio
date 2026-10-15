/** Studio owns the product's first window; account setup remains an explicit action. */

const before = `  const openInitialWindow = async (): Promise<void> => {
    if (quitting || recovery.active) return
    const state = await readWelcomeState()
    if (isQuitting() || backend.state.phase !== 'ready') return
    locale = resolveDesktopStartupLocale(state.localePreference, systemLanguages)
    windowsLanguage = locale.id
    refreshApplicationMenu()
    if (!enteredWorkspace && needsWelcome({ loggedIn: state.loggedIn, hasApiKey: state.hasApiKey })) {
      // A later login must retain its own activation policy instead of replaying startup focus.
      raiseAfterUpdate = false
      await showWelcome()
    } else {
      await enterWorkspace()
    }
  }`

const after = `  const openInitialWindow = async (): Promise<void> => {
    if (quitting || recovery.active) return
    const state = await readWelcomeState()
    if (isQuitting() || backend.state.phase !== 'ready') return
    locale = resolveDesktopStartupLocale(state.localePreference, systemLanguages)
    windowsLanguage = locale.id
    refreshApplicationMenu()
    await enterWorkspace()
  }`

/** Replay only this product startup edit, including when other main.ts edits are present. */
export const DESKTOP_STARTUP_EDIT = {
  file: 'apps/desktop/src/main.ts',
  apply(source) {
    if (source.includes(after)) {
      if (source.split(after).length !== 2 || source.includes(before)) {
        throw new Error('Desktop startup edit anchor duplicated')
      }
      return source
    }
    if (source.split(before).length !== 2) throw new Error('Desktop startup edit anchor missing or duplicated')
    return source.replace(before, after)
  },
}
