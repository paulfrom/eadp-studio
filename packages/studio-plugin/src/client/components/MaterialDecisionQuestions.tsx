import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ScenarioSource, MaterialDecisionQuestionTurnView } from '../../shared/scenarios.ts'
import css from '../studio.module.css'
import questionCss from './material-questions.module.css'

interface SelectedQuestions { turnId: string; choices: Record<string, string> }
interface MaterialQuestionContextValue {
  turn?: MaterialDecisionQuestionTurnView
  sources: ScenarioSource[]
  disabled: boolean
  choices: Record<string, string>
  notice: string
  select(questionId: string, optionId: string): void
  inserted(): void
  notify(message: string): void
}

const MaterialQuestionContext = createContext<MaterialQuestionContextValue | undefined>(undefined)

/** Keeps each assistant turn's choices beside the matching native conversation. */
export function MaterialDecisionQuestions({ turn, error, sources, disabled, children }: {
  turn?: MaterialDecisionQuestionTurnView | undefined
  error?: string | undefined
  sources: ScenarioSource[]
  disabled: boolean
  children: ReactNode
}) {
  const [selected, setSelected] = useState<SelectedQuestions>({ turnId: '', choices: {} })
  const [notice, setNotice] = useState<{ turnId: string; text: string }>({ turnId: '', text: '' })
  const choices = selected.turnId === turn?.id ? selected.choices : {}
  const select = useCallback((questionId: string, optionId: string) => {
    if (!turn) return
    setSelected(value => ({ turnId: turn.id, choices: { ...(value.turnId === turn.id ? value.choices : {}), [questionId]: optionId } }))
    setNotice({ turnId: turn.id, text: '' })
  }, [turn])
  const inserted = useCallback(() => {
    setSelected({ turnId: turn?.id ?? '', choices: {} })
    setNotice({ turnId: turn?.id ?? '', text: '已插入输入草稿；发送后 AI 才会收到回答。' })
  }, [turn?.id])
  const notify = useCallback((message: string) => setNotice({ turnId: turn?.id ?? '', text: message }), [turn?.id])
  const noticeText = turn && notice.turnId === turn.id ? notice.text : ''
  const value = useMemo<MaterialQuestionContextValue>(() => ({
    ...(turn ? { turn } : {}), sources, disabled: disabled || !!turn?.stale, choices, notice: noticeText, select, inserted, notify,
  }), [turn, sources, disabled, choices, noticeText, select, inserted, notify])

  return <MaterialQuestionContext.Provider value={value}>
    {turn && turn.questions.length > 0 && <QuestionCard turn={turn} sources={sources} disabled={value.disabled} choices={choices} select={select} />}
    {error && <div className={css.notice} role="alert">本轮问题无法显示：{error}</div>}
    {children}
  </MaterialQuestionContext.Provider>
}

function QuestionCard({ turn, sources, disabled, choices, select }: {
  turn: MaterialDecisionQuestionTurnView; sources: ScenarioSource[]; disabled: boolean;
  choices: Record<string, string>; select(questionId: string, optionId: string): void;
}) {
  return <section className={`${css.dockCard} ${questionCss.card}`} aria-label="AI 本轮问题" data-stale={turn.stale}>
    <header className={css.cardHead}><strong>AI 本轮问题 · {turn.questions.length} 项</strong><small>{turn.stale ? '历史轮次' : '选择后插入回答'}</small></header>
    {turn.stale
      ? <p className={css.muted}>材料正文、模板、项目上下文或依据已变化；本轮问题仅供回看。</p>
      : <p className={css.muted}>选择一项或多项，在对话输入区插入回答后由你发送。选项本身不会修改正文或通过确认门禁。</p>}
    <ol className={questionCss.list}>
      {turn.questions.map(question => <li key={question.id} className={questionCss.question}>
        <h4>{question.title}</h4>
        <p>{question.reason}</p>
        {question.evidenceIds.length > 0 && <div className={questionCss.evidence} aria-label="问题依据">
          依据：{question.evidenceIds.map(id => <span key={id}>{sources.find(source => source.id === id)?.name ?? id}</span>)}
        </div>}
        <div className={questionCss.options} role="radiogroup" aria-label={question.title}>
          {question.options.map(option => <button
            key={option.id}
            className={questionCss.option}
            type="button"
            role="radio"
            aria-checked={choices[question.id] === option.id}
            disabled={disabled}
            onClick={() => select(question.id, option.id)}
          >
            <strong>{option.label}</strong><span>{option.description}</span>
          </button>)}
        </div>
      </li>)}
    </ol>
  </section>
}

/** Inserts selected answers through DSH's revision-guarded editor action, preserving reference chips. */
export function MaterialDecisionQuestionDock(props: PropsRuntime<'conversation.input.dock'>) {
  const context = useContext(MaterialQuestionContext)
  const draft = props.useInput(input => input.draft)
  if (!context?.turn || context.turn.stale || context.disabled) return null
  const selectedCount = Object.keys(context.choices).length
  if (selectedCount === 0) return context.notice
    ? <div className={questionCss.dock}><span role="status">{context.notice}</span></div>
    : null

  const selected = context.turn.questions.flatMap(question => {
    const option = question.options.find(value => value.id === context.choices[question.id])
    return option ? [{ question: question.title, answer: option.label, detail: option.description }] : []
  })
  if (selected.length === 0) return null

  const insert = () => {
    const span = props.inputActions.captureInsertion()
    if (span.start !== span.end) {
      context.notify('输入框选中了一段文字。请先取消选择或把光标放到插入位置，避免替换已有内容。')
      return
    }
    const lines = selected.map((item, index) => `${index + 1}. ${item.question}\n   我的选择：${item.answer}（${item.detail}）`)
    const prefix = draft.trim() ? '\n\n' : ''
    const text = `${prefix}我对本轮问题的回答是：\n${lines.join('\n')}\n`
    if (!props.inputActions.insertText(text, span)) {
      context.notify('输入框已变化或正在发送，回答没有插入，请重试。')
      return
    }
    context.inserted()
  }

  return <div className={questionCss.dock}>
    <span role={context.notice ? 'status' : undefined}>{context.notice || `已选择 ${selected.length} 项回答；插入后仍需由你发送。`}</span>
    <button type="button" className={css.primary} onClick={insert}>插入所选回答</button>
  </div>
}
