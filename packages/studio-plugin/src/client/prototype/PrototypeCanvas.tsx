import { useEffect, useRef, useState } from 'react'

type PreviewSource = { kind: 'task'; prototypeTaskId: string } | { kind: 'baseline'; baselineId: string; commitSha: string }
export interface PrototypeCanvasIdentity { projectId: string; source: PreviewSource; previewId: string; generation: number; buildHash: string }
interface Layout { identity: PrototypeCanvasIdentity; sequence: number; visible: boolean; bounds: { x: number; y: number; width: number; height: number }; navigation?: { path?: string; reload?: boolean } }
declare global { interface Window { studioPrototypeCanvas?: { layout(request: Layout): Promise<void> } } }
let sequence = 0

/** The desktop shell owns the selected preview URL; the client sends bounds and same-origin navigation only. */
export function PrototypeCanvas({ identity, visible, registerNavigation }: { identity: PrototypeCanvasIdentity; visible: boolean; registerNavigation?(navigate?: (navigation: NonNullable<Layout['navigation']>) => Promise<void>): void }) {
  const element = useRef<HTMLDivElement>(null)
  const [error, setError] = useState('')
  const key = JSON.stringify(identity)
  useEffect(() => {
    const canvas = element.current, bridge = window.studioPrototypeCanvas
    if (!canvas || !bridge) { setError('当前桌面未提供内嵌预览'); return }
    let disposed = false, frame = 0
    const send = (show: boolean, navigation?: Layout['navigation']) => {
      const rect = canvas.getBoundingClientRect()
      const bounds = { x: Math.max(0, rect.left), y: Math.max(0, rect.top), width: Math.max(0, rect.width), height: Math.max(0, rect.height) }
      const onscreen = rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight && rect.width > 0 && rect.height > 0
      const modalOpen = [...document.querySelectorAll('dialog[open], [role="dialog"][aria-modal="true"], details[open][data-prototype-menu]')].some(element => {
        const style = getComputedStyle(element), bounds = element.getBoundingClientRect()
        return style.display !== 'none' && style.visibility !== 'hidden' && bounds.width > 0 && bounds.height > 0
      })
      const points = [0.1, 0.5, 0.9].flatMap(x => [0.1, 0.5, 0.9].map(y => [rect.left + rect.width * x, rect.top + rect.height * y] as const))
      const clear = onscreen && points.every(([x, y]) => { const top = document.elementFromPoint(x, y); return top === canvas || !!top && canvas.contains(top) })
      return bridge.layout({ identity, sequence: ++sequence, visible: show && visible && clear && !modalOpen && document.visibilityState === 'visible', bounds, ...(navigation ? { navigation } : {}) })
        .then(() => { if (!disposed) setError('') }, error => { if (!disposed) setError('内嵌预览暂不可用，请重新打开当前预览。'); if (navigation) throw error })
    }
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => send(true)) }
    registerNavigation?.(navigation => send(true, navigation))
    const resize = new ResizeObserver(schedule), mutations = new MutationObserver(schedule)
    resize.observe(canvas); mutations.observe(document.body, { childList: true, attributes: true, subtree: true })
    window.addEventListener('resize', schedule); window.addEventListener('scroll', schedule, true); document.addEventListener('visibilitychange', schedule)
    schedule()
    return () => {
      disposed = true; cancelAnimationFrame(frame); resize.disconnect(); mutations.disconnect()
      registerNavigation?.(undefined)
      window.removeEventListener('resize', schedule); window.removeEventListener('scroll', schedule, true); document.removeEventListener('visibilitychange', schedule)
      send(false)
    }
  }, [key, visible, registerNavigation])
  return <div ref={element} aria-label="原型预览画布" style={{ minHeight: 0, height: '100%', flex: 1, width: '100%' }}>{error && <p role="status">{error}</p>}</div>
}
