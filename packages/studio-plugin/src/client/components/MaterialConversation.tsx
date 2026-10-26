import type { ReactNode } from 'react'
import type { StudioProps } from '../studio/StudioPanel.tsx'
import { MaterialAttachments, MaterialAttachmentButton, type MaterialAttachmentsFace } from './MaterialAttachments.tsx'
import { MaterialDecisionQuestions } from './MaterialDecisionQuestions.tsx'
import { NativeConversation } from './NativeConversation.tsx'
import css from '../studio.module.css'
import type { MaterialDecisionQuestionTurnView } from '../../shared/scenarios.ts'

/** Keeps the same attachment entry reachable before, during and after native session restoration. */
export function MaterialConversation({ sessionId, faces, attachments, children, decisionQuestions, decisionQuestionsError }: {
  sessionId: string | undefined;
  faces: Pick<StudioProps, 'run' | 'retainSession' | 'SessionProvider' | 'renderFactorySlot'>;
  attachments: MaterialAttachmentsFace; children: ReactNode;
  decisionQuestions?: MaterialDecisionQuestionTurnView | undefined; decisionQuestionsError?: string | undefined;
}) {
  return <MaterialDecisionQuestions turn={decisionQuestions} error={decisionQuestionsError} sources={attachments.sources} disabled={attachments.disabled || attachments.readOnly}>
    <MaterialAttachments sessionId={sessionId} {...attachments}>
      {sessionId ? <NativeConversation key={sessionId} {...faces} sessionId={sessionId} accessory={<MaterialAttachmentButton sessionId={sessionId} />} /> : <div className={css.conversationEmpty}>{children}<MaterialAttachmentButton /></div>}
    </MaterialAttachments>
  </MaterialDecisionQuestions>
}
