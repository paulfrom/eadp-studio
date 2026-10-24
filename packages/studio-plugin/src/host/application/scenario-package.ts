import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { MaterialMetadata } from '@eadp/contracts'
import { digest } from '../adapters/assets/materials.ts'

const projectContextPath = 'CONTEXT.md'

/**
 * Keeps the project-root CONTEXT.md reference in a design material's file manifest.
 * The confirmation package declares this file through `metadata.files`; an
 * absent context file removes a stale reference instead of keeping it.
 */
export async function syncProjectContext(root: string, metadata: MaterialMetadata): Promise<MaterialMetadata> {
  if (metadata.kind !== 'scenario' && metadata.kind !== 'requirement') return metadata
  const files = (metadata.files ?? []).filter(file => file.path !== projectContextPath)
  let bytes: Buffer
  try { bytes = await readFile(path.join(root, projectContextPath)) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return metadata.files?.some(file => file.path === projectContextPath) ? { ...metadata, files } : metadata
    throw error
  }
  return { ...metadata, files: [...files, { path: projectContextPath, sha256: digest(bytes) }] }
}
