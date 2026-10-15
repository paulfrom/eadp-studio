import { readFileSync } from 'node:fs'
export const STUDIO_BROWSER_FILE = { file: 'apps/desktop/src/studio-browser-check.ts', source: readFileSync(new URL('studio-browser-check.ts', import.meta.url), 'utf8') }
export const STUDIO_BROWSER_EDIT = {
  file: 'apps/desktop/src/host-process.ts',
  apply(source) {
    if (source.includes('handleStudioPreviewCheck(child, message)')) return source
    const marker = "import { desktopNodeEnvironment } from './node-environment.ts'"
    const listener = "    child.on('message', (message: unknown) => {"
    if (source.split(marker).length !== 2 || source.split(listener).length !== 2) throw new Error('Studio browser check anchor changed')
    return source.replace(marker, `${marker}\nimport { handleStudioPreviewCheck, isStudioPreviewCheck } from './studio-browser-check.ts'`).replace(listener, `${listener}\n      if (isStudioPreviewCheck(message)) { void handleStudioPreviewCheck(child, message); return }`)
  },
}
