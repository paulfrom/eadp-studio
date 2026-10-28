import { readFileSync } from 'node:fs'
export const STUDIO_BROWSER_FILE = { file: 'apps/desktop/src/studio-browser-check.ts', source: readFileSync(new URL('studio-browser-check.ts', import.meta.url), 'utf8') }
export const STUDIO_PROTOTYPE_VIEW_FILE = { file: 'apps/desktop/src/studio-prototype-view.ts', source: readFileSync(new URL('studio-prototype-view.ts', import.meta.url), 'utf8') }
export const STUDIO_PROTOTYPE_BRIDGE_FILE = { file: 'apps/desktop/src/studio-prototype-bridge.ts', source: readFileSync(new URL('studio-prototype-bridge.ts', import.meta.url), 'utf8') }
export const STUDIO_BROWSER_EDIT = {
  file: 'apps/desktop/src/host-process.ts',
  apply(source) {
    const marker = "import { desktopNodeEnvironment } from './node-environment.ts'"
    const listener = "    child.on('message', (message: unknown) => {"
    if (source.split(marker).length !== 2 || source.split(listener).length !== 2) throw new Error('Studio browser check anchor changed')
    if (!source.includes("import { handleStudioPreviewCheck, isStudioPreviewCheck } from './studio-browser-check.ts'")) source = source.replace(marker, `${marker}\nimport { handleStudioPreviewCheck, isStudioPreviewCheck } from './studio-browser-check.ts'`)
    if (!source.includes("import { studioPrototypeBridge } from './studio-prototype-bridge.ts'")) source = source.replace(marker, `${marker}\nimport { studioPrototypeBridge } from './studio-prototype-bridge.ts'`)
    if (!source.includes('handleStudioPreviewCheck(child, message)')) source = source.replace(listener, `${listener}\n      if (isStudioPreviewCheck(message)) { void handleStudioPreviewCheck(child, message); return }`)
    if (!source.includes('studioPrototypeBridge.handle(child, message)')) source = source.replace(listener, `${listener}\n      if (studioPrototypeBridge.isRequest(message)) { studioPrototypeBridge.handle(child, message); return }`)
    return source
  },
}

const replaceOnce = (source, before, after) => {
  if (source.includes(after)) return source
  if (source.split(before).length !== 2) throw new Error('Studio prototype view anchor changed')
  return source.replace(before, after)
}
export const STUDIO_PROTOTYPE_MAIN_EDIT = {
  file: 'apps/desktop/src/main.ts',
  apply(source) {
    source = replaceOnce(source, "import { DesktopPlatformView, PLATFORM_IPC, platformBounds } from './platform-view.ts'", "import { DesktopPlatformView, PLATFORM_IPC, platformBounds } from './platform-view.ts'\nimport { STUDIO_PROTOTYPE_LAYOUT, studioPrototypeBridge } from './studio-prototype-bridge.ts'")
    source = replaceOnce(source, "  ipcMain.on(PLATFORM_IPC.bootstrap, (event) => {", "  ipcMain.handle(STUDIO_PROTOTYPE_LAYOUT, (event, layout: unknown) => studioPrototypeBridge.layout(assertMainApplication(event), layout))\n  ipcMain.on(PLATFORM_IPC.bootstrap, (event) => {")
    source = replaceOnce(source, '      platformView.dispose().catch((error: unknown) => { console.error(error) })])', '      platformView.dispose().catch((error: unknown) => { console.error(error) }),\n      studioPrototypeBridge.dispose().catch((error: unknown) => { console.error(error) })])')
    source = replaceOnce(source, '      void platformView.dispose().catch((error: unknown) => { console.error(error) })\n      return', '      void platformView.dispose().catch((error: unknown) => { console.error(error) })\n      void studioPrototypeBridge.dispose().catch((error: unknown) => { console.error(error) })\n      return')
    return source
  },
}
export const STUDIO_PROTOTYPE_PRELOAD_EDIT = {
  file: 'apps/desktop/src/preload-app.ts',
  apply(source) {
    const before = "  contextBridge.exposeInMainWorld('dshPlatform', {"
    const after = "  if (process.isMainFrame) contextBridge.exposeInMainWorld('studioPrototypeCanvas', {\n    layout: (request: unknown) => ipcRenderer.invoke('studio-prototype:layout', request),\n  })\n  contextBridge.exposeInMainWorld('dshPlatform', {"
    return replaceOnce(source, before, after)
  },
}
