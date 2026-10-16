/** Electron-owned static preview verification. No credentials or Host APIs enter this renderer. */
import type { BrowserWindow } from 'electron'
import { randomUUID, createHash } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'

interface PreviewRequest { type: 'studio-preview-check'; requestId: string; url: string }
export function isStudioPreviewCheck(value: unknown): value is PreviewRequest {
  return !!value && typeof value === 'object' && (value as { type?: unknown }).type === 'studio-preview-check'
}
export async function handleStudioPreviewCheck(child: ChildProcess, request: PreviewRequest): Promise<void> {
  let window: BrowserWindow | undefined
  const send = (result: object) => { if (child.connected) child.send({ type: 'studio-preview-result', requestId: request.requestId, ...result }, () => {}) }
  try {
    const url = new URL(request.url)
    if (!/^[a-f0-9-]{36}$/.test(request.requestId) || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.username || url.password || url.search || url.hash) throw new Error('preview url')
    const { BrowserWindow, session } = await import('electron')
    const isolated = session.fromPartition(`studio-check-${randomUUID()}`)
    let outsideRequests = 0
    isolated.webRequest.onBeforeRequest((details, callback) => {
      const target = new URL(details.url)
      const allowed = target.origin === url.origin && ['mainFrame', 'script', 'stylesheet', 'image', 'font', 'other'].includes(details.resourceType)
      if (!allowed && !['data:', 'blob:'].includes(target.protocol)) outsideRequests++
      callback({ cancel: !allowed && !['data:', 'blob:'].includes(target.protocol) })
    })
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    window = new BrowserWindow({ show: false, width: 1280, height: 800, webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false, backgroundThrottling: false } })
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event, target) => { if (new URL(target).origin !== url.origin) event.preventDefault() })
    let failed = false
    window.webContents.on('render-process-gone', () => { failed = true })
    await Promise.race([window.loadURL(url.href), new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('load deadline')), 20_000))])
    const result: unknown = await window.webContents.executeJavaScript(`(async () => {
      for (let i = 0; i < 100 && !window.__EADP_MOCK__?.ready; i++) await new Promise(r => setTimeout(r, 100));
      const guard = window.__EADP_MOCK_GUARD__;
      const mock = window.__EADP_MOCK__;
      if (guard?.version !== 'synthetic-only-v1' || guard.installed !== true || mock?.ready !== true || !document.body.innerText.trim()) throw new Error('Mock not ready');
      const checked = await mock.verify();
      if (!checked.ready || !checked.unknownRejected) throw new Error('Unknown request accepted');
      let fetchRejected = false; try { await fetch('https://eadp.invalid/probe'); } catch { fetchRejected = true; }
      const blocked = f => { try { f(); return false; } catch { return true; } };
      const allBlocked = fetchRejected && blocked(() => new XMLHttpRequest()) && blocked(() => new WebSocket('wss://eadp.invalid/')) && blocked(() => new Worker('data:text/javascript,0')) && blocked(() => navigator.sendBeacon('https://eadp.invalid/', ''));
      return { ready: true, unknownRejected: checked.unknownRejected, allBlocked, guardVersion: guard.version };
    })()`, true)
    if (failed || outsideRequests || !result || typeof result !== 'object' || (result as { allBlocked?: boolean }).allBlocked !== true) throw new Error('preview protection')
    const evidenceHash = createHash('sha256').update(JSON.stringify(result)).digest('hex')
    send({ ok: true, evidenceHash })
    await isolated.clearStorageData()
  } catch { send({ ok: false }) }
  finally { window?.destroy() }
}
