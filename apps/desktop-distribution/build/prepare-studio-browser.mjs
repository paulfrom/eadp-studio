/** Assemble only archives authenticated by the repository lock; never download a substitute. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import extractZip from 'extract-zip'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const sha256 = /^[a-f0-9]{64}$/
const expectedExecutables = {
  headed: 'headed/chrome-win64/chrome.exe',
  headless: 'headless/chrome-headless-shell-win64/chrome-headless-shell.exe',
}

async function inventory(root, relative = '') {
  const files = []
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const filename = path.posix.join(relative, entry.name)
    if (entry.isSymbolicLink()) throw new Error('Studio browser payload must not contain symlinks.')
    if (entry.isDirectory()) files.push(...await inventory(root, filename))
    else if (entry.isFile()) {
      const bytes = await readFile(path.join(root, filename))
      files.push({ path: filename, size: bytes.byteLength, sha256: digest(bytes) })
    } else throw new Error('Studio browser payload contains a special file.')
  }
  return files.sort((left, right) => left.path.localeCompare(right.path, 'en'))
}

export async function prepareStudioBrowserRuntime(destination, archiveCache) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Studio browser assembly requires Windows x64.')
  const lock = JSON.parse(await readFile(new URL('./studio-browser.lock.json', import.meta.url), 'utf8'))
  if (lock.schemaVersion !== 1 || lock.platform !== 'win32' || lock.arch !== 'x64' || lock.playwright !== '1.61.1' || lock.chromiumRevision !== '1228' || lock.chromiumVersion !== '149.0.7827.55') throw new Error('Studio browser lock does not match the fixed runtime route.')
  for (const kind of Object.keys(expectedExecutables)) {
    if (!sha256.test(lock.archives?.[kind]?.sha256)) throw new Error(`Studio browser ${kind} archive has no audited SHA-256; refusing to create a trusted runtime.`)
  }
  if (!archiveCache) throw new Error('Studio browser archive cache is required; runtime download fallback is forbidden.')
  const temporary = `${destination}.preparing`
  const archives = path.join(temporary, 'archives')
  await rm(temporary, { recursive: true, force: true })
  await mkdir(archives, { recursive: true })
  try {
    const distributions = {}
    for (const kind of ['headed', 'headless']) {
      const entry = lock.archives[kind]
      const expectedUrl = `https://cdn.playwright.dev/builds/cft/149.0.7827.55/win64/${kind === 'headed' ? 'chrome-win64' : 'chrome-headless-shell-win64'}.zip`
      if (entry.url !== expectedUrl || entry.filename !== `${kind}.zip`) throw new Error(`Studio browser ${kind} lock source differs from the fixed release.`)
      const bytes = await readFile(path.join(archiveCache, entry.filename))
      if (digest(bytes) !== entry.sha256) throw new Error(`Studio browser ${kind} archive integrity mismatch.`)
      const archive = path.join(archives, entry.filename)
      await writeFile(archive, bytes)
      await extractZip(archive, { dir: path.join(temporary, kind) })
    }
    await rm(archives, { recursive: true, force: true })
    const files = await inventory(temporary)
    for (const kind of ['headed', 'headless']) {
      const executable = expectedExecutables[kind]
      if (!files.some(file => file.path === executable)) throw new Error(`Studio browser ${kind} executable is missing from the audited archive.`)
      distributions[kind] = {
        executable,
        archive: { url: lock.archives[kind].url, sha256: lock.archives[kind].sha256 },
        files: files.filter(file => file.path.startsWith(`${kind}/`)),
      }
    }
    if (files.length !== distributions.headed.files.length + distributions.headless.files.length) throw new Error('Studio browser payload contains files outside the fixed distributions.')
    const manifest = {
      schemaVersion: 2,
      platform: lock.platform,
      arch: lock.arch,
      playwright: lock.playwright,
      chromiumRevision: lock.chromiumRevision,
      chromiumVersion: lock.chromiumVersion,
      distributions,
    }
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
    const manifestSha256 = digest(manifestBytes)
    await writeFile(path.join(temporary, 'browser-manifest.json'), manifestBytes)
    await rm(destination, { recursive: true, force: true })
    await mkdir(path.dirname(destination), { recursive: true })
    await rename(temporary, destination)
    const release = {
      schemaVersion: 1,
      platform: lock.platform,
      arch: lock.arch,
      playwright: lock.playwright,
      chromiumRevision: lock.chromiumRevision,
      chromiumVersion: lock.chromiumVersion,
      manifest: 'browser-runtime/browser-manifest.json',
      manifestSha256,
    }
    const releasePath = path.join(path.dirname(destination), 'browser-runtime.release.json')
    await writeFile(releasePath, `${JSON.stringify(release, null, 2)}\n`)
    return { manifestPath: path.join(destination, 'browser-manifest.json'), manifestSha256 }
  } finally { await rm(temporary, { recursive: true, force: true }) }
}
