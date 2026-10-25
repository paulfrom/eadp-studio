import type { ScenarioWriteProposalView } from '../../shared/scenarios.ts'
import css from '../studio.module.css'

/** Explains why the latest answer could not create an actionable write proposal. */
export function ScenarioWriteProposalError({ message }: { message: string }) {
  return <section className={css.dockCard} role="alert" aria-label="写入提议未生成">
    <header className={css.cardHead}><strong>写入提议未生成</strong></header>
    <p>{message}</p>
    <p className={css.muted}>请让 AI 用 eadp-write-proposal 代码块基于当前材料重新提出写入提议，生成后会显示对应的写入按钮。</p>
  </section>
}

/** The only user gesture that authorizes a whole-body write; chat replies never do. */
export function ScenarioWriteProposalCard({ proposal, disabled, onResolve, materialLabel = '场景' }: { proposal: ScenarioWriteProposalView; disabled: boolean; onResolve(decision: 'write' | 'reject'): void; materialLabel?: string }) {
  const failed = proposal.status === 'pending' && !!proposal.error
  const state = failed ? '失败，可重试' : proposal.status === 'pending' ? '待回答' : proposal.status === 'consumed' ? '已写入' : '已拒绝'
  const context = proposal.target === 'context'
  return <section className={css.dockCard} aria-label="写入提议" data-state={proposal.status}>
    <header className={css.cardHead}><strong>{proposal.status === 'pending' ? context ? '是否将这些结论写入项目根 CONTEXT.md？' : `是否将这些结论整篇写入${materialLabel}？` : `写入提议 · ${state}`}</strong><small>{failed ? state : proposal.status === 'pending' ? `待回答 · 依据 ${proposal.evidenceCount} 份已读资料` : new Date(proposal.createdAt).toLocaleString()}</small></header>
    <ul>{proposal.conclusions.map((text, index) => <li key={index}>{text}</li>)}</ul>
    {proposal.status === 'pending' && <><p className={proposal.error ? css.notice : css.muted}>{proposal.error ?? `只有点击下方按钮才会写入；聊天中的回复不构成同意。${context ? '项目上下文变化后，需重新提问。' : '正文、模板、CONTEXT.md 或依据变化后，需重新提问。'}`}</p><div className={css.dockActions}>
      <button className={css.primary} disabled={disabled} onClick={() => onResolve('write')}>{proposal.error ? '重试写入' : context ? '写入 CONTEXT.md' : '写入整篇正文'}</button>
      <button disabled={disabled} onClick={() => onResolve('reject')}>不写入</button>
    </div></>}
  </section>
}
