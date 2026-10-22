import type { ReactNode } from 'react'
import type { Candidate, EntityView, TaskView } from '../../shared/studio.ts'
import type { ScenarioWorkspace as Workspace } from '../../shared/scenarios.ts'
import { ScenarioSuggestions } from './ScenarioSuggestions.tsx'
import { ScenarioWriteProposalCard } from './ScenarioWriteProposalCard.tsx'
import { ScenarioWriteReceiptCard } from './ScenarioWriteReceiptCard.tsx'
import css from '../studio.module.css'

/** Every command the chat pane raises, gathered so the pane takes data plus one action face. */
export interface ScenarioChatActions {
  refresh(): void; newSession(): void; selectSession(sessionId: string): void; openTemplates(): void;
  setAutoWrite(enabled: boolean): void;
  adoptSuggestions(batchId: string, itemIds: string[]): Promise<void>;
  resolveWriteProposal(decision: 'write' | 'reject'): void;
  undoWrite(): void;
}
/** Read-only material revision entry: inspect the affected requirements, then start the batch. */
export interface ScenarioRevisionFace {
  shown: boolean; impact?: Workspace['impact']; inspect(): void; start(): void; dismiss(): void;
}
/** Requirement split offered after the scenario was accepted. */
export interface ScenarioSplitFace { offered: boolean; deferred: boolean; split(): void; defer(): void }
/** Requirement candidates produced from the confirmed scenario version. */
export interface ScenarioCandidateFace {
  items: Candidate[]; categories: Array<{ id: string; name: string }>; categoryId: string;
  selectCategory(categoryId: string): void; create(candidateId: string): void;
}
/**
 * Chat pane of the scenario page: session controls, the native conversation the
 * caller passes as children, and the docked write, suggestion and split cards.
 */
