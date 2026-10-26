import type { MaterialMetadata } from '../../shared/studio.ts'
import type { ScenarioSource } from '../../shared/scenarios.ts'
import layout from './materialWorkspace.module.css'

/** Surfaces actual unresolved business questions and the sources read for this material. */
export function MaterialDiscussionSummary({ questions, sources, onQuestions }: {
  questions: MaterialMetadata['openQuestions']; sources: ScenarioSource[]; onQuestions(): void;
}) {
  const evidence = sources.filter(source => source.selected && (source.status === 'read' || source.status === 'partial'))
  const visibleQuestions = [...questions].sort((left, right) => Number(right.blocking) - Number(left.blocking)).slice(0, 2)
  return <>
    {questions.length > 0 && <section className={layout.decisions} aria-label="需要你决定">
      <header><strong>需要你决定</strong><span>{questions.length} 项待澄清</span></header>
      {visibleQuestions.map((question, index) => <div key={index}><p>{question.limitation || '请补充业务问题'}</p><span>{question.blocking ? '阻断版本确认' : '不阻断版本确认'}{question.excludedScope ? ` · 不适用范围：${question.excludedScope}` : ''}</span></div>)}
      <button onClick={onQuestions}>核对待澄清项{questions.length > 2 ? ` · 共 ${questions.length} 项` : ''} ›</button>
    </section>}
    {evidence.length > 0 && <details className={layout.evidence}>
      <summary>已读资料 · {evidence.length} 份可供引用</summary>
      <ul>{evidence.map(source => <li key={source.id}><span>{source.name}{source.status === 'partial' ? ' · 部分读取' : ''}</span>{source.ranges.length > 0 && <small>{source.ranges.join(' · ')}</small>}</li>)}</ul>
    </details>}
  </>
}
