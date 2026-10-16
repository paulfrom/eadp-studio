/** Assembled beside upstream prepare-runtime.ts; all downloaded bytes are release-pinned. */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, readdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import extractZip from 'extract-zip'

export async function prepareStudioTools(destination, archiveCache) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Studio runtime assembly requires Windows x64.')
  const lock = JSON.parse(await readFile(new URL('./studio-runtime.lock.json', import.meta.url), 'utf8'))
  const temporary = `${destination}.preparing`
  await rm(temporary, { recursive: true, force: true })
  await mkdir(temporary, { recursive: true })
  try {
    for (const [name, entry] of Object.entries({ node: lock.node, pnpm: lock.pnpm, git: lock.git })) {
      const filename = `${name}.${name === 'pnpm' ? 'tgz' : 'zip'}`
      const cachedArchive = archiveCache && path.join(archiveCache, filename)
      let bytes
      if (cachedArchive) bytes = await readFile(cachedArchive).catch(error => { if (error.code !== 'ENOENT') throw error })
      if (bytes === undefined) {
        const response = await fetch(entry.url, { signal: AbortSignal.timeout(180_000) })
        if (!response.ok) throw new Error(`Cannot download fixed Studio ${name}.`)
        bytes = Buffer.from(await response.arrayBuffer())
      }
      const [algorithm, expected] = entry.integrity ? entry.integrity.split('-', 2) : ['sha256', entry.sha256]
      const actual = createHash(algorithm).update(bytes).digest(entry.integrity ? 'base64' : 'hex')
      if (actual !== expected) throw new Error(`Fixed Studio ${name} archive integrity mismatch.`)
      if (cachedArchive) { await mkdir(archiveCache, { recursive: true }); await writeFile(cachedArchive, bytes) }
      const archive = path.join(temporary, filename)
      await writeFile(archive, bytes)
      const target = path.join(temporary, name)
      await mkdir(target)
      if (name === 'pnpm') {
        const result = spawnSync(path.join(process.env.SystemRoot, 'System32', 'tar.exe'), ['-xzf', archive, '--strip-components=1', '-C', target], { windowsHide: true, stdio: 'inherit' })
        if (result.status !== 0) throw new Error('Cannot extract fixed Studio pnpm.')
        // electron-builder omits VCS placeholders; remove this empty source marker before sealing the delivered tool inventory.
        await rm(path.join(target, 'dist/node_modules/undici/lib/llhttp/.gitkeep'))
      } else await extractZip(archive, { dir: target })
      await rm(archive)
    }
    const specifications = {
      node: { path: 'node/node-v22.22.3-win-x64/node.exe', ...lock.node },
      pnpm: { path: 'pnpm/bin/pnpm.mjs', ...lock.pnpm, script: true },
      git: { path: 'git/cmd/git.exe', ...lock.git },
      ssh: { path: 'git/usr/bin/ssh.exe', ...lock.git, license: 'BSD-2-Clause AND bundled OpenSSH notices' },
    }
    const tools = {}
    for (const [name, entry] of Object.entries(specifications)) {
      tools[name] = { path: entry.path, version: entry.version, source: entry.url, license: entry.license, sha256: createHash('sha256').update(await readFile(path.join(temporary, entry.path))).digest('hex'), ...(entry.script ? { script: true } : {}) }
    }
    const files = []
    const inventory = async relative => {
      for (const entry of await readdir(path.join(temporary, relative), { withFileTypes: true })) {
        const filename = path.posix.join(relative, entry.name)
        if (entry.isSymbolicLink()) throw new Error('Studio runtime payload must not contain symlinks.')
        if (entry.isDirectory()) await inventory(filename)
        else if (entry.isFile()) {
          const bytes = await readFile(path.join(temporary, filename))
          files.push({ path: filename, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') })
        } else throw new Error('Studio runtime payload contains a special file.')
      }
    }
    await inventory('')
    files.sort((a, b) => a.path.localeCompare(b.path, 'en'))
    const manifest = { schemaVersion: 1, platform: 'win32', arch: 'x64', tools, files }
    await writeFile(path.join(temporary, 'runtime-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    await rm(destination, { recursive: true, force: true })
    await rename(temporary, destination)
  } finally { await rm(temporary, { recursive: true, force: true }) }
}
