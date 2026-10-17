/** Share the official Windows caption with Studio without duplicating native controls. */
const pairs = [
  [
    `  shadow.append(style, bar)
  const mount = (): void => {`,
    `  shadow.append(style, bar)
  // Localized menu text and font/DPI changes determine the actual caption space.
  const measureMenu = (): void => {
    document.documentElement.style.setProperty('--dsh-windows-menu-width', host.getBoundingClientRect().width + 'px')
  }
  const menuSize = new ResizeObserver(measureMenu)
  menuSize.observe(host)
  const mount = (): void => {`,
  ],
  [
    `      observer.disconnect()
      document.removeEventListener('focusout', rememberEditor, true)`,
    `      observer.disconnect()
      menuSize.disconnect()
      document.documentElement.style.removeProperty('--dsh-windows-menu-width')
      document.removeEventListener('focusout', rememberEditor, true)`,
  ],
]

export const STUDIO_TITLEBAR_EDIT = {
  file: 'apps/desktop/src/preload-menu.ts',
  pairs,
  apply(source) {
    let next = source
    for (const [before, after] of pairs) {
      if (next.split(after).length === 2 && !next.includes(before)) continue
      if (next.includes(after) || next.split(before).length !== 2) throw new Error('Studio titlebar edit anchor missing or duplicated')
      next = next.replace(before, after)
    }
    return next
  },
}
