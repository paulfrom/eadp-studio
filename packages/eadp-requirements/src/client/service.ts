import { Service, type Context } from '@deepseek-ai/cordis'
import type { EadpRequirementsClient } from '@eadp/contracts'
import type { DraftBuffer } from './DraftBuffer.ts'

/** Why a project's pending input blocks navigation; the panel localizes the reason. */
export type FlushFailure = 'composing' | 'conflict' | 'missing' | 'saving' | 'failed'

export interface FlushResult {
  ok: boolean
  reason?: FlushFailure
  /** Host failure text when a save failed. */
  message?: string
}

/** Retains unsaved editor memory per project and path while views are unmounted. */
export class RequirementsClientService extends Service implements EadpRequirementsClient {
  private readonly buffers = new Map<string, Map<string, DraftBuffer>>()
  /** Document each project last opened, so a remounted panel restores the same selection. */
  private readonly documents = new Map<string, string>()
  constructor(ctx: Context) {
    super(ctx, 'eadpRequirementsClient')
    ctx.effect(() => () => {
      for (const project of this.buffers.values()) for (const buffer of project.values()) buffer.dispose()
      this.buffers.clear()
      this.documents.clear()
    }, 'eadp-requirements: drafts')
  }
  /** Returns the buffer only when this project currently retains that path. */
  get(projectId: string, path: string): DraftBuffer | undefined { return this.buffers.get(projectId)?.get(path) }
  register(projectId: string, path: string, buffer: DraftBuffer): void {
    const project = this.buffers.get(projectId) ?? new Map<string, DraftBuffer>()
    this.buffers.set(projectId, project)
    project.set(path, buffer)
  }
  forget(projectId: string, path: string): void {
    const project = this.buffers.get(projectId)
    const buffer = project?.get(path)
    if (!project || !buffer) return
    buffer.dispose()
    project.delete(path)
    if (project.size === 0) this.buffers.delete(projectId)
  }
  /** Records the open document; `null` clears it after removal or discard. */
  remember(projectId: string, path: string | null): void {
    if (path === null) this.documents.delete(projectId)
    else this.documents.set(projectId, path)
  }
  remembered(projectId: string): string | undefined { return this.documents.get(projectId) }
  /** Saves this project's pending input; another project's draft never blocks navigation. */
  async flushActive(projectId: string): Promise<FlushResult> {
    for (const buffer of this.buffers.get(projectId)?.values() ?? []) {
      if (await buffer.flush()) continue
      const snapshot = buffer.getSnapshot()
      if (snapshot.error?.code === 'failed') return { ok: false, reason: 'failed', message: snapshot.error.message }
      if (snapshot.composing) return { ok: false, reason: 'composing' }
      if (snapshot.external === null) return { ok: false, reason: 'missing' }
      if (snapshot.external !== undefined) return { ok: false, reason: 'conflict' }
      return { ok: false, reason: 'saving' }
    }
    if (this.hasUnsaved(projectId)) return { ok: false, reason: 'saving' }
    return { ok: true }
  }
  /** Other buffers of this project that still hold input; another project never blocks. */
  hasUnsavedExcept(projectId: string, excluded: DraftBuffer): boolean {
    for (const buffer of this.buffers.get(projectId)?.values() ?? []) if (buffer !== excluded && this.unsaved(buffer)) return true
    return false
  }
  private unsaved(buffer: DraftBuffer): boolean {
    const value = buffer.getSnapshot()
    return value.dirty || value.saving || value.applying || value.composing || value.external !== undefined
  }
  hasUnsaved(projectId: string): boolean {
    for (const buffer of this.buffers.get(projectId)?.values() ?? []) if (this.unsaved(buffer)) return true
    return false
  }
}
