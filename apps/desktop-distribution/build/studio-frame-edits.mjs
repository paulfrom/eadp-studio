/** Studio owns the whole frame; the shell sidebar column closes while its main panel is active. */

const pairs = [
  [
    `  const narrow = viewport < SIDEBAR_AUTO_COLLAPSE
  const sidebarCollapsed = narrow ? !layoutInfo.narrowExpanded : layoutInfo.sidebar === 0`,
    `  const narrow = viewport < SIDEBAR_AUTO_COLLAPSE
  const activePanelId = usePanelInfo(info => info.activePanelId)
  // Studio ships its own navigation column; the shell sidebar closes while it is active.
  const sidebarCollapsed = activePanelId === 'studio' || (narrow ? !layoutInfo.narrowExpanded : layoutInfo.sidebar === 0)`,
  ],
  [
    `  const collapsedWidth = darwin
    || document.documentElement.hasAttribute('data-windows-titlebar') ? 0 : SIDEBAR_COLLAPSED`,
    `  const collapsedWidth = activePanelId === 'studio'
    || darwin
    || document.documentElement.hasAttribute('data-windows-titlebar') ? 0 : SIDEBAR_COLLAPSED`,
  ],
  [
    `      <div className={css.sidebarCol}>
        {sidebar}
      </div>`,
    `      <div className={css.sidebarCol}>
        {activePanelId !== 'studio' && sidebar}
      </div>`,
  ],
]

/** Hide the shell sidebar while the Studio main panel is active; replay idempotently. */
export const STUDIO_FRAME_EDIT = {
  file: 'packages/client/ui-layout/src/client/AppFrame.tsx',
  pairs,
  apply(source) {
    if (pairs.every(([, after]) => source.includes(after))) {
      if (pairs.some(([before, after]) => source.includes(before) || source.split(after).length !== 2)) {
        throw new Error('Studio frame edit anchor duplicated')
      }
      return source
    }
    let next = source
    for (const [before, after] of pairs) {
      if (next.split(before).length !== 2) throw new Error('Studio frame edit anchor missing or duplicated')
      next = next.replace(before, after)
    }
    return next
  },
}
