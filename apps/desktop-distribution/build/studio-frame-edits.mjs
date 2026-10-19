/** Studio owns the whole frame: the shell sidebar column collapses to zero width while its main panel is active. */

const pairs = [
  [
    `  const narrow = viewport < SIDEBAR_AUTO_COLLAPSE
  const sidebarCollapsed = narrow ? !layoutInfo.narrowExpanded : layoutInfo.sidebar === 0`,
    `  const narrow = viewport < SIDEBAR_AUTO_COLLAPSE
  const activePanelId = usePanelInfo(info => info.activePanelId)
  // Studio ships its own navigation column; the shell sidebar collapses while it is active.
  const sidebarCollapsed = activePanelId === 'studio' || (narrow ? !layoutInfo.narrowExpanded : layoutInfo.sidebar === 0)`,
  ],
  [
    `  const collapsedWidth = darwin
    || document.documentElement.hasAttribute('data-windows-titlebar') ? 0 : SIDEBAR_COLLAPSED`,
    `  const collapsedWidth = activePanelId === 'studio'
    || darwin
    || document.documentElement.hasAttribute('data-windows-titlebar') ? 0 : SIDEBAR_COLLAPSED`,
  ],
]

/**
 * Collapse the shell sidebar while the Studio main panel is active. The sidebar
 * stays mounted at zero width (clipped by its column) so slots rendered inside
 * it — chiefly the shared settings dialog — can still open while Studio owns
 * the frame; replay idempotently.
 */
export const STUDIO_FRAME_EDIT = {
  file: 'packages/client/ui-layout/src/client/AppFrame.tsx',
  pairs,
  apply(source) {
    for (const [before, after] of pairs) {
      if (source.includes(after)) continue
      if (source.split(before).length !== 2) throw new Error('Studio frame edit anchor missing or duplicated')
      source = source.replace(before, after)
    }
    return source
  },
}

const sidebarPairs = [
  [
    `:global(html[data-windows-titlebar]:has([data-sidebar-collapsed='true'])) {
  --dsh-windows-menu-start: 84px;
}`,
    `:global(html[data-windows-titlebar]:has([data-sidebar-collapsed='true'])) {
  --dsh-windows-menu-start: 84px;
}

/* Studio owns the frame with its own caption controls; the zero-width shell
   sidebar stays mounted so its settings dialog remains openable, but its fixed
   caption toggle must not draw over the Studio one. */
:global([data-windows-titlebar]:has([data-studio-panel='studio'])) .toggle {
  display: none;
}`,
  ],
]

/** Hide the shell sidebar's fixed caption toggle while the Studio panel is active; replay idempotently. */
export const STUDIO_SIDEBAR_CSS_EDIT = {
  file: 'packages/client/ui-sidebar/src/client/SidebarRoot.module.css',
  pairs: sidebarPairs,
  apply(source) {
    for (const [before, after] of sidebarPairs) {
      if (source.includes(after)) continue
      if (source.split(before).length !== 2) throw new Error('Studio sidebar CSS edit anchor missing or duplicated')
      source = source.replace(before, after)
    }
    return source
  },
}
