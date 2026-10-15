/**
 * Assemble the Studio plugin into a DSH build tree and build its two halves.
 *
 * The product workspace cannot build the plugin client bundle on its own: the
 * upstream `packages/client/tsdown.client.ts` preset imports modules that only
 * exist inside the fixed DSH source tree. This script therefore copies the
 * verified source into an ignored build tree, places the plugin at the fixed
 * location the preset expects, injects the upstream workspace dependencies,
 * and runs the upstream build faces. It never writes to the verified source
 * tree in `.local/upstream/dsh`.
 *
 * Usage: node apps/desktop-distribution/build/prepare-studio-plugin.mjs
 */
import { spawnSync } from 'node:child_process'
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runPnpm } from './run-pnpm.mjs'
import { DESKTOP_POLICY_EDITS } from './desktop-policy-edits.mjs'
import { DESKTOP_STARTUP_EDIT } from './desktop-startup-edits.mjs'
import { DESKTOP_PLUGIN_EDIT, STUDIO_PACKAGE } from './desktop-plugin-edits.mjs'
import { STUDIO_PLATFORM_EDITS, STUDIO_PLATFORM_FILES } from './studio-platform-edits.mjs'
import { STUDIO_BROWSER_EDIT, STUDIO_BROWSER_FILE } from './studio-browser-edits.mjs'
import { productionPluginManifest, recordStudioBuild, verifyStudioPlugin } from './studio-payload.mjs'
import { STUDIO_PACKAGING_EDIT } from './studio-packaging-edits.mjs'
import { STUDIO_TYPERT_EDIT } from './studio-typert-edits.mjs'
import { STUDIO_TEMPLATE_EDIT, STUDIO_TEMPLATE_FILES } from './studio-template-edits.mjs'

const repo = fileURLToPath(new URL('../../../', import.meta.url))
// .local/ is machine-local scratch under the primary checkout; every linked
// worktree shares it instead of downloading the same fixed source again.
const commonDirectory = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
  cwd: repo, encoding: 'utf8',
})
if (commonDirectory.status !== 0) throw new Error('Cannot resolve the Git common directory.')
const sharedRoot = path.dirname(commonDirectory.stdout.trim())
const upstreamSource = path.join(sharedRoot, '.local/upstream/dsh')
const buildTree = path.join(sharedRoot, '.local/build/dsh')
const productPlugin = path.join(repo, 'packages/studio-plugin')
const assembledPlugin = path.join(buildTree, 'packages/eadp/studio-plugin')
const assembledContracts = path.join(buildTree, 'packages/eadp/contracts')
const packedPluginDirectory = path.join(sharedRoot, '.local/build/packed-studio')

/**
 * Upstream edits the product needs for a built-in plugin. Each is anchored on
 * exact source text and re-applied idempotently; a missing anchor is an error
 * so upstream drift cannot silently drop the product integration.
 */
const UPSTREAM_EDITS = [
  ...DESKTOP_POLICY_EDITS,
  DESKTOP_STARTUP_EDIT,
  DESKTOP_PLUGIN_EDIT,
  ...STUDIO_PLATFORM_EDITS,
  STUDIO_BROWSER_EDIT,
  STUDIO_PACKAGING_EDIT,
  STUDIO_TYPERT_EDIT,
  STUDIO_TEMPLATE_EDIT,
  {
    file: 'apps/desktop/scripts/prepare-package-set.ts',
    apply: (source) => {
      if (source.includes('const extraInputs =')) return source
      let next = source.replace(
        "import { basename, join, resolve } from 'node:path'",
        "import { basename, delimiter, join, resolve } from 'node:path'",
      )
      next = next.replace(
        'const inputs = (values.from ?? defaultInputs).map(path => resolve(REPOSITORY_ROOT, path))',
        "const extraInputs = (process.env.DSH_DESKTOP_PACKED_EXTRA ?? '').split(delimiter).filter(Boolean)\n"
        + '  const inputs = (values.from ?? [...defaultInputs, ...extraInputs]).map(path => resolve(REPOSITORY_ROOT, path))',
      )
      return next
    },
  },
  {
    file: 'apps/desktop/src/project-manager.ts',
    apply: (source) => {
      if (source.includes('STUDIO_BUNDLE')) return source
      return source.replace(
        'const WEB_PROFILE = PROFILE_TEMPLATES.web as ProfileTemplate',
        'const SHIPPED_PROFILE = PROFILE_TEMPLATES.web as ProfileTemplate\n'
        + `const STUDIO_BUNDLE = '${STUDIO_PACKAGE}'\n`
        + '/** Shipped bundles plus the product plugin, which needs no user action to load. */\n'
        + 'const WEB_PROFILE: ProfileTemplate = {\n'
        + '  ...SHIPPED_PROFILE,\n'
        + '  bundles: [...SHIPPED_PROFILE.bundles, STUDIO_BUNDLE],\n'
        + '}',
      )
    },
  },
]

