import { randomUUID } from 'node:crypto'

export type DesktopPreviewSource = { kind: 'task'; prototypeTaskId: string } | { kind: 'baseline'; baselineId: string; commitSha: string }
export interface DesktopPreviewIdentity { projectId: string; source: DesktopPreviewSource; previewId: string; generation: number; buildHash: string }
export interface DesktopPreviewInstance extends DesktopPreviewIdentity { url: string }

/** Send a Host-owned preview lifecycle event to the shell and wait for its acknowledgement. */
async function exchange(message: Record<string, unknown>): Promise<void> {
  if (!process.send || !process.connected) throw new Error('桌面预览通道不可用')
  const requestId = randomUUID()
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('桌面预览结果未知，请核对原实例')) }, 20_000)
    const cleanup = () => { clearTimeout(timer); process.off('message', receive) }
    const receive = (value: unknown) => {
      if (!value || typeof value !== 'object') return
      const result = value as { type?: unknown; requestId?: unknown; ok?: unknown }
      if (result.type !== 'studio-prototype-result' || result.requestId !== requestId) return
      cleanup()
      if (result.ok === true) resolve(); else reject(new Error('桌面预览实例或布局身份无效'))
    }
    process.on('message', receive)
    process.send!({ ...message, requestId }, error => { if (error) { cleanup(); reject(new Error('桌面预览通道不可用')) } })
  })
}

export const desktopPreviewCanvas = {
  register: (instance: DesktopPreviewInstance): Promise<void> => exchange({ type: 'studio-prototype-register', instance }),
  select: (identity: DesktopPreviewIdentity): Promise<void> => exchange({ type: 'studio-prototype-select', identity }),
  deselect: (): Promise<void> => exchange({ type: 'studio-prototype-deselect' }),
  revoke: (identity: DesktopPreviewIdentity): Promise<void> => exchange({ type: 'studio-prototype-revoke', identity }),
  clear: (): Promise<void> => exchange({ type: 'studio-prototype-clear' }),
}
