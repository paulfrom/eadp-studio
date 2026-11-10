import type { RequirementDocument } from '@eadp/contracts'

/** Why the panel must show a message; Host text stays verbatim in `message`. */
export type DraftError =
  | { code: 'retained' }
  | { code: 'failed'; message: string }

/** One editor's unpersisted input and its last acknowledged file version. */
export interface DraftSnapshot {
  text: string
  version: string | null
  dirty: boolean
  saving: boolean
  composing: boolean
  applying: boolean
  error: DraftError | null
  recovery: PersistedDraft | null
  recoveryLoading: boolean
  persistenceError: string | null
  external: RequirementDocument | null | undefined
}
/** Durable input is separate from the acknowledged file. */
export interface PersistedDraft { text: string; baseVersion: string | null }
export interface DraftPersistence { read(): Promise<PersistedDraft | null>; save(draft: PersistedDraft | null): Promise<void> }
export interface PreparedWrite { text: string; version: string | null; revision: number }
export type SaveDraft = (text: string, version: string | null) => Promise<RequirementDocument>

function failure(error: unknown): DraftError {
  return { code: 'failed', message: error instanceof Error ? error.message : String(error) }
}

/** Serializes versioned saves without replacing input entered during a request. */
export class DraftBuffer {
  private snapshot: DraftSnapshot
  private revision = 0
  private savedText: string
  private timer: ReturnType<typeof setTimeout> | undefined
  private pending: Promise<boolean> | undefined
  private persistenceQueue: Promise<void> = Promise.resolve()
  private recoveryReadFailed = false
  private readonly listeners = new Set<() => void>()

