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
const packedPluginDirectory = path.join(sharedRoot, '.local/build/packed-studio')

/** Package name the product adds to the Desktop runtime and profile layers. */
const STUDIO_PACKAGE = '@eadp-studio/studio-plugin'

/**
 * Upstream edits the product needs for a built-in plugin. Each is anchored on
 * exact source text and re-applied idempotently; a missing anchor is an error
 * so upstream drift cannot silently drop the product integration.
 */
const UPSTREAM_EDITS = [
  {
    file: 'apps/desktop/scripts/prepare-package-set.ts',
    apply: (source) => {
      if (source.includes('STUDIO_PACKAGE')) return source
      let next = source.replace(
        "const DSH_PACKAGE = '@deepseek-ai/dsh'",
        `const DSH_PACKAGE = '@deepseek-ai/dsh'\nconst STUDIO_PACKAGE = '${STUDIO_PACKAGE}'`,
      )
      next = next.replace(
        'const ROOT_PACKAGES = [DSH_PACKAGE, DESKTOP_HOST_PACKAGE] as const',
        'const ROOT_PACKAGES: readonly string[] = [DSH_PACKAGE, DESKTOP_HOST_PACKAGE, STUDIO_PACKAGE]',
      )
      next = next.replace(
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
]

const exists = async (target) => stat(target).then(() => true, (error) => {
  if (error.code === 'ENOENT') return false
  throw error
})

function run(command, args, cwd) {
  // CI=true keeps the upstream lefthook postinstall from writing git hooks into
  // the enclosing product repository.
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, CI: 'true' },
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${String(result.status)}`)
}

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
  const manifest = JSON.parse(await readFile(path.join(productPlugin, 'package.json'), 'utf8'))
  manifest.peerDependencies = Object.fromEntries(WORKSPACE_DEPENDENCIES.map((name) => [name, 'workspace:*']))
  manifest.devDependencies = {
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
    await cp(source, path.join(assembledPlugin, entry))
  }
  for (const file of ['tsconfig.json', 'tsdown.config.ts']) {
    await cp(path.join(productPlugin, 'build', file), path.join(assembledPlugin, file))
  }
  console.log(`Placed plugin at packages/eadp/studio-plugin (${WORKSPACE_DEPENDENCIES.length} workspace dependencies).`)
}

async function referencePlugin() {
  const target = path.join(buildTree, 'tsconfig.client.json')
  const reference = './packages/eadp/studio-plugin'
  const source = await readFile(target, 'utf8')
  if (source.includes(`"${reference}"`)) {
    console.log('tsconfig.client.json already references the plugin.')
    return
  }
  const marker = '"references": ['
  const index = source.indexOf(marker)
  if (index < 0) throw new Error('tsconfig.client.json has no references block.')
  const insertion = index + marker.length
  await writeFile(target, `${source.slice(0, insertion)}\n    { "path": "${reference}" },${source.slice(insertion)}`)
  console.log('Added the plugin project reference to the build tree tsconfig.client.json.')
}

async function verifyBuildOutput() {
  for (const file of ['lib/index.js', 'lib/client.js']) {
    if (!(await exists(path.join(assembledPlugin, file)))) {
      throw new Error(`Expected build output is missing: packages/eadp/studio-plugin/${file}`)
    }
  }
}

async function applyUpstreamEdits() {
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
  run('pnpm', ['pack', '--pack-destination', packedPluginDirectory], assembledPlugin)
  console.log(`Packed the plugin into ${path.relative(sharedRoot, packedPluginDirectory)}`)
}

async function main() {
  await copyVerifiedSource()
  await placePlugin()
  await referencePlugin()
  await applyUpstreamEdits()
  run('pnpm', ['install', '--no-frozen-lockfile'], buildTree)
  run('pnpm', ['run', 'build:lib:client'], buildTree)
  // The desktop typecheck proves the product edits above still compile.
  run('pnpm', ['run', 'build:desktop'], buildTree)
  await verifyBuildOutput()
  await packPlugin()
  console.log('Studio plugin assembled and packed. Desktop packaging needs a Windows or macOS host:')
  console.log(`  DSH_DESKTOP_PACKED_EXTRA=${packedPluginDirectory} pnpm run package:desktop:win:x64`)
}

await main()
