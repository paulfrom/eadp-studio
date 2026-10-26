import { canonical } from '@eadp/asset-domain'
import { isMaterialMetadata, type EntityView, type IntegrationView, type MaterialIntegrationRequest, type MaterialMetadata, type OccupationToken, type ProjectState } from '@eadp/contracts'
import type { ConfirmationChoice, MaterialDraft, TaskView } from '../../shared/studio.ts'
import { digest, parseMaterial, readMaterial } from '../adapters/assets/materials.ts'
import { checkScenarioDocument, scenarioFileErrors } from './scenario-documents.ts'
import type { FixedCandidateInput, FixedCandidates, PreparedCandidate } from './fixed-candidates.ts'
import { mergeNoteText, type MergedCandidate, type MergeNote } from './candidate-merges.ts'
import type { GitIntegrations } from './git-integrations.ts'
import type { HostPorts } from './ports.ts'
import type { ProjectWorkspaces } from './projects.ts'
import type { AuthorReviews } from './reviews.ts'
import type { ScenarioRecord, ScenarioWorkspaces } from './scenario-workspaces.ts'
import type { PendingOperation, StudioStore } from './state.ts'

/** The immutable content and authority of one explicit material confirmation. */
export interface MaterialConfirmationRequest {
  operationId: string; entityId: string; expectedHash: string;
  body?: string; metadata?: MaterialMetadata; choice?: ConfirmationChoice; repairId?: string;
}
/** One owner of confirmation progress; save and integration receipts remain with their implementations. */
export interface MaterialConfirmationOperation {
  operationId: string; accountId: number; projectId: string; entityId: string;
  request: MaterialConfirmationRequest; fingerprint: string; task: TaskView;
  occupation: Pick<OccupationToken, 'occupationId' | 'generation' | 'taskId' | 'clientId'>;
  phase: 'saving' | 'checking' | 'fixed' | 'integrating' | 'accepted' | 'recovery' | 'superseded';
  savedHash?: string; input?: FixedCandidateInput; candidate?: PreparedCandidate; prepare?: MaterialIntegrationRequest;
  integrationId?: string; accepted?: IntegrationView; message?: string; mergeNote?: MergeNote;
}
export interface MaterialInspectionRequest {
  projectId: string; entity: EntityView; task?: TaskView; draft?: MaterialDraft; expectedHash?: string;
}
export interface MaterialInspection extends ReturnType<typeof checkScenarioDocument> { draft: MaterialDraft; templateBody: string; readOnly: boolean }
interface Dependencies {
  entity(entityId: string, projectId?: string): Promise<{ remote: ProjectState; entity: EntityView }>
  designTask(remote: ProjectState, entity: EntityView): Promise<TaskView>
  owned(entity: EntityView): Promise<OccupationToken>
}
const identity = ({ occupationId, generation, taskId, clientId }: OccupationToken): MaterialConfirmationOperation['occupation'] => ({ occupationId, generation, taskId, clientId })
const current = (owner: ScenarioRecord): MaterialConfirmationOperation | undefined => owner.materialConfirmations?.at(-1)
const recovering = (owner: ScenarioRecord): boolean => { const operation = current(owner); return !!operation && operation.phase !== 'accepted' && operation.phase !== 'superseded' }

/** Collects current material, template and authority facts behind one gate interface. */
export class MaterialConfirmationChecks {
  constructor(private readonly store: StudioStore, private readonly ports: HostPorts,
    private readonly workspaces: ScenarioWorkspaces, private readonly projects: ProjectWorkspaces) {}

