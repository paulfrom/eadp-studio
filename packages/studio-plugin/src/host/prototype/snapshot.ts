import { createHash } from 'node:crypto'
import { lstat, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** Materialize an already validated fixed Git snapshot without overwriting existing bytes. */
export async function writePrototypeSnapshot(root: string, files: Array<{ path: string; bytes: Buffer; mode: '100644' | '100755' }>): Promise<Map<string, string>> {
  const hashes = new Map<string, string>()
  for (const file of files) {
    if (!file.path || file.path.includes('\\') || file.path.includes('\0') || file.path.includes(':') || file.path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) throw new Error('原型快照路径无效')
    const target = path.join(root, ...file.path.split('/'))
    let parent = root
    for (const part of file.path.split('/').slice(0, -1)) {
      parent = path.join(parent, part)
      await mkdir(parent, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
      const info = await lstat(parent)
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('原型快照目录已变化')
    }
    await writeFile(target, file.bytes, { flag: 'wx', mode: file.mode === '100755' ? 0o700 : 0o600 })
    hashes.set(file.path, createHash('sha256').update(file.bytes).digest('hex'))
  }
  return hashes
}
