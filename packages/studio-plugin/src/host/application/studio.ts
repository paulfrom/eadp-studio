import { randomUUID } from 'node:crypto'
import { reviewInputText } from '@eadp/contracts'
import path from 'node:path'
import type { NamespaceView, CheckEvidence, ConfirmationInput, EntityView, FixedVersion, IntegrationView, OccupationToken, PrepareIntegrationRequest, ProjectState, ProjectView } from '@eadp/contracts'
import type { Candidate, ConfirmationChoice, MaterialDraft, StudioCommand, StudioReply, StudioState, TaskView } from '../../shared/studio.ts'
import { digest, materialPath, parseMaterial, readMaterial, saveMaterial, checkMaterial } from '../adapters/assets/materials.ts'
import { CollaborationClient, CollaborationError } from '../adapters/collaboration/client.ts'
import { initialMetadata, type HostPorts, type SessionOutput } from './ports.ts'
import { StudioStore, type PendingOperation, type AdoptionOperation } from './state.ts'
import { ProjectWorkspaces } from './projects.ts'
import { AuthorReviews, type ReviewCandidate } from './reviews.ts'

const prototypeRules = '按已确认需求完成原型；发现冲突时保留代码并要求作者修订需求，不得自行确认。'
const key = (): string => randomUUID()
const sameSource = (left: { projectId: string; entityId: string; version: number }, right: { projectId: string; entityId: string; version: number }) => left.projectId === right.projectId && left.entityId === right.entityId && left.version === right.version
const starter = (title: string) => `# ${title}\n\n## 业务背景\n\n请与 AI 整理实际业务背景与使用者。\n\n## 核心业务规则\n\n待补充。\n\n## 验收条件\n\n待补充。\n\n## 限制与不适用范围\n\n待澄清。\n`

