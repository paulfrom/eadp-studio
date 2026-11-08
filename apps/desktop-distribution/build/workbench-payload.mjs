/** Product payload checks complement the upstream Host/runtime smoke checks. */
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, readdir, lstat, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createPrototypeTemplateArchive } from './prototype-template-archive.mjs'

export const WORKBENCH_PACKAGES = ['eadp-contracts', 'eadp-shell', 'eadp-requirements', 'eadp-prototype', 'eadp-knowledge']
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const json = async filename => JSON.parse(await readFile(filename, 'utf8'))
const exists = async filename => stat(filename).then(() => true, error => {
  if (error.code === 'ENOENT') return false
  throw error
})
export const workbenchPackageName = name => name === 'eadp-contracts' ? '@eadp/contracts' : `@eadp/${name.slice(5)}`

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

async function templateEntries(repo) {
  const root = path.join(repo, 'packages/eadp-prototype/assets')
  const manifest = await json(path.join(root, 'prototype-template.manifest.json'))
  return [...manifest.files, ...manifest.addedFiles].map(entry => safeRelative(entry.path))
}

/** Hash the exact maintained inputs, excluding generated output and machine dependencies. */
export async function workbenchSourceDigest(repo) {
  const entries = []
  const add = async filename => entries.push([filename, hash(await readFile(path.join(repo, filename)))])
  for (const name of WORKBENCH_PACKAGES) {
    const directory = `packages/${name}`
    await add(`${directory}/package.json`)
    for (const child of ['src', 'build']) {
      if (await exists(path.join(repo, directory, child))) {
        for (const file of await inventory(path.join(repo, directory, child))) await add(`${directory}/${child}/${file.path}`)
      }
    }
    if (name !== 'eadp-contracts') await add(`${directory}/cordis.patch.yml`)
  }
  await add('packages/eadp-prototype/assets/prototype-template.manifest.json')
  for (const filename of await templateEntries(repo)) await add(`packages/eadp-prototype/assets/prototype-template/${filename}`)
  for (const file of await inventory(path.join(repo, 'packages/eadp-knowledge/resources/builtin'))) await add(`packages/eadp-knowledge/resources/builtin/${file.path}`)
  return hash(JSON.stringify(entries.sort(([a], [b]) => a.localeCompare(b, 'en'))))
}

async function verifyWorkbenchPackageFiles(packageRoot, name) {
  const artifacts = name === 'eadp-contracts'
    ? ['lib/index.js']
    : ['lib/index.js', 'lib/client.js', 'lib/typert.host.js', 'lib/typert.remote-client.js']
  for (const filename of artifacts) {
    if ((await readFile(path.join(packageRoot, filename))).length === 0) throw new Error(`Empty Workbench payload: ${name}/${filename}`)
  }
  const manifest = await json(path.join(packageRoot, 'package.json'))
  if (name !== 'eadp-contracts' && !manifest.dependencies?.['@eadp/contracts']) throw new Error(`${name} production dependency closure omits @eadp/contracts.`)
  if (name === 'eadp-prototype') {
    const template = await json(path.join(packageRoot, 'assets/prototype-template.manifest.json'))
    for (const file of [...template.files, ...template.addedFiles]) {
      const filename = safeRelative(file.path)
      if (hash(await readFile(path.join(packageRoot, 'assets/prototype-template', filename))) !== file.sha256) throw new Error(`Template integrity mismatch: ${filename}`)
    }
  }
  if (name === 'eadp-knowledge') {
    const pack = await json(path.join(packageRoot, 'resources/builtin/manifest.json'))
    for (const card of pack.documents) {
      const filename = safeRelative(card.path)
      if (hash(await readFile(path.join(packageRoot, 'resources/builtin', filename))) !== card.sha256) throw new Error(`Knowledge integrity mismatch: ${filename}`)
    }
  }
}

