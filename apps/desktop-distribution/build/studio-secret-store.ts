/** Copied into the fixed Electron Desktop build; never loaded in the browser or Agent. */
import { randomUUID } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

interface SecretRequest { type: 'studio-secret-request'; requestId: string; action: 'read' | 'write' | 'delete'; key: string; value?: unknown }
const pending = new Map<string, Promise<unknown>>()
export function isStudioSecretRequest(value: unknown): value is SecretRequest {
  return !!value && typeof value === 'object' && (value as { type?: unknown }).type === 'studio-secret-request'
}
export async function handleStudioSecretRequest(child: ChildProcess, request: SecretRequest): Promise<void> {
  const send = (value: object) => { try { if (child.connected) child.send(value, () => {}) } catch { /* The requesting Host has already exited. */ } }
  try {
    if (!/^[a-f0-9-]{36}$/.test(request.requestId) || !/^(?:collaboration-session|publication-[a-z0-9-]+)$/.test(request.key) || !['read', 'write', 'delete'].includes(request.action)) throw new Error('request')
    const { app, safeStorage } = await import('electron')
    if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) throw new Error('OS secure storage unavailable')
    const operation = (pending.get(request.key) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const root = join(app.getPath('userData'), 'studio-vault')
      const filename = join(root, `${request.key}.bin`)
      await mkdir(root, { recursive: true, mode: 0o700 })
      if (request.action === 'delete') { await rm(filename, { force: true }); return undefined }
      if (request.action === 'read') {
        let bytes: Buffer
        try { bytes = await readFile(filename) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
        if (bytes.byteLength > 1024 * 1024) throw new Error('size')
        return JSON.parse(safeStorage.decryptString(bytes)) as unknown
      }
      const text = JSON.stringify(request.value)
      if (!text || Buffer.byteLength(text) > 512 * 1024) throw new Error('value')
      const temporary = `${filename}.${randomUUID()}.tmp`
      try { await writeFile(temporary, safeStorage.encryptString(text), { mode: 0o600, flag: 'wx' }); await rename(temporary, filename) }
      finally { await rm(temporary, { force: true }) }
      return undefined
    })
    pending.set(request.key, operation)
    try { send({ type: 'studio-secret-result', requestId: request.requestId, ok: true, value: await operation }) }
    finally { if (pending.get(request.key) === operation) pending.delete(request.key) }
  } catch { send({ type: 'studio-secret-result', requestId: request.requestId, ok: false }) }
}
