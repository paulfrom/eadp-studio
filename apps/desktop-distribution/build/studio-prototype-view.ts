import { randomUUID } from 'node:crypto'
import type { WebContentsView, BrowserWindow, Session } from 'electron'

/** Identity and origin are supplied by the Host that owns a started preview, never by the preview page. */
type StudioPreviewSource = { kind: 'task'; prototypeTaskId: string } | { kind: 'baseline'; baselineId: string; commitSha: string }
export interface StudioPreviewIdentity {
  projectId: string
  source: StudioPreviewSource
  previewId: string
  generation: number
  buildHash: string
}
export interface StudioPreviewInstance extends StudioPreviewIdentity {
  url: string
}
export interface StudioPreviewBounds { x: number; y: number; width: number; height: number }

function identity(instance: StudioPreviewInstance): StudioPreviewIdentity {
  return { projectId: instance.projectId, source: { ...instance.source }, previewId: instance.previewId, generation: instance.generation, buildHash: instance.buildHash }
}
export function samePreviewIdentity(left: StudioPreviewIdentity, right: StudioPreviewIdentity): boolean {
  const sourceMatches = left.source.kind === 'task' && right.source.kind === 'task' ? left.source.prototypeTaskId === right.source.prototypeTaskId
    : left.source.kind === 'baseline' && right.source.kind === 'baseline' && left.source.baselineId === right.source.baselineId && left.source.commitSha === right.source.commitSha
  return left.projectId === right.projectId && sourceMatches && left.previewId === right.previewId && left.generation === right.generation && left.buildHash === right.buildHash
}
export function previewUrl(instance: StudioPreviewInstance): URL {
  const source = instance.source
  const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256
  const validSource = source?.kind === 'task' ? validId(source.prototypeTaskId) : source?.kind === 'baseline' && validId(source.baselineId) && /^[a-f0-9]{40}$/.test(source.commitSha)
  if (!validId(instance.projectId) || !validId(instance.previewId) || !validSource ||
      !Number.isSafeInteger(instance.generation) || instance.generation < 1 || !/^[a-f0-9]{64}$/.test(instance.buildHash)) throw new Error('Invalid preview identity')
  const url = new URL(instance.url)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.username || url.password || url.search || url.hash) throw new Error('Invalid preview origin')
  return url
}
function boundsFor(owner: BrowserWindow, value: StudioPreviewBounds): StudioPreviewBounds {
  const bounds = owner.getContentBounds()
  for (const number of [value.x, value.y, value.width, value.height]) if (!Number.isFinite(number) || number < 0 || number > 100_000) throw new Error('Invalid preview bounds')
  const zoom = owner.webContents.getZoomFactor()
  if (!Number.isFinite(zoom) || zoom <= 0) throw new Error('Invalid application zoom')
  const result = { x: Math.round(value.x * zoom), y: Math.round(value.y * zoom), width: Math.round(value.width * zoom), height: Math.round(value.height * zoom) }
  if (result.x + result.width > bounds.width || result.y + result.height > bounds.height) throw new Error('Preview bounds outside application content')
  return result
}

/** A single native preview, with no preload or application session, owned by its main window. */
export class StudioPrototypeView {
  private view: WebContentsView | undefined
  private instance: StudioPreviewIdentity | undefined
  private owner: BrowserWindow | undefined
  private revision = 0
  private epoch = 0
  private releaseOwner: (() => void) | undefined
  private cleanups = new Set<Promise<void>>()
  private cleanupFailures: unknown[] = []
  private disposed = false

