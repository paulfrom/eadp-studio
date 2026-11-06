import type { RequirementDocument } from '@eadp/contracts'

/** One editor's unpersisted input and its last acknowledged file version. */
export interface DraftSnapshot {
  text: string
  version: string | null
  dirty: boolean
  saving: boolean
  composing: boolean
  applying: boolean
  error: string
  external: RequirementDocument | null | undefined
}
export interface PreparedWrite { text: string; version: string | null; revision: number }
export type SaveDraft = (text: string, version: string | null) => Promise<RequirementDocument>

/** Serializes versioned saves without replacing input entered during a request. */
export class DraftBuffer {
  private snapshot: DraftSnapshot
  private revision = 0
  private savedText: string
  private timer: ReturnType<typeof setTimeout> | undefined
  private pending: Promise<boolean> | undefined
  private readonly listeners = new Set<() => void>()

  constructor(document: RequirementDocument | null, private readonly save: SaveDraft, private readonly read: () => Promise<RequirementDocument | null>, private readonly delay = 800) {
    this.savedText = document?.text ?? ''
    this.snapshot = { text: this.savedText, version: document?.version ?? null, dirty: false, saving: false, composing: false, applying: false, error: '', external: undefined }
  }
  getSnapshot = (): DraftSnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(next: DraftSnapshot): void { this.snapshot = next; for (const listener of this.listeners) listener() }
  private cancelTimer(): void { if (this.timer !== undefined) clearTimeout(this.timer); this.timer = undefined }
  private schedule(): void {
    this.cancelTimer()
    if (this.snapshot.dirty && !this.snapshot.applying && !this.snapshot.composing && this.snapshot.external === undefined) this.timer = setTimeout(() => { void this.flush() }, this.delay)
  }
  reportError(error: string): void { this.publish({ ...this.snapshot, error }) }
  edit(text: string): void {
    this.revision += 1
    this.publish({ ...this.snapshot, text, dirty: text !== this.savedText, error: '' })
    this.schedule()
  }
  compose(composing: boolean): void {
    this.publish({ ...this.snapshot, composing })
    if (composing) this.cancelTimer(); else this.schedule()
  }
  /** Clean editors reload; dirty editors keep their exact input and offer an explicit choice. */
  receive(document: RequirementDocument | null): void {
    if (this.snapshot.saving || document?.version === this.snapshot.version || (!document && this.snapshot.version === null)) return
    this.cancelTimer()
    if (document === null || this.snapshot.dirty || this.snapshot.composing || this.snapshot.applying) {
      this.publish({ ...this.snapshot, external: document })
      return
    }
    this.accept(document)
  }
  private accept(document: RequirementDocument | null): void {
    this.savedText = document?.text ?? ''
    this.publish({ ...this.snapshot, text: this.savedText, version: document?.version ?? null, dirty: false, error: '', external: undefined })
  }
  /** User explicitly chooses the observed disk content; no write is performed. */
  loadExternal(): void {
    if (this.snapshot.external === undefined || this.snapshot.applying || this.snapshot.composing || this.snapshot.saving) return
    this.accept(this.snapshot.external)
  }
  /** Keep input against the observed version; a later save still checks that version. */
  keepDraft(): void {
    if (this.snapshot.external === undefined || this.snapshot.applying || this.snapshot.composing || this.snapshot.saving) return
    const external = this.snapshot.external
    // A removed requirement is not silently recreated by an update save.
    if (!external) { this.publish({ ...this.snapshot, error: '文件已被删除，请保留输入并重新创建文件。' }); return }
    this.savedText = external.text
    this.publish({ ...this.snapshot, version: external.version, dirty: this.snapshot.text !== external.text, external: undefined, error: '' })
    this.schedule()
  }
  flush = async (): Promise<boolean> => {
    this.cancelTimer()
    if (this.snapshot.applying || this.snapshot.composing || this.snapshot.external !== undefined) return false
    if (this.pending) { const ok = await this.pending; return ok ? this.flush() : false }
    if (!this.snapshot.dirty) return true
    this.pending = this.write()
    const ok = await this.pending
    this.pending = undefined
    if (!ok || this.snapshot.applying || this.snapshot.composing || this.snapshot.external !== undefined) return false
    return this.snapshot.dirty ? this.flush() : !this.snapshot.saving
  }
  /** Pause automatic writes before waiting, then require unchanged clean input. */
  async prepareWrite(): Promise<PreparedWrite | undefined> {
    if (this.snapshot.applying) return undefined
    const revision = this.revision
    this.cancelTimer()
    this.publish({ ...this.snapshot, applying: true })
    const pending = this.pending
    if (pending && !await pending) { this.finishWrite(); return undefined }
    this.cancelTimer()
    if (this.revision !== revision || this.snapshot.dirty || this.snapshot.composing || this.snapshot.external !== undefined || this.snapshot.saving) { this.finishWrite(); return undefined }
    return { text: this.snapshot.text, version: this.snapshot.version, revision }
  }
  matchesPrepared(prepared: PreparedWrite): boolean {
    return this.snapshot.applying && !this.snapshot.dirty && !this.snapshot.composing && !this.snapshot.saving
      && this.snapshot.external === undefined && this.snapshot.version === prepared.version && this.revision === prepared.revision
  }
  /** Apply the Host acknowledgement without overwriting edits made during the request. */
  acknowledgeWrite(document: RequirementDocument, prepared: PreparedWrite): void {
    const changed = this.revision !== prepared.revision || this.snapshot.composing
    const text = changed ? this.snapshot.text : document.text
    const external = this.snapshot.external
    this.savedText = document.text
    this.publish({ ...this.snapshot, text, version: document.version, dirty: text !== document.text,
      external: external?.version === document.version ? undefined : external,
      error: changed ? '提案已写入磁盘，应用期间输入已保留为草稿。' : '' })
  }
  /** Resume automatic saving only after the explicit write has settled. */
  finishWrite(): void {
    this.publish({ ...this.snapshot, applying: false })
    this.schedule()
  }
  /** Recreating a removed file requires a distinct explicit user action. */
  async recreate(create: (text: string) => Promise<RequirementDocument>): Promise<boolean> {
    this.cancelTimer()
    if (this.pending || this.snapshot.applying || this.snapshot.composing || this.snapshot.external !== null) return false
    this.pending = this.write(text => create(text))
    const ok = await this.pending
    this.pending = undefined
    if (ok) this.schedule()
    return ok
  }
  private async write(save: SaveDraft = this.save): Promise<boolean> {
    const text = this.snapshot.text
    const version = this.snapshot.version
    this.publish({ ...this.snapshot, saving: true, error: '' })
    try {
      let saved: RequirementDocument
      try { saved = await save(text, version) }
      catch (error) {
        // A lost acknowledgement can be reconciled only against the exact bytes submitted.
        const observed = await this.read().catch(() => undefined)
        if (observed && observed.text === text) saved = observed
        else {
          this.publish({ ...this.snapshot, saving: false, error: error instanceof Error ? error.message : String(error) })
          if (observed !== undefined) this.receive(observed)
          return false
        }
      }
      this.savedText = saved.text
      this.publish({ ...this.snapshot, version: saved.version, dirty: this.snapshot.text !== saved.text, saving: false, error: '', external: undefined })
      return true
    } catch (error) {
      this.publish({ ...this.snapshot, saving: false, error: error instanceof Error ? error.message : String(error) })
      return false
    }
  }
  dispose(): void { this.cancelTimer(); this.listeners.clear() }
}
