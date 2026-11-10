import { useEffect, useState } from 'react'
import type { FactoryLocalComponent, PropsRenderFactories, SessionProviderComponent } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import { Notice } from './ui.ts'
import type { ShellFace } from './types.ts'
import css from './shell.module.css'

interface ConversationProps extends Pick<ShellFace, 'restoreSession' | 'retainSession'>, PropsRenderFactories {
  projectId: string
  sessionId: string | undefined
  SessionProvider: SessionProviderComponent
  loading: string
  empty: string
}
/** Keeps the transcript seat present even when the native blank view renders no content. */
const EmbeddedViews: FactoryLocalComponent<'conversation.content', 'views'> = ({ renderSlot }) => (
  <div className={css.conversationViews}>{renderSlot('conversation.session', {})}</div>
)

/** Retain and release the official Session reference for the selected project. */
export function Conversation(props: ConversationProps) {
  const [reference, setReference] = useState<{ projectId: string; sessionId: string; value: SessionReference }>()
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    let retained: SessionReference | undefined
    setReference(undefined); setError('')
    if (!props.sessionId) return
    const id = props.sessionId
    void props.restoreSession(props.projectId, id).then(async restored => {
      if (!active) return
      if (restored !== id) throw new Error('SESSION_ID_MISMATCH')
      const current = props.retainSession(id)
      retained = current
      await current.ready
      if (active) setReference({ projectId: props.projectId, sessionId: id, value: current })
    }).catch((reason: unknown) => {
      retained?.release(); retained = undefined
      if (active) setError(reason instanceof Error ? reason.message : String(reason))
    })
    return () => { active = false; retained?.release(); retained = undefined }
  }, [props.projectId, props.sessionId, props.restoreSession, props.retainSession])
  if (error) return <div className={css.chatNotice}><Notice tone="danger">{error}</Notice></div>
  if (!props.sessionId) return <p className={css.chatMessage}>{props.empty}</p>
  if (!reference || reference.projectId !== props.projectId || reference.sessionId !== props.sessionId) return <p className={css.chatMessage}>{props.loading}</p>
  const Provider = props.SessionProvider
  return <Provider session={reference.value}>{props.renderFactorySlot('conversation.content', { variant: 'embedded', phase: 'active', hero: false }, { slots: { views: EmbeddedViews } })}</Provider>
}
