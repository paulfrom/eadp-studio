import type { ScenarioWriteReceiptView } from '../../shared/scenarios.ts'
import css from '../studio.module.css'

/** Post-write summary; undo is offered only while the file still holds this write's result. */
export function ScenarioWriteReceiptCard({ receipt, disabled, onUndo }: { receipt: ScenarioWriteReceiptView; disabled: boolean; onUndo(): void }) {
  const { summary } = receipt
  return <section className={css.dockCard} aria-label="写入结果">
    <header className={css.cardHead}><strong>整篇写入完成</strong><small>{summary.changed.length + summary.added.length + summary.removed.length} 处章节变化</small></header>
    {summary.added.length > 0 && <p>新增章节：{summary.added.join('、')}</p>}
    {summary.changed.length > 0 && <p>修改章节：{summary.changed.join('、')}</p>}
    {summary.removed.length > 0 && <p>删除章节：{summary.removed.join('、')}</p>}
    <p className={css.muted}>使用已读资料：{summary.evidence.length ? summary.evidence.join('、') : '无'}</p>
    {summary.unanswered.length > 0 && <p>仍缺业务答案：{summary.unanswered.join('；')}</p>}
    {receipt.canUndo
      ? <div className={css.dockActions}><button disabled={disabled} onClick={onUndo}>撤销本次写入</button></div>
      : <p className={css.muted}>正文已变化，本次写入无法撤销；请先处理当前编辑。</p>}
  </section>
}
