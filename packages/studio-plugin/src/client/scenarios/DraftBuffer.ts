import type { MaterialDraft, MaterialMetadata } from '../../shared/studio.ts'

export interface DraftInput { body: string; metadata: MaterialMetadata }
export interface DraftSnapshot extends DraftInput {
  sha256: string; dirty: boolean; saving: boolean; error: string; conflict: MaterialDraft | undefined
}
export type SaveDraft = (input: DraftInput & { expectedHash: string; operationId: string }) => Promise<MaterialDraft>
const sameInput = (a: DraftInput, b: DraftInput) => a.body === b.body && JSON.stringify(a.metadata) === JSON.stringify(b.metadata)
export { sameInput as sameDraftInput }

/** Keeps unsaved input across projections and serializes writes against the last acknowledged hash. */
export class DraftBuffer {
  private snapshot: DraftSnapshot
  private saved: MaterialDraft
  private listeners = new Set<() => void>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private pending: Promise<boolean> | undefined
  private operation: { input: DraftInput; expectedHash: string; operationId: string } | undefined
  private explicitObserved: MaterialDraft[] | undefined
  private save: SaveDraft
  private delay: number
  constructor(draft: MaterialDraft, save: SaveDraft, delay = 800) {
    this.save = save; this.delay = delay
    this.saved = draft
    this.snapshot = { body: draft.body, metadata: draft.metadata, sha256: draft.sha256, dirty: false, saving: false, error: '', conflict: undefined }
  }
  getSnapshot = (): DraftSnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(next: DraftSnapshot) { this.snapshot = next; for (const listener of this.listeners) listener() }
  edit(input: DraftInput): void {
    this.publish({ ...this.snapshot, ...input, dirty: !sameInput(input, this.saved), error: '' })
    this.schedule()
  }
  receive(draft: MaterialDraft): void {
    if (draft.sha256 === this.saved.sha256) return
    this.explicitObserved?.push(draft)
    if (this.snapshot.saving && this.operation && sameInput(draft, this.operation.input)) return
    if (this.snapshot.dirty || this.snapshot.saving) {
      this.cancelTimer()
      this.publish({ ...this.snapshot, conflict: draft, error: '文件已发生外部变化，请合并两份内容后保存。' })
    } else {
      this.saved = draft
      this.publish({ body: draft.body, metadata: draft.metadata, sha256: draft.sha256, dirty: false, saving: false, error: '', conflict: undefined })
    }
  }
  private cancelTimer() { if (this.timer) clearTimeout(this.timer); this.timer = undefined }
  private schedule() {
    this.cancelTimer()
    if (this.snapshot.dirty && !this.snapshot.conflict) this.timer = setTimeout(() => { void this.flush() }, this.delay)
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
    if (this.snapshot.conflict) return false
    if (!this.snapshot.dirty) return true
    this.pending = this.write()
    const completed = await this.pending
    this.pending = undefined
    return completed && this.snapshot.dirty ? this.flush() : completed
  }
  private async write(): Promise<boolean> {
    const input = { body: this.snapshot.body, metadata: this.snapshot.metadata }
    if (!this.operation || !sameInput(input, this.operation.input) || this.operation.expectedHash !== this.saved.sha256) {
      this.operation = { input, expectedHash: this.saved.sha256, operationId: crypto.randomUUID() }
    }
    this.publish({ ...this.snapshot, saving: true, error: '' })
    try {
      const draft = await this.save({ ...input, expectedHash: this.operation.expectedHash, operationId: this.operation.operationId })
      this.acknowledge(draft, input)
      return !this.snapshot.conflict
    } catch (error) {
      this.publish({ ...this.snapshot, saving: false, error: error instanceof Error ? error.message : '本地保存失败，输入已保留。' })
      return false
    }
  }
  /** Acknowledges exact submitted input while preserving edits or external changes observed during the write. */
  acknowledge(draft: MaterialDraft, input: DraftInput, resolvedHash?: string): void {
    this.saved = draft
    this.operation = undefined
    const observed = this.explicitObserved?.findLast(value => value.sha256 !== draft.sha256 && value.sha256 !== resolvedHash)
    this.finishWrite()
    const candidate = observed ?? this.snapshot.conflict
    const conflict = candidate?.sha256 === draft.sha256 || candidate?.sha256 === resolvedHash ? undefined : candidate
    const inputNow = sameInput(this.snapshot, input) ? { body: draft.body, metadata: draft.metadata } : this.snapshot
    this.publish({ ...this.snapshot, ...inputNow, sha256: draft.sha256, saving: false, dirty: !sameInput(inputNow, draft), error: conflict ? '文件已发生外部变化，请合并两份内容后保存。' : '', conflict })
  }
  /** Restores durable unsaved input against the actual file hash without scheduling an implicit write. */
  restoreInput(input: DraftInput, conflict?: MaterialDraft): void {
    this.cancelTimer()
    this.publish({ ...this.snapshot, ...input, dirty: !sameInput(input, this.saved), conflict, error: conflict ? '请选择要保留的内容，或合并后继续保存。' : '' })
  }
  /** An explicit conflict resolution supplies the newly accepted version; it never resumes repair authority. */
  accept(draft: MaterialDraft): void {
    this.cancelTimer(); this.saved = draft; this.operation = undefined
    this.publish({ body: draft.body, metadata: draft.metadata, sha256: draft.sha256, dirty: false, saving: false, error: '', conflict: undefined })
  }
  dispose(): void { this.cancelTimer(); this.listeners.clear() }
}
