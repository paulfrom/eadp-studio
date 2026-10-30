import type { ReactNode } from 'react'
import type { Candidate, EntityView, StudioReply, TaskView } from '../../shared/studio.ts'
import type { ScenarioWorkspace as Workspace } from '../../shared/scenarios.ts'
import { ScenarioWriteProposalCard, ScenarioWriteProposalError } from './ScenarioWriteProposalCard.tsx'
import { ScenarioWriteReceiptCard } from './ScenarioWriteReceiptCard.tsx'
import { RequirementCandidatePanel } from '../requirements/RequirementCandidatePanel.tsx'
import { MaterialDiscussionSummary } from '../components/MaterialDiscussionSummary.tsx'
import { MaterialWorkspaceHeader } from '../components/MaterialWorkspaceChrome.tsx'
import layout from '../components/materialWorkspace.module.css'
import css from '../studio.module.css'

/** Every command the chat pane raises, gathered so the pane takes data plus one action face. */
export interface ScenarioChatActions {
  refresh(): void; newSession(): void; selectSession(sessionId: string): void; openTemplates(): void;
  resolveWriteProposal(decision: 'write' | 'reject', selectedChangeIds?: string[]): void;
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
  items: Candidate[]; create(candidateId: string): Promise<StudioReply | undefined>;
}
/**
 * Chat pane of the scenario page: session controls, the native conversation the
 * caller passes as children, and the docked write and split cards. The related
 * requirement rows look back from the scenario to its formal requirements.
 */
export function ScenarioChatPanel({ entity, entities, workspace, busy, locked, sessions, activeSessionId, actions, revision, split, candidates, relatedRequirements, onOpenRequirement, reviewRequested, onReview, onConfirm, questions, children }: {
  entity: EntityView; workspace: Workspace; busy: boolean; locked: boolean;
  entities: EntityView[];
  sessions: TaskView[]; activeSessionId: string | undefined;
  actions: ScenarioChatActions; revision: ScenarioRevisionFace; split: ScenarioSplitFace; candidates: ScenarioCandidateFace;
  relatedRequirements: EntityView[]; onOpenRequirement(entityId: string): void;
  questions: Workspace['draft']['metadata']['openQuestions']; reviewRequested: number; onReview(): void; onConfirm(): void; children: ReactNode;
}) {
  const task = sessions.find(session => session.sessionId === activeSessionId)
  return <section className={`${css.chatPanel} ${layout.materialPanel}`} aria-label="场景对话">
    <MaterialWorkspaceHeader entity={entity} sessions={sessions} activeSessionId={activeSessionId} locked={locked} readOnly={workspace.readOnly} reviewCount={workspace.writeProposal?.status === 'pending' ? workspace.writeProposal.changes.length : 0} onReview={onReview} onConfirm={onConfirm} onRefresh={actions.refresh} onNewSession={actions.newSession} onSelectSession={actions.selectSession} onTemplates={actions.openTemplates} />
    {workspace.readOnly && !revision.shown && <div className={css.panelNotice}>
      <span>确认人 #{workspace.confirmedBy ?? entity.current?.confirmedBy} · {workspace.confirmedAt ?? entity.current?.confirmedAt}</span>
      <button disabled={busy} onClick={revision.inspect}>开始修订：查看影响</button>
    </div>}
    {revision.shown && <section className={css.revisionImpact} aria-label="修订影响清单">
      <header className={css.cardHead}><strong>修订影响清单</strong></header>
      <p>启动后会领取设计占用，之后可修订场景正文并重新确认。</p>
      {revision.impact?.length ? <ul>{revision.impact.map(item => <li key={item.id}>{item.code ?? item.id} · {item.title}</li>)}</ul> : <p>没有关联需求。</p>}
      <div className={css.dockActions}>
        <button className={css.primary} disabled={busy || revision.impact === undefined} onClick={revision.start}>确认影响并启动修订</button>
        <button onClick={revision.dismiss}>取消</button>
      </div>
    </section>}
    <div className={css.chatDock}>
      {task?.error && <div className={css.notice}>{task.error}</div>}
      <MaterialDiscussionSummary questions={questions} sources={workspace.sources} onQuestions={onConfirm} />
      {workspace.writeProposalError && <ScenarioWriteProposalError message={workspace.writeProposalError} />}
      {workspace.writeProposal && <ScenarioWriteProposalCard sources={workspace.sources} hideReviewAction reviewRequested={reviewRequested} proposal={workspace.writeProposal} disabled={locked || workspace.readOnly} onResolve={actions.resolveWriteProposal} />}
      {workspace.writeReceipt && <ScenarioWriteReceiptCard receipt={workspace.writeReceipt} disabled={locked || workspace.readOnly} onUndo={actions.undoWrite} />}
      {workspace.readOnly && split.offered && !split.deferred && <section className={css.dockCard} aria-label="从已确认场景拆分需求">
        <header className={css.cardHead}><strong>场景已被后台接受</strong><small>可继续拆分需求</small></header>
        <p className={css.muted}>仅生成候选；选择后才会创建需求草稿。</p>
        <div className={css.dockActions}><button className={css.primary} disabled={busy} onClick={split.split}>生成需求候选</button><button disabled={busy} onClick={split.defer}>稍后拆分</button></div>
      </section>}
      {workspace.readOnly && (!split.offered || split.deferred) && <details className={layout.secondaryDetails}><summary>从已确认场景拆分需求</summary><section className={css.dockCard} aria-label="需求拆分">
        <header className={css.cardHead}><strong>{split.offered && !split.deferred ? '场景已被后台接受，是否立即拆分需求？' : '从当前确认版拆分需求'}</strong></header>
        <p className={css.muted}>仅生成候选，选用后才创建需求草稿。</p>
        <div className={css.dockActions}>
          <button disabled={busy} onClick={split.split}>{split.offered && !split.deferred ? '立即生成拆分候选' : '生成需求候选'}</button>
          {split.offered && !split.deferred && <button onClick={split.defer}>稍后拆分</button>}
        </div>
      </section></details>}
      <RequirementCandidatePanel candidates={candidates.items} entities={entities} busy={busy} adopt={candidate => candidates.create(candidate.id)} onOpen={onOpenRequirement} />
      <details className={layout.secondaryDetails}><summary>关联需求 · {relatedRequirements.length} 项</summary><section className={css.dockCard} aria-label="关联需求">
        <header className={css.cardHead}><strong>关联需求</strong><small>{relatedRequirements.length} 项</small></header>
        {relatedRequirements.length === 0 && <p className={css.muted}>尚无正式关联的需求。</p>}
        {relatedRequirements.map(requirement => <button key={requirement.id} className={css.candidateRow} disabled={busy} onClick={() => onOpenRequirement(requirement.id)} title="跳转到需求阶段查看">
          <span>{requirement.code ?? requirement.id} · {requirement.title}</span>
          <span className={requirement.confirmationStatus === 'confirmed' ? css.success : css.muted}>{requirement.confirmationStatus === 'confirmed' ? '已确认' : '草稿'}</span>
        </button>)}
      </section></details>
    </div>
    {children}
    <p className={layout.composerHint}>Enter 发送 · Shift + Enter 换行 · 审阅写入后更新正文</p>
  </section>
}
