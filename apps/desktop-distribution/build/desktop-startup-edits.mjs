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

const welcomeBefore = `        welcomeBackend = await connectDesktopWelcome(ready.url, (input, init) => net.fetch(input, init), async () => (await session.defaultSession.cookies.get({ url: ready.url })).map(cookie => \`\${cookie.name}=\${cookie.value}\`).join('; '))`
const welcomeAfter = `        // Native welcome and account requests share the already authenticated Host cookie.
        const welcomeCookie = hostCookie
        const welcomeUrl = new URL(ready.url)
        welcomeUrl.search = ''
        welcomeBackend = await connectDesktopWelcome(welcomeUrl.href, (input, init) => {
          if (new URL(input).origin !== welcomeUrl.origin) throw new Error('Desktop welcome request origin changed')
          const headers = new Headers(init?.headers)
          headers.set('cookie', welcomeCookie)
          return fetch(input, { ...init, headers, redirect: 'error' })
        }, async () => welcomeCookie)`

/** Apply each exact anchor once; reject missing, duplicated or mixed source. */
function replaceAnchor(source, before, after) {
  if (source.includes(after)) {
    if (source.split(after).length !== 2 || source.includes(before)) throw new Error('Desktop startup edit anchor duplicated')
    return source
  }
  if (source.split(before).length !== 2) throw new Error('Desktop startup edit anchor missing or duplicated')
  return source.replace(before, after)
}

/** Replay only this product startup edit, including when other main.ts edits are present. */
export const DESKTOP_STARTUP_EDIT = {
  file: 'apps/desktop/src/main.ts',
  apply(source) {
    source = replaceAnchor(source, before, after)
    source = replaceAnchor(source, welcomeBefore, welcomeAfter)
    return replaceAnchor(source, '  nativeTheme,\n  net,\n  protocol,', '  nativeTheme,\n  protocol,')
  },
}
