import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'

export type PrototypeBrowserDistribution = 'headed' | 'headless'
export interface PrototypeBrowserRuntimeManifest {
  schemaVersion: 2
  platform: 'win32'; arch: 'x64'; playwright: '1.61.1'; chromiumRevision: '1228'; chromiumVersion: '149.0.7827.55'
  distributions: Record<PrototypeBrowserDistribution, {
    executable: string
    archive: { url: string; sha256: string }
    files: Array<{ path: string; sha256: string; size: number }>
  }>
}

const sha256 = /^[a-f0-9]{64}$/
const executables: Record<PrototypeBrowserDistribution, string> = {
  headed: 'headed/chrome-win64/chrome.exe',
  headless: 'headless/chrome-headless-shell-win64/chrome-headless-shell.exe',
}
const relativeFile = (value: string): boolean => typeof value === 'string' && value.length > 0 && value.length <= 400 && !value.includes('\\') && !value.includes('\0') && !value.includes(':') && !path.posix.isAbsolute(value) && value.split('/').every(part => part !== '' && part !== '.' && part !== '..')

async function fileDigest(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(file)) hash.update(bytes as Buffer)
  return hash.digest('hex')
}

/** Authenticate the manifest and both complete distributions before selecting the Host-requested mode. */
export async function verifyPrototypeBrowserRuntime(rootPath: string, manifestPath: string, expectedManifestHash: string, distribution: PrototypeBrowserDistribution): Promise<{ executablePath: string; manifest: PrototypeBrowserRuntimeManifest }> {
  if (!sha256.test(expectedManifestHash) || (distribution !== 'headed' && distribution !== 'headless')) throw new Error('浏览器发行清单摘要或分发模式无效')
  if ((await lstat(manifestPath)).isSymbolicLink()) throw new Error('浏览器发行清单不能是符号链接')
  const bytes = await readFile(manifestPath)
  if (createHash('sha256').update(bytes).digest('hex') !== expectedManifestHash) throw new Error('浏览器发行清单校验失败')
  const manifest = JSON.parse(bytes.toString('utf8')) as PrototypeBrowserRuntimeManifest
  if (manifest.schemaVersion !== 2 || manifest.platform !== process.platform || manifest.arch !== process.arch || manifest.playwright !== '1.61.1' || manifest.chromiumRevision !== '1228' || manifest.chromiumVersion !== '149.0.7827.55' || !manifest.distributions) throw new Error('浏览器发行清单与当前平台或固定版本不匹配')
  const expected = new Map<string, { sha256: string; size: number }>()
  for (const kind of ['headed', 'headless'] as const) {
    const item = manifest.distributions[kind]
    if (!item || item.executable !== executables[kind] || !item.archive || !sha256.test(item.archive.sha256) || typeof item.archive.url !== 'string' || !Array.isArray(item.files) || !item.files.length || item.files.length > 10000) throw new Error('浏览器分发物清单无效')
    for (const file of item.files) {
      if (!relativeFile(file.path) || !file.path.startsWith(`${kind}/`) || !sha256.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > 1024 * 1024 * 1024 || expected.has(file.path)) throw new Error('浏览器发行清单文件项无效')
      expected.set(file.path, file)
    }
    if (!expected.has(item.executable)) throw new Error('浏览器执行文件未列入发行清单')
  }
  if ((await lstat(rootPath)).isSymbolicLink()) throw new Error('浏览器运行时目录不能是符号链接')
  const root = await realpath(rootPath), authenticatedManifest = await realpath(manifestPath), seen = new Set<string>()
  const walk = async (directory: string, prefix = ''): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name, absolute = path.join(directory, entry.name)
      if (!relativeFile(rel) || entry.isSymbolicLink()) throw new Error('浏览器运行时包含无效路径或符号链接')
      if (entry.isDirectory()) await walk(absolute, rel)
      else if (entry.isFile()) {
        if (absolute === authenticatedManifest) continue
        const item = expected.get(rel), stat = await lstat(absolute)
        if (!item || !stat.isFile() || stat.size !== item.size || await fileDigest(absolute) !== item.sha256) throw new Error('浏览器运行时文件与发行清单不一致')
        seen.add(rel)
      } else throw new Error('浏览器运行时包含不支持的文件类型')
    }
  }
  await walk(root)
  if (seen.size !== expected.size) throw new Error('浏览器运行时文件缺失')
  const executable = manifest.distributions[distribution].executable
  return { executablePath: path.join(root, ...executable.split('/')), manifest }
}