export function ScenarioChatPanel({ entity, workspace, busy, locked, material, sessions, activeSessionId, actions, revision, split, candidates, expandSpec, children }: {
  entity: EntityView; workspace: Workspace; busy: boolean; locked: boolean; material: { hash: string; dirty: boolean };
  sessions: TaskView[]; activeSessionId: string | undefined;
  actions: ScenarioChatActions; revision: ScenarioRevisionFace; split: ScenarioSplitFace; candidates: ScenarioCandidateFace;
  expandSpec: (() => void) | undefined; children: ReactNode;
}) {
  const task = sessions.find(session => session.sessionId === activeSessionId)
  const suggestionCount = workspace.suggestions.reduce((total, batch) => total + batch.groups.reduce((count, group) => count + group.items.length, 0), 0)
  return <section className={css.chatPanel} aria-label="场景对话">
    <header className={css.panelBar}>
      <div className={css.panelIdentity}>
        <span className={css.codeChip}>{entity.code ?? entity.id}</span>
        <strong>{entity.title}</strong>
      </div>
      <div className={css.panelActions}>
        <button onClick={actions.refresh} disabled={busy} title="重新读取场景材料">刷新</button>
        <label className={css.inlineField}>历史会话<select disabled={locked} value={activeSessionId ?? ''} onChange={event => { if (event.target.value) actions.selectSession(event.target.value) }}><option value="" disabled>选择场景会话</option>{sessions.map((session, index) => <option key={session.sessionId} value={session.sessionId}>会话 {index + 1} · {session.sessionId.slice(0, 8)}</option>)}</select></label>
        <button onClick={actions.newSession} disabled={locked}>新会话</button>
        <button onClick={actions.openTemplates}>场景模板</button>
        {expandSpec && <button className={css.primary} onClick={expandSpec}>展开契约</button>}
      </div>
    </header>
    <div className={css.contextStrip}>
      <span>{workspace.readOnly ? `确认版本 ${entity.materialVersion}` : '本地草稿'}</span>
      <span>{entity.occupation ? `当前编辑人 #${entity.occupation.ownerId}` : '无设计占用'}</span>
      <span>创建人 {entity.creator?.name ?? `#${entity.authorId}`}</span>
    </div>
    {workspace.readOnly && !revision.shown && <div className={css.panelNotice}>
      <span>确认人 #{workspace.confirmedBy ?? entity.current?.confirmedBy} · {workspace.confirmedAt ?? entity.current?.confirmedAt}</span>
      <button disabled={busy} onClick={revision.inspect}>开始修订：查看影响</button>
    </div>}
    {revision.shown && <section className={css.revisionImpact} aria-label="修订影响清单">
      <header className={css.cardHead}><strong>修订影响清单</strong><small>关联需求将进入场景批次冻结</small></header>
      <p>启动后会领取设计占用，关联需求进入场景批次冻结，并按同批规则处理及确认。</p>
      {revision.impact?.length ? <ul>{revision.impact.map(item => <li key={item.id}>{item.code ?? item.id} · {item.title}</li>)}</ul> : <p>没有关联需求。</p>}
      <div className={css.dockActions}>
        <button className={css.primary} disabled={busy || revision.impact === undefined} onClick={revision.start}>确认影响并启动修订</button>
        <button onClick={revision.dismiss}>取消</button>
      </div>
    </section>}
    <div className={css.chatDock}>
      {task?.error && <div className={css.notice}>{task.error}</div>}
      {workspace.writeProposal && <ScenarioWriteProposalCard proposal={workspace.writeProposal} disabled={locked || workspace.readOnly || material.dirty} onResolve={actions.resolveWriteProposal} />}
      {workspace.writeReceipt && <ScenarioWriteReceiptCard receipt={workspace.writeReceipt} disabled={locked || workspace.readOnly || material.dirty} onUndo={actions.undoWrite} />}
      <section className={css.dockCard} aria-label="AI 建议">
        <header className={css.cardHead}><strong>AI 建议</strong><small>{suggestionCount} 条建议</small></header>
        {!workspace.readOnly && <label className={css.checkbox} title="开启后 AI 返回的合法建议会整批写入右侧正文并更新版本；手工编辑期间的文件变化会提示合并，写入失败保留建议卡。">
          <input type="checkbox" disabled={busy || locked} checked={workspace.autoWrite} onChange={event => actions.setAutoWrite(event.target.checked)} />自动写入 AI 建议
          <small className={css.muted}>{workspace.autoWrite ? '建议生成后直接写入正文' : '建议需手动采纳后才写入'}</small>
        </label>}
        <ScenarioSuggestions batches={workspace.suggestions} hash={material.hash} disabled={locked || workspace.readOnly || material.dirty} onAdopt={actions.adoptSuggestions} />
      </section>
      {workspace.readOnly && <section className={css.dockCard} aria-label="需求拆分">
        <header className={css.cardHead}><strong>{split.offered && !split.deferred ? '场景已被后台接受，是否立即拆分需求？' : '从当前确认版拆分需求'}</strong></header>
        <p className={css.muted}>仅生成候选，选用后才创建需求草稿。</p>
        <div className={css.dockActions}>
          <button disabled={busy} onClick={split.split}>{split.offered && !split.deferred ? '立即生成拆分候选' : '生成需求候选'}</button>
          {split.offered && !split.deferred && <button onClick={split.defer}>稍后拆分</button>}
        </div>
      </section>}
      {candidates.items.length > 0 && <section className={css.dockCard} aria-label="需求拆分候选">
        <header className={css.cardHead}><strong>需求拆分候选</strong><small>{candidates.items.length} 条</small></header>
        <label className={css.inlineField}>需求业务分类<select value={candidates.categoryId} onChange={event => candidates.selectCategory(event.target.value)}>{candidates.categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
        {candidates.items.map(candidate => <article className={css.candidateRow} key={candidate.id}>
          <div><strong>{candidate.title}</strong><p>{candidate.summary}</p></div>
          <button disabled={busy || !candidates.categoryId || !!candidate.selectedEntityId} onClick={() => candidates.create(candidate.id)}>{candidate.selectedEntityId ? '已创建草稿' : '选用并创建需求草稿'}</button>
        </article>)}
      </section>}
    </div>
    {children}
  </section>
}
