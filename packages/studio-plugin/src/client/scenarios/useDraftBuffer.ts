import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { MaterialDraft } from '../../shared/studio.ts'
import { DraftBuffer, type SaveDraft } from './DraftBuffer.ts'

export function useDraftBuffer(draft: MaterialDraft, save: SaveDraft, registerFlush: (flush?: () => Promise<boolean>) => void) {
  const saveRef = useRef(save)
  saveRef.current = save
  const [buffer] = useState(() => new DraftBuffer(draft, input => saveRef.current(input)))
  const snapshot = useSyncExternalStore(buffer.subscribe, buffer.getSnapshot)
  useEffect(() => { buffer.receive(draft) }, [buffer, draft])
  useEffect(() => {
    registerFlush(buffer.flush)
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (buffer.getSnapshot().dirty || buffer.getSnapshot().saving) { event.preventDefault(); event.returnValue = ''; void buffer.flush() }
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => { registerFlush(); window.removeEventListener('beforeunload', beforeUnload); buffer.dispose() }
  }, [buffer, registerFlush])
  return { buffer, snapshot }
}
