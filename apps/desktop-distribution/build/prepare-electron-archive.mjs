/** Assembled beside upstream prepare-runtime.ts; the Electron archive is release-pinned and verified before extraction. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * Reuse the verified Electron archive from the pinned cache, downloading it only when the cache is empty.
 * @param {{ version: string, platform: string, arch: string, archiveCache: string }} options - Electron version
 *   resolved from the installed package, the target platform and architecture, and the archive cache directory.
 * @returns {Promise<string>} Absolute path of the archive whose bytes match the maintained lock.
 */
export async function prepareElectronArchive({ version, platform, arch, archiveCache }) {
  const lock = JSON.parse(await readFile(new URL('./eadp-electron-archive.lock.json', import.meta.url), 'utf8'))
  const target = `${platform}-${arch}`
  const entry = lock.archives?.[target]
  const fileName = `electron-v${version}-${target}.zip`
  // Fail closed on an upstream version bump instead of trusting whatever release the dependency happens to resolve.
  if (entry === undefined || lock.schemaVersion !== 1 || lock.version !== version || entry.file !== fileName) {
    throw new Error(`Maintained Electron archive lock does not pin ${version} ${target}; update apps/desktop-distribution/build/eadp-electron-archive.lock.json.`)
  }
  const destination = path.join(archiveCache, fileName)
  let bytes = await readFile(destination).catch(error => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (bytes === undefined) {
    const response = await fetch(entry.url, { signal: AbortSignal.timeout(600_000) })
    if (!response.ok) throw new Error(`Cannot download pinned Electron ${version}: ${String(response.status)} ${entry.url}`)
    bytes = Buffer.from(await response.arrayBuffer())
    // The pin covers both sources: a truncated download and a damaged cache file both fail here.
    if (bytes.byteLength !== entry.bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
      throw new Error(`Pinned Electron archive integrity mismatch: ${fileName}`)
    }
    await mkdir(archiveCache, { recursive: true })
    await writeFile(destination, bytes)
    return destination
  }
  if (bytes.byteLength !== entry.bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
    throw new Error(`Pinned Electron archive integrity mismatch: ${destination}`)
  }
  return destination
}
