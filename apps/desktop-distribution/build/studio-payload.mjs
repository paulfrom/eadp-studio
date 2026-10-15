/** Product payload checks complement the upstream Host/runtime smoke checks. */
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, readdir, lstat, writeFile } from 'node:fs/promises'
import path from 'node:path'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const json = async filename => JSON.parse(await readFile(filename, 'utf8'))

export function productionPluginManifest(source) {
  const manifest = structuredClone(source)
  manifest.dependencies = { ...manifest.dependencies, '@eadp/contracts': 'workspace:*' }
  delete manifest.devDependencies?.['@eadp/contracts']
  manifest.files = [...new Set([...(manifest.files ?? []), 'studio-build.json'])]
  return manifest
}

export function assertStudioHost(source) {
  if (!['StudioService', 'composeStudio', 'StudioApplication'].every(symbol => source.includes(symbol))) {
    throw new Error('The payload does not contain the complete Studio Host; rebuild the current source before packaging.')
  }
}

async function inventory(root, relative = '') {
  const entries = []
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const filename = path.posix.join(relative, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`Payload symlink is forbidden: ${filename}`)
    if (entry.isDirectory()) entries.push(...await inventory(root, filename))
    else if (entry.isFile()) {
      const bytes = await readFile(path.join(root, filename))
      entries.push({ path: filename, bytes: bytes.byteLength, sha256: hash(bytes) })
    } else throw new Error(`Payload special file is forbidden: ${filename}`)
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path, 'en'))
}

function safeRelative(filename) {
  if (typeof filename !== 'string' || !filename || filename.includes('\\') || path.posix.isAbsolute(filename)
    || filename.split('/').some(part => !part || part === '.' || part === '..') || filename.includes(':')) {
    throw new Error(`Invalid payload path: ${filename}`)
  }
  return filename
}

async function verifyFiles(root, files) {
  const seen = new Set()
  if (!Array.isArray(files) || files.length === 0) throw new Error('Payload inventory is empty.')
  for (const file of files) {
    const filename = safeRelative(file.path)
    if (seen.has(filename)) throw new Error(`Duplicate payload file: ${filename}`)
    seen.add(filename)
    const target = path.join(root, filename)
    const metadata = await lstat(target).catch(() => { throw new Error(`Missing payload file: ${filename}`) })
    if (!metadata.isFile()) throw new Error(`Payload is not a regular file: ${filename}`)
    const bytes = await readFile(target)
    if (bytes.byteLength !== file.bytes || hash(bytes) !== file.sha256) throw new Error(`Payload integrity mismatch: ${filename}`)
  }
  return seen
}

/** Hash the exact staged product inputs, excluding generated output and machine dependencies. */
export async function studioSourceDigest(repo) {
  const entries = []
  for (const directory of ['packages/studio-plugin/src', 'packages/studio-plugin/build', 'packages/contracts/src']) {
    for (const file of await inventory(path.join(repo, directory))) entries.push([`${directory}/${file.path}`, file.sha256])
  }
  for (const filename of ['packages/studio-plugin/package.json', 'packages/studio-plugin/cordis.patch.yml', 'packages/studio-plugin/assets/prototype-template.manifest.json', 'packages/contracts/package.json']) {
    entries.push([filename, hash(await readFile(path.join(repo, filename)))])
  }
  return hash(JSON.stringify(entries.sort(([a], [b]) => a.localeCompare(b, 'en'))))
}

/** Stamp only after current Host, client and generated Remote outputs passed the build. */
export async function recordStudioBuild(pluginRoot, repo) {
  await verifyStudioPluginFiles(pluginRoot)
  const files = []
  for (const directory of ['lib', 'assets']) files.push(...(await inventory(path.join(pluginRoot, directory)))
    .filter(file => directory === 'assets' || /^(?:index\.js|client\.js|typert\.(?:host|remote-client)\.(?:js|d\.ts)|types\/.*(?:\.js|\.d\.ts))$/.test(file.path))
    .map(file => ({ ...file, path: `${directory}/${file.path}` })))
  files.push({ path: 'cordis.patch.yml', bytes: (await readFile(path.join(pluginRoot, 'cordis.patch.yml'))).length, sha256: hash(await readFile(path.join(pluginRoot, 'cordis.patch.yml'))) })
  await writeFile(path.join(pluginRoot, 'studio-build.json'), `${JSON.stringify({ schemaVersion: 1, sourceDigest: await studioSourceDigest(repo), files }, null, 2)}\n`)
}

async function verifyStudioPluginFiles(pluginRoot) {
  assertStudioHost(await readFile(path.join(pluginRoot, 'lib/index.js'), 'utf8'))
  for (const filename of ['lib/client.js', 'lib/typert.host.js', 'lib/typert.remote-client.js', 'assets/prototype-template.manifest.json']) {
    if ((await readFile(path.join(pluginRoot, filename))).length === 0) throw new Error(`Empty Studio payload: ${filename}`)
  }
  const manifest = await json(path.join(pluginRoot, 'package.json'))
  if (!manifest.dependencies?.['@eadp/contracts']) throw new Error('Studio production dependency closure omits @eadp/contracts.')
  const template = await json(path.join(pluginRoot, 'assets/prototype-template.manifest.json'))
  for (const file of [...template.files, ...template.addedFiles]) {
    const filename = safeRelative(file.path)
    if (hash(await readFile(path.join(pluginRoot, 'assets/prototype-template', filename))) !== file.sha256) throw new Error(`Template integrity mismatch: ${filename}`)
  }
}

export async function verifyStudioPlugin(pluginRoot, repo) {
  await verifyStudioPluginFiles(pluginRoot)
  const receipt = await json(path.join(pluginRoot, 'studio-build.json'))
  if (receipt.schemaVersion !== 1 || receipt.sourceDigest !== await studioSourceDigest(repo)) throw new Error('Studio payload was built from different product source.')
  await verifyFiles(pluginRoot, receipt.files)
}

export async function verifyRuntimePayload(root) {
  const manifest = await json(path.join(root, 'runtime-manifest.json'))
  if (manifest.schemaVersion !== 1 || manifest.platform !== process.platform || manifest.arch !== process.arch) throw new Error('Studio runtime target mismatch.')
  const files = await verifyFiles(root, manifest.files)
  for (const name of ['node', 'pnpm', 'git', 'ssh']) {
    const tool = manifest.tools?.[name]
    if (!tool || !files.has(tool.path) || !tool.version || !tool.source || !tool.license) throw new Error(`Missing Studio tool: ${name}`)
    if (hash(await readFile(path.join(root, tool.path))) !== tool.sha256) throw new Error(`Studio tool integrity mismatch: ${name}`)
  }
  for (const file of await inventory(root)) if (file.path !== 'runtime-manifest.json' && !files.has(file.path)) throw new Error(`Untracked runtime file: ${file.path}`)
}

/** Run on the extracted final app resources, after upstream production installation. */
export async function verifyStudioDistribution(pluginRoot, runtimeRoot, repo) {
  await verifyStudioPlugin(pluginRoot, repo)
  await verifyRuntimePayload(runtimeRoot)
  const require = createRequire(path.join(pluginRoot, 'package.json'))
  const contracts = require.resolve('@eadp/contracts')
  await readFile(contracts)
  const contractsRequire = createRequire(contracts)
  await readFile(contractsRequire.resolve('@sinclair/typebox'))
}
