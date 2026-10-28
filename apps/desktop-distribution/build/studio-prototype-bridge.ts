import type { ChildProcess } from 'node:child_process'
import type { BrowserWindow } from 'electron'
import { StudioPrototypeView, previewUrl, samePreviewIdentity, type StudioPreviewBounds, type StudioPreviewIdentity, type StudioPreviewInstance } from './studio-prototype-view.ts'

export const STUDIO_PROTOTYPE_LAYOUT = 'studio-prototype:layout'
type HostRequest = { type: 'studio-prototype-register'; requestId: string; instance: StudioPreviewInstance }
  | { type: 'studio-prototype-select'; requestId: string; identity: StudioPreviewIdentity }
  | { type: 'studio-prototype-revoke'; requestId: string; identity: StudioPreviewIdentity }
  | { type: 'studio-prototype-clear'; requestId: string }
  | { type: 'studio-prototype-deselect'; requestId: string }

/** Only the owned Host child may register an origin or change the selected instance. */
class PrototypeBridge {
  private readonly native = new StudioPrototypeView()
  private readonly instances = new Map<string, StudioPreviewInstance>()
  private child: ChildProcess | undefined
  private selected: StudioPreviewIdentity | undefined
  private mounted: StudioPreviewIdentity | undefined
  private work: Promise<unknown> = Promise.resolve()

  private validIdentity(value: unknown): StudioPreviewIdentity {
    if (!value || typeof value !== 'object') throw new Error('Invalid preview identity')
    const candidate = value as StudioPreviewIdentity
    // Identity validation uses the same strict rules as the view; the URL here is not registered.
    previewUrl({ ...candidate, url: 'http://127.0.0.1:1/' })
    return candidate
  }
  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.work.catch(() => {}).then(action)
    this.work = operation
    return operation
  }
  isRequest(value: unknown): value is HostRequest {
    if (!value || typeof value !== 'object') return false
    const candidate = value as Record<string, unknown>
    return typeof candidate.type === 'string' && ['studio-prototype-register', 'studio-prototype-select', 'studio-prototype-revoke', 'studio-prototype-clear', 'studio-prototype-deselect'].includes(candidate.type)
  }
  handle(child: ChildProcess, request: HostRequest): void {
    const reply = (ok: boolean) => { if (child.connected && typeof request.requestId === 'string') child.send({ type: 'studio-prototype-result', requestId: request.requestId, ok }, () => {}) }
    // Invalidate the visible view immediately, even while an earlier load is pending.
    if (this.child === child && request.type !== 'studio-prototype-register') {
      let invalidate = request.type === 'studio-prototype-clear' || request.type === 'studio-prototype-deselect'
      if ((request.type === 'studio-prototype-select' || request.type === 'studio-prototype-revoke') && this.selected) {
        try { const id = this.validIdentity(request.identity); invalidate = request.type === 'studio-prototype-select' ? !samePreviewIdentity(this.selected, id) : samePreviewIdentity(this.selected, id) } catch { /* Validation below reports the invalid request. */ }
      }
      if (invalidate) { this.selected = undefined; this.mounted = undefined; void this.native.close().catch(() => {}) }
    }
    void this.enqueue(async () => {
      if (!/^[a-f0-9-]{36}$/.test(request.requestId)) throw new Error('Invalid request identity')
      if (!this.child) {
        this.child = child
        child.once('close', () => { if (this.child === child) void this.enqueue(() => this.clear(child)).catch(() => {}) })
      }
      if (this.child !== child || !child.connected) throw new Error('Host is not current')
      if (request.type === 'studio-prototype-clear') { await this.clear(child); return }
      if (request.type === 'studio-prototype-deselect') { this.selected = undefined; this.mounted = undefined; await this.native.close(); return }
      if (request.type === 'studio-prototype-register') {
        previewUrl(request.instance)
        const item = structuredClone(request.instance), previous = this.instances.get(item.previewId)
        if (previous && (!samePreviewIdentity(previous, item) || previous.url !== item.url)) throw new Error('Preview ID already registered')
        this.instances.set(item.previewId, item); return
      }
      const id = this.validIdentity(request.identity), registered = this.instances.get(id.previewId)
      if (!registered && request.type === 'studio-prototype-revoke') return
      if (!registered || !samePreviewIdentity(id, registered)) throw new Error('Preview not registered')
      if (request.type === 'studio-prototype-revoke') {
        this.instances.delete(id.previewId)
        if (this.selected && samePreviewIdentity(this.selected, id)) { this.selected = undefined; this.mounted = undefined; await this.native.close() }
        return
      }
      if (!this.selected || !samePreviewIdentity(this.selected, id)) { this.mounted = undefined; await this.native.close() }
      this.selected = structuredClone(id)
    }).then(() => reply(true), () => reply(false))
  }
  private async clear(child: ChildProcess): Promise<void> {
    if (this.child !== child) return
    this.instances.clear(); this.child = undefined; this.selected = undefined; this.mounted = undefined
    await this.native.close()
  }
  /** Caller must verify the owning top-level application frame before reaching this method. */
  layout(owner: BrowserWindow, value: unknown): Promise<void> {
    return this.enqueue(async () => {
      if (!value || typeof value !== 'object') throw new Error('Invalid preview layout')
      const request = value as { identity: unknown; sequence: number; visible: boolean; bounds: StudioPreviewBounds }
      const id = this.validIdentity(request.identity)
      const selected = this.selected, registered = this.instances.get(id.previewId)
      if (!selected || !registered || !samePreviewIdentity(id, selected) || !samePreviewIdentity(id, registered) || typeof request.visible !== 'boolean') throw new Error('Preview is not selected')
      if (!this.mounted || !samePreviewIdentity(this.mounted, id) || !this.native.isOpen(owner, id)) {
        if (!request.visible) return
        await this.native.open(owner, registered)
        if (!this.selected || !samePreviewIdentity(this.selected, id)) { await this.native.close(); throw new Error('Preview selection changed') }
        this.mounted = structuredClone(id)
      }
      this.native.layout(id, request.sequence, request.visible, request.bounds)
    })
  }
  async dispose(): Promise<void> { this.instances.clear(); this.selected = undefined; this.mounted = undefined; this.child = undefined; await this.native.dispose() }
}

export const studioPrototypeBridge = new PrototypeBridge()
