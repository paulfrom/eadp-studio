import { readFile, rm, writeFile } from 'node:fs/promises'
import { containedFile } from '../assets/materials.ts'

/**
 * Copies the exact working-tree bytes of `files` into another worktree without
 * creating a commit. A path absent from the source is removed from the target;
 * every other path keeps the target's committed version.
 */
export async function snapshotWorktreeFiles(source: string, target: string, files: readonly string[]): Promise<void> {
  for (const relative of new Set(files)) {
    const bytes = await readFile(await containedFile(source, relative)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    const destination = await containedFile(target, relative, true)
    if (bytes) await writeFile(destination, bytes)
    else await rm(destination, { force: true })
  }
}
