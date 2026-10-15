import { randomUUID } from 'node:crypto'

export interface SecretStore {
  read(key: string): Promise<unknown | undefined>
  write(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
}

/** Private parent/child IPC to Electron safeStorage. This is never registered as a Remote. */
export class DesktopSecretStore implements SecretStore {
  private request(action: 'read' | 'write' | 'delete', key: string, value?: unknown): Promise<unknown> {
    if (!/^(?:collaboration-session|publication-[a-z0-9-]+)$/.test(key)) return Promise.reject(new Error('凭据标识无效。'))
    if (!process.connected || !process.send) return Promise.reject(new Error('桌面安全凭据存储不可用。'))
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error('桌面凭据操作超时。')) }, 10_000)
      const listener = (message: unknown) => {
        if (!message || typeof message !== 'object') return
        const response = message as Record<string, unknown>
        if (response.type !== 'studio-secret-result' || response.requestId !== requestId) return
        cleanup()
        if (response.ok === true) resolve(response.value)
        else reject(new Error('桌面安全凭据操作失败。'))
      }
      const cleanup = () => { clearTimeout(timer); process.off('message', listener) }
      process.on('message', listener)
      process.send?.({ type: 'studio-secret-request', requestId, action, key, ...(action === 'write' ? { value } : {}) }, error => { if (error) { cleanup(); reject(new Error('桌面凭据通道不可用。')) } })
    })
  }
  read(key: string): Promise<unknown | undefined> { return this.request('read', key) }
  async write(key: string, value: unknown): Promise<void> { await this.request('write', key, value) }
  async delete(key: string): Promise<void> { await this.request('delete', key) }
}
