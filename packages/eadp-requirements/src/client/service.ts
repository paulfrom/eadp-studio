import { Service, type Context } from '@deepseek-ai/cordis'
import type { EadpRequirementsClient } from '@eadp/contracts'
import type { DraftBuffer } from './DraftBuffer.ts'

/** Retains unsaved editor memory while a feature view is temporarily unmounted. */
export class RequirementsClientService extends Service implements EadpRequirementsClient {
  private readonly buffers = new Map<string, DraftBuffer>()
  constructor(ctx: Context) {
    super(ctx, 'eadpRequirementsClient')
    ctx.effect(() => () => { for (const buffer of this.buffers.values()) buffer.dispose(); this.buffers.clear() }, 'eadp-requirements: drafts')
  }
  get(key: string): DraftBuffer | undefined { return this.buffers.get(key) }
  register(key: string, buffer: DraftBuffer): void { this.buffers.set(key, buffer) }
  forget(key: string): void { this.buffers.get(key)?.dispose(); this.buffers.delete(key) }
  async flushActive(): Promise<{ ok: boolean; message?: string }> {
    for (const buffer of this.buffers.values()) {
      if (!await buffer.flush()) return { ok: false, message: buffer.getSnapshot().error || '请先结束中文组字或处理外部文件冲突，输入已保留。' }
    }
    if (this.hasUnsaved()) return { ok: false, message: '等待保存期间输入或文件状态已变化，请处理后重试。' }
    return { ok: true }
  }
  hasUnsaved(): boolean { return [...this.buffers.values()].some(buffer => { const value = buffer.getSnapshot(); return value.dirty || value.saving || value.composing || value.external !== undefined }) }
}
