import { ScenarioWorkspaces } from './scenario-workspaces.ts'
import { ScenarioTemplates } from './scenario-templates.ts'
import { ScenarioRepairs } from './scenario-repairs.ts'
import { scenarioFileErrors } from './scenario-documents.ts'
import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { isMaterialMetadata, reviewInputText } from '@eadp/contracts'
import { canonical, prototypeBindings } from '@eadp/asset-domain'
import path from 'node:path'
import type { NamespaceView, CheckEvidence, ConfirmationInput, EntityOccupancyView, EntityView, FixedReference, FixedVersion, IntegrationView, MaterialIntegrationRequest, OccupationToken, ProjectState, ProjectView, MaterialMetadata } from '@eadp/contracts'
import type { Candidate, ConfirmationChoice, MaterialDraft, ProjectProgressReply, StudioCommand, StudioReply, StudioState, TaskView } from '../../shared/studio.ts'
import { checkMaterial, containedFile, digest, findMaterialFile, normalizeMaterialPath, parseMaterial, readMaterial, saveMaterial } from '../adapters/assets/materials.ts'
import { CollaborationClient, CollaborationError } from '../adapters/collaboration/client.ts'
import { initialMetadata, type HostPorts, type SessionOutput } from './ports.ts'
import { StudioStore, type PendingOperation, type AdoptionOperation, type MaterialReservation } from './state.ts'
import { ProjectWorkspaces } from './projects.ts'
import { TaskMaintenance } from './task-maintenance.ts'
import { AuthorReviews, type ReviewCandidate, type ReviewFile } from './reviews.ts'
import { syncProjectContext } from './scenario-package.ts'
import { BackgroundLane } from './background-lane.ts'
import { ProjectProgressTracker } from './progress.ts'
import { RequirementCandidates } from './requirement-candidates.ts'
import { ConsistencyComparisons } from './consistency-comparisons.ts'
import type { CandidateTemplate, SplitSource } from '../../shared/requirements.ts'
import type { ConsistencyCommand } from '../../shared/consistency.ts'
import type { RequirementWorkspaceCommand } from '../../shared/requirement-workspace.ts'
import { candidateBusinessEvidence } from './requirement-candidate-content.ts'
import { readRequirementSource } from './requirement-sources.ts'

const prototypeRules = '按已确认需求完成原型；发现冲突时保留代码并要求作者修订需求，不得自行确认。'
const key = (): string => randomUUID()
const sameSource = (left: { projectId: string; entityId: string; version: number }, right: { projectId: string; entityId: string; version: number }) => left.projectId === right.projectId && left.entityId === right.entityId && left.version === right.version
const isEntityView = (value: EntityView | EntityOccupancyView): value is EntityView => 'generation' in value
const exists = (target: string): Promise<boolean> => stat(target).then(() => true, error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return false })
const starter = (title: string) => `# ${title}\n\n## 业务背景\n\n请与 AI 整理实际业务背景与使用者。\n\n## 核心业务规则\n\n待补充。\n\n## 验收条件\n\n待补充。\n\n## 限制与不适用范围\n\n待澄清。\n`
/** One failure mapping for every command: an operation that fails answers with a typed reply, never a rejected promise. */
const respond = (result: Promise<StudioReply>): Promise<StudioReply> =>
  result.catch((error: unknown) => ({ ok: false, code: error instanceof CollaborationError ? error.code : 'STUDIO_OPERATION_FAILED', message: error instanceof Error ? error.message : '操作未完成，请查询当前状态' }))