/** Upstream workspace packages the assembled plugin needs to compile and bundle. */
const WORKSPACE_DEPENDENCIES = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-layout',
  '@deepseek-ai/dsh-client-ui-renderer',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-session',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-api-gateway',
  '@deepseek-ai/dsh-api-session-controller',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-subprocess',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-typert-protocol',
]

const exists = async (target) => stat(target).then(() => true, (error) => {
  if (error.code === 'ENOENT') return false
  throw error
})

async function copyVerifiedSource() {
  if (await exists(buildTree)) {
    console.log(`Build tree present: ${path.relative(repo, buildTree)}`)
    return
  }
  if (!(await exists(upstreamSource))) {
    throw new Error('Verified DSH source is missing; run node scripts/fetch-dsh.mjs first.')
  }
  console.log(`Creating build tree from verified source: ${path.relative(repo, buildTree)}`)
  await mkdir(path.dirname(buildTree), { recursive: true })
  await cp(upstreamSource, buildTree, {
    recursive: true,
    filter: (source) => !source.split(path.sep).includes('node_modules'),
  })
}

async function placePlugin() {
  await rm(assembledPlugin, { recursive: true, force: true })
  await mkdir(assembledPlugin, { recursive: true })
  await cp(path.join(productPlugin, 'src'), path.join(assembledPlugin, 'src'), { recursive: true })
  const manifest = productionPluginManifest(JSON.parse(await readFile(path.join(productPlugin, 'package.json'), 'utf8')))
  manifest.peerDependencies = Object.fromEntries(WORKSPACE_DEPENDENCIES.map((name) => [name, 'workspace:*']))
  manifest.devDependencies = {
    ...manifest.devDependencies,
    ...Object.fromEntries(WORKSPACE_DEPENDENCIES.map((name) => [name, 'workspace:*'])),
    '@types/react': '~18.3.1',
    react: '^18.2.0',
  }
  await writeFile(path.join(assembledPlugin, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await cp(path.join(productPlugin, 'README.md'), path.join(assembledPlugin, 'README.md'))
  // Publishable files the tarball must carry (the bundle patch); lib/* outputs
  // and glob patterns are produced by the build instead.
  for (const entry of manifest.files ?? []) {
    if (entry.includes('*')) continue
    const source = path.join(productPlugin, entry)
    if (!(await exists(source))) continue
    await mkdir(path.dirname(path.join(assembledPlugin, entry)), { recursive: true })
    if ((await stat(source)).isDirectory()) continue
    await cp(source, path.join(assembledPlugin, entry))
  }
  const templateManifest = JSON.parse(await readFile(path.join(productPlugin, 'assets/prototype-template.manifest.json'), 'utf8'))
  for (const entry of [...templateManifest.files, ...templateManifest.addedFiles]) {
    if (!entry.path || entry.path.includes('\\') || entry.path.split('/').some(part => !part || part === '..' || part === '.')) throw new Error('Invalid template bundle entry')
    const destination = path.join(assembledPlugin, 'assets/prototype-template', entry.path)
    await mkdir(path.dirname(destination), { recursive: true })
    await cp(path.join(productPlugin, 'assets/prototype-template', entry.path), destination)
  }
  for (const file of ['tsconfig.json', 'tsconfig.host.json', 'tsconfig.client.json', 'tsdown.config.ts']) {
    await cp(path.join(productPlugin, 'build', file), path.join(assembledPlugin, file))
  }
  console.log(`Placed plugin at packages/eadp/studio-plugin (${WORKSPACE_DEPENDENCIES.length} workspace dependencies).`)
}

async function referencePlugin() {
  for (const face of ['host', 'client']) {
    const target = path.join(buildTree, `tsconfig.${face}.json`)
    const reference = `./packages/eadp/studio-plugin/tsconfig.${face}.json`
    let source = await readFile(target, 'utf8')
    source = source.replace('"./packages/eadp/studio-plugin"', `"${reference}"`)
    if (!source.includes(`"${reference}"`)) {
      const marker = '"references": ['; const index = source.indexOf(marker)
      if (index < 0) throw new Error(`tsconfig.${face}.json has no references block.`)
      const insertion = index + marker.length
      source = `${source.slice(0, insertion)}\n    { "path": "${reference}" },${source.slice(insertion)}`
    }
    await writeFile(target, source)
  }
  const target = assembledContracts
  await rm(target, { recursive: true, force: true })
  await mkdir(target, { recursive: true })
  await cp(path.join(repo, 'packages/contracts/src'), path.join(target, 'src'), { recursive: true })
  const manifest = JSON.parse(await readFile(path.join(repo, 'packages/contracts/package.json'), 'utf8'))
  manifest.main = 'lib/index.js'; manifest.types = 'lib/types/index.d.ts'
  manifest.exports = { '.': { types: './lib/types/index.d.ts', default: './lib/index.js' } }
  manifest.files = ['lib/index.js', 'lib/types/**/*.d.ts', 'lib/types/**/*.d.ts.map', 'lib/types/**/*.js', 'lib/types/**/*.js.map']
  delete manifest.scripts
  await writeFile(path.join(target, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(path.join(target, 'tsconfig.json'), JSON.stringify({ extends: '../../../tsconfig.base.json', compilerOptions: { rootDir: 'src', outDir: 'lib/types' }, include: ['src'] }, null, 2) + '\n')
}

async function verifyBuildOutput() {
  for (const file of ['lib/index.js', 'lib/client.js']) {
    if (!(await exists(path.join(assembledPlugin, file)))) {
      throw new Error(`Expected build output is missing: packages/eadp/studio-plugin/${file}`)
    }
  }
  if (!(await exists(path.join(assembledContracts, 'lib/index.js')))) throw new Error('Expected contracts production build output is missing.')
  await recordStudioBuild(assembledPlugin, repo)
  await verifyStudioPlugin(assembledPlugin, repo)
}

async function applyUpstreamEdits() {
  for (const addition of [...STUDIO_PLATFORM_FILES, STUDIO_BROWSER_FILE, ...STUDIO_TEMPLATE_FILES]) {
    const target = path.join(buildTree, addition.file)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, addition.source)
  }
  for (const edit of UPSTREAM_EDITS) {
    const target = path.join(buildTree, edit.file)
    const source = await readFile(target, 'utf8')
    const next = edit.apply(source)
    if (next === source) {
      console.log(`Upstream edit already applied: ${edit.file}`)
      continue
    }
    if (next === undefined || next.length === 0) throw new Error(`Upstream edit failed on ${edit.file}`)
    await writeFile(target, next)
    console.log(`Applied the product edit to ${edit.file}`)
  }
}

async function packPlugin() {
  await rm(packedPluginDirectory, { recursive: true, force: true })
  await mkdir(packedPluginDirectory, { recursive: true })
  runPnpm('pack', assembledPlugin)
  runPnpm('pack', assembledContracts)
  console.log(`Packed the plugin and contracts into ${path.relative(sharedRoot, packedPluginDirectory)}`)
}

async function main() {
  await copyVerifiedSource()
  await placePlugin()
  await referencePlugin()
  await applyUpstreamEdits()
  if (process.argv.includes('--stage-only')) { console.log('Studio source staged; build steps skipped.'); return }
  runPnpm('install', buildTree)
  // A clean source tree needs Host-generated Remote contracts before Client compilation.
  runPnpm('libraries', buildTree)
  // The desktop typecheck proves the product edits above still compile.
  runPnpm('desktop', buildTree)
  await verifyBuildOutput()
  await packPlugin()
  console.log('Studio plugin assembled and packed. Desktop packaging needs a Windows or macOS host:')
  console.log(`  DSH_DESKTOP_PACKED_EXTRA=${packedPluginDirectory} pnpm run package:desktop:win:x64`)
}

await main()
