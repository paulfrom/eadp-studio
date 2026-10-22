import type { ReactNode } from 'react'
import type { StudioProps } from '../studio/StudioPanel.tsx'
import { MaterialAttachments, MaterialAttachmentButton, type MaterialAttachmentsFace } from './MaterialAttachments.tsx'
import { NativeConversation } from './NativeConversation.tsx'
import css from '../studio.module.css'

/** Keeps the same attachment entry reachable before, during and after native session restoration. */
export function MaterialConversation({ sessionId, faces, attachments, children }: {
  sessionId: string | undefined;
  faces: Pick<StudioProps, 'run' | 'retainSession' | 'SessionProvider' | 'renderFactorySlot'>;
  attachments: MaterialAttachmentsFace; children: ReactNode;
}) {
  return <MaterialAttachments sessionId={sessionId} {...attachments}>
    {sessionId ? <NativeConversation key={sessionId} {...faces} sessionId={sessionId} accessory={<MaterialAttachmentButton sessionId={sessionId} />} /> : <div className={css.conversationEmpty}>{children}<MaterialAttachmentButton /></div>}
  </MaterialAttachments>
}
