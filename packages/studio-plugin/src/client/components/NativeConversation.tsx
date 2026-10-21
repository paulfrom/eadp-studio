import { memo, useEffect, useRef, useState } from 'react'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { StudioProps } from '../studio/StudioPanel.tsx'
import css from '../studio.module.css'

type ConversationProps = Pick<StudioProps, 'run' | 'retainSession' | 'SessionProvider' | 'renderFactorySlot'> & { sessionId: string }

/** Retains a native DSH conversation for its session identity, independently of workspace polling. */
export const NativeConversation = memo(function NativeConversation(props: ConversationProps) {
  const faces = useRef(props)
  faces.current = props
  const [reference, setReference] = useState<SessionReference>()
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let cancelled = false, retained: SessionReference | undefined
    setReference(undefined); setError('')
    void (async () => {
      const result = await faces.current.run({ action: 'restoreSession', sessionId: props.sessionId })
      if (cancelled) return
      if (!result.ok) throw new Error(result.message)
      if (result.sessionId !== props.sessionId) throw new Error('恢复结果与当前场景会话不一致，请重试。')
      retained = faces.current.retainSession(props.sessionId)
      await retained.ready
      if (!cancelled) setReference(retained)
    })().catch(reason => {
      retained?.release(); retained = undefined
      if (!cancelled) setError(reason instanceof Error ? reason.message : '会话恢复失败，请重试')
    })
    return () => { cancelled = true; retained?.release(); retained = undefined }
  }, [props.sessionId, attempt])
  if (error) return <div role="alert" className={css.error}>{error}<button onClick={() => setAttempt(value => value + 1)}>重试恢复对话</button></div>
  if (!reference) return <div className={css.empty}>正在恢复原生会话…</div>
  const Provider = props.SessionProvider
  return <div className={css.nativeConversation}><Provider session={reference}>{props.renderFactorySlot('conversation.content', { variant: 'embedded', phase: 'active', hero: false })}</Provider></div>
})
