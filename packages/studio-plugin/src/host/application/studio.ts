import { ScenarioWorkspaces } from './scenario-workspaces.ts'
import { ScenarioTemplates } from './scenario-templates.ts'
import { ScenarioRepairs } from './scenario-repairs.ts'
import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { canonical } from '@eadp/asset-domain'
import path from 'node:path'
import type { NamespaceView, EntityOccupancyView, EntityView, FixedReference, FixedVersion, IntegrationView, MaterialIntegrationRequest, OccupationToken, ProjectState, ProjectView, PrototypeBaselineView, MaterialMetadata } from '@eadp/contracts'
import type { Candidate, ConfirmationChoice, MaterialDraft, ProjectProgressReply, StudioCommand, StudioReply, StudioState, TaskView } from '../../shared/studio.ts'
import { digest, findMaterialFile, parseMaterial, readMaterial, saveMaterial } from '../adapters/assets/materials.ts'
import { CollaborationClient, CollaborationError } from '../adapters/collaboration/client.ts'
import { initialMetadata, type HostPorts, type SessionOutput } from './ports.ts'
import { StudioStore, type PendingOperation, type AdoptionOperation, type MaterialReservation } from './state.ts'
import { ProjectWorkspaces } from './projects.ts'
import { TaskMaintenance } from './task-maintenance.ts'
import { AuthorReviews } from './reviews.ts'
import { FixedCandidates } from './fixed-candidates.ts'
import { CandidateMerges } from './candidate-merges.ts'
import { GitIntegrations } from './git-integrations.ts'
import { MaterialConfirmations } from './material-confirmations.ts'
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
import { PrototypeCollaboration } from './prototype-collaboration.ts'

