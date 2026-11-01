import { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { StudioProps } from '../studio/StudioPanel.tsx'
import { NativeSessionSelector, type NativeConversationSelection } from './NativeSessionSelector.tsx'
import selectionCss from './native-session-selector.module.css'
import css from '../studio.module.css'
export type { NativeConversationSelection } from './NativeSessionSelector.tsx'

export type NativeConversationFaces = Pick<StudioProps, 'run' | 'retainSession' | 'SessionProvider' | 'renderFactorySlot'>
type ConversationProps = NativeConversationFaces & { sessionId: string | undefined; selection?: NativeConversationSelection; emptyMessage?: string; accessory?: ReactNode }

/** Retains a native DSH conversation for its session identity, independently of workspace polling. */
export const NativeConversation = memo(function NativeConversation(props: ConversationProps) {
  const faces = useRef(props)
  faces.current = props
  const [retainedSession, setRetainedSession] = useState<{ id: string; reference: SessionReference }>()
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let cancelled = false, retained: SessionReference | undefined
    const sessionId = props.sessionId
    setRetainedSession(undefined); setError('')
    if (!sessionId) return
    void (async () => {
      const result = await faces.current.run({ action: 'restoreSession', sessionId })
      if (cancelled) return
      if (!result.ok) throw new Error(result.message)
      if (result.sessionId !== sessionId) throw new Error('恢复结果与当前会话不一致，请重试。')
      retained = faces.current.retainSession(sessionId)
      await retained.ready
      if (!cancelled) setRetainedSession({ id: sessionId, reference: retained })
    })().catch(reason => {
      retained?.release(); retained = undefined
      if (!cancelled) setError(reason instanceof Error ? reason.message : '会话恢复失败，原会话和工作现场已保留，请重试')
    })
    return () => { cancelled = true; retained?.release(); retained = undefined }
  }, [props.sessionId, attempt])
  const reference = retainedSession?.id === props.sessionId ? retainedSession?.reference : undefined
  const Provider = props.SessionProvider
  return <div className={css.nativeConversation}>
    {props.selection && <NativeSessionSelector {...props.selection} />}
    <div className={selectionCss.body}>{error
      ? <div role="alert" className={css.error}>{error}<button onClick={() => setAttempt(value => value + 1)}>重试恢复对话</button>{props.accessory}</div>
      : !props.sessionId ? <div className={css.empty}>{props.emptyMessage ?? '选择需求，进入对应的 AI 会话。'}{props.accessory}</div>
      : !reference ? <div className={css.empty}>正在恢复原生会话…{props.accessory}</div>
      : <Provider session={reference}>{props.renderFactorySlot('conversation.content', { variant: 'embedded', phase: 'active', hero: false })}</Provider>}
    </div>
  </div>
})