/** Stamp only after current Host, Client and generated Remote outputs passed the build. */
export async function recordWorkbenchBuild(tree, repo) {
  const sourceDigest = await workbenchSourceDigest(repo)
  for (const name of WORKBENCH_PACKAGES) {
    const packageRoot = path.join(tree, 'packages/eadp', name)
    if (name === 'eadp-prototype') await createPrototypeTemplateArchive(packageRoot)
    await verifyWorkbenchPackageFiles(packageRoot, name)
    const files = []
    const libraryFiles = (await inventory(path.join(packageRoot, 'lib'))).filter(file => {
      if (name === 'eadp-contracts') return file.path === 'index.js' || /^types\/.*\.(?:d\.ts|js)(?:\.map)?$/.test(file.path)
      return ['index.js', 'client.js', 'convert-worker.js', 'typert.host.js', 'typert.host.d.ts', 'typert.remote-client.js', 'typert.remote-client.d.ts'].includes(file.path) || /^types\/.*\.(?:d\.ts|js)$/.test(file.path)
    })
    files.push(...libraryFiles.map(file => ({ ...file, path: `lib/${file.path}` })))
    for (const directory of ['assets', 'resources']) {
      if (!await exists(path.join(packageRoot, directory))) continue
      files.push(...(await inventory(path.join(packageRoot, directory))).map(file => ({ ...file, path: `${directory}/${file.path}` })))
    }
    if (name !== 'eadp-contracts') {
      const bytes = await readFile(path.join(packageRoot, 'cordis.patch.yml'))
      files.push({ path: 'cordis.patch.yml', bytes: bytes.length, sha256: hash(bytes) })
    }
    await writeFile(path.join(packageRoot, 'workbench-build.json'), `${JSON.stringify({ schemaVersion: 1, sourceDigest, files }, null, 2)}\n`)
  }
}

export async function verifyWorkbenchBuild(tree, repo) {
  const sourceDigest = await workbenchSourceDigest(repo)
  for (const name of WORKBENCH_PACKAGES) {
    const packageRoot = path.join(tree, 'packages/eadp', name)
    await verifyWorkbenchPackageFiles(packageRoot, name)
    const receipt = await json(path.join(packageRoot, 'workbench-build.json'))
    if (receipt.schemaVersion !== 1 || receipt.sourceDigest !== sourceDigest) throw new Error(`${name} payload was built from different product source.`)
    await verifyFiles(packageRoot, receipt.files)
  }
}

export async function verifyRuntimePayload(root) {
  const manifest = await json(path.join(root, 'runtime-manifest.json'))
  if (manifest.schemaVersion !== 1 || manifest.platform !== process.platform || manifest.arch !== process.arch) throw new Error('EADP runtime target mismatch.')
  const files = await verifyFiles(root, manifest.files)
  for (const name of ['node', 'pnpm']) {
    const tool = manifest.tools?.[name]
    if (!tool || !files.has(tool.path) || !tool.version || !tool.source || !tool.license) throw new Error(`Missing EADP tool: ${name}`)
    if (hash(await readFile(path.join(root, tool.path))) !== tool.sha256) throw new Error(`EADP tool integrity mismatch: ${name}`)
  }
  for (const file of await inventory(root)) if (file.path !== 'runtime-manifest.json' && !files.has(file.path)) throw new Error(`Untracked runtime file: ${file.path}`)
}

/** Run on extracted final app resources after upstream production installation. */
export async function verifyWorkbenchDistribution(dshRoot, runtimeRoot, repo) {
  const sourceDigest = await workbenchSourceDigest(repo)
  for (const name of WORKBENCH_PACKAGES) {
    const packageName = workbenchPackageName(name)
    const packageRoot = path.join(dshRoot, 'node_modules', ...packageName.split('/'))
    await verifyWorkbenchPackageFiles(packageRoot, name)
    const receipt = await json(path.join(packageRoot, 'workbench-build.json'))
    if (receipt.schemaVersion !== 1 || receipt.sourceDigest !== sourceDigest) throw new Error(`${name} distribution was built from different product source.`)
    await verifyFiles(packageRoot, receipt.files)
    if (name !== 'eadp-contracts') {
      const require = createRequire(path.join(packageRoot, 'package.json'))
      const contracts = require.resolve('@eadp/contracts')
      await readFile(contracts)
      await readFile(createRequire(contracts).resolve('@sinclair/typebox'))
    }
  }
  await verifyRuntimePayload(runtimeRoot)
}
