import { Service, type Context } from '@deepseek-ai/cordis'
import type { EadpRequirementsClient } from '@eadp/contracts'
import type { KnowledgeTurnReferenceView, RequirementKnowledgeAdoptionInput, RequirementProposal } from '@eadp/contracts'
import type { RequirementsApi } from './api.ts'

import type { DraftBuffer } from './DraftBuffer.ts'

/** Why a project's pending input blocks navigation; the panel localizes the reason. */
export type FlushFailure = 'composing' | 'conflict' | 'missing' | 'saving' | 'failed'

export interface FlushResult {
  ok: boolean
  reason?: FlushFailure
  /** Host failure text when a save failed. */
  message?: string
}

/** Why an adoption stopped before reaching the Host; each view supplies its own copy. */
export type AdoptionFailure =
  | { kind: 'draft'; reason: FlushFailure; message?: string }
  | { kind: 'missingRequirement' }

/** Local adoption refusal, distinct from a Host rejection whose message is shown verbatim. */
export class KnowledgeAdoptionError extends Error {
  constructor(readonly failure: AdoptionFailure) {
    super(failure.kind)
    this.name = 'KnowledgeAdoptionError'
  }
}

/** Retains unsaved editor memory per project and path while views are unmounted. */
export class RequirementsClientService extends Service implements EadpRequirementsClient {
  private readonly buffers = new Map<string, Map<string, DraftBuffer>>()
  /** Document each project last opened, so a remounted panel restores the same selection. */
  private readonly documents = new Map<string, string>()
  /** Remote surface, bound by the plugin entry once the injected scope is ready. */
  private api: RequirementsApi | null = null
  constructor(ctx: Context) {
    super(ctx, 'eadpRequirementsClient')
    ctx.effect(() => () => {
      for (const project of this.buffers.values()) for (const buffer of project.values()) buffer.dispose()
      this.buffers.clear()
      this.documents.clear()
    }, 'eadp-requirements: drafts')
  }
  /** Binds the generated Remote surface created in the plugin's injected scope. */
  attach(api: RequirementsApi): void { this.api = api }
  /** The bound Remote surface; adoption and turn reads are unavailable before binding. */
  private get remote(): RequirementsApi {
    if (this.api === null) throw new Error('需求服务尚未就绪，请稍后重试。')
    return this.api
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

  /** 最近一轮自动参考的实际注入结果；没有需求会话时明确为空。 */
  async turnReferences(projectId: string, sessionId: string | null): Promise<KnowledgeTurnReferenceView | null> {
    if (sessionId === null) return null
    return this.remote.turnReferences(projectId, sessionId)
  }

  /**
   * Saves pending input of the current project, resolves the requirement version the
   * Host must still see, then asks the Host to add the adopted content to the pending
   * proposal. Both views call this one path so neither implements its own save or version.
   * @param input - target project, requirement session, and the adoption chosen in a view.
   * @returns the pending proposal that now carries the adopted knowledge.
   */
  async adoptKnowledge(input: { projectId: string; sessionId: string; adoption: RequirementKnowledgeAdoptionInput }): Promise<RequirementProposal> {
    const { projectId, sessionId, adoption } = input
    const flushed = await this.flushActive(projectId)
    if (!flushed.ok) {
      const reason = flushed.reason ?? 'saving'
      const failure: AdoptionFailure = flushed.message === undefined
        ? { kind: 'draft', reason }
        : { kind: 'draft', reason, message: flushed.message }
      throw new KnowledgeAdoptionError(failure)
    }
    const baseVersion = this.cleanVersion(projectId, adoption.relativePath) ?? await this.remote.statVersion(projectId, adoption.relativePath)
    if (baseVersion === null) throw new KnowledgeAdoptionError({ kind: 'missingRequirement' })
    return this.remote.adoptKnowledge(projectId, sessionId, { ...adoption, baseVersion })
  }

  /** Version acknowledged by a clean editor buffer; a buffer with pending input is not a base. */
  private cleanVersion(projectId: string, relativePath: string): string | null {
    const snapshot = this.get(projectId, relativePath)?.getSnapshot()
    if (snapshot === undefined) return null
    const clean = !snapshot.dirty && !snapshot.saving && !snapshot.composing && !snapshot.applying && snapshot.external === undefined
    return clean ? snapshot.version : null
  }
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