/** Serializes one local writer. PostgreSQL and Git CAS remain the cross-client authority. */
export class StudioApplication {
  private queue: Promise<unknown> = Promise.resolve()
  private previewState: StudioState['preview']
  private namespaces: NamespaceView[] = []
  private readonly reviews: AuthorReviews
  private readonly projects: ProjectWorkspaces
  constructor(readonly store: StudioStore, private readonly api: CollaborationClient, private readonly ports: HostPorts) { this.projects = new ProjectWorkspaces(store, api, ports); this.reviews = new AuthorReviews(store, ports) }
  async dispose(): Promise<void> { await this.projects.dispose() }
  command(command: StudioCommand): Promise<StudioReply> {
    const result = this.queue.then(() => this.execute(command))
    this.queue = result.catch(() => undefined)
    return result.catch((error: unknown) => ({ ok: false, code: error instanceof CollaborationError ? error.code : 'STUDIO_OPERATION_FAILED', message: error instanceof Error ? error.message : '操作未完成，请查询当前状态' }))
  }
  private async execute(command: StudioCommand): Promise<StudioReply> {
    let sessionId: string | undefined
    if (!['state', 'login', 'logout'].includes(command.action)) await this.requireAccount()
    switch (command.action) {
      case 'state': break
      case 'login': { await this.ports.stopPreview(); this.previewState = undefined; this.namespaces = []; const identity = await this.ports.login(command.username, command.password); this.store.useUser(identity.user.id); break }
      case 'logout': { try { await this.ports.logout() } finally { this.store.useUser(); await this.ports.stopPreview(); await this.projects.dispose(); this.previewState = undefined; this.namespaces = [] } break }
      case 'namespaces': this.namespaces = await this.api.request<NamespaceView[]>('GET', '/v1/namespaces', undefined, 180_000); break
      case 'createProject': await this.projects.create(command); break
      case 'openProject': await this.projects.open(command.projectId); break
      case 'retryProjectInitialization': await this.projects.resume(command.operationId); break
      case 'selectProject': {
        const local = await this.store.read()
        if (!local.projects.some(p => p.id === command.projectId)) throw new Error('项目未在此工作空间登记')
        await this.ports.stopPreview(); this.previewState = undefined
        local.selectedProjectId = command.projectId; await this.store.save(); break
      }
      case 'addCategory': {
        const { remote } = await this.selected()
        await this.api.request('POST', this.route(remote.project.id, '/categories'), { idempotencyKey: key(), categoryId: key(), name: command.name.trim(), expectedRevision: remote.project.revision }); break
      }
      case 'createMaterial': await this.createMaterial(command.kind, command.title, command.categoryId, command.scenarioId); break
      case 'saveMaterial': {
        const context = await this.entity(command.entityId)
        const task = await this.designTask(context.remote, context.entity)
        if (command.metadata.entityId !== command.entityId || command.metadata.kind !== context.entity.kind) throw new Error('材料身份不能修改')
        if (!context.entity.frozenBy.length && (JSON.stringify(command.metadata.scenarioIds) !== JSON.stringify(context.entity.scenarioIds) || JSON.stringify(command.metadata.prerequisites) !== JSON.stringify(context.entity.prerequisites))) {
          const fresh = await this.entity(command.entityId)
          await this.api.request('PUT', this.route(context.remote.project.id, `/entities/${context.entity.id}/relations`), { idempotencyKey: key(), token: await this.requireOwned(fresh.entity), scenarioIds: command.metadata.scenarioIds, prerequisites: command.metadata.prerequisites })
        }
        await saveMaterial(task.worktree, command.metadata, command.body); break
      }
      case 'startSession': {
        const { remote, entity } = await this.entity(command.entityId)
        if (command.purpose === 'prototype') {
          const task = await this.prototypeTask(remote, entity)
          sessionId = await this.ports.session(task, prototypeRules)
        } else {
          const task = await this.designTask(remote, entity)
          const draft = await readMaterial(task.worktree, entity.kind, entity.id)
          sessionId = await this.ports.session(task, this.materialRules(draft))
        }
        break
      }
      case 'requestReview': { const snapshot = await this.prepareCandidate(command.entityId, command.purpose); await this.reviews.request(snapshot.review); break }
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
        await this.ports.stopPreview(); this.previewState = undefined; break
      }
      case 'setEligibility': {
        const { remote } = await this.selected()
        await this.api.request('POST', this.route(remote.project.id, `/entities/${command.entityId}/eligibility`), { idempotencyKey: key(), version: command.version, enabled: command.enabled, reason: command.reason }); break
      }
      case 'selectCandidate': await this.selectCandidate(command.candidateId, command.categoryId); break
      case 'adopt': await this.adopt(command); break
      case 'retryOperation': {
        const local = await this.store.read(); const operation = local.operations.find(op => op.id === command.operationId)
        if (operation) await this.resumeOperation(operation)
        else { const adoption = local.adoptions.find(op => op.id === command.operationId); if (!adoption) throw new Error('未找到原操作现场'); await this.resumeAdoption(adoption) }
        break
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
  async state(): Promise<StudioState> {
    const account = await this.ports.account()
    if (!account) {
      if (this.store.scoped) { await this.ports.stopPreview(); await this.projects.dispose() }
      this.store.useUser(); this.previewState = undefined
      return { connected: false, projects: [], availableProjects: [], namespaces: [], projectInitializations: [], drafts: [], tasks: [], candidates: [], reviews: [], pending: [] }
    }
    this.store.useUser(account.id)
    const local = await this.store.read()
    const availableProjects = await this.api.request<ProjectView[]>('GET', '/v1/projects')
    const allowed = new Set(availableProjects.map(project => project.id))
    const projects = local.projects.filter(project => allowed.has(project.id))
    const selected = projects.find(project => project.id === local.selectedProjectId)
    const remote = selected ? await this.api.request<ProjectState>('GET', this.route(selected.id)) : undefined
    if (remote) for (const value of remote.entities) {
      if ('title' in value && value.frozenBy.length && !(value.completedVersion === value.materialVersion && value.materialVersion > 0)
        && remote.entities.some(batch => 'title' in batch && batch.occupation?.ownerId === account.id && batch.occupation.clientId === local.clientId && value.frozenBy.includes(batch.occupation.occupationId))) await this.designTask(remote, value)
    }
    const tasks = local.tasks.filter(task => task.projectId === selected?.id)
    const drafts: MaterialDraft[] = []
    if (remote) for (const entity of remote.entities.filter(entity => entity.kind !== 'baseline')) {
      const task = tasks.find(task => task.entityId === entity.id && (task.purpose === 'material' || task.purpose === 'handoff'))
      if (task) {
        try { drafts.push(await readMaterial(task.worktree, entity.kind, entity.id)) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      } else if ('current' in entity && entity.current) {
        const bytes = await this.projects.readFixed(remote.project.id, entity.current.fixed.commitSha, entity.current.fixed.path)
        if (digest(bytes) !== entity.current.fixed.sha256) throw new Error('固定材料哈希校验失败')
        drafts.push(parseMaterial(Buffer.from(bytes), entity.current.fixed.path))
      }
    }
    return { connected: true, account, projects, availableProjects, namespaces: this.namespaces,
      projectInitializations: local.projectInitializations.filter(op => op.phase !== 'ready').map(op => ({ id: op.id, name: op.name, phase: op.phase, ...(op.projectId ? { projectId: op.projectId } : {}), ...(op.message ? { message: op.message } : {}) })),
      ...(selected ? { selectedProjectId: selected.id } : {}), ...(remote ? { project: remote.project, collaboration: remote } : {}), drafts, tasks, reviews: await this.reviews.views(selected?.id),
      candidates: local.candidates.filter(candidate => candidate.projectId === selected?.id && (candidate.selectedEntityId || (remote && this.currentCandidate(candidate, remote)))), ...(this.previewState ? { preview: this.previewState } : {}),
      pending: [...local.operations, ...local.adoptions.filter(op => op.phase !== 'succeeded')].filter(op => op.projectId === selected?.id).map(op => ({ id: op.id, entityId: op.entityId, phase: op.phase, ...(op.message ? { message: op.message } : {}) })) }
  }
  private async requireAccount() { const account = await this.ports.account(); if (!account) { this.store.useUser(); throw new CollaborationError('LOGIN_REQUIRED', '请先登录协同工作台。', 401) }; this.store.useUser(account.id); return account }
  private route(projectId: string, suffix = '') { return `/v1/projects/${encodeURIComponent(projectId)}${suffix}` }
  private async selected() {
    const state = await this.store.read(); const project = state.projects.find(p => p.id === state.selectedProjectId)
    if (!project) throw new Error('请先选择项目')
    const remote = await this.api.request<ProjectState>('GET', this.route(project.id))
    if (remote.project.initializationStatus !== 'ready' || !remote.project.recognizedHead) throw new Error('项目尚未完成初始化，请先恢复首次提交。')
    return { project, remote }
  }
  private async entity(entityId: string) { const context = await this.selected(); const entity = context.remote.entities.find(e => e.id === entityId); if (!entity || !('title' in entity)) throw new Error('资产不存在或不可见'); return { ...context, entity } }
  private async requireOwned(entity: EntityView): Promise<OccupationToken> {
    const account = await this.ports.account(); const state = await this.store.read(); const token = entity.occupation
    if (!token || token.ownerId !== account?.id || token.clientId !== state.clientId) throw new Error('此任务需要本人当前客户端的有效占用')
    const { occupationId, generation, taskId, clientId, expectedRevision } = token
    return { occupationId, generation, taskId, clientId, expectedRevision }
  }
  private async identity() {
    const account = await this.requireAccount()
    if (account.gitlabEmail) return { name: account.name || account.gitlabUsername, email: account.gitlabEmail }
    const { project } = await this.selected(); return this.ports.git.identity(project.directory)
  }
  private async createMaterial(kind: 'scenario' | 'requirement' | 'handoff', title: string, categoryId: string, scenarioId?: string): Promise<EntityView> {
    const { remote } = await this.selected()
    let entity = await this.api.request<EntityView>('POST', this.route(remote.project.id, '/entities'), { idempotencyKey: key(), kind, title, categoryId })
    const task = await this.designTask(remote, entity)
    if (scenarioId) {
      const fresh = await this.entity(entity.id); entity = fresh.entity
      await this.api.request('PUT', this.route(remote.project.id, `/entities/${entity.id}/relations`), { idempotencyKey: key(), token: await this.requireOwned(entity), scenarioIds: [scenarioId], prerequisites: [] })
    }
    await saveMaterial(task.worktree, initialMetadata(entity, scenarioId), starter(title)); return entity
  }
  private async designTask(remote: ProjectState, entity: EntityView): Promise<TaskView> {
    const local = await this.store.read()
    if (entity.frozenBy.length) {
      const batch = remote.entities.find((value): value is EntityView => 'title' in value && value.kind === 'scenario' && !!value.occupation && entity.frozenBy.includes(value.occupation.occupationId))
      if (!batch) throw new Error('关联场景正在修订，请从当前场景批次编辑需求')
      await this.requireOwned(batch)
      if (entity.completedVersion === entity.materialVersion && entity.materialVersion > 0) throw new Error('已完成需求必须保留，请派生新需求')
      const base = await this.designTask(remote, batch)
      let task = local.tasks.find(value => value.projectId === base.projectId && value.entityId === entity.id && value.purpose === 'material' && value.worktree === base.worktree)
      if (!task) { task = { ...base, entityId: entity.id, sessionId: 'studio-' + key(), inputHash: entity.current?.fixed.sha256 ?? '', purpose: 'material' }; local.tasks.push(task); await this.store.save() }
      try { await readMaterial(task.worktree, entity.kind, entity.id) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        if (entity.current) {
          const bytes = await this.projects.readFixed(remote.project.id, entity.current.fixed.commitSha, entity.current.fixed.path)
          if (digest(bytes) !== entity.current.fixed.sha256) throw new Error('批次需求固定材料哈希不一致')
          const draft = parseMaterial(Buffer.from(bytes), entity.current.fixed.path)
          await saveMaterial(task.worktree, draft.metadata, draft.body)
        } else await saveMaterial(task.worktree, { ...initialMetadata(entity), scenarioIds: entity.scenarioIds, prerequisites: entity.prerequisites, businessEvidence: [{ label: '关联场景修订批次', reference: batch.id }] }, starter(entity.title))
      }
      return task
    }
    let current = entity
    if (!current.occupation) current = await this.api.request<EntityView>('POST', this.route(remote.project.id, `/entities/${entity.id}/claim`), { idempotencyKey: key(), expectedRevision: entity.revision, taskId: key(), clientId: local.clientId, purpose: entity.kind === 'scenario' && entity.materialVersion ? 'scenario-batch' : 'design' })
    const token = await this.requireOwned(current)
    const existing = local.tasks.find(t => t.projectId === remote.project.id && t.entityId === entity.id && (t.purpose === 'material' || t.purpose === 'handoff') && path.basename(t.worktree) === token.taskId)
    if (existing) return existing
    const project = local.projects.find(p => p.id === remote.project.id)!
    await this.ports.git.fetch(project.directory, remote.project.stableBranch)
    const worktree = path.join(this.store.directory, 'worktrees', remote.project.id, token.taskId)
    await this.ports.git.createWorktree(project.directory, worktree, `studio/${entity.id}/${token.generation}`, remote.project.recognizedHead!)
    const task: TaskView = { projectId: project.id, entityId: entity.id, sessionId: `studio-${key()}`, purpose: entity.kind === 'handoff' ? 'handoff' : 'material', inputHash: entity.current?.fixed.sha256 ?? '', worktree }
    local.tasks = local.tasks.filter(t => !(t.projectId === project.id && t.entityId === entity.id && t.purpose === task.purpose)); local.tasks.push(task); await this.store.save(); return task
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
    await this.ports.git.fetch(project.directory, remote.project.stableBranch)
    const worktree = path.join(this.store.directory, 'worktrees', project.id, token.taskId)
    await this.ports.git.createWorktree(project.directory, worktree, `studio/${entity.id}/prototype-${token.generation}`, remote.project.recognizedHead!)
    const task: TaskView = { projectId: project.id, entityId: entity.id, sessionId: `studio-${key()}`, purpose: 'prototype', inputHash: entity.current!.fixed.sha256, worktree }
    local.tasks = local.tasks.filter(t => !(t.projectId === project.id && t.entityId === entity.id && t.purpose === 'prototype')); local.tasks.push(task); await this.store.save(); return task
  }
  private materialRules(draft: MaterialDraft): string {
    return `你正在整理 ${draft.metadata.kind} ${draft.entityId}。仅编辑 ${draft.path}；保留 eadp-metadata 身份。实际业务依据、核心业务规则、验收条件缺失时提出问题，不编造；核心待澄清项阻断确认，非阻断项明确限制和不适用范围。不得自行确认、释放占用、修改Git/模板规则或执行shell。作者通过工作台确认。当前材料哈希 ${draft.sha256}。`
  }
  private materialEvidence(candidateSha: string, draft: MaterialDraft): CheckEvidence {
    checkMaterial(draft)
    return { candidateSha, passed: true, checks: ['materials', 'relations'].map(name => ({ name, passed: true, evidenceHash: digest(`${name}:${draft.sha256}`) })) }
  }
  private async candidateSha(task: TaskView, expectedHead: string, allowed: (file: string) => boolean, files: string[], message: string): Promise<{ sha: string; changed: string[] }> {
    const entries = (await this.ports.gitLocal(['status', '--porcelain=v1', '-z', '--untracked-files=all'], task.worktree)).split('\0').filter(Boolean)
    const dirty: string[] = []
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]!, name = entry.slice(3); dirty.push(name)
      if (/[RC]/.test(entry.slice(0, 2))) { const source = entries[++index]; if (!source) throw new Error('Git 变更列表不完整'); dirty.push(source) }
    }
    if (dirty.some(file => !allowed(file))) throw new Error('存在本任务允许范围外的变更，请先处理后再固定候选')
    const sha = dirty.length ? await this.ports.git.commitFiles(task.worktree, files.length ? files : dirty, message, await this.identity()) : (await this.ports.git.state(task.worktree)).head
    const changed = await this.ports.git.changedFiles(task.worktree, expectedHead, sha)
    if (!changed.length || changed.some(file => !allowed(file))) throw new Error('候选相对当前项目基线没有有效变化或包含本任务范围外提交')
    return { sha, changed }
  }
  private async prepareCandidate(entityId: string, purpose: 'material' | 'prototype', expectedHash?: string) {
    let context = await this.entity(entityId)
    if (context.entity.frozenBy.length) throw new Error('冻结需求须由当前场景批次统一确认')
    const task = purpose === 'prototype' ? await this.prototypeTask(context.remote, context.entity) : await this.designTask(context.remote, context.entity)
    context = await this.entity(entityId)
    const { remote, entity } = context, token = await this.requireOwned(entity)
    const draft = await readMaterial(task.worktree, entity.kind, entity.id)
    if (expectedHash && draft.sha256 !== expectedHash) throw new Error('材料已变化，请阅读并确认新版本')
    let candidateSha: string, paths: string[], checks: CheckEvidence
    const confirmations: Array<Pick<ConfirmationInput, 'entityId' | 'expectedRevision' | 'fixed' | 'metadata'>> = []
    const prepareBase = { idempotencyKey: key(), entityId: entity.id, token, expectedHead: remote.project.recognizedHead! }
    let batch: { expectedAssociationRevision: number; batchRequirementIds: string[] } | undefined
    if (purpose === 'material') {
      checkMaterial(draft)
      const frozen = entity.kind === 'scenario' && entity.materialVersion > 0 ? remote.entities.filter((value): value is EntityView => 'title' in value && value.frozenBy.includes(token.occupationId)) : []
      const drafts = [{ entity, draft }]
      for (const requirement of frozen) {
        if (requirement.completedVersion === requirement.materialVersion && requirement.materialVersion > 0) continue
        const related = await readMaterial(task.worktree, 'requirement', requirement.id); checkMaterial(related); drafts.push({ entity: requirement, draft: related })
      }
      paths = drafts.map(value => value.draft.path)
      candidateSha = (await this.candidateSha(task, prepareBase.expectedHead, file => paths.includes(file), paths, '固定材料 ' + entity.id)).sha
      for (const value of drafts) { await this.ports.git.verifyFile(task.worktree, candidateSha, value.draft.path); confirmations.push({ entityId: value.entity.id, expectedRevision: value.entity.revision, fixed: { commitSha: candidateSha, path: value.draft.path, sha256: value.draft.sha256 }, metadata: value.draft.metadata }) }
      checks = { candidateSha, passed: true, checks: drafts.flatMap(value => this.materialEvidence(candidateSha, value.draft).checks) }
      if (entity.kind === 'scenario' && entity.materialVersion > 0) batch = { expectedAssociationRevision: entity.associationRevision, batchRequirementIds: frozen.map(value => value.id) }
    } else {
      if (entity.kind !== 'requirement' || !entity.current || task.inputHash !== entity.current.fixed.sha256 || draft.sha256 !== entity.current.fixed.sha256) throw new Error('原型输入已失效，请重新确认需求')
      const candidate = await this.candidateSha(task, prepareBase.expectedHead, file => file.startsWith('原型代码/'), [], '固定原型 ' + entity.id)
      candidateSha = candidate.sha; paths = candidate.changed; checks = await this.ports.checks(task, candidateSha)
      confirmations.push({ entityId: entity.id, expectedRevision: entity.revision, fixed: entity.current.fixed, metadata: entity.current.metadata })
    }
    const prepare = { ...prepareBase, stage: purpose === 'prototype' ? 'prototype' as const : batch ? 'scenario-batch' as const : 'material' as const, sourceSha: candidateSha, candidateSha, allowedPaths: paths, checks, ...batch }
    const inputHash = digest(reviewInputText({ ...prepare, confirmations }, entity))
    const review: ReviewCandidate = { projectId: remote.project.id, entityId: entity.id, purpose, candidateSha, inputHash, paths, checks, task }
    return { task, draft, prepare, confirmations, review }
  }
  private async confirmMaterial(entityId: string, expectedHash: string, choice: ConfirmationChoice) {
    const snapshot = await this.prepareCandidate(entityId, 'material', expectedHash)
    const authority = await this.reviews.confirmation(choice, snapshot.review)
    await this.integrate(snapshot.task, snapshot.draft, { ...snapshot.prepare, confirmations: snapshot.confirmations.map(value => ({ ...value, ...authority, authorConfirmed: true as const })) })
  }
  private async confirmPrototype(entityId: string, choice: ConfirmationChoice) {
    const snapshot = await this.prepareCandidate(entityId, 'prototype')
    const authority = await this.reviews.confirmation(choice, snapshot.review)
    await this.integrate(snapshot.task, snapshot.draft, { ...snapshot.prepare, confirmations: snapshot.confirmations.map(value => ({ ...value, ...authority, authorConfirmed: true as const })) })
  }
  private async integrate(task: TaskView, draft: MaterialDraft, prepare: PrepareIntegrationRequest) {
    const local = await this.store.read()
    const operation: PendingOperation = { id: prepare.idempotencyKey, projectId: task.projectId, entityId: task.entityId, phase: 'fixed', candidateSha: prepare.candidateSha, expectedHead: prepare.expectedHead, fixedPath: draft.path, sha256: draft.sha256, prepare, token: prepare.token, adoptionIds: local.adoptions.filter(value => value.projectId === task.projectId && value.entityId === task.entityId && value.worktree === task.worktree && value.applied && draft.metadata.sources.some(source => sameSource(source, value.request.source))).map(value => value.id) }
    local.operations.push(operation); await this.store.save()
    await this.ports.git.push(task.worktree, operation.candidateSha, `studio-fixed/${operation.id}`)
    await this.resumeOperation(operation)
  }
  private async resumeOperation(operation: PendingOperation) {
    const local = await this.store.read(); const project = local.projects.find(p => p.id === operation.projectId)
    const task = local.tasks.find(t => t.projectId === operation.projectId && t.entityId === operation.entityId && t.worktree)
    if (!project || !task) throw new Error('原操作所需项目/任务现场缺失，已停止恢复')
    try {
      if (!operation.integrationId) {
        let result: IntegrationView
        try { result = (await this.api.request<{ result: IntegrationView }>('GET', this.route(project.id, `/operations/${operation.id}`))).result }
        catch (error) { if (!(error instanceof CollaborationError) || error.code !== 'OPERATION_NOT_FOUND') throw error; result = await this.api.request<IntegrationView>('POST', this.route(project.id, '/integrations'), operation.prepare) }
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
      const remote = await this.api.request<ProjectState>('GET', this.route(project.id)); const entity = remote.entities.find(e => e.id === operation.entityId)
      for (const adoptionId of operation.adoptionIds ?? []) {
        const adoption = local.adoptions.find(value => value.id === adoptionId)
        if (!adoption) throw new Error('采用恢复记录缺失，不能申报复用成功')
        const confirmations = (operation.prepare as PrepareIntegrationRequest).confirmations
        const index = confirmations.findIndex(value => value.entityId === adoption.entityId)
        const confirmationId = integration.confirmationIds?.[index]
        if (index < 0 || !confirmationId || !confirmations[index]!.metadata.sources.some(source => sameSource(source, adoption.request.source))) throw new Error('本次接受结果未包含精确采用来源')
        adoption.success ??= { idempotencyKey: adoption.id + '-success-' + confirmationId, targetConfirmationId: confirmationId }
        await this.store.save(); await this.resumeAdoption(adoption)
      }
      if (entity && 'current' in entity && entity.kind === 'scenario' && entity.current && integration.confirmationIds?.includes(entity.current.confirmationId)) await this.splitScenario(remote, entity, integration.id)
      if (integration.baselineId) await this.generateHandoff(integration.baselineId).catch(async error => { operation.message = `基线已完成，交接清单生成待重试：${error instanceof Error ? error.message : '未知'}`; await this.store.save() })
      if (entity && 'current' in entity && entity.kind === 'requirement' && integration.stage === 'material') {
        try { const next = await this.prototypeTask(remote, entity); await this.ports.session(next, '根据当前已确认需求与前置完成依据，按模板规则实现原型；冲突先请求修订。'); await this.ports.prompt(next.sessionId, `开始实现已确认需求 ${entity.id}，输入哈希 ${entity.current!.fixed.sha256}。`) }
        catch (error) { task.error = error instanceof Error ? `材料已确认，原型等待：${error.message}` : '原型等待条件'; await this.store.save() }
      }
    } catch (error) { if (operation.phase !== 'accepted') operation.phase = 'unknown'; operation.message = error instanceof Error ? error.message : '原操作结果未知'; await this.store.save(); throw error }
  }
  private async splitScenario(remote: ProjectState, entity: EntityView, integrationId: string) {
    const local = await this.store.read(), input = entity.current!
    let task = local.tasks.find(t => t.projectId === remote.project.id && t.entityId === entity.id && t.purpose === 'split' && t.split?.integrationId === integrationId)
    if (!task) {
      const base = local.tasks.find(t => t.entityId === entity.id && t.projectId === remote.project.id && t.purpose === 'material')
      if (!base) throw new Error('场景拆分所需的材料任务现场缺失')
      task = { projectId: base.projectId, entityId: base.entityId, worktree: base.worktree, sessionId: `studio-${key()}`, purpose: 'split', inputHash: input.fixed.sha256,
        split: { integrationId, confirmationId: input.confirmationId, version: input.version, fixed: { ...input.fixed }, status: 'pending' } }
      local.tasks.push(task); await this.store.save()
    }
    const split = task.split!
    if (split.confirmationId !== input.confirmationId || task.inputHash !== input.fixed.sha256 || split.version !== input.version) throw new Error('拆分任务已绑定其他确认版本，不能替换其输入')
    if (split.status === 'completed') return
    const rules = '仅从工作台提供的固定已确认场景生成需求候选。不要预留正式ID或认领；每项给出title与summary。不要读取未确认草稿或修改项目文件。'
    if (split.status === 'sent') { await this.ports.session(task, rules); return }
    try {
      // Read accepted Git bytes, never a subsequently edited material worktree.
      const bytes = await this.projects.readFixed(task.projectId, split.fixed.commitSha, split.fixed.path)
      if (digest(bytes) !== task.inputHash) throw new Error('场景拆分固定输入哈希校验失败')
      await this.ports.session(task, rules)
      await this.ports.prompt(task.sessionId, `场景 ${entity.id} 第 ${split.version} 版已确认，确认记录 ${split.confirmationId}，输入哈希 ${task.inputHash}。仅根据以下固定材料拆分需求候选，在会话最后输出唯一代码块 \`\`\`eadp-candidates，内容为JSON数组 [{"title":"…","summary":"…"}]。不要修改项目文件。\n\n${Buffer.from(bytes).toString('utf8')}`)
      split.status = 'sent'; delete task.error; await this.store.save()
    } catch (error) {
      split.status = 'failed'; task.error = error instanceof Error ? error.message : '场景拆分请求未完成'; await this.store.save(); throw error
    }
  }
  acceptSessionOutput(sessionId: string, output: SessionOutput): Promise<void> {
    const result = this.queue.then(async () => { if (this.store.scoped && !await this.reviews.accept(sessionId, output) && output.kind === 'assistant') await this.acceptCandidateContent(sessionId, output.content) })
    this.queue = result.catch(() => undefined); return result
  }
  private async acceptCandidateContent(sessionId: string, content: string): Promise<void> {
    const local = await this.store.read(); const task = local.tasks.find(t => t.sessionId === sessionId && t.purpose === 'split')
    if (!task?.split || task.split.status === 'completed') return
    const remote = await this.api.request<ProjectState>('GET', this.route(task.projectId))
    const found = remote.entities.find(entity => entity.id === task.entityId)
    const current = found && 'current' in found ? found.current : undefined
    if (!current || current.confirmationId !== task.split.confirmationId || current.version !== task.split.version || current.fixed.sha256 !== task.inputHash) return
    const match = /```eadp-candidates\s*\n([\s\S]*?)\n```/.exec(content)
    if (!match) return
    const values: unknown = JSON.parse(match[1]!)
    if (!Array.isArray(values) || values.length > 50 || values.some(v => !v || typeof v.title !== 'string' || !v.title.trim() || v.title.length > 150 || typeof v.summary !== 'string' || v.summary.length > 2000)) throw new Error('需求候选格式无效')
    const split = task.split
    local.candidates.push(...values.map(v => ({ id: key(), projectId: task.projectId, scenarioId: task.entityId, sessionId: task.sessionId, integrationId: split.integrationId, confirmationId: split.confirmationId, version: split.version, inputHash: task.inputHash, title: v.title, summary: v.summary }) as Candidate))
    split.status = 'completed'; delete task.error; await this.store.save()
  }
  private currentCandidate(candidate: Candidate, remote: ProjectState): boolean {
    const found = remote.entities.find(entity => entity.id === candidate.scenarioId)
    const current = found && 'current' in found ? found.current : undefined
    return candidate.projectId === remote.project.id && current?.confirmationId === candidate.confirmationId && current.version === candidate.version && current.fixed.sha256 === candidate.inputHash
  }
  private async selectCandidate(id: string, categoryId: string) {
    const local = await this.store.read(); const candidate = local.candidates.find(c => c.id === id)
    if (!candidate || candidate.selectedEntityId) throw new Error('候选不存在或已采用')
    const { remote } = await this.selected()
    if (!this.currentCandidate(candidate, remote)) throw new Error('候选来源场景已修订，请采用当前确认版本的候选')
    const entity = await this.createMaterial('requirement', candidate.title, categoryId, candidate.scenarioId)
    candidate.selectedEntityId = entity.id; await this.store.save()
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
          const bytes = await this.projects.readFixed(operation.request.source.projectId, operation.sourceFixed.commitSha, operation.sourceFixed.path)
          if (digest(bytes) !== operation.sourceFixed.sha256) throw new Error('来源固定材料校验失败')
          const draft = parseMaterial(Buffer.from(bytes), operation.sourceFixed.path)
          await saveMaterial(operation.worktree, { ...draft.metadata, entityId: entity.id, kind: entity.kind, title: entity.title, categoryId: entity.categoryId, scenarioIds: entity.scenarioIds, prerequisites: entity.prerequisites, sources: [operation.request.source], coreRulesPresent: false, acceptanceCriteriaPresent: false }, draft.body + '\n\n## 目标采用调整\n\n' + operation.request.adjustmentSummary + '\n')
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
    const existing = remote.entities.find((e): e is EntityView => 'title' in e && e.kind === 'handoff' && e.title === `交接 ${baseline.id}`)
    const source = remote.entities.find((value): value is EntityView => 'title' in value && value.id === baseline.entityId)
    if (!source) throw new Error('基线需求不可见')
    const entity = existing ?? await this.api.request<EntityView>('POST', this.route(remote.project.id, '/entities'), { idempotencyKey: key(), kind: 'handoff', title: '交接 ' + baseline.id, categoryId: source.categoryId })
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
        const metadata = { ...initialMetadata(entity), referencedAssets: [{ projectId: remote.project.id, entityId: source.id, version: baseline.version }], businessEvidence: [{ label: '已接受原型基线', reference: baseline.id }] }
        draft = await saveMaterial(task.worktree, metadata, '# ' + entity.title + '\n\n## 固定资料\n\n需求 ' + source.id + '，材料版本 ' + baseline.version + '，代码 ' + baseline.commitSha + '。\n\n## 核心业务规则\n\n待根据固定需求整理。\n\n## 验收条件\n\n待根据固定需求整理。\n\n## 交付内容、限制与待澄清\n\n请结合固定材料补充。\n')
      }
      await this.ports.session(task, this.materialRules(draft))
      await this.ports.prompt(task.sessionId, '基于已接受基线 ' + baseline.id + '（代码 ' + baseline.commitSha + '）读取固定需求，整理可阅读交接清单 ' + materialPath('handoff', entity.id) + '：业务范围、规则、字段、异常、验收、依赖、来源、限制和不适用范围。不能编造缺失内容，不要自行确认。')
      handoff.status = 'sent'; delete task.error; await this.store.save()
    } catch (error) { handoff.status = 'failed'; task.error = error instanceof Error ? error.message : '交接清单请求未完成'; await this.store.save(); throw error }
  }
}