  /** Only the trusted Host registration path may call this with an instance it started. */
  async open(owner: BrowserWindow, instance: StudioPreviewInstance): Promise<void> {
    if (this.disposed) throw new Error('Preview view disposed')
    const url = previewUrl(instance)
    await this.close()
    if (owner.isDestroyed()) throw new Error('Application window is unavailable')
    const epoch = this.epoch
    // HostProcess is also imported by ordinary Node processes; load native APIs only when mounting a view.
    if (!process.versions.electron) throw new Error('Native preview requires Electron')
    const { WebContentsView, session } = await import('electron')
    if (this.disposed || epoch !== this.epoch || owner.isDestroyed()) throw new Error('Preview selection changed')
    const isolated = session.fromPartition(`studio-prototype-${randomUUID()}`)
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    isolated.setPermissionCheckHandler(() => false)
    isolated.on('will-download', event => event.preventDefault())
    isolated.webRequest.onBeforeRequest((details, callback) => {
      let permitted = false
      try {
        const target = new URL(details.url)
        permitted = target.origin === url.origin && !target.username && !target.password && ['mainFrame', 'script', 'stylesheet', 'image', 'font'].includes(details.resourceType)
        if (['data:', 'blob:'].includes(target.protocol)) permitted = ['image', 'font'].includes(details.resourceType)
      } catch { /* Invalid targets are denied. */ }
      callback({ cancel: !permitted })
    })
    const view = new WebContentsView({ webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false } })
    this.view = view; this.instance = identity(instance); this.owner = owner; this.revision = 0
    const closeOwned = () => { if (this.epoch === epoch) void this.close().catch(() => {}) }
    const hideOwned = () => { if (this.epoch === epoch && !view.webContents.isDestroyed()) view.setVisible(false) }
    const ownerNavigate = (_event: Electron.Event, _url: string, inPlace: boolean, mainFrame: boolean) => { if (mainFrame && !inPlace) closeOwned() }
    owner.on('closed', closeOwned); owner.on('minimize', hideOwned); owner.on('resize', hideOwned)
    owner.webContents.on('did-start-navigation', ownerNavigate); owner.webContents.on('render-process-gone', closeOwned); owner.webContents.on('destroyed', closeOwned)
    this.releaseOwner = () => {
      owner.removeListener('closed', closeOwned); owner.removeListener('minimize', hideOwned); owner.removeListener('resize', hideOwned)
      owner.webContents.removeListener('did-start-navigation', ownerNavigate); owner.webContents.removeListener('render-process-gone', closeOwned); owner.webContents.removeListener('destroyed', closeOwned)
    }
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    const allowed = (target: string) => { try { const next = new URL(target); return next.origin === url.origin && !next.username && !next.password } catch { return false } }
    view.webContents.on('will-navigate', (event, target) => { if (!allowed(target)) event.preventDefault() })
    view.webContents.on('will-redirect', (event, target) => { if (!allowed(target)) event.preventDefault() })
    view.webContents.on('will-attach-webview', event => event.preventDefault())
    view.webContents.on('render-process-gone', closeOwned)
    view.setVisible(false); owner.contentView.addChildView(view)
    try {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([view.webContents.loadURL(url.href), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Preview load timed out')), 20_000) })])
      } finally { clearTimeout(timer) }
      if (this.epoch !== epoch || this.view !== view) throw new Error('Preview instance was replaced')
    } catch (error) { if (this.epoch === epoch) await this.close(); throw error }
  }

  /** Navigate only the selected live view within its Host-registered origin. */
  async navigate(owner: BrowserWindow, instance: StudioPreviewInstance, path?: string): Promise<void> {
    if (!this.isOpen(owner, instance) || !this.view) throw new Error('Preview is not mounted')
    if (path === undefined) { this.view.webContents.reload(); return }
    const origin = previewUrl(instance)
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('\\')) throw new Error('Invalid preview path')
    const target = new URL(path, origin)
    if (target.origin !== origin.origin || target.username || target.password) throw new Error('Invalid preview path')
    await this.view.webContents.loadURL(target.href)
  }

  /** Show only a matching live instance, and ignore stale layout messages. */
  isOpen(owner: BrowserWindow, selected: StudioPreviewIdentity): boolean {
    return !!this.view && !this.view.webContents.isDestroyed() && this.owner === owner && !!this.instance && samePreviewIdentity(this.instance, selected)
  }
  layout(selected: StudioPreviewIdentity, sequence: number, visible: boolean, bounds: StudioPreviewBounds): void {
    if (!this.view || !this.owner || !this.instance || !samePreviewIdentity(selected, this.instance)) throw new Error('Preview identity changed')
    if (!Number.isSafeInteger(sequence) || sequence <= this.revision) throw new Error('Stale preview layout')
    const rect = boundsFor(this.owner, bounds)
    this.revision = sequence
    this.view.setBounds(rect)
    this.view.setVisible(visible && !this.owner.isMinimized() && rect.width > 0 && rect.height > 0)
  }

  /** Destroy the view and its non-persistent session without touching the Host preview process. */
  async close(): Promise<void> {
    this.epoch++
    const view = this.view, owner = this.owner
    this.view = undefined; this.owner = undefined; this.instance = undefined
    this.releaseOwner?.(); this.releaseOwner = undefined
    if (!view) return
    if (owner && !owner.isDestroyed()) owner.contentView.removeChildView(view)
    const isolated: Session = view.webContents.session
    const destroyed = new Promise<void>(resolve => {
      if (view.webContents.isDestroyed()) resolve()
      else { view.webContents.once('destroyed', resolve); view.webContents.close({ waitForBeforeUnload: false }) }
    })
    const cleanup = destroyed.then(async () => {
      isolated.webRequest.onBeforeRequest(null)
      await isolated.closeAllConnections()
      await Promise.all([isolated.clearStorageData(), isolated.clearCache(), isolated.clearAuthCache()])
    })
    this.cleanups.add(cleanup)
    try { await cleanup } catch (error) { this.cleanupFailures.push(error); throw error } finally { this.cleanups.delete(cleanup) }
  }
  async dispose(): Promise<void> {
    this.disposed = true
    await this.close().catch(() => {})
    await Promise.allSettled(this.cleanups)
    if (this.cleanupFailures.length) throw new AggregateError(this.cleanupFailures, 'Preview session cleanup failed')
  }
}
