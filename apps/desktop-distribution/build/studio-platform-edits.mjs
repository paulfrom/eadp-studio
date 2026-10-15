/** Exact-anchor product edits and additions; replay only into the disposable fixed DSH tree. */
import { readFileSync } from 'node:fs'

function edit(file, replacements) {
  return { file, apply(source) {
    for (const [before, after] of replacements) {
      if (source.includes(after)) continue
      if (source.split(before).length !== 2) throw new Error(`Studio platform edit anchor missing or duplicated: ${file}`)
      source = source.replace(before, after)
    }
    return source
  } }
}
export const STUDIO_PLATFORM_FILES = [
  ['apps/desktop/src/studio-secret-store.ts', 'studio-secret-store.ts'],
  ['apps/desktop/scripts/prepare-studio-tools.mjs', 'prepare-studio-tools.mjs'],
  ['apps/desktop/scripts/prepare-studio-tools.d.mts', 'prepare-studio-tools.d.mts'],
  ['apps/desktop/scripts/studio-runtime.lock.json', 'studio-runtime.lock.json'],
].map(([file, source]) => ({ file, source: readFileSync(new URL(source, import.meta.url), 'utf8') }))

export const STUDIO_PLATFORM_EDITS = [
  edit('apps/desktop/src/host-process.ts', [
    ["import { desktopNodeEnvironment } from './node-environment.ts'", "import { desktopNodeEnvironment } from './node-environment.ts'\nimport { handleStudioSecretRequest, isStudioSecretRequest } from './studio-secret-store.ts'"],
    ["    child.on('message', (message: unknown) => {\n      if (!isDesktopHostEvent(message))", "    child.on('message', (message: unknown) => {\n      if (isStudioSecretRequest(message)) { void handleStudioSecretRequest(child, message); return }\n      if (!isDesktopHostEvent(message))"],
  ]),
  edit('apps/desktop/scripts/prepare-runtime.ts', [
    ["import { prepareCommandLink } from './prepare-command-link.ts'", "import { prepareCommandLink } from './prepare-command-link.ts'\nimport { prepareStudioTools } from './prepare-studio-tools.mjs'"],
    ["  const { pnpm } = await readPrimaryRuntime(join(RUNTIME_ROOT, 'primary-runtime'))", "  await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'prepare:studio-tools',\n    () => prepareStudioTools(join(RUNTIME_ROOT, 'studio-tools')))\n  const { pnpm } = await readPrimaryRuntime(join(RUNTIME_ROOT, 'primary-runtime'))"],
  ]),
  edit('packages/subprocess/subprocess-local/src/index.ts', [
    ["      if (available) return 'windows-job'\n    }", "      if (available) return 'windows-job'\n      throw new Error('Studio requires native Windows Job process containment; the runner is unavailable')\n    }"],
  ]),
]
