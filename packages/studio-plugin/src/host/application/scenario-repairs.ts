import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isMaterialMetadata, type RepairEventRequest, type RepairTaskView } from '@eadp/contracts'
import type { ScenarioCommand, ScenarioWorkspace } from '../../shared/scenarios.ts'
import type { TaskView } from '../../shared/studio.ts'
import { containedFile, digest, findMaterialFile, readMaterial } from '../adapters/assets/materials.ts'
import { CollaborationError } from '../adapters/collaboration/client.ts'
import { syncProjectContext } from './scenario-package.ts'
import type { ScenarioRecord, ScenarioWorkspaces } from './scenario-workspaces.ts'

export interface LocalScenarioRepair { projectId: string; entityId: string; view: RepairTaskView; task: TaskView; question?: string; message?: string; waiting: boolean; nextRound?: boolean; pending?: RepairEventRequest; recoverPending?: RepairEventRequest; pendingAnswer?: string; turnEnded?: boolean; abortRequested?: boolean; lastHandledSeq?: number }
/** Runs one bounded, explicitly authorized repair task through the existing DSH Agent. */
export class ScenarioRepairs {
  constructor(private readonly workspaces: ScenarioWorkspaces, private readonly confirm: (entityId: string, hash: string, repairId: string) => Promise<void>) {}
  async view(entityId: string): Promise<ScenarioWorkspace['repair']> {
    const local = await this.workspaces.store.read(), record = local.scenarioRepairs.findLast(r => r.entityId === entityId && r.projectId === local.selectedProjectId)
    if (!record) return undefined
    return { ...record.view, ...(record.question ? { question: record.question } : {}), ...(record.message ? { message: record.message } : {}), sessionId: record.task.sessionId }
  }
  async start(command: Extract<ScenarioCommand, { action: 'startScenarioRepair' }>): Promise<void> {
    const w = this.workspaces, record = await w.record(command.entityId)
    if (record.repairAuthorization?.status === 'pending') throw new Error('上次修复授权结果待核对，请先重试核对')
    const local = await w.store.read(), existing = local.scenarioRepairs.findLast(r => r.entityId === command.entityId && r.projectId === record.projectId)
    if (existing?.pending || existing?.recoverPending) throw new Error('上次修复操作结果待核对，请先重试核对')
    if (existing?.view.userActionId === command.userActionId) return
    if (existing && ['active', 'paused'].includes(existing.view.status)) throw new Error('当前修复尚未结束，请先核对或撤销')
    const { entity, task } = await w.editable(command.entityId), draft = await readMaterial(task.worktree, 'scenario', entity.id)
    if (record.observationError) throw new Error(record.observationError)
    if (record.conflict || draft.sha256 !== command.expectedHash) throw new Error('文件冲突或阅读版本已变化，请先核对')
    record.repairAuthorization = {
      request: { idempotencyKey: command.userActionId, token: await w.deps.owned(entity), userActionId: command.userActionId, startHash: draft.sha256 },
      task: { ...task, sessionId: `studio-${randomUUID()}`, purpose: 'review', scenarioRepair: true }, status: 'pending',
    }
    await w.store.save()
    try {
      const view = await w.api.request<RepairTaskView>('POST', `/v1/projects/${task.projectId}/entities/${entity.id}/repairs`, record.repairAuthorization.request)
      await this.authorized(record, view)
    } catch (error) { record.repairAuthorization.message = error instanceof Error ? error.message : '修复授权结果待核对'; await w.store.save(); throw error }
  }
  /** Resolves the original authorization before any retry can consume another repair budget. */
  async retryStart(entityId: string): Promise<void> {
    const w = this.workspaces, record = await w.record(entityId), authorization = record.repairAuthorization
    if (!authorization) throw new Error('没有待核对的修复授权')
    try {
      let view: RepairTaskView
      try { view = (await w.api.request<{ result: RepairTaskView }>('GET', `/v1/projects/${record.projectId}/operations/${authorization.request.idempotencyKey}`)).result }
      catch (error) {
        if (!(error instanceof CollaborationError) || error.code !== 'OPERATION_NOT_FOUND') throw error
        view = await w.api.request('POST', `/v1/projects/${record.projectId}/entities/${entityId}/repairs`, authorization.request)
      }
      await this.authorized(record, view)
    } catch (error) { authorization.message = error instanceof Error ? error.message : '修复授权结果待核对'; await w.store.save(); throw error }
  }
  private async authorized(record: ScenarioRecord, view: RepairTaskView): Promise<void> {
    const w = this.workspaces, authorization = record.repairAuthorization!, local = await w.store.read()
    authorization.status = 'accepted'; delete authorization.message
    const existing = local.scenarioRepairs.find(r => r.view.id === view.id && r.projectId === record.projectId)
    if (existing) { await w.store.save(); return }
    const repair: LocalScenarioRepair = { projectId: record.projectId, entityId: record.entityId, view, task: authorization.task, waiting: false }
    local.scenarioRepairs.push(repair); await w.store.save()
    if (!['active', 'paused'].includes(view.status)) return
    if (!await this.current(repair)) return
    await w.editable(record.entityId, record.projectId)
    await this.request(repair)
  }
  async resume(command: Extract<ScenarioCommand, { action: 'resumeScenarioRepair' }>): Promise<void> {
    const repair = await this.latest(command.entityId)
    if (repair.pending || repair.recoverPending) throw new Error('上次修复操作结果待核对，请先重试核对')
    if (repair.view.status !== 'paused' || !command.answer.trim()) throw new Error('仅暂停的修复可通过补充业务答案继续')
    const { task } = await this.workspaces.editable(command.entityId), draft = await readMaterial(task.worktree, 'scenario', command.entityId)
    if (draft.sha256 !== repair.view.currentHash || command.expectedHash !== draft.sha256) { await this.terminate(repair, 'concurrent-edit'); return }
    repair.pendingAnswer = command.answer; await this.workspaces.store.save()
    await this.event(repair, { type: 'resume', userActionId: command.userActionId })
    await this.recoverPending(repair)
  }
  async cancel(entityId: string): Promise<void> { const repair = await this.latest(entityId); if (repair.pending || repair.recoverPending) throw new Error('上次修复操作结果待核对，请先重试核对'); await this.terminate(repair, 'cancelled') }
  async observationFailed(entityId: string, projectId: string, message: string): Promise<void> {
    const local = await this.workspaces.store.read(), repair = local.scenarioRepairs.findLast(r => r.entityId === entityId && r.projectId === projectId && ['active', 'paused'].includes(r.view.status))
    if (repair) { repair.message = message; await this.terminate(repair, 'cancelled') }
  }
  async checkConcurrent(entityId: string, projectId?: string): Promise<void> {
    const local = await this.workspaces.store.read(), repair = local.scenarioRepairs.findLast(r => r.entityId === entityId && r.projectId === (projectId ?? local.selectedProjectId) && (['active', 'paused'].includes(r.view.status) || r.pending || r.recoverPending))
    if (!repair) return
    if (repair.pending || repair.recoverPending) { await this.recoverPending(repair); return }
    repair.view = await this.workspaces.api.request('GET', `/v1/projects/${repair.projectId}/repairs/${repair.view.id}`)
    if (!['active', 'paused'].includes(repair.view.status)) { repair.waiting = false; delete repair.nextRound; await this.workspaces.store.save(); return }
    if (repair.abortRequested) { await this.terminate(repair, 'cancelled'); return }
    await this.current(repair)
  }
  private async current(repair: LocalScenarioRepair): Promise<boolean> {
    const relative = await findMaterialFile(repair.task.worktree, 'scenario', repair.entityId)
    const bytes = relative ? await containedFile(repair.task.worktree, relative).then(file => readFile(file)).catch(() => undefined) : undefined
    if (bytes && digest(bytes) === repair.view.currentHash) return true
    await this.terminate(repair, 'concurrent-edit'); return false
  }
  /** A lost event response must resume the continuation without writing or counting the round twice. */
  private async recoverPending(repair: LocalScenarioRepair, continueWork = true): Promise<void> {
    const pending = (repair.pending ?? repair.recoverPending)!
    if (repair.pending) await this.sendPending(repair)
    if (!['active', 'paused'].includes(repair.view.status)) { repair.waiting = false; delete repair.nextRound; delete repair.recoverPending; await this.workspaces.store.save(); return }
    if (!await this.current(repair)) { delete repair.recoverPending; await this.workspaces.store.save(); return }
    if (repair.abortRequested) { delete repair.recoverPending; await this.workspaces.store.save(); await this.terminate(repair, 'cancelled'); return }
    if (!continueWork) { delete repair.recoverPending; await this.workspaces.store.save(); return }
    if (pending.type === 'round') await this.continueRound(repair)
    if (pending.type === 'resume') await this.continueResume(repair)
    delete repair.recoverPending; await this.workspaces.store.save()
  }
  private async continueResume(repair: LocalScenarioRepair): Promise<void> {
    delete repair.question
    if (repair.turnEnded === false) { repair.nextRound = true; await this.workspaces.store.save(); return }
    await this.request(repair)
  }
  private async continueRound(repair: LocalScenarioRepair): Promise<void> {
    if (repair.view.status !== 'active' || !await this.current(repair)) return
    await this.workspaces.editable(repair.entityId, repair.projectId)
    const draft = await readMaterial(repair.task.worktree, 'scenario', repair.entityId), after = await this.workspaces.confirmationChecks.inspectTask(repair.task, draft)
    if (after.passed) {
      await this.confirm(repair.entityId, draft.sha256, repair.view.id)
      repair.view = await this.workspaces.api.request('GET', `/v1/projects/${repair.projectId}/repairs/${repair.view.id}`)
      delete repair.message
    } else if (repair.view.roundsUsed >= 3) await this.terminate(repair, 'round-limit')
    else if (repair.turnEnded) await this.request(repair)
    else repair.nextRound = true
    await this.workspaces.store.save()
  }
  private async latest(entityId: string): Promise<LocalScenarioRepair> {
    const local = await this.workspaces.store.read(), repair = local.scenarioRepairs.findLast(r => r.entityId === entityId && r.projectId === local.selectedProjectId)
    if (!repair) throw new Error('没有当前场景的修复任务')
    return repair
  }
  private async request(repair: LocalScenarioRepair): Promise<void> {
    const w = this.workspaces
    await w.editable(repair.entityId, repair.projectId)
    if (repair.view.status !== 'active') return
    if (repair.view.roundsUsed >= 3) { await this.terminate(repair, 'round-limit'); return }
    const context = await w.context(repair.task)
    await w.ports.session(repair.task, '你是只读场景修复助手。先用可读中文说明修复要点，再按协议给出修复候选；根据可信Host传入的当前材料和实际读取依据生成修复候选，不直接写文件、不执行确认。场景只确认触发条件、角色、主要路径、必要分支及业务结果形成完整流程。金额阈值、字段、计算口径等细节留待需求确认，不能因此阻断。可依据当前正文及用户明确答复，不强制要求外部资料；缺少决定流程走向的答案才提问，不得编造。')
    const answer = repair.pendingAnswer ?? ''
    repair.waiting = true; repair.turnEnded = false; delete repair.nextRound; delete repair.pendingAnswer; await w.store.save()
    await w.ports.prompt(repair.task.sessionId, `本任务已由用户授权修复后由Host确认，最多3轮，当前已用${repair.view.roundsUsed}轮。${context}\n本次业务补答：${answer}\n先用可读中文逐项说明本轮修复了什么、对应哪条门禁阻断、依据哪些已读资料；再在回答最后给出唯一 eadp-repair 代码块：{"baseHash":"${repair.view.currentHash}","body":"完整修复后正文","flowComplete":true,"openQuestions":[],"evidenceIds":[]}。块内只写这些字段，引用已读资料时在evidenceIds填写实际ID；仅依据当前正文和用户明确答复时保持空数组。身份、标题、模板与正式依据由Host保留。缺业务答案时先说明缺口，只输出{"baseHash":"${repair.view.currentHash}","question":"需要用户补充的具体问题"}。`)
  }
  async accept(sessionId: string, output: { kind: string; content?: string; reason?: string; seq?: number }): Promise<boolean> {
    const w = this.workspaces, local = await w.store.read(), repair = local.scenarioRepairs.find(r => r.task.sessionId === sessionId)
    if (!repair) return false
    if (output.seq !== undefined) {
      if (repair.lastHandledSeq !== undefined && output.seq <= repair.lastHandledSeq) return true
      repair.lastHandledSeq = output.seq; await w.store.save()
    }
    if (output.kind === 'turn-ended') {
      repair.turnEnded = true
      if (output.reason === 'aborted') repair.abortRequested = true
      await w.store.save()
      if (repair.abortRequested) {
        if (repair.pending || repair.recoverPending) await this.recoverPending(repair, false)
        await this.terminate(repair, 'cancelled'); return true
      }
      if (repair.pending || repair.recoverPending) { await this.recoverPending(repair); return true }
      if (repair.nextRound && repair.view.status === 'active') { delete repair.nextRound; await this.request(repair); return true }
      if (repair.view.status === 'active' && repair.waiting) { repair.waiting = false; repair.message = '生成结束但未返回有效修复结果，可取消后重新授权' }
      await w.store.save(); return true
    }
    if (repair.view.status !== 'active' || !repair.waiting || repair.pending || repair.recoverPending) return true
    if (output.kind !== 'assistant') return true
    const matches = [...(output.content ?? '').matchAll(/```eadp-repair\s*\n([\s\S]*?)\n```/g)]
    if (!matches.length) return true
    repair.waiting = false
    try {
      if (matches.length !== 1) throw new Error('修复必须返回唯一结果')
      await this.checkConcurrent(repair.entityId, repair.projectId)
      if (repair.view.status !== 'active') return true
      const { task, entity } = await w.editable(repair.entityId, repair.projectId), draft = await readMaterial(task.worktree, 'scenario', entity.id)
      const result = JSON.parse(matches[0]![1]!) as { baseHash: string; question?: string; body?: string; flowComplete?: unknown; openQuestions?: unknown; evidenceIds?: unknown }
      if (result.baseHash !== repair.view.currentHash || draft.sha256 !== result.baseHash) { await this.terminate(repair, 'concurrent-edit'); return true }
      if (typeof result.question === 'string' && result.question.trim()) {
        repair.question = result.question.slice(0, 4000); await this.event(repair, { type: 'pause', reason: 'business-answer-required' }); return true
      }
      const record = await w.record(entity.id, task.projectId), readIds = new Set(record.sources.filter(s => s.selected && (s.status === 'read' || s.status === 'partial') && s.text.trim() && s.ranges.length).map(s => s.id))
      if (!Array.isArray(result.evidenceIds) || result.evidenceIds.some(id => typeof id !== 'string' || !readIds.has(id))) { await this.terminate(repair, 'missing-evidence'); return true }
      if (typeof result.body !== 'string') throw new Error('修复候选缺少完整正文')
      // Identity, title, template and formal evidence come from the current file;
      // the Agent may only restate the business quality items and open questions.
      const candidate = { ...draft.metadata, flowComplete: result.flowComplete, openQuestions: result.openQuestions }
      if (!isMaterialMetadata(candidate)) throw new Error('修复候选的业务质量项或待澄清项无效')
      const metadata = await syncProjectContext(task.worktree, candidate)
      const before = await this.workspaces.confirmationChecks.inspectTask(task, draft)
      const next = await w.documents.save({ root: task.worktree, metadata, body: result.body, expectedHash: draft.sha256, operationId: `${repair.view.id}-round-${repair.view.roundsUsed + 1}` })
      const after = await this.workspaces.confirmationChecks.inspectTask(task, next)
      const priorIssues = before.groups.filter(g => g.status === 'blocked').flatMap(g => g.messages), remainingIssues = after.groups.filter(g => g.status === 'blocked').flatMap(g => g.messages)
      const improved = after.passed || remainingIssues.length < priorIssues.length || priorIssues.some(issue => !remainingIssues.includes(issue))
      await this.event(repair, { type: 'round', hashAfter: next.sha256, improved })
      if (repair.view.status !== 'active') return true
      await this.recoverPending(repair)
    } catch (error) { repair.message = error instanceof Error ? error.message : '修复执行结果待核对'; await w.store.save() }
    await w.store.save(); return true
  }
  private async terminate(repair: LocalScenarioRepair, reason: 'cancelled' | 'concurrent-edit' | 'missing-evidence' | 'no-improvement' | 'round-limit'): Promise<void> {
    if (!['active', 'paused'].includes(repair.view.status)) return
    if (repair.pending) throw new Error('上次修复操作结果待核对，请先重试核对')
    repair.waiting = false; delete repair.nextRound; delete repair.pendingAnswer; await this.workspaces.ports.cancelSession?.(repair.task.sessionId); await this.event(repair, { type: 'terminate', reason })
  }
  private async event(repair: LocalScenarioRepair, input: object): Promise<void> {
    if (repair.pending) throw new Error('上次修复操作结果待核对，请先重试核对')
    const { entity } = await this.workspaces.deps.entity(repair.entityId, repair.projectId)
    repair.pending = { ...input, idempotencyKey: randomUUID(), token: await this.workspaces.deps.owned(entity), expectedHash: repair.view.currentHash } as RepairEventRequest
    await this.workspaces.store.save(); await this.sendPending(repair)
  }
  private async sendPending(repair: LocalScenarioRepair): Promise<void> {
    const pending = repair.pending!
    repair.view = await this.workspaces.api.request('POST', `/v1/projects/${repair.projectId}/repairs/${repair.view.id}/events`, repair.pending)
    if ((pending.type === 'round' || pending.type === 'resume') && repair.view.status === 'active') repair.recoverPending = pending
    if (!['active', 'paused'].includes(repair.view.status)) delete repair.recoverPending
    delete repair.pending; await this.workspaces.store.save()
  }
}
