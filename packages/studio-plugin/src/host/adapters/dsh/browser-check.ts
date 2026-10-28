import { randomUUID } from 'node:crypto'
/** A private IPC capability, deliberately absent from client Remote and Agent tools. */
export function checkStaticPreview(url: string): Promise<{ mockHash: string; browserHash: string }> {
  if (!process.connected || !process.send) return Promise.reject(new Error('原生桌面静态预览验证不可用'))
  const requestId = randomUUID()
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); process.off('message', listener) }
    const listener = (message: unknown) => {
      if (!message || typeof message !== 'object') return
      const value = message as Record<string, unknown>
      if (value.type !== 'studio-preview-result' || value.requestId !== requestId) return
      cleanup()
      if (value.ok === true && typeof value.mockHash === 'string' && /^[a-f0-9]{64}$/.test(value.mockHash) && typeof value.browserHash === 'string' && /^[a-f0-9]{64}$/.test(value.browserHash)) resolve({ mockHash: value.mockHash, browserHash: value.browserHash })
      else reject(new Error('静态页面、Mock 或网络保护验证失败，不能完成原型'))
    }
    const timer = setTimeout(() => { cleanup(); reject(new Error('静态页面验证超时')) }, 35_000)
    process.on('message', listener)
    process.send?.({ type: 'studio-preview-check', requestId, url }, error => { if (error) { cleanup(); reject(new Error('桌面验证通道不可用')) } })
  })
}
