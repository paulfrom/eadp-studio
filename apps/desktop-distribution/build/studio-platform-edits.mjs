/** Exact-anchor product edits and additions; replay only into the disposable fixed DSH tree. */
import { readFileSync } from 'node:fs'

function edit(file, replacements) {
  return { file, apply(source) {
    // Replace the obsolete product-generated call when replaying into an
    // existing disposable build tree; the maintained source has one cache path.
    if (file === 'apps/desktop/scripts/prepare-runtime.ts') source = source.replace(
      "() => prepareStudioTools(join(RUNTIME_ROOT, 'studio-tools')))",
      "() => prepareStudioTools(join(RUNTIME_ROOT, 'studio-tools'), join(BUILD_PATHS.downloads, 'studio-tools-archives')))",
    )
    for (const [before, after] of replacements) {
      if (source.includes(after)) continue
      // The product browser-check patch can already have inserted another
      // IPC handler before the same validation anchor in a staged DSH tree.
      // Treat the unique Studio secret handler as applied in that ordering too.
      if (file === 'apps/desktop/src/host-process.ts'
        && ((after.includes('handleStudioSecretRequest(child, message)')
          && source.includes('handleStudioSecretRequest(child, message)'))
          || (after.includes('isStudioSecretRequest }')
            && source.includes("import { handleStudioSecretRequest, isStudioSecretRequest } from './studio-secret-store.ts'")))) continue
      if (source.split(before).length !== 2) throw new Error(`Studio platform edit anchor missing or duplicated: ${file}`)
      source = source.replace(before, after)
    }
    if (file === 'apps/desktop/src/host-process.ts') {
      const secretImport = "import { handleStudioSecretRequest, isStudioSecretRequest } from './studio-secret-store.ts'"
      const first = source.indexOf(secretImport)
      let duplicate = source.indexOf(secretImport, first + secretImport.length)
      while (first >= 0 && duplicate >= 0) {
        source = `${source.slice(0, duplicate)}${source.slice(duplicate + secretImport.length)}`
        duplicate = source.indexOf(secretImport, first + secretImport.length)
      }
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
    ["  const { pnpm } = await readPrimaryRuntime(join(RUNTIME_ROOT, 'primary-runtime'))", "  await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'prepare:studio-tools',\n    () => prepareStudioTools(join(RUNTIME_ROOT, 'studio-tools'), join(BUILD_PATHS.downloads, 'studio-tools-archives')))\n  const { pnpm } = await readPrimaryRuntime(join(RUNTIME_ROOT, 'primary-runtime'))"],
  ]),
  edit('packages/subprocess/subprocess-local/src/index.ts', [
    ["      if (available) return 'windows-job'\n    }", "      if (available) return 'windows-job'\n      throw new Error('Studio requires native Windows Job process containment; the runner is unavailable')\n    }"],
  ]),
]