/** Serializes one local writer. PostgreSQL and Git CAS remain the cross-client authority. */
export class StudioApplication {
  private queue: Promise<unknown> = Promise.resolve()
  /** Work no reply waits for: Git synchronization and the preparation that depends on it. */
  private readonly lane = new BackgroundLane()
  /** Progress of that work, read by the surfaces without waiting for it. */
  private readonly progress = new ProjectProgressTracker()
  private projection: Promise<StudioState> | undefined
  private previewState: StudioState['preview']
  private namespaces: NamespaceView[] = []
  private readonly reviews: AuthorReviews
  private readonly projects: ProjectWorkspaces
  private readonly maintenance: TaskMaintenance
  private readonly scenarios: ScenarioWorkspaces
  private readonly templates: ScenarioTemplates
  private readonly repairs: ScenarioRepairs
  private readonly candidates: RequirementCandidates
  private readonly comparisons: ConsistencyComparisons
  private lastState: StudioState | undefined
  constructor(readonly store: StudioStore, private readonly api: CollaborationClient, private readonly ports: HostPorts) { this.projects = new ProjectWorkspaces(store, api, ports, this.lane, this.progress); this.reviews = new AuthorReviews(store, ports)
    this.maintenance = new TaskMaintenance(store, ports, { sync: (projectId, commit) => this.projects.syncMain(projectId, commit), release: task => this.releaseTask(task) })
    this.scenarios = new ScenarioWorkspaces(store, api, ports, this.projects, { entity: (id, projectId) => this.entity(id, projectId), task: (remote, entity) => this.designTask(remote, entity), owned: entity => this.requireOwned(entity), deliver: work => this.lane.append(work), changed: async (task, error) => { if (error) await this.repairs.observationFailed(task.entityId, task.projectId, error); else await this.repairs.checkConcurrent(task.entityId, task.projectId) } })
    this.templates = new ScenarioTemplates(store, api, ports, this.projects, this.lane)
    this.repairs = new ScenarioRepairs(this.scenarios, (id, hash, repairId) => this.confirmRepairedScenario(id, hash, repairId))
    this.candidates = new RequirementCandidates(store, ports, {
      readFixed: (projectId, fixed) => this.projects.readFixed(projectId, fixed.commitSha, fixed.path, fixed.sha256),
      template: projectId => this.requirementTemplate(projectId),
      create: candidate => this.createMaterial('requirement', candidate.title, candidate.sources.map(source => source.entityId), candidate.id, candidate),
      write: (candidate, entityId) => this.verifyCandidateContent(candidate, entityId),
    })
    this.comparisons = new ConsistencyComparisons(store, api, ports)
  }
  /** Await every queued command and every background Git task this workbench started. */
  async settle(): Promise<void> { await this.queue; await this.lane.settle(); await this.comparisons.settle() }
  /**
   * Read the progress of the project operations the background lane is running.
   * This is a local read: no network, no Git, and no wait for the work it reports.
   * @returns the operations currently running or stopped with a reason.
   */
  projectProgress(): ProjectProgressReply { return { operations: this.progress.views() } }
  async dispose(): Promise<void> { this.scenarios.dispose(); await this.comparisons.dispose(); await this.settle(); await this.projects.dispose() }
  /**
   * Run one command. Projection reads keep their own lane so a long local write
   * (worktree, dependency install, checks, agent resume) cannot hold the state the
   * workbench and the settings surface render; every other action keeps the single
   * local-writer queue. A projection reads the local store while a writer is mid-save,
   * which the store's atomic file replacement already tolerates.
   */
  command(command: StudioCommand): Promise<StudioReply> {
    if (command.action === 'state') return this.project()
    const result = this.queue.then(() => this.execute(command))
    this.queue = result.catch(() => undefined)
    return respond(result)
  }
  /**
   * Join the projection read already in flight instead of starting another: the
   * workbench poll and every mounted settings section collapse into one Host read.
   * A caller that arrives after the read settled starts the next one.
   * @returns the shared projection as a successful reply.
   */
  private project(): Promise<StudioReply> {
    let read = this.projection
    if (read === undefined) {
      const started = this.state()
      read = started
      this.projection = started
      const settled = (): void => { if (this.projection === started) this.projection = undefined }
      void started.then(settled, settled)
    }
    return respond(read.then(state => ({ ok: true, state })))
  }
  private async execute(command: Exclude<StudioCommand, { action: 'state' }>): Promise<StudioReply> {
    let sessionId: string | undefined
    if (command.action !== 'login' && command.action !== 'logout') await this.requireAccount()
    if (command.action === 'readRequirementSource') {
      const { remote, entity } = await this.entity(command.entityId)
      const requirementSource = await readRequirementSource(remote.project.id, entity, command.sourceEntityId, command.expectedVersion, {
        versions: entityId => this.api.request<FixedVersion[]>('GET', this.route(remote.project.id, `/entities/${encodeURIComponent(entityId)}/versions`)),
        read: fixed => this.projects.readFixed(remote.project.id, fixed.commitSha, fixed.path, fixed.sha256),
      })
      return { ok: true, state: await this.state(), requirementSource }
    }
    if (['compareConsistency', 'cancelConsistencyComparison', 'retryConsistencySubmission', 'checkConsistencyFreshness', 'listConsistencyComparisons', 'listConsistencySummaries'].includes(command.action)) return this.executeConsistency(command as ConsistencyCommand)
    sessionId = await this.executeScenario(command)
    switch (command.action) {
      case 'login': {
        await this.comparisons.dispose(); this.lastState = undefined
        await this.ports.stopPreview(); this.previewState = undefined; this.namespaces = []
        const identity = await this.ports.login(command.username, command.password)
        this.store.useUser(identity.user.id)
        // Login's contract is authentication, not a full projection: the reply
        // only needs connected+account, and a projection failure must not mask
        // an already-stored successful login. The workbench refreshes its own
        // full state right after.
        return { ok: true, state: { connected: true, account: identity.user, projects: [], availableProjects: [], namespaces: [], projectInitializations: [], drafts: [], tasks: [], candidates: [], reviews: [], pending: [] } }
      }
      case 'logout': { try { await this.comparisons.dispose(); await this.ports.logout() } finally { this.scenarios.dispose(); this.store.useUser(); await this.ports.stopPreview(); await this.projects.dispose(); this.previewState = undefined; this.lastState = undefined; this.namespaces = [] } break }
      case 'namespaces': this.namespaces = await this.api.request<NamespaceView[]>('GET', '/v1/namespaces', undefined, 180_000); break
      case 'createProject': await this.projects.create(command); break
      case 'openProject': await this.projects.open(command.projectId); break
      case 'retryProjectInitialization': await this.projects.retry(command.operationId); break
      case 'bindScenarioTemplate': await this.bindScenarioTemplate(command.entityId, command.templateId); break
      case 'splitRequirements': sessionId = await this.splitRequirements(command.scenarioIds); break
      case 'createMaterial': { const entity = await this.createMaterial(command.kind, command.title, command.scenarioIds, command.operationId); if (entity.kind === 'scenario') this.scenarios.activeEntityId = entity.id; break }
      case 'saveMaterial': {
        const context = await this.entity(command.entityId)
        if (context.entity.kind === 'scenario' || context.entity.kind === 'requirement') throw new Error('场景与需求编辑必须使用带版本检查的保存命令')
        const task = await this.designTask(context.remote, context.entity)
        if (command.metadata.entityId !== command.entityId || command.metadata.kind !== context.entity.kind) throw new Error('材料身份不能修改')
        await saveMaterial(task.worktree, command.metadata, command.body); break
      }
      case 'startSession': {
        const { remote, entity } = await this.entity(command.entityId)
        if (command.purpose === 'prototype') {
          const task = await this.prototypeTask(remote, entity)
          sessionId = await this.ports.session(task, prototypeRules)
        } else {
          if ((entity.kind === 'scenario' || entity.kind === 'requirement') && entity.current && !entity.occupation) throw new Error('已确认材料只读，请显式开始修订')
          const task = await this.designTask(remote, entity)
          const draft = await readMaterial(task.worktree, entity.kind, entity.id)
          sessionId = await this.ports.session(task, this.materialRules(draft))
        }
        break
      }
      case 'restoreSession': sessionId = await this.restoreSession(command.sessionId); break
      case 'requestReview': { const content = await this.prepareContent(command.entityId, command.purpose); await this.reviews.request({ projectId: content.remote.project.id, entityId: content.entity.id, purpose: command.purpose, head: content.snapshot.head, inputHash: content.inputHash, files: content.snapshot.files, paths: content.paths, task: content.task }); break }
      case 'confirmMaterial': await this.confirmMaterial(command.entityId, command.expectedHash, command); break
      case 'claimPrototype': { const { remote, entity } = await this.entity(command.entityId); const task = await this.prototypeTask(remote, entity); sessionId = await this.ports.session(task, prototypeRules); break }
      case 'checkPrototype': { this.previewState = undefined; const { remote, entity } = await this.entity(command.entityId); const task = await this.prototypeTask(remote, entity); const sha = (await this.ports.git.state(task.worktree)).head; await this.ports.checks(task, sha); break }
      case 'startPreview': { this.previewState = undefined; const { remote, entity } = await this.entity(command.entityId); const task = await this.prototypeTask(remote, entity); const result = await this.ports.preview(task); this.previewState = { entityId: entity.id, url: result.url }; break }
      case 'stopPreview': await this.ports.stopPreview(); this.previewState = undefined; break
      case 'confirmPrototype': await this.confirmPrototype(command.entityId, command); break
      case 'releaseOccupation': {
        const { remote, entity } = await this.entity(command.entityId)
        const token = await this.requireOwned(entity)
        await this.api.request('POST', this.route(remote.project.id, `/entities/${entity.id}/cancel`), { idempotencyKey: key(), token, reason: '作者主动取消任务，保留本地草稿和代码现场' })
        const local = await this.store.read(); for (const task of local.tasks.filter(t => t.projectId === remote.project.id && t.entityId === entity.id)) this.scenarios.stopObservation(task)
        await this.ports.stopPreview(); this.previewState = undefined; break
      }
      case 'setEligibility': {
        const { remote } = await this.entity(command.entityId)
        await this.api.request('POST', this.route(remote.project.id, `/entities/${command.entityId}/eligibility`), { idempotencyKey: key(), version: command.version, enabled: command.enabled, reason: command.reason }); break
      }
      case 'selectCandidate': { const local = await this.store.read(); if (!local.selectedProjectId) throw new Error('请先选择项目'); await this.candidates.select(command.candidateId, local.selectedProjectId, command.expectedInputHash); break }
      case 'adopt': await this.adopt(command); break
      case 'retryOperation': {
        const local = await this.store.read(); const operation = local.operations.find(op => op.id === command.operationId)
        if (operation) this.resumeOnLane(operation)
          else { const adoption = local.adoptions.find(op => op.id === command.operationId); const reservation = local.materialReservations.find(op => op.id === command.operationId)
            const repairAuthorization = local.scenarios.find(record => record.projectId === local.selectedProjectId && record.repairAuthorization?.request.idempotencyKey === command.operationId)
            const repairEvent = local.scenarioRepairs.find(record => record.projectId === local.selectedProjectId && (record.pending?.idempotencyKey === command.operationId || record.recoverPending?.idempotencyKey === command.operationId))
            const templateBinding = local.scenarios.find(record => record.projectId === local.selectedProjectId && (record.templateBinding?.request.idempotencyKey === command.operationId || record.templateBinding?.application?.operationId === command.operationId))
            if (adoption) await this.resumeAdoption(adoption)
            else if (reservation) await this.retryMaterialReservation(reservation)
            else if (repairAuthorization) await this.repairs.retryStart(repairAuthorization.entityId)
            else if (repairEvent) await this.repairs.checkConcurrent(repairEvent.entityId, repairEvent.projectId)
            else if (templateBinding) await this.scenarios.retryTemplateBinding(templateBinding.entityId)
            else if (local.templateOperations.some(op => op.preview.operationId === command.operationId)) { const { remote } = await this.selected(); await this.templates.publish(command.operationId, remote) }
            else throw new Error('未找到原操作现场') }
        break
      }
      case 'syncMainCheckout': {
        const local = await this.store.read(), project = local.projects.find(p => p.id === command.projectId)
        if (!project) throw new Error('项目未在本机登记')
        const remote = await this.api.request<ProjectState>('GET', this.route(project.id))
        if (!remote.project.recognizedHead) throw new Error('项目没有已接受版本')
        this.lane.append(() => this.projects.syncMain(project.id, remote.project.recognizedHead!)); break
      }
      case 'retryTaskSettlement': {
        const local = await this.store.read(), task = local.tasks.find(t => t.projectId === command.projectId && path.resolve(t.worktree) === path.resolve(command.worktree))
        if (!task) throw new Error('任务记录不存在')
        const remote = await this.api.request<ProjectState>('GET', this.route(task.projectId))
        if (!remote.project.recognizedHead) throw new Error('项目没有已接受版本')
        this.lane.append(() => this.maintenance.settle(task, remote.project.recognizedHead!)); break
      }
      case 'generateHandoff': await this.generateHandoff(command.baselineId); break
      case 'acknowledgeHandoff': {
        const { remote, entity } = await this.entity(command.entityId)
        if (entity.kind !== 'handoff' || !entity.current) throw new Error('交接材料尚未确认')
        await this.api.request('POST', this.route(remote.project.id, `/entities/${entity.id}/receipts`), { idempotencyKey: key(), confirmationId: entity.current.confirmationId, note: command.note }); break
      }
      case 'publish': case 'revokePublication': {
        const { remote } = await this.selected(); const baseline = remote.baselines.find(b => b.id === remote.project.currentBaselineId)
        await this.ports.publication(command.action, baseline); break
      }
    }
    const state = await this.state()
    return { ok: true, state, ...(sessionId ? { sessionId } : {}) }
  }
  async scenarioSessionContext(task: TaskView, signal?: AbortSignal): Promise<{ text: string; readPaths: string[] }> {
    signal?.throwIfAborted()
    if ((await this.ports.account())?.id !== this.store.accountId) throw new Error('会话登录身份已变化')
    const text = await this.scenarios.context(task), local = await this.store.read()
    const paths = await this.scenarios.sources.readPaths(task)
    for (const value of local.tasks.filter(item => item.projectId === task.projectId && item.entityId === task.entityId && item.purpose === 'material')) { const relative = await findMaterialFile(value.worktree, 'scenario', value.entityId); if (relative) paths.push(path.join(value.worktree, relative)) }
    return { text, readPaths: paths }
  }
  private async requirementTemplate(projectId: string): Promise<CandidateTemplate> {
    const remote = await this.api.request<ProjectState>('GET', this.route(projectId))
    const catalog = await this.templates.catalog(remote.project)
    const template = catalog?.requirements.templates.find(value => value.id === catalog.requirements.defaultTemplateId)
    if (!template) throw new Error('本项目默认需求模板尚未就绪，请先发布或等待后台同步')
    return { id: template.id, fixed: template.fixed, body: template.body }
  }
  /** Split only the chosen accepted inputs; later confirmations never replace these references. */
  private async splitRequirements(scenarioIds: string[]): Promise<string> {
    const { project, remote } = await this.selected()
    if (!scenarioIds.length || new Set(scenarioIds).size !== scenarioIds.length) throw new Error('请选择不同的已确认普通场景')
    const sources: SplitSource[] = scenarioIds.map(id => {
      const entity = remote.entities.find((value): value is EntityView => isEntityView(value) && value.id === id)
      if (!entity || entity.kind !== 'scenario' || entity.builtinKey || !entity.current) throw new Error('联合拆分只接受本项目已确认普通场景')
      return { projectId: project.id, entityId: entity.id, title: entity.title, version: entity.current.version, confirmationId: entity.current.confirmationId, fixed: entity.current.fixed }
    })
    const existingRequirements = remote.entities.filter(isEntityView).filter(entity => entity.kind === 'requirement' && entity.scenarioIds.some(id => scenarioIds.includes(id))).map(entity => ({ id: entity.id, title: entity.title, ...(entity.summary !== undefined ? { summary: entity.summary } : {}) }))
    return (await this.candidates.start({ projectId: project.id, worktree: project.directory, sources, existingRequirements })).sessionId
  }
  /** The adopted candidate is written during the same recoverable materialization as its reservation. */
  private async verifyCandidateContent(candidate: Candidate, entityId: string): Promise<void> {
    const { remote, entity } = await this.entity(entityId, candidate.projectId)
    if (entity.kind !== 'requirement') throw new Error('候选目标不是需求')
    const task = await this.designTask(remote, entity), draft = await readMaterial(task.worktree, 'requirement', entity.id)
    const sources = candidate.sources.map(source => ({ projectId: source.projectId, entityId: source.entityId, version: source.version }))
    if (draft.body !== candidate.body || draft.metadata.kind !== 'requirement' || draft.metadata.templateId !== candidate.template.id || canonical(draft.metadata.templateRef) !== canonical(candidate.template.fixed) || canonical(draft.metadata.sources) !== canonical(sources) || canonical(draft.metadata.openQuestions) !== canonical(candidate.quality.openQuestions)) throw new Error('原候选目标内容已变化，保留当前材料并核对原操作')
  }
  /** Comparison commands reply from local projection only, keeping state/Git loading outside their call path. */
  private async executeConsistency(command: ConsistencyCommand): Promise<StudioReply> {
    const local = await this.store.read(), project = local.projects.find(value => value.id === local.selectedProjectId)
    if (!project) throw new Error('请先打开当前项目')
    switch (command.action) {
      case 'compareConsistency': {
        const task = local.tasks.findLast(value => value.projectId === project.id && value.entityId === command.entityId && value.purpose === 'material' && !value.cleanup)
        const worktree = task && await exists(task.worktree) ? task.worktree : project.directory
        await this.comparisons.start({ projectId: project.id, entityId: command.entityId, worktree, trigger: 'manual' }); break
      }
      case 'cancelConsistencyComparison': await this.comparisons.cancel(command.comparisonId, project.id); break
      case 'retryConsistencySubmission': await this.comparisons.retry(command.comparisonId, project.id); break
      case 'checkConsistencyFreshness': await this.comparisons.checkFreshness(command.comparisonId, project.id); break
      case 'listConsistencyComparisons': await this.comparisons.list(project.id, command.entityId, command.limit, command.offset); break
      case 'listConsistencySummaries': await this.comparisons.listLatest(project.id); break
    }
    const account = await this.ports.account()
    const state: StudioState = this.lastState?.account?.id === account?.id && this.lastState?.selectedProjectId === project.id ? this.lastState : { connected: true, ...(account ? { account } : {}), projects: local.projects, selectedProjectId: project.id, availableProjects: [], namespaces: [], projectInitializations: [], drafts: [], tasks: [], candidates: [], reviews: [], pending: [] }
    const comparisons = command.action === 'listConsistencyComparisons' ? this.comparisons.historyViews(project.id, command.entityId) : undefined
    return { ok: true, state: { ...state, consistencyTasks: await this.comparisons.views(project.id), consistencyLatest: this.comparisons.latestViews(project.id) }, ...(comparisons ? { comparisons } : {}) }
  }
  private async executeScenario(command: StudioCommand): Promise<string | undefined> {
    if (['openRequirement', 'startRequirementRevision', 'saveRequirement', 'resolveRequirementConflict', 'resolveRequirementWriteProposal', 'undoRequirementWrite', 'newRequirementSession', 'selectRequirementSession', 'bindRequirementTemplate'].includes(command.action)) return this.executeRequirement(command as RequirementWorkspaceCommand)
    switch (command.action) {
      case 'openScenario': await this.scenarios.open(command.entityId); break
      case 'saveScenario': case 'resolveScenarioConflict': await this.repairs.checkConcurrent(command.entityId); await this.scenarios.save(command); await this.repairs.checkConcurrent(command.entityId); break
      case 'resolveScenarioWriteProposal': await this.scenarios.resolveWriteProposal(command); await this.repairs.checkConcurrent(command.entityId); break
      case 'undoScenarioWrite': await this.scenarios.undoWrite(command); await this.repairs.checkConcurrent(command.entityId); break
      case 'newScenarioSession': return this.scenarios.newSession(command.entityId)
      case 'selectScenarioSession': return this.scenarios.selectSession(command.entityId, command.sessionId)
      case 'setScenarioStructureCheck': { const local = await this.store.read(); local.scenarioStructureCheck = command.enabled; await this.store.save(); break }
      case 'importScenarioSource': await this.scenarios.sources.importSource(command); break
      case 'retryScenarioSource': await this.scenarios.sources.retrySource(command.entityId, command.sourceId); break
      case 'selectScenarioSource': await this.scenarios.sources.selectSource(command); await this.repairs.checkConcurrent(command.entityId); break
      case 'scenarioRevisionImpact': { const { remote, entity } = await this.entity(command.entityId); if (entity.kind !== 'scenario') throw new Error('此操作只适用于项目场景'); await this.api.request('GET', this.route(remote.project.id, `/entities/${entity.id}/revision-impact`)); const record = await this.scenarios.record(entity.id, remote.project.id); record.impact = remote.entities.filter(e => e.kind === 'requirement' && 'scenarioIds' in e && e.scenarioIds.includes(entity.id)); await this.store.save(); this.scenarios.activeEntityId = entity.id; break }
      case 'startScenarioRevision': {
        const { remote, entity } = await this.entity(command.entityId)
        if (entity.kind !== 'scenario') throw new Error('此操作只适用于项目场景')
        if (!entity.current || entity.revision !== command.expectedRevision) throw new Error('场景及影响范围已变化，请重新查看影响清单')
        const task = await this.designTask(remote, entity)
        try { await readMaterial(task.worktree, 'scenario', entity.id) } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          const bytes = await this.projects.readFixed(remote.project.id, entity.current.fixed.commitSha, entity.current.fixed.path, entity.current.fixed.sha256)
          if (digest(bytes) !== entity.current.fixed.sha256) throw new Error('修订输入固定版本hash不符')
          const draft = parseMaterial(Buffer.from(bytes), entity.current.fixed.path); await saveMaterial(task.worktree, draft.metadata, draft.body)
        }
        const record = await this.scenarios.record(entity.id); record.activeSessionId = task.sessionId; this.scenarios.activeEntityId = entity.id; await this.store.save(); break
      }
      case 'splitScenario': { const sessionId = await this.splitRequirements([command.entityId]); const record = await this.scenarios.record(command.entityId); record.splitOffered = false; await this.store.save(); return sessionId }
      case 'startScenarioRepair': await this.repairs.start(command); break
      case 'resumeScenarioRepair': await this.repairs.resume(command); break
      case 'cancelScenarioRepair': await this.repairs.cancel(command.entityId); break
      case 'previewMaterialTemplates': { const { remote } = await this.selected(); await this.templates.preview(remote, command.kind, command.templates, command.defaultTemplateId); break }
      case 'publishMaterialTemplates': { const { remote } = await this.selected(); await this.templates.publish(command.operationId, remote); break }
    }
    return undefined
  }
  private async executeRequirement(command: RequirementWorkspaceCommand): Promise<string | undefined> {
    const { entity, remote } = await this.entity(command.entityId)
    if (entity.kind !== 'requirement') throw new Error('此操作只适用于需求材料')
    switch (command.action) {
      case 'openRequirement': await this.scenarios.open(entity.id); break
      case 'saveRequirement': case 'resolveRequirementConflict':
        if (await this.updateRequirementRelations(command)) await this.scenarios.save(command); break
      case 'resolveRequirementWriteProposal': await this.scenarios.resolveWriteProposal(command); break
      case 'undoRequirementWrite': await this.scenarios.undoWrite(command); break
      case 'newRequirementSession': return this.scenarios.newSession(entity.id)
      case 'selectRequirementSession': return this.scenarios.selectSession(entity.id, command.sessionId)
      case 'bindRequirementTemplate': await this.scenarios.bindTemplate(entity.id, command.templateId, command.expectedHash, command.operationId); break
      case 'startRequirementRevision': {
        if (!entity.current || entity.revision !== command.expectedRevision) throw new Error('需求版本已变化，请刷新后重新开始修订')
        const task = await this.designTask(remote, entity)
        if (!await findMaterialFile(task.worktree, 'requirement', entity.id)) {
          const fixed = entity.current.fixed, bytes = await this.projects.readFixed(remote.project.id, fixed.commitSha, fixed.path, fixed.sha256)
          const draft = parseMaterial(Buffer.from(bytes), fixed.path)
          if (digest(bytes) !== fixed.sha256 || draft.entityId !== entity.id) throw new Error('需求修订固定输入无效')
          await saveMaterial(task.worktree, draft.metadata, draft.body)
        }
        const record = await this.scenarios.record(entity.id); record.activeSessionId = task.sessionId
        this.scenarios.activeEntityId = entity.id; await this.store.save(); break
      }
    }
    return undefined
  }
  private async updateRequirementRelations(command: Extract<RequirementWorkspaceCommand, { action: 'saveRequirement' | 'resolveRequirementConflict' }>): Promise<boolean> {
    const { remote, entity, task } = await this.scenarios.editable(command.entityId)
    if (!isMaterialMetadata(command.metadata) || entity.kind !== 'requirement' || command.metadata.kind !== 'requirement' || command.metadata.entityId !== entity.id) throw new Error('需求身份不能改变')
    const draft = await readMaterial(task.worktree, 'requirement', entity.id)
    // File conflicts are preserved by the document service before any relation mutation.
    if (draft.sha256 !== command.expectedHash) { await this.scenarios.save(command); return false }
    if (canonical(command.metadata.scenarioIds) === canonical(entity.scenarioIds) && canonical(command.metadata.sources) === canonical(entity.scenarioSources ?? []) && canonical(command.metadata.prerequisites) === canonical(entity.prerequisites)) return true
    await this.api.request('PUT', this.route(remote.project.id, `/entities/${entity.id}/relations`), { idempotencyKey: `${command.operationId}-relations`, token: await this.requireOwned(entity), scenarioIds: command.metadata.scenarioIds, sources: command.metadata.sources, prerequisites: command.metadata.prerequisites })
    return true
  }
  private async validateDesignConfirmation(entityId: string, hash: string): Promise<void> {
    const { entity } = await this.entity(entityId)
    if (entity.kind !== 'scenario' && entity.kind !== 'requirement') return
    this.scenarios.activeEntityId = entityId
    const { remote } = await this.selected(), workspace = await this.scenarios.snapshot(remote)
    if (!workspace || workspace.readOnly || workspace.draft.sha256 !== hash) throw new Error('请核对当前场景版本与有效占用')
    const { task } = await this.scenarios.editable(entityId), fileErrors = await scenarioFileErrors(task.worktree, workspace.draft)
    const blocked = workspace.gates.filter(g => g.status === 'blocked').flatMap(g => g.messages)
    if (blocked.length || fileErrors.length) throw new Error([...blocked, ...fileErrors].join('；'))
  }
  private async confirmRepairedScenario(entityId: string, hash: string, repairId: string): Promise<void> {
    await this.validateDesignConfirmation(entityId, hash)
    const snapshot = await this.prepareCandidate(entityId, 'material', hash)
    await this.integrate(snapshot.task, snapshot.draft, { ...snapshot.prepare, confirmations: snapshot.confirmations.map((value): ConfirmationInput => value.entityId === entityId ? { ...value, readHash: value.fixed.sha256, authorConfirmed: true, confirmationMethod: 'ai-repair', repairTaskId: repairId } : { ...value, readHash: value.fixed.sha256, authorConfirmed: true, confirmationMethod: 'direct' }) })
  }
  private async acceptSourceRead(sessionId: string, output: Extract<SessionOutput, { kind: 'source-read' }>): Promise<void> {
    const local = await this.store.read(), task = local.tasks.find(t => t.sessionId === sessionId)
    if (!task) return
    await this.scenarios.sources.acceptRead(task, output)
  }
  /**
   * Build the projection the surfaces render. This read never synchronizes Git:
   * commit fetches, mirrors and preparation are queued on the background lane,
   * and a fixed material that is not local yet is left out until it arrives.
   * @returns the current workbench projection.
   */
  async state(): Promise<StudioState> {
    const account = await this.ports.account()
    if (!account) {
      await this.comparisons.dispose(); this.lastState = undefined
      if (this.store.scoped) { await this.ports.stopPreview(); await this.projects.dispose() }
      this.scenarios.dispose(); this.store.useUser(); this.previewState = undefined
      return { connected: false, projects: [], availableProjects: [], namespaces: [], projectInitializations: [], drafts: [], tasks: [], candidates: [], reviews: [], pending: [] }
    }
    if (this.store.scoped && this.store.accountId !== account.id) await this.comparisons.dispose()
    this.store.useUser(account.id)
    const local = await this.store.read()
    const availableProjects = await this.api.request<ProjectView[]>('GET', '/v1/projects')
    const allowed = new Set(availableProjects.map(project => project.id))
    const projects = local.projects.filter(project => allowed.has(project.id))
    const selected = projects.find(project => project.id === local.selectedProjectId)
    const remote = selected ? await this.api.request<ProjectState>('GET', this.route(selected.id)) : undefined
    const projectTemplates = remote?.project.initializationStatus === 'ready' ? await this.templates.catalog(remote.project) : undefined
    const tasks = local.tasks.filter(task => task.projectId === selected?.id)
    const drafts: MaterialDraft[] = []
    if (remote) for (const entity of remote.entities.filter(isEntityView).filter(entity => entity.kind !== 'scenario')) {
      const task = tasks.findLast(task => task.entityId === entity.id && !task.cleanup && (task.purpose === 'material' || task.purpose === 'handoff') && (!entity.occupation || path.basename(task.worktree) === entity.occupation.taskId))
      if (task) {
        try { drafts.push(await readMaterial(task.worktree, entity.kind, entity.id)) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      } else if ('current' in entity && entity.current) {
        const bytes = await this.projects.localFixed(remote.project.id, entity.current.fixed.commitSha, entity.current.fixed.path, entity.current.fixed.sha256)
        if (bytes) drafts.push(parseMaterial(Buffer.from(bytes), entity.current.fixed.path))
      }
    }
    // Accepted documents from an earlier contract stay displayable: their exact
    // fixed bytes are read locally and never parsed into an editable draft.
    const legacyMaterials: Array<{ entityId: string; body: string }> = []
    if (remote) for (const entity of remote.entities.filter(isEntityView)) {
      const legacy = entity.legacyCurrent
      if (!legacy) continue
      const bytes = await this.projects.localFixed(remote.project.id, legacy.fixed.commitSha, legacy.fixed.path, legacy.fixed.sha256)
      if (bytes) legacyMaterials.push({ entityId: entity.id, body: Buffer.from(bytes).toString('utf8') })
    }
    const workspace = remote ? await this.scenarios.snapshot(remote) : undefined
    const scenario = workspace?.draft.metadata.kind === 'scenario' ? workspace : undefined
    const requirement = workspace?.draft.metadata.kind === 'requirement' ? workspace : undefined
    if (scenario) { await this.repairs.checkConcurrent(scenario.entityId); const repair = await this.repairs.view(scenario.entityId); if (repair) scenario.repair = repair }
    const materialSources = remote ? await this.scenarios.sources.views(remote, drafts) : []
    const templatePreview = local.templateOperations.findLast(op => op.projectId === selected?.id && op.phase !== 'accepted')?.preview
    const recovery = this.store.preservedRecord
    const state: StudioState = { ...(scenario ? { scenario } : {}), ...(requirement ? { requirement } : {}), ...(materialSources.length ? { materialSources } : {}), ...(templatePreview ? { templatePreview } : {}), ...(recovery ? { recovery } : {}), connected: true, account, projects, availableProjects, namespaces: this.namespaces,
      projectInitializations: local.projectInitializations
        // Unfinished local work is reported only while the backend still offers its project; a
        // record the account can no longer read cannot be finished, so it stops being a task
        // instead of waiting for a retry. The record itself stays, so restored access brings it back.
        .filter(op => op.phase !== 'ready' && (op.projectId === undefined || allowed.has(op.projectId)))
        .map(op => ({ id: op.id, name: op.name, phase: op.phase, ...(op.projectId ? { projectId: op.projectId } : {}), ...(op.message ? { message: op.message } : {}) })),
      ...(selected ? { selectedProjectId: selected.id } : {}), ...(remote ? { project: remote.project, collaboration: remote } : {}), ...(projectTemplates ? { projectTemplates } : {}), ...(legacyMaterials.length ? { legacyMaterials } : {}), drafts, tasks, reviews: await this.reviews.views(selected?.id),
      candidates: local.candidates.filter(candidate => candidate.projectId === selected?.id), ...(this.previewState ? { preview: this.previewState } : {}),
      consistencyTasks: await this.comparisons.views(selected?.id), consistencyLatest: this.comparisons.latestViews(selected?.id),
      pending: [
        ...[...local.operations, ...local.adoptions.filter(op => op.phase !== 'succeeded')].filter(op => op.projectId === selected?.id).map(op => ({ id: op.id, entityId: op.entityId, phase: op.phase, ...(op.message ? { message: op.message } : {}) })),
        ...local.scenarios.filter(record => record.projectId === selected?.id && record.repairAuthorization?.status === 'pending').map(record => ({ id: record.repairAuthorization!.request.idempotencyKey, entityId: record.entityId, phase: 'unknown', message: record.repairAuthorization!.message ?? '修复授权结果待核对' })),
        ...local.scenarioRepairs.filter(record => record.projectId === selected?.id && (record.pending || record.recoverPending)).map(record => ({ id: (record.pending ?? record.recoverPending)!.idempotencyKey, entityId: record.entityId, phase: 'unknown', message: record.message ?? '修复轮次结果待核对' })),
        ...local.templateOperations.filter(op => op.projectId === selected?.id && op.phase === 'unknown').map(op => ({ id: op.preview.operationId, entityId: 'templates', phase: op.phase, ...(op.message ? { message: op.message } : {}) })),
        ...local.scenarios.filter(record => record.projectId === selected?.id && record.templateBinding?.status === 'pending').map(record => ({ id: record.templateBinding!.application?.operationId ?? record.templateBinding!.request.idempotencyKey, entityId: record.entityId, phase: 'unknown', message: record.templateBinding!.message ?? '模板绑定结果待核对' })),
        ...local.materialReservations.filter(op => op.projectId === selected?.id && op.phase !== 'materialized').map(op => ({ id: op.id, entityId: op.entityId ?? op.id, phase: op.phase, ...(op.message ? { message: op.message } : {}) })),
      ] }
    this.lastState = state
    return state
  }
  private async requireAccount() { const account = await this.ports.account(); if (!account) { await this.comparisons.dispose(); this.store.useUser(); throw new CollaborationError('LOGIN_REQUIRED', '请先登录协同工作台。', 401) }; if (this.store.scoped && this.store.accountId !== account.id) await this.comparisons.dispose(); this.store.useUser(account.id); return account }
  private route(projectId: string, suffix = '') { return `/v1/projects/${encodeURIComponent(projectId)}${suffix}` }
  private async selected() {
    const state = await this.store.read(); const project = state.projects.find(p => p.id === state.selectedProjectId)
    if (!project) throw new Error('请先选择项目')
    const remote = await this.api.request<ProjectState>('GET', this.route(project.id))
    if (remote.project.initializationStatus !== 'ready' || !remote.project.recognizedHead) throw new Error('项目尚未完成初始化，请先恢复首次提交。')
    return { project, remote }
  }
  private async entity(entityId: string, projectId?: string) { const context = projectId ? { remote: await this.api.request<ProjectState>('GET', this.route(projectId)), project: (await this.store.read()).projects.find(p => p.id === projectId)! } : await this.selected(); const entity = context.remote.entities.find(e => e.id === entityId); if (!entity || !isEntityView(entity)) throw new Error('资产不存在或不可见'); this.requireCurrentContract(entity); return { ...context, entity } }
  /** An accepted material from before the current contract stays readable only. */
  private requireCurrentContract(entity: EntityView): void { if (entity.legacyCurrent) throw new Error('该材料的已接受版本早于当前契约，只能只读查看，不能编辑、确认、复用或发起会话') }
  private async requireOwned(entity: EntityView): Promise<OccupationToken> {
    const account = await this.ports.account(); const state = await this.store.read(); const token = entity.occupation
    if (!token || token.ownerId !== account?.id || token.clientId !== state.clientId) throw new Error('此任务需要本人当前客户端的有效占用')
    const { occupationId, generation, taskId, clientId, expectedRevision } = token
    return { occupationId, generation, taskId, clientId, expectedRevision }
  }
  /** Reopen an existing task before the native client can promote its persisted Session. */
  private async restoreSession(sessionId: string): Promise<string> {
    const local = await this.store.read()
    const repair = local.scenarioRepairs.find(value => value.task.sessionId === sessionId && value.projectId === local.selectedProjectId)
    if (repair) {
      if (!['active', 'paused'].includes(repair.view.status)) throw new Error('修复任务授权已结束')
      await this.scenarios.context(repair.task)
      return this.ports.session(repair.task, '只读场景修复助手，由Host执行受控写入和确认。')
    }
    const task = local.tasks.find(value => value.sessionId === sessionId && value.projectId === local.selectedProjectId)
    if (!task || !['material', 'handoff', 'prototype', 'split'].includes(task.purpose)) throw new Error('未找到当前项目可恢复的工作台任务')
    if (task.purpose === 'split') { await this.candidates.resume(task.sessionId); return task.sessionId }
    const { remote, entity } = await this.entity(task.entityId)
    if (entity.kind === 'scenario' && task.purpose === 'material') return this.scenarios.selectSession(entity.id, sessionId)
    const expectedPurpose = task.purpose === 'prototype' ? 'prototype' : entity.kind === 'handoff' ? 'handoff' : 'material'
    if (task.purpose !== expectedPurpose || task.purpose === 'prototype' && entity.kind !== 'requirement') throw new Error('会话任务类型与当前资产不一致')
    const token = await this.requireOwned(entity)
    const occupation = entity.occupation!
    const expectedOccupation = task.purpose === 'prototype' ? 'prototype' : 'design'
    if (occupation.purpose !== expectedOccupation || occupation.inputVersion !== entity.materialVersion) throw new Error('会话任务占用类型或输入版本已失效')
    if (path.resolve(task.worktree) !== path.join(this.store.directory, 'worktrees', remote.project.id, token.taskId)) throw new Error('会话现场与当前任务占用不一致')
    if (task.inputHash !== (entity.current?.fixed.sha256 ?? '') || task.purpose === 'prototype' && !entity.current) throw new Error('需求或材料已修订，旧会话输入已失效')
      if (task.purpose === 'prototype' && canonical(prototypeBindings(entity, remote.entities.filter(isEntityView))) !== canonical(occupation.prerequisiteBindings)) throw new Error('前置需求固定完成依据已变化，旧原型会话输入已失效')
    const draft = await readMaterial(task.worktree, entity.kind, entity.id)
    if (task.purpose === 'prototype' && draft.sha256 !== task.inputHash) throw new Error('原型现场需求与固定输入不一致')
    return this.ports.session(task, task.purpose === 'prototype' ? prototypeRules : this.materialRules(draft))
  }
  private async identity() {
    const account = await this.requireAccount()
    if (account.gitlabEmail) return { name: account.name || account.gitlabUsername, email: account.gitlabEmail }
    const { project } = await this.selected(); return this.ports.git.identity(project.directory)
  }
    private async createMaterial(kind: 'scenario' | 'requirement' | 'handoff', title: string, scenarioIds: string[] = [], operationId = key(), candidate?: Candidate): Promise<EntityView> {
      const { remote } = await this.selected()
      const currentSources = scenarioIds.map(id => remote.entities.find((value): value is EntityView => isEntityView(value) && value.id === id && value.kind === 'scenario' && value.materialVersion > 0))
      if (currentSources.some(source => !source) || new Set(scenarioIds).size !== scenarioIds.length) throw new Error('需求来源必须是本项目已确认的场景版本')
      let template: { templateId: string; templateRef: FixedReference } | undefined = candidate ? { templateId: candidate.template.id, templateRef: candidate.template.fixed } : undefined
      if (kind !== 'handoff' && !candidate) {
        const catalogs = await this.templates.catalog(remote.project)
        if (kind === 'scenario' && !catalogs?.scenarios.templates.length) throw new Error('本项目尚未发布场景模板，请先在设置里上传并发布默认场景模板，再新建场景。')
        if (kind === 'requirement') {
          if (!catalogs) throw new Error('需求模板固定内容正在后台同步，请稍后重试。')
          // A new requirement binds the project's default requirement template.
          const selected = catalogs.requirements.templates.find(value => value.id === catalogs.requirements.defaultTemplateId)
          if (!selected) throw new Error('本项目尚未发布默认需求模板，请先在设置里发布需求模板。')
          template = { templateId: selected.id, templateRef: selected.fixed }
        }
      }
      if (kind === 'requirement' && !currentSources.length) throw new Error('新需求必须绑定至少一个已确认场景版本')
      const local = await this.store.read()
      let reservation = local.materialReservations.find(value => value.id === operationId)
      const exact = (value: MaterialReservation) => value.projectId === remote.project.id && value.kind === kind && value.title === title && value.templateId === template?.templateId && JSON.stringify(value.templateRef) === JSON.stringify(template?.templateRef) && JSON.stringify(value.scenarioIds) === JSON.stringify(scenarioIds)
      if (reservation && !exact(reservation)) throw new Error('新建操作编号已绑定其他场景请求')
      if (reservation?.phase === 'materialized') { const entityId = reservation.entityId; const value = remote.entities.find((e): e is EntityView => e.id === entityId && isEntityView(e)); if (!value) throw new Error('原场景不可访问'); return value }
      if (!reservation) {
        const sources = candidate ? candidate.sources.map(source => ({ projectId: source.projectId, entityId: source.entityId, version: source.version })) : currentSources.filter((source): source is EntityView => !!source).map(source => ({ projectId: remote.project.id, entityId: source.id, version: source.materialVersion }))
        reservation = { id: operationId, projectId: remote.project.id, kind, title, ...(template ?? {}), scenarioIds, sources, phase: 'reserving', ...(candidate ? { initialContent: { body: candidate.body, summary: candidate.summary, quality: candidate.quality } } : {}) }
        local.materialReservations.push(reservation); await this.store.save()
      }
      const entity = await this.reserveMaterial(reservation)
      return this.materializeReservation(reservation, entity, remote)
  }
    private async reserveMaterial(operation: MaterialReservation): Promise<EntityView> {
      try {
        const entity = await this.api.request<EntityView>('POST', this.route(operation.projectId, '/entities'), {
          idempotencyKey: operation.id, kind: operation.kind, title: operation.title,
          ...(operation.kind === 'requirement' ? { templateId: operation.templateId!, templateRef: operation.templateRef!, sources: operation.sources } : {}),
        })
        if (operation.entityId && operation.entityId !== entity.id) throw new Error('同一新建操作返回了不同资产编号')
        operation.entityId = entity.id; operation.phase = 'reserved'; delete operation.message; await this.store.save(); return entity
      } catch (error) { operation.phase = 'unknown'; operation.message = error instanceof Error ? error.message : '新建场景结果未知'; await this.store.save(); throw error }
    }
    private async retryMaterialReservation(operation: MaterialReservation): Promise<void> {
      const remote = await this.api.request<ProjectState>('GET', this.route(operation.projectId))
      const entity = await this.reserveMaterial(operation)
      await this.materializeReservation(operation, entity, remote)
    }
    private async materializeReservation(operation: MaterialReservation, entity: EntityView, remote: ProjectState): Promise<EntityView> {
      if (operation.phase === 'materialized') return entity
      const task = await this.designTask(remote, entity)
      let metadata = await syncProjectContext(task.worktree, initialMetadata(entity, operation.scenarioIds, operation.sources))
      try {
        await readMaterial(task.worktree, entity.kind, entity.id)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        if (operation.initialContent) {
          const candidate = (await this.store.read()).candidates.find(candidate => candidate.id === operation.id)
          if (!candidate) throw new Error('原候选采用现场缺失，不能重新生成依据')
          metadata = { ...metadata, businessEvidence: await candidateBusinessEvidence(task.worktree, candidate, (projectId, fixed) => this.projects.readFixed(projectId, fixed.commitSha, fixed.path, fixed.sha256)) }
        }
        await saveMaterial(task.worktree, operation.initialContent ? { ...metadata, ...operation.initialContent.quality, summary: operation.initialContent.summary } : metadata,
          operation.initialContent?.body ?? (operation.kind === 'handoff' ? starter(operation.title) : ''))
      }
      operation.phase = 'materialized'; delete operation.message; operation.entityId = entity.id; await this.store.save(); return entity
    }
  private async bindScenarioTemplate(entityId: string, templateId: string): Promise<void> {
    const { task, entity } = await this.scenarios.editable(entityId)
    if (entity.kind !== 'scenario') throw new Error('只有场景可以绑定场景模板')
    const draft = await readMaterial(task.worktree, 'scenario', entity.id)
    await this.scenarios.bindTemplate(entity.id, templateId, draft.sha256, key())
  }
  private async designTask(remote: ProjectState, entity: EntityView): Promise<TaskView> {
    const local = await this.store.read()
    let current = entity
    if (!current.occupation) current = await this.api.request<EntityView>('POST', this.route(remote.project.id, `/entities/${entity.id}/claim`), { idempotencyKey: key(), expectedRevision: entity.revision, taskId: key(), clientId: local.clientId, purpose: 'design' })
    const token = await this.requireOwned(current)
    const sessions = local.tasks.filter(t => t.projectId === remote.project.id && t.entityId === entity.id && (t.purpose === 'material' || t.purpose === 'handoff') && path.basename(t.worktree) === token.taskId)
    const activeSessionId = local.scenarios.find(record => record.projectId === remote.project.id && record.entityId === entity.id)?.activeSessionId
    const existing = sessions.find(task => task.sessionId === activeSessionId) ?? sessions.at(-1)
    if (existing) return existing
    const project = local.projects.find(p => p.id === remote.project.id)!
    await this.projects.requireCommit(project, remote.project.stableBranch, remote.project.recognizedHead!)
    const worktree = path.join(this.store.directory, 'worktrees', remote.project.id, token.taskId)
    await this.ports.git.createWorktree(project.directory, worktree, `studio/${entity.id}/${token.generation}`, remote.project.recognizedHead!)
    const task: TaskView = { projectId: project.id, entityId: entity.id, sessionId: `studio-${key()}`, purpose: entity.kind === 'handoff' ? 'handoff' : 'material', inputHash: entity.current?.fixed.sha256 ?? '', worktree }
    if (entity.kind === 'handoff') local.tasks = local.tasks.filter(t => !(t.projectId === project.id && t.entityId === entity.id && t.purpose === task.purpose)); local.tasks.push(task); await this.store.save(); return task
  }
  private async prototypeTask(remote: ProjectState, entity: EntityView): Promise<TaskView> {
    if (entity.kind !== 'requirement' || !entity.current) throw new Error('请先确认唯一需求材料')
    const local = await this.store.read()
    if (entity.occupation?.purpose === 'design') {
      const token = await this.requireOwned(entity)
      await this.api.request('POST', this.route(remote.project.id, `/entities/${entity.id}/cancel`), { idempotencyKey: key(), token, reason: '设计材料已确认，转入原型生产' })
      entity = (await this.entity(entity.id)).entity
    }
    if (!entity.occupation) entity = await this.api.request<EntityView>('POST', this.route(remote.project.id, `/entities/${entity.id}/claim`), { idempotencyKey: key(), expectedRevision: entity.revision, taskId: key(), clientId: local.clientId, purpose: 'prototype' })
    const token = await this.requireOwned(entity)
    if (entity.occupation!.purpose !== 'prototype') throw new Error('当前占用属于其他任务类型')
    const existing = local.tasks.find(t => t.projectId === remote.project.id && t.entityId === entity.id && t.purpose === 'prototype' && path.basename(t.worktree) === token.taskId)
    if (existing) {
      if (existing.inputHash !== entity.current!.fixed.sha256) throw new Error('需求已修订；旧原型现场已保留，请重新认领并绑定新输入')
      return existing
    }
    const project = local.projects.find(p => p.id === remote.project.id)!
    await this.projects.requireCommit(project, remote.project.stableBranch, remote.project.recognizedHead!)
    const worktree = path.join(this.store.directory, 'worktrees', project.id, token.taskId)
    await this.ports.git.createWorktree(project.directory, worktree, `studio/${entity.id}/prototype-${token.generation}`, remote.project.recognizedHead!)
    const task: TaskView = { projectId: project.id, entityId: entity.id, sessionId: `studio-${key()}`, purpose: 'prototype', inputHash: entity.current!.fixed.sha256, worktree }
    local.tasks = local.tasks.filter(t => !(t.projectId === project.id && t.entityId === entity.id && t.purpose === 'prototype')); local.tasks.push(task); await this.store.save(); return task
  }
  private materialRules(draft: MaterialDraft): string {
    if (draft.metadata.kind === 'scenario') return '你是场景设计助手。使用 grilling 逐问推进设计，用 domain-modeling 沉淀术语与决策；普通对话只归纳结论与提问，禁止直接写入文件、修改Git或确认。每次调用须以Host提供的当前Markdown、固定模板和实际已读资料为准。'
    if (draft.metadata.kind === 'requirement') return '你是需求设计助手。使用 grilling 逐问推进需求设计，用 domain-modeling 沉淀术语与决策；普通对话只归纳结论与提问，不写正文、不直接修改文件或确认。以Host提供的当前需求、已接受场景依据和实际已读资料为准，缺业务答案时提问。'
    return `你正在整理 ${draft.metadata.kind} ${draft.entityId}。仅编辑 ${draft.path}；保留 eadp-metadata 身份。实际业务依据、核心业务规则、验收条件缺失时提出问题，不编造；核心待澄清项阻断确认，非阻断项明确限制和不适用范围。不得自行确认、释放占用、修改Git/模板规则或执行shell。作者通过工作台确认。当前材料哈希 ${draft.sha256}。`
  }
  private materialEvidence(candidateSha: string, draft: MaterialDraft): CheckEvidence {
    checkMaterial(draft)
    return { candidateSha, passed: true, checks: ['materials', 'relations'].map(name => ({ name, passed: true, evidenceHash: digest(`${name}:${draft.sha256}`) })) }
  }
  /** Working-tree paths this task changed, including both sides of a rename. */
  private async dirtyPaths(task: TaskView): Promise<string[]> {
    const entries = (await this.ports.gitLocal(['status', '--porcelain=v1', '-z', '--untracked-files=all'], task.worktree)).split('\0').filter(Boolean)
    const dirty: string[] = []
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]!, name = entry.slice(3); dirty.push(name)
      if (/[RC]/.test(entry.slice(0, 2))) { const source = entries[++index]; if (!source) throw new Error('Git 变更列表不完整'); dirty.push(source) }
    }
    return dirty
  }
  private async candidateSha(task: TaskView, expectedHead: string, allowed: (file: string) => boolean, files: string[], message: string): Promise<{ sha: string; changed: string[] }> {
    const dirty = await this.dirtyPaths(task)
    if (dirty.some(file => !allowed(file))) throw new Error('存在本任务允许范围外的变更，请先处理后再固定候选')
    const sha = dirty.length ? await this.ports.git.commitFiles(task.worktree, files.length ? files : dirty, message, await this.identity()) : (await this.ports.git.state(task.worktree)).head
    const changed = await this.ports.git.changedFiles(task.worktree, expectedHead, sha)
    if (!changed.length || changed.some(file => !allowed(file))) throw new Error('候选相对当前项目基线没有有效变化或包含本任务范围外提交')
    return { sha, changed }
  }
  /** Reads a material that is about to be fixed, first giving it the path its title requires. */
  private async currentMaterialDraft(task: TaskView, entity: EntityView): Promise<MaterialDraft> {
    const draft = await readMaterial(task.worktree, entity.kind, entity.id)
    const relative = await normalizeMaterialPath(task.worktree, draft)
    // Renaming keeps the bytes, so only the reported path changes.
    return relative === draft.path ? draft : { ...draft, path: relative }
  }
  /**
   * Removed worktree paths that held one of this batch's own materials before a
   * title edit renamed it. Only those paths may join the candidate's scope.
   */
  private async replacedMaterialPaths(task: TaskView, expectedHead: string, entityIds: Set<string>): Promise<string[]> {
    const entries = (await this.ports.gitLocal(['status', '--porcelain=v1', '-z', '--untracked-files=all'], task.worktree)).split('\0').filter(Boolean)
    const removed = new Set<string>()
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]!, status = entry.slice(0, 2), name = entry.slice(3)
      if (/[RC]/.test(status)) { const source = entries[++index]; if (source && status.includes('R')) removed.add(source) }
      if (status.includes('D')) removed.add(name)
    }
    const owned: string[] = []
    for (const relative of removed) {
      const bytes = await this.ports.git.readBlob(task.worktree, expectedHead, relative).catch(() => undefined)
      if (!bytes) continue
      try { if (entityIds.has(parseMaterial(bytes, relative).entityId)) owned.push(relative) }
      catch { /* A removed non-material path never enters the candidate scope. */ }
    }
    return owned
  }
  /**
   * Resolves the exact local content a review or confirmation covers. It reads
   * the task worktree only: no commit, check run or remote write happens here,
   * so an optional review can bind the snapshot a later confirmation commits.
   */
  private async prepareContent(entityId: string, purpose: 'material' | 'prototype', expectedHash?: string) {
    let context = await this.entity(entityId)
    const task = purpose === 'prototype' ? await this.prototypeTask(context.remote, context.entity) : await this.designTask(context.remote, context.entity)
    context = await this.entity(entityId)
    const { remote, entity } = context, token = await this.requireOwned(entity)
    const draft = await this.currentMaterialDraft(task, entity)
    if (expectedHash && draft.sha256 !== expectedHash) throw new Error('材料已变化，请阅读并确认新版本')
    // The snapshot starts from the task HEAD; target files are bound by their own hashes.
    const head = (await this.ports.git.state(task.worktree)).head
    let paths: string[], allowedPaths: string[]
    const confirmations: Array<Pick<ConfirmationInput, 'entityId' | 'expectedRevision' | 'fixed'>> = []
    const prepareBase = { idempotencyKey: key(), entityId: entity.id, token, expectedHead: remote.project.recognizedHead! }
    const drafts: Array<{ entity: EntityView; draft: MaterialDraft }> = [{ entity, draft }]
    if (purpose === 'material') {
      checkMaterial(draft)
      if (entity.kind === 'scenario') {
        // The package declares the project context; a legacy draft must be saved once to pick it up.
        const context = await readFile(await containedFile(task.worktree, 'CONTEXT.md')).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error })
        if (context && !draft.metadata.files?.some(file => file.path === 'CONTEXT.md' && file.sha256 === digest(context))) throw new Error('项目上下文尚未纳入场景文件包，请保存场景后重新确认')
      }
      const materialPaths = drafts.map(value => value.draft.path)
      const evidenceFiles = new Map(drafts.flatMap(value => [...value.draft.metadata.businessEvidence.flatMap(evidence => evidence.files), ...(value.draft.metadata.files ?? [])]).map(file => [file.path, file]))
      for (const file of evidenceFiles.values()) {
        const bytes = await readFile(await containedFile(task.worktree, file.path))
        if (digest(bytes) !== file.sha256) throw new Error(`正式依据或关联文件已变化：${file.path}`)
      }
      paths = [...new Set([...materialPaths, ...evidenceFiles.keys()])]
      // A title edit renames the material; the removed previous path belongs to this batch.
      const allowed = new Set([...paths, ...await this.replacedMaterialPaths(task, prepareBase.expectedHead, new Set(drafts.map(value => value.entity.id)))])
      allowedPaths = [...allowed]
      // The commit hash is filled in after this snapshot; review input binds only the material hash.
      for (const value of drafts) confirmations.push({ entityId: value.entity.id, expectedRevision: value.entity.revision, fixed: { commitSha: '', path: value.draft.path, sha256: value.draft.sha256 } })
    } else {
      if (entity.kind !== 'requirement' || !entity.current || task.inputHash !== entity.current.fixed.sha256 || draft.sha256 !== entity.current.fixed.sha256) throw new Error('原型输入已失效，请重新确认需求')
      // Local commits since the recognized head are part of the same snapshot.
      const committed = head === prepareBase.expectedHead ? [] : await this.ports.git.changedFiles(task.worktree, prepareBase.expectedHead, head)
      paths = [...new Set([...committed, ...await this.dirtyPaths(task)])]
      if (!paths.length || paths.some(file => !file.startsWith('原型代码/'))) throw new Error('候选相对当前项目基线没有有效变化或包含本任务范围外提交')
      allowedPaths = paths
      confirmations.push({ entityId: entity.id, expectedRevision: entity.revision, fixed: entity.current.fixed })
    }
    const stage = purpose === 'prototype' ? 'prototype' as const : 'material' as const
    const input = { ...prepareBase, stage, confirmations }
    return { remote, entity, task, draft, drafts, paths, allowedPaths, confirmations, input,
      inputHash: digest(reviewInputText(input, entity)),
      snapshot: { head, files: await this.snapshotFiles(task.worktree, allowedPaths) } }
  }
  private async prepareCandidate(entityId: string, purpose: 'material' | 'prototype', expectedHash?: string) {
    const content = await this.prepareContent(entityId, purpose, expectedHash)
    const { task, draft, entity, remote } = content
    let candidateSha: string, paths = content.paths, allowedPaths = content.allowedPaths, checks: CheckEvidence
    if (purpose === 'material') {
      await this.scenarios.sources.pruneEvidence(task)
      const allowed = new Set(allowedPaths)
      candidateSha = (await this.candidateSha(task, content.input.expectedHead, file => allowed.has(file), paths, '固定材料 ' + entity.id)).sha
      for (const path of paths) await this.ports.git.verifyFile(task.worktree, candidateSha, path)
      checks = { candidateSha, passed: true, checks: content.drafts.flatMap(value => this.materialEvidence(candidateSha, value.draft).checks) }
      for (const value of content.confirmations) value.fixed.commitSha = candidateSha
    } else {
      const candidate = await this.candidateSha(task, content.input.expectedHead, file => file.startsWith('原型代码/'), [], '固定原型 ' + entity.id)
      candidateSha = candidate.sha; paths = candidate.changed; allowedPaths = paths
      checks = await this.ports.checks(task, candidateSha)
    }
    const prepare = { ...content.input, sourceSha: candidateSha, candidateSha, allowedPaths, checks }
    const review: ReviewCandidate = { projectId: remote.project.id, entityId: entity.id, purpose, head: content.snapshot.head, inputHash: content.inputHash, files: content.snapshot.files, paths, task, candidateSha }
    return { task, draft, prepare, confirmations: content.confirmations, review }
  }
  /** Content identity of the worktree bytes a review and its confirmation must share. */
  private async snapshotFiles(root: string, files: readonly string[]): Promise<ReviewFile[]> {
    const result: ReviewFile[] = []
    for (const relative of [...new Set(files)].sort()) {
      const bytes = await readFile(await containedFile(root, relative)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined
        throw error
      })
      result.push({ path: relative, sha256: bytes ? digest(bytes) : null })
    }
    return result
  }
  private async confirmMaterial(entityId: string, expectedHash: string, choice: ConfirmationChoice) {
    await this.validateDesignConfirmation(entityId, expectedHash)
    const snapshot = await this.prepareCandidate(entityId, 'material', expectedHash)
    const authority = await this.reviews.confirmation(choice, snapshot.review)
    await this.integrate(snapshot.task, snapshot.draft, { ...snapshot.prepare, confirmations: snapshot.confirmations.map(value => ({ ...value, readHash: value.fixed.sha256, ...authority, authorConfirmed: true as const })) })
  }
  private async confirmPrototype(entityId: string, choice: ConfirmationChoice) {
    const snapshot = await this.prepareCandidate(entityId, 'prototype')
    const authority = await this.reviews.confirmation(choice, snapshot.review)
    await this.integrate(snapshot.task, snapshot.draft, { ...snapshot.prepare, confirmations: snapshot.confirmations.map(value => ({ ...value, readHash: value.fixed.sha256, ...authority, authorConfirmed: true as const })) })
  }
  /**
   * Record a fixed candidate and queue its publication. The push, the
   * conditional branch update and backend acceptance run on the background lane:
   * the reply reports the pending operation, which the surfaces render and
   * `retryOperation` can resume.
   */
  private async integrate(task: TaskView, draft: MaterialDraft, prepare: MaterialIntegrationRequest) {
    const local = await this.store.read()
    const operation: PendingOperation = { id: prepare.idempotencyKey, projectId: task.projectId, entityId: task.entityId, phase: 'fixed', candidateSha: prepare.candidateSha, expectedHead: prepare.expectedHead, fixedPath: draft.path, sha256: draft.sha256, prepare, token: prepare.token, adoptionIds: local.adoptions.filter(value => value.projectId === task.projectId && value.entityId === task.entityId && value.worktree === task.worktree && value.applied && draft.metadata.sources.some(source => sameSource(source, value.request.source))).map(value => value.id) }
    local.operations.push(operation); await this.store.save()
    this.resumeOnLane(operation)
  }
  /** Queue a recorded operation's remaining Git and backend work. */
  private resumeOnLane(operation: PendingOperation): void {
    this.lane.schedule(`operation:${operation.id}`, () => this.resumeOperation(operation))
  }
  /** Settle this machine once an integration is accepted; the reply never waits for it. */
  private scheduleMaintenance(task: TaskView, commit: string, inputsRead = Promise.resolve()): void {
    this.lane.schedule(`maintenance:${task.worktree}`, async () => { await inputsRead; await this.maintenance.settle(task, commit) })
  }
  /** Release one task's file observation, preview and Agent handles; other tasks stay live. */
  private async releaseTask(task: TaskView): Promise<void> {
    this.scenarios.stopWorktree(task.worktree)
    if (task.purpose === 'prototype' && this.previewState?.entityId === task.entityId) { await this.ports.stopPreview(); this.previewState = undefined }
    await this.ports.releaseTask?.(task.worktree)
  }
  private async resumeOperation(operation: PendingOperation) {
    const local = await this.store.read(); const project = local.projects.find(p => p.id === operation.projectId)
    const task = local.tasks.find(t => t.projectId === operation.projectId && t.entityId === operation.entityId && t.worktree)
    if (!project || !task) throw new Error('原操作所需项目/任务现场缺失，已停止恢复')
    try {
      if (!operation.integrationId) {
        let result: IntegrationView
        try { result = (await this.api.request<{ result: IntegrationView }>('GET', this.route(project.id, `/operations/${operation.id}`))).result }
        catch (error) {
          if (!(error instanceof CollaborationError) || error.code !== 'OPERATION_NOT_FOUND') throw error
          // The candidate must exist on the remote before the backend prepares it.
          // This push is idempotent, so a retry after any lost acknowledgement repeats it.
          await this.ports.git.push(task.worktree, operation.candidateSha, `studio-fixed/${operation.id}`)
          result = await this.api.request<IntegrationView>('POST', this.route(project.id, '/integrations'), operation.prepare)
        }
        operation.integrationId = result.id; operation.phase = 'prepared'; await this.store.save()
      }
      let integration = await this.api.request<IntegrationView>('GET', this.route(project.id, `/integrations/${operation.integrationId}`))
      if (integration.status === 'aborted') throw new Error('原集成操作已中止；本地成果已保留')
      if (integration.status !== 'accepted') {
        const head = await this.ports.git.remoteHead(project.directory, (await this.api.request<ProjectState>('GET', this.route(project.id))).project.stableBranch)
        if (head === operation.expectedHead) await this.ports.git.conditionalUpdate(task.worktree, (await this.api.request<ProjectState>('GET', this.route(project.id))).project.stableBranch, operation.expectedHead, operation.candidateSha)
        else if (head !== operation.candidateSha) throw new Error('Git 集成头已变化，需核对原候选并重新集成')
        operation.phase = 'pushed'; await this.store.save()
        integration = await this.api.request<IntegrationView>('POST', this.route(project.id, `/integrations/${integration.id}/complete`), { idempotencyKey: `${operation.id}-complete`, token: operation.token })
      }
      operation.phase = 'accepted'; delete operation.message; await this.store.save()
      const comparisonReads: Promise<void>[] = []
      if (integration.stage === 'material') {
        const confirmations = (operation.prepare as MaterialIntegrationRequest).confirmations
        for (const [index, confirmation] of confirmations.entries()) {
          const confirmationId = integration.confirmationIds?.[index]
          if (confirmationId) {
            const comparison = await this.comparisons.start({ projectId: project.id, entityId: confirmation.entityId, worktree: task.worktree, trigger: 'confirmation', confirmationId }).catch(() => undefined)
            if (comparison) comparisonReads.push(comparison.inputsRead)
          }
        }
      }
      const remote = await this.api.request<ProjectState>('GET', this.route(project.id)); const entity = remote.entities.find(e => e.id === operation.entityId)
      if (remote.project.recognizedHead) this.scheduleMaintenance(task, remote.project.recognizedHead, Promise.all(comparisonReads).then(() => undefined))
      for (const adoptionId of operation.adoptionIds ?? []) {
        const adoption = local.adoptions.find(value => value.id === adoptionId)
        if (!adoption) throw new Error('采用恢复记录缺失，不能申报复用成功')
        const confirmations = (operation.prepare as MaterialIntegrationRequest).confirmations
        const index = confirmations.findIndex(value => value.entityId === adoption.entityId)
        const confirmationId = integration.confirmationIds?.[index]
        const confirmation = confirmations[index]
        if (index < 0 || !confirmationId || !confirmation) throw new Error('本次接受结果未包含目标确认记录')
        const fixedBytes = await this.projects.readFixed(project.id, confirmation.fixed.commitSha, confirmation.fixed.path, confirmation.fixed.sha256)
        const fixedDraft = parseMaterial(Buffer.from(fixedBytes), confirmation.fixed.path)
        if (digest(fixedBytes) !== confirmation.fixed.sha256 || fixedDraft.metadata.entityId !== adoption.entityId || !fixedDraft.metadata.sources.some(source => sameSource(source, adoption.request.source))) throw new Error('本次接受结果未包含精确采用来源')
        adoption.success ??= { idempotencyKey: adoption.id + '-success-' + confirmationId, targetConfirmationId: confirmationId }
        await this.store.save(); await this.resumeAdoption(adoption)
      }
      if (entity && 'current' in entity && entity.kind === 'scenario' && entity.current && integration.confirmationIds?.includes(entity.current.confirmationId)) { const record = await this.scenarios.record(entity.id); record.splitOffered = true; this.scenarios.stopObservation(task); await this.store.save() }
      if (integration.baselineId) await this.generateHandoff(integration.baselineId).catch(async error => { operation.message = `基线已完成，交接清单生成待重试：${error instanceof Error ? error.message : '未知'}`; await this.store.save() })
      if (entity && 'current' in entity && entity.kind === 'requirement' && integration.stage === 'material') {
        try { const next = await this.prototypeTask(remote, entity); await this.ports.session(next, '根据当前已确认需求与前置完成依据，按模板规则实现原型；冲突先请求修订。'); await this.ports.prompt(next.sessionId, `开始实现已确认需求 ${entity.id}，输入哈希 ${entity.current!.fixed.sha256}。`) }
        catch (error) { task.error = error instanceof Error ? `材料已确认，原型等待：${error.message}` : '原型等待条件'; await this.store.save() }
      }
    } catch (error) { if (operation.phase !== 'accepted') operation.phase = 'unknown'; operation.message = error instanceof Error ? error.message : '原操作结果未知'; await this.store.save(); throw error }
  }
  acceptSessionOutput(sessionId: string, output: SessionOutput): Promise<void> {
    const result = this.queue.then(async () => {
      if (!this.store.scoped || (await this.ports.account())?.id !== this.store.accountId) return
      if (output.kind === 'source-read') { await this.acceptSourceRead(sessionId, output); return }
      if (await this.repairs.accept(sessionId, output)) return
      if (!await this.reviews.accept(sessionId, output) && output.kind === 'assistant' && !await this.scenarios.accept(sessionId, output.content)) await this.candidates.accept(sessionId, output.content)
    })
    this.queue = result.catch(() => undefined); return result
  }
  private async adopt(command: Extract<StudioCommand, { action: 'adopt' }>) {
    const { remote, entity } = await this.entity(command.targetEntityId); const task = await this.designTask(remote, entity), local = await this.store.read()
    const previous = local.adoptions.find(value => value.projectId === remote.project.id && value.entityId === entity.id && value.worktree === task.worktree && value.request.source.projectId === command.sourceProjectId && value.request.source.entityId === command.sourceEntityId && value.request.source.version === command.version)
    if (previous) { if (previous.request.adjustmentSummary !== command.reason) throw new Error('原采用调整说明已固定，请先恢复原操作'); await this.resumeAdoption(previous); return }
    const versions = await this.api.request<FixedVersion[]>('GET', this.route(command.sourceProjectId, '/entities/' + command.sourceEntityId + '/versions')); const source = versions.find(v => v.version === command.version)
    if (!source?.reuse.enabled) throw new Error('该来源当前不能采用')
    const current = await readMaterial(task.worktree, entity.kind, entity.id)
    const operation: AdoptionOperation = { id: key(), projectId: remote.project.id, entityId: entity.id, worktree: task.worktree, sourceFixed: { ...source.fixed }, targetHash: current.sha256, phase: 'requesting',
      request: { idempotencyKey: key(), source: { projectId: command.sourceProjectId, entityId: command.sourceEntityId, version: command.version }, targetEntityId: entity.id, targetTaskId: path.basename(task.worktree), scope: 'material-package', adjustmentSummary: command.reason } }
    local.adoptions.push(operation); await this.store.save(); await this.resumeAdoption(operation)
  }
  private async resumeAdoption(operation: AdoptionOperation): Promise<void> {
    try {
      if (!operation.adoptionId) {
        let result: { id: string }
        try { result = (await this.api.request<{ result: { id: string } }>('GET', this.route(operation.projectId, '/operations/' + operation.request.idempotencyKey))).result }
        catch (error) { if (!(error instanceof CollaborationError) || error.code !== 'OPERATION_NOT_FOUND') throw error; result = await this.api.request<{ id: string }>('POST', this.route(operation.projectId, '/adoptions'), operation.request) }
        operation.adoptionId = result.id; operation.phase = 'accepted'; await this.store.save()
      }
      if (!operation.applied) {
        const { remote, entity } = await this.entity(operation.entityId)
        const token = await this.requireOwned(entity)
        if (remote.project.id !== operation.projectId || token.taskId !== operation.request.targetTaskId) throw new Error('原采用任务占用已变化，不能覆盖目标材料')
        const current = await readMaterial(operation.worktree, entity.kind, entity.id)
        const hasSource = current.metadata.sources.some(source => sameSource(source, operation.request.source))
        if (!hasSource) {
          if (current.sha256 !== operation.targetHash) throw new Error('目标草稿已变化，采用现场已保留，请先核对')
          const bytes = await this.projects.readFixed(operation.request.source.projectId, operation.sourceFixed.commitSha, operation.sourceFixed.path, operation.sourceFixed.sha256)
          if (digest(bytes) !== operation.sourceFixed.sha256) throw new Error('来源固定材料校验失败')
          const draft = parseMaterial(Buffer.from(bytes), operation.sourceFixed.path)
          const metadata = { ...initialMetadata(entity), entityId: entity.id, kind: entity.kind, title: entity.title,
            scenarioIds: entity.scenarioIds, prerequisites: entity.prerequisites,
            sources: [...(entity.scenarioSources ?? []), operation.request.source],
            businessEvidence: draft.metadata.businessEvidence, files: draft.metadata.files, referencedAssets: draft.metadata.referencedAssets,
            coreRulesPresent: false, acceptanceCriteriaPresent: false, openQuestions: draft.metadata.openQuestions,
            ...(entity.kind === 'scenario' && entity.templateId && entity.templateRef ? { templateId: entity.templateId, templateRef: entity.templateRef } : {}) } as MaterialMetadata
          await saveMaterial(operation.worktree, metadata, draft.body + '\n\n## 目标采用调整\n\n' + operation.request.adjustmentSummary + '\n')
        }
        operation.applied = true; await this.store.save()
      }
      if (operation.success && operation.phase !== 'succeeded') {
        const result = await this.api.request<{ status: string; targetConfirmationId: string }>('POST', this.route(operation.projectId, '/adoptions/' + operation.adoptionId + '/success'), operation.success)
        if (result.status !== 'succeeded' || result.targetConfirmationId !== operation.success.targetConfirmationId) throw new Error('服务端未确认本次目标采用成功')
        operation.phase = 'succeeded'
      }
      delete operation.message; await this.store.save()
    } catch (error) { operation.message = error instanceof Error ? error.message : '采用操作结果待恢复'; await this.store.save(); throw error }
  }
  private async generateHandoff(baselineId: string) {
    const { remote } = await this.selected(); const baseline = remote.baselines.find(b => b.id === baselineId)
    if (!baseline) throw new Error('基线不存在或尚未被接受')
    const source = remote.entities.find((value): value is EntityView => isEntityView(value) && value.id === baseline.entityId)
    if (!source) throw new Error('基线需求不可见')
    // The handoff is a named material too: its title carries the requirement and baseline version, never an ID.
    const title = `交接 ${source.title} v${baseline.version}`
    const existing = remote.entities.find((e): e is EntityView => isEntityView(e) && e.kind === 'handoff' && e.title === title)
    const entity = existing ?? await this.api.request<EntityView>('POST', this.route(remote.project.id, '/entities'), { idempotencyKey: key(), kind: 'handoff', title })
    const fresh = await this.entity(entity.id); const task = await this.designTask(fresh.remote, fresh.entity)
    if (!task.handoff) { task.handoff = { baselineId: baseline.id, entityId: baseline.entityId, version: baseline.version, commitSha: baseline.commitSha, status: 'pending' }; await this.store.save() }
    const handoff = task.handoff
    if (handoff.baselineId !== baseline.id || handoff.commitSha !== baseline.commitSha || handoff.entityId !== baseline.entityId || handoff.version !== baseline.version) throw new Error('交接任务已绑定其他固定基线')
    if (handoff.status === 'sent') return
    try {
      let draft: MaterialDraft
      try { draft = await readMaterial(task.worktree, 'handoff', entity.id) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        const metadata = { ...initialMetadata(entity), referencedAssets: [{ projectId: remote.project.id, entityId: source.id, version: baseline.version }] }
        draft = await saveMaterial(task.worktree, metadata, '# ' + entity.title + '\n\n## 固定资料\n\n需求 ' + source.id + '，材料版本 ' + baseline.version + '，代码 ' + baseline.commitSha + '。\n\n## 核心业务规则\n\n待根据固定需求整理。\n\n## 验收条件\n\n待根据固定需求整理。\n\n## 交付内容、限制与待澄清\n\n请结合固定材料补充。\n')
      }
      await this.ports.session(task, this.materialRules(draft))
      await this.ports.prompt(task.sessionId, '基于已接受基线 ' + baseline.id + '（代码 ' + baseline.commitSha + '）读取固定需求，整理可阅读交接清单 ' + draft.path + '：业务范围、规则、字段、异常、验收、依赖、来源、限制和不适用范围。不能编造缺失内容，不要自行确认。')
      handoff.status = 'sent'; delete task.error; await this.store.save()
    } catch (error) { handoff.status = 'failed'; task.error = error instanceof Error ? error.message : '交接清单请求未完成'; await this.store.save(); throw error }
  }
}