  constructor(document: RequirementDocument | null, private readonly save: SaveDraft, private readonly read: () => Promise<RequirementDocument | null>, private readonly delay = 800, private readonly persistence?: DraftPersistence) {
    this.savedText = document?.text ?? ''
    this.snapshot = { text: this.savedText, version: document?.version ?? null, dirty: false, saving: false, composing: false, applying: false, error: null, external: undefined, recovery: null, recoveryLoading: !!persistence, persistenceError: null }
    if (persistence) void this.loadRecovery()
  }
  getSnapshot = (): DraftSnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(next: DraftSnapshot): void { this.snapshot = next; for (const listener of this.listeners) listener() }
  private async loadRecovery(): Promise<void> {
    try {
      const recovery = await this.persistence!.read()
      this.publish({ ...this.snapshot, recoveryLoading: false, recovery: recovery && recovery.text !== this.savedText ? recovery : null })
      // A crash may occur after the file write but before clearing its draft.
      // Remove only a record already equal to the acknowledged file content.
      if (!this.snapshot.recovery) this.persist()
    } catch (error) { this.recoveryReadFailed = true; this.publish({ ...this.snapshot, recoveryLoading: false, persistenceError: String(error) }) }
  }
  /** Serialize draft writes and clears so an acknowledgement cannot delete later input. */
  private persist(): void {
    if (!this.persistence || this.recoveryReadFailed || this.snapshot.recoveryLoading || this.snapshot.recovery) return
    const draft = this.snapshot.dirty ? { text: this.snapshot.text, baseVersion: this.snapshot.version } : null
    this.persistenceQueue = this.persistenceQueue.catch(() => undefined).then(async () => { await this.persistence!.save(draft); this.publish({ ...this.snapshot, persistenceError: null }) }).catch(error => { this.publish({ ...this.snapshot, persistenceError: String(error) }) })
  }
  recoverDraft(): void {
    if (!this.snapshot.recovery || this.snapshot.saving || this.snapshot.applying || this.snapshot.composing) return
    this.cancelTimer()
    const recovery = this.snapshot.recovery
    this.revision += 1
    this.publish({ ...this.snapshot, text: recovery.text, version: recovery.baseVersion, dirty: recovery.text !== this.savedText, recovery: null, error: null })
    this.persist()
  }
  discardRecovery(): void {
    if (!this.snapshot.recovery) return
    this.publish({ ...this.snapshot, recovery: null })
    this.persist()
    this.schedule()
  }
  /** Explicit abandonment clears durable input after all queued writes settle. */
  async discardPersisted(): Promise<void> {
    this.cancelTimer()
    await this.persistenceQueue
    await this.persistence?.save(null)
  }
  private cancelTimer(): void { if (this.timer !== undefined) clearTimeout(this.timer); this.timer = undefined }
  private schedule(): void {
    this.cancelTimer()
    if (this.snapshot.dirty && !this.snapshot.recoveryLoading && !this.snapshot.recovery && !this.snapshot.applying && !this.snapshot.composing && this.snapshot.external === undefined) this.timer = setTimeout(() => { void this.flush() }, this.delay)
  }
  reportError(message: string): void { this.publish({ ...this.snapshot, error: { code: 'failed', message } }) }
  edit(text: string): void {
    this.revision += 1
    this.publish({ ...this.snapshot, text, dirty: text !== this.savedText, error: null })
    this.persist()
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
    this.publish({ ...this.snapshot, text: this.savedText, version: document?.version ?? null, dirty: false, error: null, external: undefined })
  }
  /** User explicitly chooses the observed disk content; no write is performed. */
  loadExternal(): void {
    if (this.snapshot.external === undefined || this.snapshot.applying || this.snapshot.composing || this.snapshot.saving) return
    this.accept(this.snapshot.external)
    this.persist()
  }
  /** Keep input against the observed version; a later save still checks that version. */
  keepDraft(): void {
    if (this.snapshot.external === undefined || this.snapshot.applying || this.snapshot.composing || this.snapshot.saving) return
    const external = this.snapshot.external
    // A removed requirement is recreated only through the explicit recreate action.
    if (!external) return
    this.savedText = external.text
    this.publish({ ...this.snapshot, version: external.version, dirty: this.snapshot.text !== external.text, external: undefined, error: null })
    this.persist()
    this.schedule()
  }
  /** Save now; joins an in-flight write and debounces the retry when input arrives mid-write. */
  flush = async (): Promise<boolean> => {
    this.cancelTimer()
    // Unchosen recovered input remains durable; browsing another file does not discard it.
    if (this.snapshot.recovery && !this.snapshot.dirty) return true
    if (this.snapshot.recoveryLoading || this.snapshot.recovery || this.snapshot.applying || this.snapshot.composing || this.snapshot.external !== undefined) return false
    if (this.pending) return this.pending
    if (!this.snapshot.dirty) return true
    this.pending = this.write().then(ok => {
      if (!ok) return false
      // Input received during the write keeps the buffer dirty; retry through the
      // normal debounce instead of writing again immediately.
      if (this.snapshot.dirty) { this.schedule(); return false }
      return true
    }).finally(() => { this.pending = undefined })
    return this.pending
  }
  /** Pause automatic writes before waiting, then require unchanged clean input. */
  async prepareWrite(): Promise<PreparedWrite | undefined> {
    if (this.snapshot.recoveryLoading || this.snapshot.recovery || this.snapshot.applying) return undefined
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
      error: changed ? { code: 'retained' } : null })
    this.persist()
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
    this.publish({ ...this.snapshot, saving: true, error: null })
    try {
      let saved: RequirementDocument
      try { saved = await save(text, version) }
      catch (error) {
        // A lost acknowledgement can be reconciled only against the exact bytes submitted.
        const observed = await this.read().catch(() => undefined)
        if (observed && observed.text === text) saved = observed
        else {
          // Synchronize the observed disk state first, then surface the failure: the
          // panel must show both the conflict and the Host error.
          this.publish({ ...this.snapshot, saving: false })
          if (observed !== undefined) this.receive(observed)
          this.publish({ ...this.snapshot, error: failure(error) })
          return false
        }
      }
      this.savedText = saved.text
      this.publish({ ...this.snapshot, version: saved.version, dirty: this.snapshot.text !== saved.text, saving: false, error: null, external: undefined })
      this.persist()
      return true
    } catch (error) {
      this.publish({ ...this.snapshot, saving: false, error: failure(error) })
      return false
    }
  }
  dispose(): void {
    this.cancelTimer()
    this.snapshot = { ...this.snapshot, composing: false }
    this.listeners.clear()
  }
}