  /** Collect trusted gate facts for display, explicit confirmation and authorized repair alike. */
  async inspect(input: MaterialInspectionRequest): Promise<MaterialInspection | undefined> {
    const { projectId, entity, task } = input
    if ((entity.kind !== 'scenario' && entity.kind !== 'requirement') || entity.builtinKey) throw new Error('请选择可确认的场景或需求')
    const local = await this.store.read(), account = await this.ports.account(), owner = await this.workspaces.record(entity.id, projectId)
    const occupied = entity.occupation?.ownerId === account?.id && entity.occupation?.clientId === local.clientId && entity.occupation?.purpose === 'design'
    const readOnly = !!entity.current && !occupied
    let draft = input.draft
    if (!draft) {
      if (readOnly && !recovering(owner) && !this.workspaces.requirementSaves.view(owner)) {
        const fixed = entity.current!.fixed, bytes = await this.projects.localFixed(projectId, fixed.commitSha, fixed.path, fixed.sha256)
        if (!bytes) return undefined
        draft = parseMaterial(Buffer.from(bytes), fixed.path)
      } else {
        if (!task) throw new Error('原编辑任务现场缺失，请保留输入并核对任务')
        draft = await readMaterial(task.worktree, entity.kind, entity.id)
      }
    }
    if (draft.entityId !== entity.id || draft.metadata.kind !== entity.kind) throw new Error('当前材料身份或类型已变化')
    const ref = draft.metadata.templateRef
    if (!ref) throw new Error('材料缺少固定模板')
    const template = await this.projects.localFixed(projectId, ref.commitSha, ref.path, ref.sha256)
    if (!template) return undefined
    const templateBody = Buffer.from(template).toString('utf8')
    const checked = checkScenarioDocument({ draft, expectedHash: input.expectedHash ?? draft.sha256,
      hasPermission: !!account, hasOccupation: !!occupied, conflict: !!owner.conflict,
      structureCheck: local.scenarioStructureCheck, templateBody,
      fileErrors: task && (!readOnly || recovering(owner)) ? await scenarioFileErrors(task.worktree, draft) : [] })
    if (owner.observationError) {
      const version = checked.groups.find(gate => gate.id === 'version')!
      version.status = 'blocked'; version.messages.push(owner.observationError); checked.passed = false
    }
    return { ...checked, draft, templateBody, readOnly }
  }

  async inspectTask(task: TaskView, draft: MaterialDraft): Promise<MaterialInspection> {
    const { entity } = await this.workspaces.deps.entity(task.entityId, task.projectId)
    const inspection = await this.inspect({ projectId: task.projectId, entity, task, draft, expectedHash: draft.sha256 })
    if (!inspection) throw new Error('所选模板固定版本正在后台同步，请稍后重试')
    return inspection
  }

}

/** Owns material confirmation from the author's exact input to durable backend acceptance. */
export class MaterialConfirmations {
  constructor(private readonly store: StudioStore, private readonly ports: HostPorts,
    private readonly workspaces: ScenarioWorkspaces, private readonly candidates: FixedCandidates, private readonly integrations: GitIntegrations,
    private readonly reviews: AuthorReviews, private readonly deps: Dependencies) {}

  view(owner: ScenarioRecord, operations?: PendingOperation[]): { operationId: string; message: string; expectedHash?: string } | undefined {
    const operation = current(owner)
    if (!operation || operation.phase === 'accepted' || operation.phase === 'superseded') return undefined
    const child = operation.integrationId ? operations?.find(value => value.id === operation.integrationId && value.projectId === operation.projectId) : undefined
    const failure = child?.phase === 'unknown' ? child.message : undefined
    return { operationId: operation.operationId,
      message: operation.message ?? failure ?? (operation.phase === 'integrating' ? '确认已提交，正在核对原结果' : '请按选择恢复保存并继续确认'),
      ...(operation.savedHash ? { expectedHash: operation.savedHash } : {}) }
  }

