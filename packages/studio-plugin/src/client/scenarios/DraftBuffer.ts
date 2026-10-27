import type { MaterialDraft, MaterialMetadata } from '../../shared/studio.ts'

export interface DraftInput { body: string; metadata: MaterialMetadata }
/** One external file version the buffer loaded over input this page had not saved. */
export interface DraftExternalUpdate { draft: MaterialDraft; replaced: DraftInput; dirty: boolean }
export interface DraftSnapshot extends DraftInput {
  sha256: string; dirty: boolean; saving: boolean; error: string;
  /** The latest external version, offered back to the author while nothing is unsaved. */
  external?: MaterialDraft | undefined;
  /** External versions that replaced input this page had not saved yet. */
  externalUpdates: DraftExternalUpdate[];
}
export type SaveDraft = (input: DraftInput & { operationId: string }) => Promise<MaterialDraft>
const sameInput = (a: DraftInput, b: DraftInput) => a.body === b.body && JSON.stringify(a.metadata) === JSON.stringify(b.metadata)
export { sameInput as sameDraftInput }

/** Keeps every page edit and still loads the file's latest bytes, never one at the cost of the other. */
export class DraftBuffer {
  private snapshot: DraftSnapshot
  private saved: MaterialDraft
  private listeners = new Set<() => void>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private pending: Promise<boolean> | undefined
  private operation: { input: DraftInput; operationId: string } | undefined
  private explicitObserved: MaterialDraft[] | undefined
  private save: SaveDraft
  private delay: number
  constructor(draft: MaterialDraft, save: SaveDraft, delay = 800) {
    this.save = save; this.delay = delay
    this.saved = draft
    this.snapshot = { body: draft.body, metadata: draft.metadata, sha256: draft.sha256, dirty: false, saving: false, error: '', externalUpdates: [] }
  }
  getSnapshot = (): DraftSnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(next: DraftSnapshot) { this.snapshot = next; for (const listener of this.listeners) listener() }
  edit(input: DraftInput): void {
    this.publish({ ...this.snapshot, ...input, dirty: !sameInput(input, this.saved), error: '' })
    this.schedule()
  }
  /**
   * Applies the file's current bytes, whether the workbench wrote them or
   * another program did. Unsaved input is kept as an undo step instead of
   * blocking the load, and the newest copy stays available as `external`.
   */
  receive(draft: MaterialDraft): void {
    const current = this.snapshot
    if (draft.sha256 === this.saved.sha256 && !current.external) return
    this.explicitObserved?.push(draft)
    if (current.saving && this.operation && sameInput(draft, this.operation.input)) return
    const keep = current.dirty && !sameInput(current, draft)
    const externalUpdates = keep ? [...current.externalUpdates, { draft, replaced: { body: current.body, metadata: current.metadata }, dirty: true }].slice(-20) : current.externalUpdates
    this.cancelTimer(); this.saved = draft
    this.publish({ body: draft.body, metadata: draft.metadata, sha256: draft.sha256, dirty: false, saving: false, error: '', externalUpdates, external: keep ? draft : undefined })
  }
  private cancelTimer() { if (this.timer) clearTimeout(this.timer); this.timer = undefined }
  private schedule() {
    this.cancelTimer()
    if (this.snapshot.dirty) this.timer = setTimeout(() => { void this.flush() }, this.delay)
  }
  /** Gives an explicit write the next turn without starting another automatic save. */
  async prepareWrite(): Promise<void> {
    this.cancelTimer()
    while (this.pending) await this.pending
    this.cancelTimer()
    this.explicitObserved = []
  }
  /** Ends an explicit command that did not produce an acknowledged document. */
  finishWrite(): void { this.explicitObserved = undefined }
  /** Resolves only after the latest input is saved; false keeps navigation and confirmation in place. */
  flush = async (): Promise<boolean> => {
    this.cancelTimer()
    if (this.pending) { const completed = await this.pending; return completed ? this.flush() : false }
    if (!this.snapshot.dirty) return true
    this.pending = this.write()
    const completed = await this.pending
    this.pending = undefined
    return completed && this.snapshot.dirty ? this.flush() : completed
  }
  private async write(): Promise<boolean> {
    const input = { body: this.snapshot.body, metadata: this.snapshot.metadata }
    if (!this.operation || !sameInput(input, this.operation.input)) this.operation = { input, operationId: crypto.randomUUID() }
    this.publish({ ...this.snapshot, saving: true, error: '' })
    try {
      const draft = await this.save({ ...input, operationId: this.operation.operationId })
      this.acknowledge(draft, input)
      return true
    } catch (error) {
      this.publish({ ...this.snapshot, saving: false, error: error instanceof Error ? error.message : '本地保存失败，输入已保留。' })
      return false
    }
  }
  /** Acknowledges exact submitted input while preserving edits or external changes observed during the write. */
  acknowledge(draft: MaterialDraft, input: DraftInput): void {
    const observed = this.explicitObserved?.findLast(value => value.sha256 !== draft.sha256)
    this.finishWrite()
    this.saved = draft
    this.operation = undefined
    const external = observed ?? this.snapshot.external
    const newest = external?.sha256 === draft.sha256 ? undefined : external
    const inputNow = sameInput(this.snapshot, input) ? { body: draft.body, metadata: draft.metadata } : this.snapshot
    this.publish({ ...this.snapshot, ...inputNow, sha256: draft.sha256, saving: false, dirty: !sameInput(inputNow, draft), external: newest })
    // The file holds bytes newer than this write: show them instead of saving over them again.
    if (newest) this.receive(newest)
  }
  /** Restores the durable input of a save that did not finish, against the file's actual hash. */
  restoreInput(input: DraftInput): void {
    this.cancelTimer()
    this.publish({ ...this.snapshot, ...input, dirty: !sameInput(input, this.saved) })
  }
  /** An explicit command that rewrote the file supplies the accepted version. */
  accept(draft: MaterialDraft): void {
    this.cancelTimer(); this.saved = draft; this.operation = undefined
    this.publish({ body: draft.body, metadata: draft.metadata, sha256: draft.sha256, dirty: false, saving: false, error: '', externalUpdates: [], external: undefined })
  }
  /** Discards loaded external versions; the disk content stays the saved version. */
  clearExternal(): void { if (this.snapshot.external || this.snapshot.externalUpdates.length) this.publish({ ...this.snapshot, external: undefined, externalUpdates: [] }) }
  /** Puts the input an external version replaced back into the editor; the file itself is untouched. */
  undoExternal(update: DraftExternalUpdate): void {
    const kept = this.snapshot.externalUpdates.filter(value => value !== update)
    this.cancelTimer()
    this.publish({ ...this.snapshot, ...update.replaced, dirty: update.dirty, externalUpdates: kept, ...(kept.length ? {} : { external: undefined }) })
  }
  dispose(): void { this.cancelTimer(); this.listeners.clear() }
}