const key = (): string => randomUUID()
const confirmationChoice = (choice: ConfirmationChoice): ConfirmationChoice => choice.method === 'direct' ? { method: 'direct' } : { method: 'ai-assisted', reviewId: choice.reviewId, authorDisposition: choice.authorDisposition }
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
  private readonly requirementRecoveries = new Set<string>()
  private previewState: StudioState['preview']
  private readonly prototypePreviews = new Map<string, { prototypeTaskId: string; url: string }>()
  private namespaces: NamespaceView[] = []
  private readonly reviews: AuthorReviews
  private readonly projects: ProjectWorkspaces
  private readonly maintenance: TaskMaintenance
  private readonly scenarios: ScenarioWorkspaces
  private readonly templates: ScenarioTemplates
  private readonly repairs: ScenarioRepairs
  private readonly candidates: RequirementCandidates
  private readonly comparisons: ConsistencyComparisons
  private readonly fixedCandidates: FixedCandidates
  private readonly candidateMerges: CandidateMerges
  private readonly integrations: GitIntegrations
  private readonly confirmations: MaterialConfirmations
  private readonly prototypeCollaboration: PrototypeCollaboration
  private lastState: StudioState | undefined
  constructor(readonly store: StudioStore, private readonly api: CollaborationClient, private readonly ports: HostPorts) { this.prototypeCollaboration = new PrototypeCollaboration(store, api, ports); this.projects = new ProjectWorkspaces(store, api, ports, this.lane, this.progress); this.reviews = new AuthorReviews(store, ports)
    this.maintenance = new TaskMaintenance(store, ports, { sync: (projectId, commit) => this.projects.syncMain(projectId, commit), release: task => this.releaseTask(task) })
    this.scenarios = new ScenarioWorkspaces(store, api, ports, this.projects, { entity: (id, projectId) => this.entity(id, projectId), task: (remote, entity) => this.designTask(remote, entity), owned: entity => this.requireOwned(entity), deliver: work => this.lane.append(work), changed: async (task, error) => { if (error) await this.repairs.observationFailed(task.entityId, task.projectId, error); else await this.repairs.checkConcurrent(task.entityId, task.projectId) } })
    this.templates = new ScenarioTemplates(store, api, ports, this.projects, this.lane)
    this.fixedCandidates = new FixedCandidates(store, ports, {
      entity: (id, projectId) => this.entity(id, projectId), designTask: (remote, entity) => this.designTask(remote, entity),
      owned: entity => this.requireOwned(entity),
      identity: projectId => this.identity(projectId), pruneEvidence: task => this.scenarios.sources.pruneEvidence(task),
    })
    this.candidateMerges = new CandidateMerges(store, ports, {
      entity: (id, projectId) => this.entity(id, projectId),
      identity: projectId => this.identity(projectId),
      checks: (candidateSha, draft) => this.fixedCandidates.materialChecks(candidateSha, draft),
      readDraft: (task, entity) => readMaterial(task.worktree, entity.kind, entity.id),
    })
    this.integrations = new GitIntegrations(store, api, ports, this.lane, { accepted: async (operation, integration, task) => {
      await this.confirmations.accept(operation, integration)
      this.scheduleAcceptedWork(operation, integration, task)
    }, merge: async (operation, request, head, branch) => {
      if (request.stage !== 'material') return false
      const merged = await this.candidateMerges.merge(operation, request, head, branch)
      if (!merged) return false
      const local = await this.store.read()
      const original = local.operations.find(value => value.id === operation.id && value.projectId === operation.projectId)
      if (original) { original.phase = 'superseded'; original.message = '已由自动合并候选承接' }
      await this.confirmations.remap(operation.id, merged)
      await this.store.save()
      await this.integrations.submit(merged.task, merged.draft, merged.prepare)
      return true
    } })
    this.confirmations = new MaterialConfirmations(store, ports, this.scenarios, this.fixedCandidates, this.integrations, this.reviews, {
      entity: (id, projectId) => this.entity(id, projectId), designTask: (remote, entity) => this.designTask(remote, entity), owned: entity => this.requireOwned(entity),
      deliver: work => { this.lane.append(work) }, identity: projectId => this.identity(projectId),
    })
    this.repairs = new ScenarioRepairs(this.scenarios, async (entityId, expectedHash, repairId) => {
      const operation = await this.confirmations.confirm({ operationId: digest(`${repairId}:${expectedHash}`), entityId, expectedHash, repairId })
      if (operation.phase === 'recovery') throw new Error(operation.message)
    })
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
  async dispose(): Promise<void> {
    this.scenarios.dispose(); await this.comparisons.dispose(); await this.settle()
    // A queued save can reopen observation while it finishes; release that observation too.
    this.scenarios.dispose(); await this.projects.dispose()
  }
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
    if (command.action === 'readPrototypeBuffer') return { ok: true, state: await this.state(), prototypeBuffer: await this.prototypeCollaboration.readBuffer(command.prototypeTaskId, command.path) }
    if (command.action === 'savePrototypeBuffer') { await this.prototypeCollaboration.saveBuffer(command.operationId, command.buffer); return { ok: true, state: await this.state() } }
    if (command.action === 'clearPrototypeBuffer') { await this.prototypeCollaboration.clearBuffer(command.prototypeTaskId, command.path, command.expectedContent); return { ok: true, state: await this.state() } }
    if (command.action === 'readPrototypeDiff') return { ok: true, state: await this.state(), prototypeFiles: await this.prototypeCollaboration.diff(command) }
    if (command.action === 'listPrototypeDirectory' || command.action === 'searchPrototypeFiles' || command.action === 'readPrototypeFile' || command.action === 'savePrototypeFile') {
      const prototypeFiles = command.action === 'savePrototypeFile' ? await this.prototypeCollaboration.saveFile(command) : await this.prototypeCollaboration.fileService.read(await this.prototypeCollaboration.fileWorkspace(command.prototypeTaskId), command)
      return { ok: true, state: await this.state(), prototypeFiles }
    }
    if (command.action === 'startPrototypeCollaboration') { await this.prototypeCollaboration.start(command); return { ok: true, state: await this.state() } }
    if (command.action === 'continuePrototypeCollaboration' || command.action === 'extendPrototypeDevelopment') { await this.prototypeCollaboration.continue(command); return { ok: true, state: await this.state() } }
    if (command.action === 'selectPrototypeQueueItem') { await this.prototypeCollaboration.select(command.prototypeTaskId); return { ok: true, state: await this.state() } }
    if (command.action === 'resumePrototypeQueueItem') { await this.prototypeCollaboration.resumeQueued(command.prototypeTaskId); return { ok: true, state: await this.state() } }
    if (command.action === 'queryPrototypeMessage') { await this.prototypeCollaboration.queryMessage(command.prototypeTaskId); return { ok: true, state: await this.state() } }
    if (command.action === 'readPrototypeConversation') return { ok: true, state: await this.state(), prototypeConversation: await this.prototypeCollaboration.conversation(command.prototypeTaskId) }
    if (command.action === 'readPrototypeQueue') return { ok: true, state: await this.state() }
    if (command.action === 'savePrototypeInstructionDraft') { await this.prototypeCollaboration.saveDraft(command.operationId, command.draft); return { ok: true, state: await this.state() } }
    if (command.action === 'checkProjectPrototype' || command.action === 'startProjectPrototypePreview') {
      const task = await this.prototypeCollaboration.task(command.prototypeTaskId)
      const sha = (await this.ports.git.state(task.worktree)).head
      await this.ports.checks(task, sha)
      if (command.action === 'startProjectPrototypePreview') {
        const preview = await this.ports.preview(task)
        this.prototypePreviews.set(command.prototypeTaskId, { prototypeTaskId: command.prototypeTaskId, url: preview.url })
      }
      return { ok: true, state: await this.state() }
    }
    if (command.action === 'stopProjectPrototypePreview') {
      const sessionId = await this.prototypeCollaboration.sessionId(command.prototypeTaskId)
      if (sessionId) await this.ports.stopPreview(sessionId)
      this.prototypePreviews.delete(command.prototypeTaskId)
      return { ok: true, state: await this.state() }
    }
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
        await this.ports.stopPreview(); this.previewState = undefined; this.prototypePreviews.clear(); this.namespaces = []
        const identity = await this.ports.login(command.username, command.password)
        this.store.useUser(identity.user.id)
        // Login's contract is authentication, not a full projection: the reply
        // only needs connected+account, and a projection failure must not mask
        // an already-stored successful login. The workbench refreshes its own
        // full state right after.
        return { ok: true, state: { connected: true, account: identity.user, projects: [], availableProjects: [], namespaces: [], projectInitializations: [], drafts: [], tasks: [], candidates: [], reviews: [], pending: [] } }
      }
      case 'logout': { try { await this.comparisons.dispose(); await this.ports.logout() } finally { this.scenarios.dispose(); this.store.useUser(); await this.ports.stopPreview(); await this.projects.dispose(); this.previewState = undefined; this.prototypePreviews.clear(); this.lastState = undefined; this.namespaces = [] } break }
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
        if ((entity.kind === 'scenario' || entity.kind === 'requirement') && entity.current && !entity.occupation) throw new Error('已确认材料只读，请显式开始修订')
        const task = await this.designTask(remote, entity)
        const draft = await readMaterial(task.worktree, entity.kind, entity.id)
        sessionId = await this.ports.session(task, this.materialRules(draft))
        break
      }
      case 'restoreSession': sessionId = await this.restoreSession(command.sessionId); break
      case 'requestReview': { const content = await this.fixedCandidates.content({ entityId: command.entityId, purpose: command.purpose }); await this.reviews.request({ projectId: content.remote.project.id, entityId: content.entity.id, purpose: command.purpose, head: content.snapshot.head, inputHash: content.inputHash, files: content.snapshot.files, paths: content.paths, task: content.task }); break }
      case 'confirmRequirement': await this.confirmations.confirm({ entityId: command.entityId, operationId: command.operationId, expectedHash: command.expectedHash, body: command.body, metadata: command.metadata, choice: confirmationChoice(command) }); break
      case 'confirmMaterial': {
        const { entity } = await this.entity(command.entityId)
        if (entity.kind === 'requirement') {
          const { task } = await this.scenarios.editable(entity.id)
          const draft = await readMaterial(task.worktree, 'requirement', entity.id)
          // The confirmation fixes the file's current bytes, so a hash that moved on is not a conflict.
          await this.confirmations.confirm({ entityId: command.entityId, operationId: key(), expectedHash: draft.sha256, body: draft.body, metadata: draft.metadata, choice: confirmationChoice(command) })
        } else if (entity.kind === 'scenario') {
          const operation = await this.confirmations.confirm({ entityId: command.entityId, operationId: key(), expectedHash: command.expectedHash, choice: confirmationChoice(command) })
          if (operation.phase === 'recovery') throw new Error(operation.message)
        } else await this.confirmReviewedCandidate(command.entityId, 'material', command, command.expectedHash)
        break
      }
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
        const local = await this.store.read(), matching = local.operations.filter(op => op.id === command.operationId)
        const operation = matching.find(op => op.projectId === local.selectedProjectId) ?? (matching.length === 1 ? matching[0] : undefined)
        const confirmation = local.scenarios.find(record => record.materialConfirmations?.some(value => value.operationId === command.operationId || value.integrationId === command.operationId))
        const confirmed = confirmation?.materialConfirmations?.find(value => value.operationId === command.operationId || value.integrationId === command.operationId)
        if (confirmation && confirmed) await this.confirmations.retry(confirmation.entityId, confirmed.operationId, confirmation.projectId)
        else if (operation) this.integrations.schedule(operation)
        else { const adoption = local.adoptions.find(op => op.id === command.operationId); const reservation = local.materialReservations.find(op => op.id === command.operationId)
            const repairAuthorization = local.scenarios.find(record => record.projectId === local.selectedProjectId && record.repairAuthorization?.request.idempotencyKey === command.operationId)
            const repairEvent = local.scenarioRepairs.find(record => record.projectId === local.selectedProjectId && (record.pending?.idempotencyKey === command.operationId || record.recoverPending?.idempotencyKey === command.operationId))
            const templateBinding = local.scenarios.find(record => record.projectId === local.selectedProjectId && (record.templateBinding?.request.idempotencyKey === command.operationId || record.templateBinding?.application?.operationId === command.operationId))
            const requirementSave = local.scenarios.find(record => record.projectId === local.selectedProjectId && record.requirementSaves?.some(operation => operation.operationId === command.operationId))
            if (adoption) await this.resumeAdoption(adoption)
            else if (reservation) await this.retryMaterialReservation(reservation)
            else if (repairAuthorization) await this.repairs.retryStart(repairAuthorization.entityId)
            else if (repairEvent) await this.repairs.checkConcurrent(repairEvent.entityId, repairEvent.projectId)
            else if (templateBinding) await this.scenarios.retryTemplateBinding(templateBinding.entityId)
            else if (requirementSave) { await this.scenarios.requirementSaves.retry(requirementSave.entityId, command.operationId); await this.confirmations.continue(requirementSave.entityId) }
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
        await this.selected()
        await this.ports.publication(command.action); break
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
    if (['openRequirement', 'startRequirementRevision', 'saveRequirement', 'retryRequirementSave', 'resolveRequirementWriteProposal', 'undoRequirementWrite', 'newRequirementSession', 'selectRequirementSession'].includes(command.action)) return this.executeRequirement(command as RequirementWorkspaceCommand)
    switch (command.action) {
      case 'openScenario': await this.scenarios.open(command.entityId); break
      case 'saveScenario': await this.repairs.checkConcurrent(command.entityId); await this.scenarios.save(command); await this.repairs.checkConcurrent(command.entityId); break
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
    if (command.action === 'retryRequirementSave') {
      await this.scenarios.requirementSaves.retry(command.entityId, command.operationId)
      await this.confirmations.continue(command.entityId)
      return undefined
    }
    const { entity, remote } = await this.entity(command.entityId)
    if (entity.kind !== 'requirement') throw new Error('此操作只适用于需求材料')
    switch (command.action) {
      case 'openRequirement': await this.scenarios.open(entity.id); break
      case 'saveRequirement':
        await this.scenarios.save(command); break
      case 'resolveRequirementWriteProposal': await this.scenarios.resolveWriteProposal(command); break
      case 'undoRequirementWrite': await this.scenarios.undoWrite(command); break
      case 'newRequirementSession': return this.scenarios.newSession(entity.id)
      case 'selectRequirementSession': return this.scenarios.selectSession(entity.id, command.sessionId)
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
  /** Projection reads only enqueue recovery; the same local writer runs it after current commands. */
  private async scheduleRequirementRecoveries(projectId: string): Promise<void> {
    const accountId = this.store.accountId
    for (const pending of await this.scenarios.requirementSaves.automatic(projectId)) {
      const identity = `${accountId}:${projectId}:${pending.operationId}`
      if (this.requirementRecoveries.has(identity)) continue
      this.requirementRecoveries.add(identity)
      const recovery = this.queue.then(async () => {
        if (this.store.accountId !== accountId || (await this.ports.account())?.id !== accountId) return
        const local = await this.store.read()
        if (local.selectedProjectId !== projectId) return
        await this.scenarios.requirementSaves.retry(pending.entityId, pending.operationId)
        await this.confirmations.continue(pending.entityId)
      })
      this.queue = recovery.catch(() => undefined)
      void recovery.then(() => this.requirementRecoveries.delete(identity), () => this.requirementRecoveries.delete(identity))
    }
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
    for (const operation of local.operations) if (operation.phase === 'accepted' && operation.accepted && operation.accountId === account.id && allowed.has(operation.projectId)) {
      // A confirmation may have been persisted after its child was accepted but
      // before it recorded completion; adopt the durable child receipt first.
      await this.confirmations.accept(operation, operation.accepted)
      const original = local.tasks.find(task => task.projectId === operation.projectId && task.entityId === operation.entityId && task.worktree === operation.task.worktree && task.sessionId === operation.task.sessionId && task.purpose === operation.task.purpose)
      if (original) this.scheduleAcceptedWork(operation, operation.accepted, original)
    }
    for (const operation of local.operations) if (operation.accountId === account.id && allowed.has(operation.projectId)) this.integrations.recover(operation)
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
    // One confirmation owns its integration notice. Emitting the child as a
    // second pending row duplicated the key and hid the child's real failure.
    const claimed = new Set(local.scenarios.filter(record => record.projectId === selected?.id)
      .flatMap(record => record.materialConfirmations ?? [])
      .filter(value => value.phase !== 'accepted' && value.phase !== 'superseded' && value.integrationId)
      .map(value => value.integrationId!))
    const prototypeQueue = await this.prototypeCollaboration.view()
    const prototypeBaselines = selected && remote?.project.initializationStatus === 'ready' ? await this.api.request<PrototypeBaselineView[]>('GET', this.route(selected.id, '/prototype/baselines?limit=100&offset=0')) : undefined
    const state: StudioState = { ...(scenario ? { scenario } : {}), ...(requirement ? { requirement } : {}), ...(materialSources.length ? { materialSources } : {}), ...(templatePreview ? { templatePreview } : {}), ...(recovery ? { recovery } : {}), connected: true, account, projects, availableProjects, namespaces: this.namespaces, prototypeQueue, prototypeInstructionDrafts: await this.prototypeCollaboration.drafts(), prototypePreviews: [...this.prototypePreviews.values()], ...(prototypeBaselines ? { prototypeBaselines } : {}),
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
        ...[...local.operations.filter(op => !claimed.has(op.id)), ...local.adoptions.filter(op => op.phase !== 'succeeded')].filter(op => op.projectId === selected?.id && op.phase !== 'superseded').map(op => ({ id: op.id, entityId: op.entityId, phase: op.phase, ...(op.message ? { message: op.message } : {}) })),
        ...local.scenarios.filter(record => record.projectId === selected?.id && record.repairAuthorization?.status === 'pending').map(record => ({ id: record.repairAuthorization!.request.idempotencyKey, entityId: record.entityId, phase: 'unknown', message: record.repairAuthorization!.message ?? '修复授权结果待核对' })),
        ...local.scenarioRepairs.filter(record => record.projectId === selected?.id && (record.pending || record.recoverPending)).map(record => ({ id: (record.pending ?? record.recoverPending)!.idempotencyKey, entityId: record.entityId, phase: 'unknown', message: record.message ?? '修复轮次结果待核对' })),
        ...local.templateOperations.filter(op => op.projectId === selected?.id && op.phase === 'unknown').map(op => ({ id: op.preview.operationId, entityId: 'templates', phase: op.phase, ...(op.message ? { message: op.message } : {}) })),
        ...local.scenarios.filter(record => record.projectId === selected?.id && record.templateBinding?.status === 'pending').map(record => ({ id: record.templateBinding!.application?.operationId ?? record.templateBinding!.request.idempotencyKey, entityId: record.entityId, phase: 'unknown', message: record.templateBinding!.message ?? '模板绑定结果待核对' })),
        ...local.scenarios.filter(record => record.projectId === selected?.id).flatMap(record => {
          const save = this.scenarios.requirementSaves.view(record), confirmation = this.confirmations.view(record, local.operations)
          return save || confirmation ? [{ id: save?.operationId ?? confirmation!.operationId, entityId: record.entityId, phase: save?.phase ?? confirmation!.phase, message: save?.message ?? confirmation!.message }] : []
        }),
        ...local.materialReservations.filter(op => op.projectId === selected?.id && op.phase !== 'materialized').map(op => ({ id: op.id, entityId: op.entityId ?? op.id, phase: op.phase, ...(op.message ? { message: op.message } : {}) })),
      ] }
    if (selected) await this.scheduleRequirementRecoveries(selected.id)
    if (selected) this.scenarios.statusReports.resume(selected.id)
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
    const prototypeSession = await this.prototypeCollaboration.restoreSession(sessionId)
    if (prototypeSession) return prototypeSession
    const local = await this.store.read()
    const repair = local.scenarioRepairs.find(value => value.task.sessionId === sessionId && value.projectId === local.selectedProjectId)
    if (repair) {
      if (!['active', 'paused'].includes(repair.view.status)) throw new Error('修复任务授权已结束')
      await this.scenarios.context(repair.task)
      return this.ports.session(repair.task, '只读场景修复助手，由Host执行受控写入和确认。')
    }
    const task = local.tasks.find(value => value.sessionId === sessionId && value.projectId === local.selectedProjectId)
    if (!task || !['material', 'handoff', 'split'].includes(task.purpose)) throw new Error('未找到当前项目可恢复的工作台任务')
    if (task.purpose === 'split') { await this.candidates.resume(task.sessionId); return task.sessionId }
    const { remote, entity } = await this.entity(task.entityId)
    if (entity.kind === 'scenario' && task.purpose === 'material') return this.scenarios.selectSession(entity.id, sessionId)
    const expectedPurpose = entity.kind === 'handoff' ? 'handoff' : 'material'
    if (task.purpose !== expectedPurpose) throw new Error('会话任务类型与当前资产不一致')
    const token = await this.requireOwned(entity)
    const occupation = entity.occupation!
    if (occupation.purpose !== 'design' || occupation.inputVersion !== entity.materialVersion) throw new Error('会话任务占用类型或输入版本已失效')
    if (path.resolve(task.worktree) !== path.join(this.store.directory, 'worktrees', remote.project.id, token.taskId)) throw new Error('会话现场与当前任务占用不一致')
    if (task.inputHash !== (entity.current?.fixed.sha256 ?? '')) throw new Error('材料已修订，旧会话输入已失效')
    const draft = await readMaterial(task.worktree, entity.kind, entity.id)
    return this.ports.session(task, this.materialRules(draft))
  }
  private async identity(projectId?: string) {
    const account = await this.requireAccount()
    if (account.gitlabEmail) return { name: account.name || account.gitlabUsername, email: account.gitlabEmail }
    const project = projectId ? (await this.store.read()).projects.find(value => value.id === projectId) : (await this.selected()).project
    if (!project) throw new Error('原项目未在本机登记')
    return this.ports.git.identity(project.directory)
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
    const accountId = this.store.accountId, directory = this.store.directory
    if (!accountId) throw new Error('请登录后打开任务')
    const local = await this.taskAccount(accountId, () => this.store.read())
    const claimed = !entity.occupation
    let current = entity
    if (!current.occupation) current = await this.taskAccount(accountId, () => this.api.request<EntityView>('POST', this.route(remote.project.id, `/entities/${entity.id}/claim`), { idempotencyKey: key(), expectedRevision: entity.revision, taskId: key(), clientId: local.clientId, purpose: 'design' }))
    const token = await this.taskAccount(accountId, () => this.requireOwned(current))
    const sessions = local.tasks.filter(t => t.projectId === remote.project.id && t.entityId === entity.id && (t.purpose === 'material' || t.purpose === 'handoff') && path.basename(t.worktree) === token.taskId)
    const activeSessionId = local.scenarios.find(record => record.projectId === remote.project.id && record.entityId === entity.id)?.activeSessionId
    const existing = sessions.find(task => task.sessionId === activeSessionId) ?? sessions.at(-1)
    if (existing) {
      if (claimed) void this.scenarios.statusReports.report({ projectId: remote.project.id, entityId: entity.id, trigger: 'occupation-start', worktree: existing.worktree, baseHead: remote.project.recognizedHead! })
      return existing
    }
    const project = local.projects.find(p => p.id === remote.project.id)!
    if (!project) throw new Error('原项目未在本机登记')
    await this.taskAccount(accountId, () => this.projects.requireCommit(project, remote.project.stableBranch, remote.project.recognizedHead!))
    const worktree = path.join(directory, 'worktrees', remote.project.id, token.taskId)
    await this.taskAccount(accountId, () => this.ports.git.createWorktree(project.directory, worktree, `studio/${entity.id}/${token.generation}`, remote.project.recognizedHead!))
    const task: TaskView = { projectId: project.id, entityId: entity.id, sessionId: `studio-${key()}`, purpose: entity.kind === 'handoff' ? 'handoff' : 'material', inputHash: entity.current?.fixed.sha256 ?? '', worktree, baseHead: remote.project.recognizedHead! }
    if (entity.kind === 'handoff') local.tasks = local.tasks.filter(t => !(t.projectId === project.id && t.entityId === entity.id && t.purpose === task.purpose)); local.tasks.push(task); await this.taskAccount(accountId, () => this.store.save())
    if (claimed) void this.scenarios.statusReports.report({ projectId: remote.project.id, entityId: entity.id, trigger: 'occupation-start', worktree: task.worktree, baseHead: remote.project.recognizedHead! })
    return task
  }
  private materialRules(draft: MaterialDraft): string {
    if (draft.metadata.kind === 'scenario') return '你是场景设计助手。使用 grilling 逐问推进设计，用 domain-modeling 沉淀术语与决策；普通对话只归纳结论与提问，禁止直接写入文件、修改Git或确认。场景只确认业务流程完整：触发条件、角色、主要路径、必要分支及业务结果；金额阈值、字段和计算口径等细节留待需求确认，不作为场景阻断项。资料与引用仅提醒，可依据当前正文和用户明确答复，不强制外部附件。每次调用须以Host提供的当前Markdown、固定模板和实际已读资料为准。'
    if (draft.metadata.kind === 'requirement') return '你是需求设计助手。使用 grilling 逐问推进需求设计，用 domain-modeling 沉淀术语与决策；普通对话只归纳结论与提问，不写正文、不直接修改文件或确认。以Host提供的当前需求、已接受场景依据和实际已读资料为准，缺业务答案时提问。'
    return `你正在整理 ${draft.metadata.kind} ${draft.entityId}。仅编辑 ${draft.path}；保留 eadp-metadata 身份。实际业务依据、核心业务规则、验收条件缺失时提出问题，不编造；核心待澄清项阻断确认，非阻断项明确限制和不适用范围。不得自行确认、释放占用、修改Git/模板规则或执行shell。作者通过工作台确认。当前材料哈希 ${draft.sha256}。`
  }
  private async confirmReviewedCandidate(entityId: string, purpose: 'material', choice: ConfirmationChoice, expectedHash?: string) {
    const snapshot = await this.fixedCandidates.prepare({ entityId, purpose, ...(expectedHash ? { expectedHash } : {}) })
    const authority = await this.reviews.confirmation(confirmationChoice(choice), snapshot.review)
    await this.integrations.submit(snapshot.task, snapshot.draft, { ...snapshot.prepare, confirmations: snapshot.confirmations.map(value => ({ ...value, readHash: value.fixed.sha256, ...authority, authorConfirmed: true as const })) })
  }
  /** Deliver accepted facts through independently owned follow-up work, never through confirmation failure. */
  private scheduleAcceptedWork(operation: PendingOperation, integration: IntegrationView, task: TaskView): void {
    const scope = `${operation.accountId}:${operation.projectId}:${integration.id}`
    const schedule = (name: string, work: () => Promise<void>): void => this.lane.schedule(`${name}:${scope}`, async () => {
      await this.requireTaskAccount(operation.accountId)
      try { await work(); await this.requireTaskAccount(operation.accountId) }
      catch (error) {
        await this.requireTaskAccount(operation.accountId)
        task.error = `成果已接受，后续工作待恢复：${error instanceof Error ? error.message : '未知错误'}`
        await this.store.save(); throw error
      }
    })
    const confirmations = (operation.prepare as MaterialIntegrationRequest).confirmations
    if (integration.stage === 'material') schedule('comparison-inputs', async () => {
      const reads: Promise<void>[] = []
      for (const [index, confirmation] of confirmations.entries()) {
        const confirmationId = integration.confirmationIds![index]!
        await this.requireTaskAccount(operation.accountId)
        const comparison = await this.comparisons.start({ projectId: operation.projectId, entityId: confirmation.entityId, worktree: task.worktree, trigger: 'confirmation', confirmationId })
        reads.push(comparison.inputsRead)
      }
      await Promise.all(reads)
      await this.requireTaskAccount(operation.accountId)
      this.scheduleMaintenance(task, integration.candidateSha)
    })
    else this.scheduleMaintenance(task, integration.candidateSha)
    if (integration.stage === 'material') schedule('accepted-material', async () => {
      const { entity } = await this.entity(operation.entityId, operation.projectId)
      await this.requireTaskAccount(operation.accountId)
      if (!entity.current || !integration.confirmationIds!.includes(entity.current.confirmationId)) return
      if (entity.kind === 'scenario') {
        const record = await this.scenarios.record(entity.id, operation.projectId)
        record.splitOffered = true; this.scenarios.stopObservation(task); await this.store.save()
      }
    })
    for (const adoptionId of operation.adoptionIds ?? []) schedule(`adoption-success:${adoptionId}`, async () => {
      const local = await this.store.read(), adoption = local.adoptions.find(value => value.id === adoptionId)
      if (!adoption) throw new Error('采用恢复记录缺失，不能申报复用成功')
      const index = confirmations.findIndex(value => value.entityId === adoption.entityId), confirmation = confirmations[index]
      const confirmationId = integration.confirmationIds?.[index]
      if (!confirmation || !confirmationId) throw new Error('本次接受结果未包含目标确认记录')
      const bytes = await this.projects.readFixed(operation.projectId, confirmation.fixed.commitSha, confirmation.fixed.path, confirmation.fixed.sha256)
      await this.requireTaskAccount(operation.accountId)
      const fixed = parseMaterial(Buffer.from(bytes), confirmation.fixed.path)
      if (digest(bytes) !== confirmation.fixed.sha256 || fixed.metadata.entityId !== adoption.entityId || !fixed.metadata.sources.some(source => sameSource(source, adoption.request.source))) throw new Error('本次接受结果未包含精确采用来源')
      adoption.success ??= { idempotencyKey: adoption.id + '-success-' + confirmationId, targetConfirmationId: confirmationId }
      await this.store.save(); await this.resumeAdoption(adoption)
    })
  }
  private async requireTaskAccount(accountId: number): Promise<void> {
    if (!this.store.scoped || this.store.accountId !== accountId) throw new Error('账号已变化，任务现场保留供原账号恢复')
    const account = await this.ports.account()
    if (!this.store.scoped || this.store.accountId !== accountId || account?.id !== accountId) throw new Error('账号已变化，任务现场保留供原账号恢复')
  }
  /** External task work may finish in its original directory, but cannot continue in another account. */
  private async taskAccount<T>(accountId: number, work: () => Promise<T>): Promise<T> {
    await this.requireTaskAccount(accountId)
    let result: T
    try { result = await work() }
    catch (error) { await this.requireTaskAccount(accountId); throw error }
    await this.requireTaskAccount(accountId)
    return result
  }
  /** Settle this machine once an integration is accepted; the reply never waits for it. */
  private scheduleMaintenance(task: TaskView, commit: string): void {
    this.lane.schedule(`maintenance:${task.worktree}`, () => this.maintenance.settle(task, commit))
  }
  /** Release one task's file observation, preview and Agent handles; other tasks stay live. */
  private async releaseTask(task: TaskView): Promise<void> {
    this.scenarios.stopWorktree(task.worktree)
    if (task.purpose === 'prototype' && this.previewState?.entityId === task.entityId) { await this.ports.stopPreview(); this.previewState = undefined }
    await this.ports.releaseTask?.(task.worktree)
  }

  acceptSessionOutput(sessionId: string, output: SessionOutput): Promise<void> {
    const result = this.queue.then(async () => {
      if (!this.store.scoped || (await this.ports.account())?.id !== this.store.accountId) return
      if (await this.prototypeCollaboration.accept(sessionId, output)) return
      if (output.kind === 'source-read') { await this.acceptSourceRead(sessionId, output); return }
      if (await this.candidateMerges.accept(sessionId, output)) return
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
            ...(entity.kind === 'scenario' ? { flowComplete: false } : { coreRulesPresent: false, acceptanceCriteriaPresent: false }), openQuestions: draft.metadata.openQuestions,
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
    const title = `原型交接 v${baseline.sequence}`
    const existing = remote.entities.find((e): e is EntityView => isEntityView(e) && e.kind === 'handoff' && e.title === title)
    const entity = existing ?? await this.api.request<EntityView>('POST', this.route(remote.project.id, '/entities'), { idempotencyKey: key(), kind: 'handoff', title })
    const fresh = await this.entity(entity.id); const task = await this.designTask(fresh.remote, fresh.entity)
    if (!task.handoff) { task.handoff = { baselineId: baseline.id, sequence: baseline.sequence, commitSha: baseline.commitSha, status: 'pending' }; await this.store.save() }
    const handoff = task.handoff
    if (handoff.baselineId !== baseline.id || handoff.commitSha !== baseline.commitSha || handoff.sequence !== baseline.sequence) throw new Error('交接任务已绑定其他固定基线')
    if (handoff.status === 'sent') return
    try {
      let draft: MaterialDraft
      try { draft = await readMaterial(task.worktree, 'handoff', entity.id) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        const metadata = initialMetadata(entity)
        if (metadata.kind !== 'handoff') throw new Error('交接材料身份不正确')
        metadata.prototypeBaseline = { baselineId: baseline.id, commitSha: baseline.commitSha }
        draft = await saveMaterial(task.worktree, metadata, '# ' + entity.title + '\n\n## 固定资料\n\n原型基线 ' + baseline.id + '，代码 ' + baseline.commitSha + '。\n\n## 核心业务规则\n\n待根据固定需求整理。\n\n## 验收条件\n\n待根据固定需求整理。\n\n## 交付内容、限制与待澄清\n\n请结合固定材料补充。\n')
      }
      await this.ports.session(task, this.materialRules(draft))
      await this.ports.prompt(task.sessionId, '基于已接受基线 ' + baseline.id + '（代码 ' + baseline.commitSha + '）结合基线关联需求和原型代码，整理可阅读交接清单 ' + draft.path + '：业务范围、规则、字段、异常、验收、依赖、来源、限制和不适用范围。不能编造缺失内容，不要自行确认。')
      handoff.status = 'sent'; delete task.error; await this.store.save()
    } catch (error) { handoff.status = 'failed'; task.error = error instanceof Error ? error.message : '交接清单请求未完成'; await this.store.save(); throw error }
  }
}
