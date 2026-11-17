/** Fixed Node/pnpm payload and native process containment for the local workbench. */
import { readFileSync } from 'node:fs'

function edit(file, replacements) {
  return { file, apply(source) {
    for (const [before, after] of replacements) {
      if (source.includes(after)) {
        if (source.split(after).length !== 2 || source.includes(before)) throw new Error(`Workbench runtime edit is partial or duplicated: ${file}`)
        continue
      }
      if (source.split(before).length !== 2) throw new Error(`Workbench runtime edit anchor missing or duplicated: ${file}`)
      source = source.replace(before, after)
    }
    return source
  } }
}

export const WORKBENCH_RUNTIME_FILES = [
  ['apps/desktop/scripts/prepare-eadp-tools.mjs', 'prepare-eadp-tools.mjs'],
  ['apps/desktop/scripts/prepare-eadp-tools.d.mts', 'prepare-eadp-tools.d.mts'],
  ['apps/desktop/scripts/eadp-runtime.lock.json', 'eadp-runtime.lock.json'],
  ['apps/desktop/scripts/prepare-electron-archive.mjs', 'prepare-electron-archive.mjs'],
  ['apps/desktop/scripts/prepare-electron-archive.d.mts', 'prepare-electron-archive.d.mts'],
  ['apps/desktop/scripts/eadp-electron-archive.lock.json', 'eadp-electron-archive.lock.json'],
].map(([file, source]) => ({ file, source: readFileSync(new URL(source, import.meta.url), 'utf8') }))

export const WORKBENCH_RUNTIME_EDITS = [
  edit('apps/desktop/scripts/prepare-runtime.ts', [
    ["import { prepareCommandLink } from './prepare-command-link.ts'", "import { prepareCommandLink } from './prepare-command-link.ts'\nimport { prepareEadpTools } from './prepare-eadp-tools.mjs'"],
    ["import { downloadArtifact } from '@electron/get'", "import { prepareElectronArchive } from './prepare-electron-archive.mjs'"],
    ["    () => downloadArtifact({ version, platform, arch, artifactName: 'electron', cacheRoot: BUILD_PATHS.downloads }))",
      "    () => prepareElectronArchive({ version, platform, arch, archiveCache: process.env.EADP_ELECTRON_ARCHIVE_CACHE ?? join(BUILD_PATHS.downloads, 'electron-archives') }))"],
    ["  const { pnpm } = await readPrimaryRuntime(join(RUNTIME_ROOT, 'primary-runtime'))", "  await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'prepare:eadp-tools',\n    () => prepareEadpTools(join(RUNTIME_ROOT, 'eadp-tools'), join(BUILD_PATHS.downloads, 'eadp-tools-archives')))\n  const { pnpm } = await readPrimaryRuntime(join(RUNTIME_ROOT, 'primary-runtime'))"],
  ]),
  edit('packages/subprocess/subprocess-local/src/index.ts', [
    ["      if (available) return 'windows-job'\n    }", "      if (available) return 'windows-job'\n      throw new Error('EADP requires native Windows Job process containment; the runner is unavailable')\n    }"],
  ]),
  // The knowledge plugin converts spreadsheets in a shipped Host worker, so the parser patch
  // belongs to the Desktop runtime as well instead of staying a workspace-only build fix.
  edit('apps/desktop/scripts/runtime-patch-policy.ts', [
    ["  'exceljs@4.4.0': { scope: 'workspace-only', reason: 'The patched parser is embedded in the client bundle and worker.' },",
      "  'exceljs@4.4.0': { scope: 'shared', reason: 'The patched parser ships in the knowledge worker as well as the client bundle.' },"],
  ]),
]