  async confirm(request: MaterialConfirmationRequest): Promise<MaterialConfirmationOperation> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(request.operationId) || !/^[a-f0-9]{64}$/.test(request.expectedHash) || (!!request.choice === !!request.repairId)) throw new Error('材料确认的操作身份、版本或授权无效')
    if ((request.body === undefined) !== (request.metadata === undefined)) throw new Error('材料确认必须提交完整正文与元数据')
    if (request.metadata && (!isMaterialMetadata(request.metadata) || request.metadata.entityId !== request.entityId)) throw new Error('材料确认的内容身份无效')
    const accountId = this.store.accountId
    if (!accountId) throw new Error('请登录后确认材料')
    await this.account(accountId)
    const { remote, entity } = await this.deps.entity(request.entityId)
    await this.account(accountId)
    if ((entity.kind !== 'scenario' && entity.kind !== 'requirement') || entity.builtinKey) throw new Error('请选择可确认的场景或需求')
    const owner = await this.workspaces.record(entity.id, remote.project.id), fingerprint = digest(canonical(request))
    const existing = owner.materialConfirmations?.find(operation => operation.operationId === request.operationId)
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error('同一确认操作不能用于不同内容或确认依据')
      if (existing.phase === 'superseded') throw new Error('该确认已由新的用户选择承接')
      await this.advance(owner, existing); return existing
    }
    const previous = current(owner)
    if (previous?.integrationId && previous.phase !== 'accepted') throw new Error('原确认已提交，请先核对原确认结果，或保留当前输入稍后继续')
    const token = await this.deps.owned(entity)
    if (entity.occupation?.purpose !== 'design') throw new Error('材料确认需要当前有效设计占用，不能自动重新认领')
    const task = await this.deps.designTask(remote, entity)
    await this.account(accountId)
    const captured = structuredClone(request)
    // Hash-only commands refer to an already saved draft; keep its exact input
    // so an external edit cannot erase the author's original recovery choice.
    if (captured.body === undefined) {
      const draft = await readMaterial(task.worktree, entity.kind, entity.id)
      await this.account(accountId)
      if (draft.sha256 !== request.expectedHash) throw new Error('文件已变化，请核对当前内容后重新确认')
      captured.body = draft.body; captured.metadata = structuredClone(draft.metadata)
    }
    const operation: MaterialConfirmationOperation = { operationId: request.operationId, accountId, projectId: remote.project.id, entityId: entity.id,
      request: captured, fingerprint, task: structuredClone(task), occupation: identity(token), phase: 'saving' }
    if (previous && previous.phase !== 'accepted') previous.phase = 'superseded'
    ;(owner.materialConfirmations ??= []).push(operation)
    await this.store.save()
    void this.workspaces.statusReports.report({ projectId: operation.projectId, entityId: operation.entityId, trigger: 'pre-confirmation', worktree: task.worktree, baseHead: remote.project.recognizedHead ?? task.baseHead })
    await this.advance(owner, operation)
    return operation
  }

  /** Continue the current explicit confirmation after its existing save recovery finishes. */
  async continue(entityId: string, projectId?: string): Promise<void> {
    const owner = await this.workspaces.record(entityId, projectId), operation = current(owner)
    if (operation && operation.phase !== 'accepted' && operation.phase !== 'superseded') await this.advance(owner, operation)
  }

  async retry(entityId: string, operationId: string, projectId?: string): Promise<void> {
    const owner = await this.workspaces.record(entityId, projectId), operation = owner.materialConfirmations?.find(value => value.operationId === operationId)
    if (!operation || current(owner) !== operation || operation.phase === 'superseded') throw new Error('未找到当前用户选择对应的确认操作')
    await this.advance(owner, operation)
  }

  /** Rebind a confirmation to its merged candidate; the author's original read hash stays untouched. */
  async remap(originalIntegrationId: string, next: MergedCandidate): Promise<void> {
    const local = await this.store.read()
    const operation = local.scenarios.flatMap(record => record.materialConfirmations ?? []).find(value => value.integrationId === originalIntegrationId)
    if (!operation) throw new Error('原确认记录缺失，合并候选已保留')
    operation.integrationId = next.prepare.idempotencyKey
    operation.prepare = structuredClone(next.prepare)
    operation.candidate = { ...operation.candidate!, task: structuredClone(next.task), draft: structuredClone(next.draft),
      prepare: structuredClone(next.prepare), confirmations: structuredClone(next.prepare.confirmations) }
    operation.mergeNote = structuredClone(next.note)
    operation.message = `${mergeNoteText(next.note)}，正在核对集成结果`
    operation.phase = 'integrating'
    await this.store.save()
  }

  /** Persist completion before independently delivered work can fail. */
  async accept(integration: PendingOperation, accepted: IntegrationView): Promise<void> {
    const owner = await this.workspaces.record(integration.entityId, integration.projectId)
    const operation = owner.materialConfirmations?.find(value => value.integrationId === integration.id)
    if (!operation) return
    await this.scope(operation)
    if (accepted.status !== 'accepted' || accepted.candidateSha !== operation.prepare?.candidateSha) throw new Error('后台尚未接受本次精确固定候选')
    operation.accepted = structuredClone(accepted); operation.phase = 'accepted'; delete operation.message
    await this.store.save()
  }

  private async scope(operation: MaterialConfirmationOperation): Promise<void> {
    await this.account(operation.accountId)
  }
  private async account(accountId: number): Promise<void> {
    if (!this.store.scoped || this.store.accountId !== accountId) throw new Error('登录身份已变化，原确认已保留供核对')
    const account = await this.ports.account()
    if (!this.store.scoped || this.store.accountId !== accountId || account?.id !== accountId) throw new Error('登录身份已变化，原确认已保留供核对')
  }

  private async context(operation: MaterialConfirmationOperation): Promise<{ entity: EntityView; task: TaskView }> {
    await this.scope(operation)
    const { entity } = await this.deps.entity(operation.entityId, operation.projectId), local = await this.store.read()
    await this.scope(operation)
    const original = operation.task
    const task = local.tasks.find(value => value.projectId === operation.projectId && value.entityId === operation.entityId && value.worktree === original.worktree && value.sessionId === original.sessionId && value.purpose === original.purpose && value.inputHash === original.inputHash)
    if (!task || task.cleanup) throw new Error('原编辑任务现场缺失，已保留输入，请核对原任务')
    const token = await this.deps.owned(entity)
    if (canonical(identity(token)) !== canonical(operation.occupation)) throw new Error('材料占用已变化，请保留输入并重新选择恢复方式')
    return { entity, task }
  }

  private async advance(owner: ScenarioRecord, operation: MaterialConfirmationOperation): Promise<void> {
    if (operation.phase === 'accepted' || operation.phase === 'superseded') return
    await this.scope(operation)
    try {
      if (operation.integrationId && operation.prepare && operation.candidate) {
        const child = (await this.store.read()).operations.find(value => value.id === operation.integrationId && value.projectId === operation.projectId && value.entityId === operation.entityId && value.accountId === operation.accountId)
        if (child) {
          if (child.phase === 'accepted' && child.accepted) await this.accept(child, child.accepted)
          this.integrations.schedule(child)
        } else {
          const { task } = await this.context(operation)
          await this.integrations.submit(task, operation.candidate.draft, operation.prepare)
        }
        return
      }
      const { entity, task } = await this.context(operation), { request } = operation
      let draft: MaterialDraft
      if (entity.kind === 'requirement' && request.body !== undefined && request.metadata) {
        await this.workspaces.requirementSaves.save({ action: 'saveRequirement', entityId: entity.id, operationId: operation.operationId,
          expectedHash: request.expectedHash, body: request.body, metadata: request.metadata }, operation.projectId)
        const pending = this.workspaces.requirementSaves.view(owner)
        if (pending) { operation.phase = 'saving'; operation.message = pending.message; await this.store.save(); return }
        const saved = this.workspaces.requirementSaves.result(owner, operation.operationId)
        if (!saved) throw new Error('本次完整保存尚未完成，请按当前选择恢复')
        draft = saved
      } else {
        draft = await readMaterial(task.worktree, entity.kind, entity.id)
        if (draft.sha256 !== request.expectedHash) throw new Error('文件已变化，请选择当前内容、外部版本或合并后继续确认')
      }
      operation.savedHash = draft.sha256; operation.phase = 'checking'; delete operation.message
      await this.store.save()
      const refreshed = await this.context(operation)
      const inspection = await this.workspaces.confirmationChecks.inspect({ projectId: operation.projectId, entity: refreshed.entity, task: refreshed.task, expectedHash: draft.sha256 })
      if (!inspection) throw new Error('所选模板固定版本正在后台同步，请稍后重试')
      if (!inspection.passed) throw new Error(inspection.groups.filter(gate => gate.status === 'blocked').flatMap(gate => gate.messages).join('；'))
      const candidateRequest = { projectId: operation.projectId, entityId: operation.entityId,
        purpose: 'material' as const, task: refreshed.task, expectedHash: draft.sha256, operationId: operation.operationId }
      if (!operation.input) {
        const content = await this.candidates.content(candidateRequest)
        operation.input = structuredClone({ snapshot: content.snapshot, paths: content.paths, allowedPaths: content.allowedPaths, input: content.input, inputHash: content.inputHash })
        await this.scope(operation); await this.store.save()
      }
      const candidate = operation.candidate ?? await this.candidates.prepare({ ...candidateRequest, fixedInput: operation.input })
      operation.candidate = structuredClone(candidate); operation.phase = 'fixed'; await this.store.save()
      const authority = request.repairId ? { confirmationMethod: 'ai-repair' as const, repairTaskId: request.repairId }
        : await this.reviews.confirmation(request.choice!, candidate.review)
      const prepare: MaterialIntegrationRequest = { ...candidate.prepare, confirmations: candidate.confirmations.map(value => ({ ...value, readHash: value.fixed.sha256, ...authority, authorConfirmed: true as const })) }
      operation.prepare = structuredClone(prepare); operation.integrationId = prepare.idempotencyKey; operation.phase = 'integrating'
      await this.scope(operation); await this.store.save()
      await this.integrations.submit(refreshed.task, candidate.draft, prepare)
    } catch (error) {
      await this.scope(operation)
      operation.phase = operation.integrationId ? 'integrating' : 'recovery'
      operation.message = error instanceof Error ? error.message : '确认尚未完成，请选择恢复方式'
      await this.store.save()
    }
  }
}
