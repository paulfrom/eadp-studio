import { randomUUID, createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WorkspaceLocation } from './workspace-location.ts'
import { isProjectManifest, type ProjectState, type ProjectView } from '@eadp/contracts'
import { generalScenarioDocument } from '@eadp/asset-domain'
import { defaultRequirementTemplate, defaultRequirementTemplateBody, defaultScenarioTemplate, defaultScenarioTemplateBody } from './default-material-templates.ts'
import type { StudioCommand, LocalProject, ProjectSync, ProjectProgressPhase } from '../../shared/studio.ts'
import type { CollaborationClient } from '../adapters/collaboration/client.ts'
import type { HostPorts } from './ports.ts'
import type { BackgroundLane } from './background-lane.ts'
import { clonePercent, pushPercent, type ProjectProgressTracker } from './progress.ts'
import { StudioStore, type ProjectInitialization } from './state.ts'

const exists = async (target: string) => stat(target).then(() => true, error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return false })
const expectedManifest = (project: ProjectView) => ({ schemaVersion: 1, projectId: project.id, gitlabProjectId: project.gitlabProjectId, repositoryUrl: project.repositoryUrl, stableBranch: project.stableBranch, directories: ['场景', '需求', '交接', '原型代码'], scenarioTemplates: { defaultTemplateId: defaultScenarioTemplate.id, templates: [defaultScenarioTemplate] }, requirementTemplates: { defaultTemplateId: defaultRequirementTemplate.id, templates: [defaultRequirementTemplate] } })
async function writeInitialFile(target: string, value: string): Promise<void> {
  try { await writeFile(target, value, { flag: 'wx' }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; if ((await lstat(target)).isSymbolicLink() || await readFile(target, 'utf8') !== value) throw new Error('初始化文件已被修改，请保留并核对原现场。') }
}

/** Backend owns repository provisioning. This service owns only attributable local Git workspaces. */
export class ProjectWorkspaces {
  readonly location: WorkspaceLocation
  private readonly caches = new Map<string, string>()
  private readonly fixedBytes = new Map<string, Uint8Array>()
  constructor(private readonly store: StudioStore, private readonly api: CollaborationClient, private readonly ports: HostPorts, private readonly lane: BackgroundLane, private readonly progress: ProjectProgressTracker) {
    this.location = new WorkspaceLocation(store.rootDirectory, [store.rootDirectory, fileURLToPath(new URL('../../../', import.meta.url))], ports.workspaceRoot)
  }
  async create(command: Extract<StudioCommand, { action: 'createProject' }>): Promise<void> {
    if (!command.name.trim() || command.name.length > 200 || !Number.isSafeInteger(command.namespaceId) || command.namespaceId <= 0 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(command.path) || command.path.length > 100) throw new Error('请填写项目名称、群组和有效的仓库路径。')
    const local = await this.store.read()
    // A ready record already produced a project, so a new request for the same path
    // is a new creation the backend must judge, never a replay of the finished one.
    const previous = local.projectInitializations.find(op => op.namespaceId === command.namespaceId && op.path === command.path && op.phase !== 'ready')
    if (previous) { if (previous.name !== command.name.trim() || command.workspaceDirectory && path.resolve(command.workspaceDirectory) !== previous.workspaceDirectory) throw new Error('此仓库路径已有创建记录，请从待处理记录恢复。'); this.start(previous); return }
    const operationId = randomUUID()
    const operation: ProjectInitialization = { id: operationId, name: command.name.trim(), namespaceId: command.namespaceId, path: command.path, phase: 'creating', workspaceDirectory: await this.location.project(operationId, command.path, command.workspaceDirectory) }
    local.projectInitializations.push(operation); await this.store.save()
    this.start(operation)
  }
  /**
   * Open one project the backend registered. A project this machine already
   * holds is opened from the local checkout; anything else is acquired on the
   * background lane, which reports its progress until the record reaches `ready`.
   */
  async open(projectId: string, workspaceDirectory?: string): Promise<void> {
    const project = await this.project(projectId), local = await this.store.read()
    const existing = local.projects.find(p => p.id === project.id)
    if (existing && workspaceDirectory && path.resolve(workspaceDirectory) !== existing.workspaceDirectory) throw new Error('已登记项目沿用原项目文件夹，不能通过重新打开移动现场。')
    // A pending project has no accepted version yet, so only the local checkout of an
    // accepted one can be opened as it is.
    if (project.initializationStatus === 'ready' && existing && await this.holdsCheckout(existing, project)) {
      await this.verify(existing.directory, project); local.selectedProjectId = project.id; await this.store.save(); return
    }
    // A finished record cannot be replayed: the lane remembers it as completed, so a
    // checkout that has to be acquired again gets its own operation and key.
    let operation = local.projectInitializations.find(op => op.projectId === project.id && op.phase !== 'ready')
    if (!operation) {
      // `path` only matters to the creation request that started a pending record.
      const pending = project.initializationStatus === 'pending'
      operation = { id: randomUUID(), name: project.name, namespaceId: project.namespaceId, path: pending ? project.repositoryUrl.split('/').at(-1)!.replace(/\.git$/, '') : '', projectId: project.id, phase: 'initializing', workspaceDirectory: existing?.workspaceDirectory ?? await this.location.project(project.id, project.repositoryUrl, workspaceDirectory) }
      local.projectInitializations.push(operation); await this.store.save()
    }
    this.start(operation)
  }
  /** Retry a recorded initialization on the Git lane; the reply reports the record, not the download. */
  async retry(operationId: string): Promise<void> {
    const local = await this.store.read()
    const operation = local.projectInitializations.find(op => op.id === operationId)
    if (!operation) throw new Error('未找到当前用户的项目创建记录。')
    this.start(operation)
  }
  /** Queue one initialization and publish its progress. Every clone, fetch and push it performs runs on that lane, never in a reply. */
  private start(operation: ProjectInitialization): void {
    this.progress.begin(operation.id, operation.name)
    this.lane.schedule(`project-init:${operation.id}`, () => this.resume(operation.id))
  }
  /**
   * Require a commit to exist locally before a worktree starts from it. A
   * missing commit is fetched on the background lane and the caller reports
   * that the action must be retried, so no reply waits for the remote.
   * @param project - local project holding the repository.
   * @param branch - stable branch the commit belongs to.
   * @param commit - commit the new worktree must start from.
   */
  async requireCommit(project: Pick<LocalProject, 'id' | 'directory'>, branch: string, commit: string): Promise<void> {
    if (await this.ports.git.hasCommit(project.directory, commit)) return
    this.lane.schedule(`sync:${project.id}:${commit}`, async () => {
      await this.ports.git.fetch(project.directory, branch)
      if (!await this.ports.git.hasCommit(project.directory, commit)) throw new Error('远端未提供当前项目基线提交。')
    })
    throw new Error('项目仓库正在后台同步，请稍后重试当前操作。')
  }
  /**
   * Drive one recorded initialization to a verdict. Runs on the Git lane: the
   * Git calls below stay direct so the lane is not asked to wait for itself.
   * Every step reports to the progress record, so the surfaces show where the
   * operation is without the reply waiting for the transfer.
   */
  private async resume(operationId: string): Promise<void> {
    const local = await this.store.read(), operation = local.projectInitializations.find(op => op.id === operationId)
    if (!operation) throw new Error('未找到当前用户的项目创建记录。')
    const report = (phase: ProjectProgressPhase, percent: number, label: string): void => this.progress.report(operationId, phase, percent, label)
    try {
      let project: ProjectView
      if (!operation.projectId) {
        report('matching', 2, '后台正在登记项目仓库')
        // Exactly the original body and key survive a lost response or desktop restart.
        project = await this.api.request<ProjectView>('POST', '/v1/projects', { idempotencyKey: operation.id, name: operation.name, namespaceId: operation.namespaceId, path: operation.path }, 180_000)
        operation.projectId = project.id; operation.phase = 'initializing'; await this.store.save()
      } else project = await this.project(operation.projectId)
      if (project.initializationStatus === 'ready') { await this.openReady(project, operation, report); return }
      const directory = await this.ownedDirectory(project, operation)
      report('initializing', 5, '探测远端首次提交')
      // A prior push can have succeeded with a lost reply, on this or another machine.
      const remoteHead = await this.ports.git.probeRemoteHead(project.repositoryUrl, project.stableBranch, path.dirname(directory))
      const hasGit = await exists(path.join(directory, '.git'))
      if (remoteHead) {
        if (!hasGit) {
          if ((await readdir(directory)).length) throw new Error('远端已有提交，本地保留了未完成文件；请核对原现场后恢复。')
          report('cloning', 10, '从 GitLab 获取项目仓库')
          await this.ports.git.clone(project.repositoryUrl, directory, undefined, progress => report('cloning', clonePercent(progress), '从 GitLab 获取项目仓库'))
        } else {
          await this.ports.git.fetchCommit(directory, remoteHead)
          const localHead = await this.ports.git.head(directory)
          if (localHead !== remoteHead) throw new Error('远端已有首次提交，本地提交尚不一致；原文件已保留，请核对现场。')
        }
        if (operation.commitSha && operation.commitSha !== remoteHead) throw new Error('远端已存在其他提交，未覆盖原初始化现场。')
        report('verifying', 85, '校验项目清单')
        await this.verifyFixedManifest(directory, project, remoteHead)
        operation.commitSha = remoteHead
      } else {
        if (!hasGit) await this.ports.git.init(directory, project.repositoryUrl, project.stableBranch)
        const stateHead = await this.ports.git.head(directory)
        if (operation.commitSha && stateHead !== operation.commitSha) throw new Error('初始化提交已变化，请核对保留的本地现场。')
        if (!operation.commitSha && stateHead) {
          await this.verifyFixedManifest(directory, project, stateHead)
          operation.commitSha = stateHead
        }
        if (!operation.commitSha) {
          report('initializing', 30, '写入项目目录与默认模板')
          await this.initializeFiles(directory, project)
          const files = (await this.ports.gitLocal(['ls-files', '--others', '--exclude-standard', '-z'], directory)).split('\0').filter(Boolean)
          report('initializing', 40, '提交初始化文件')
          operation.commitSha = await this.ports.git.commitFiles(directory, files, '初始化项目资产与指定原型模板', await this.identity(directory))
        }
        operation.phase = 'pushing'; await this.store.save()
        report('pushing', 45, '推送首次提交')
        // Regular push never bypasses GitLab repository or protected-branch permissions.
        await this.ports.git.push(directory, operation.commitSha, project.stableBranch, progress => report('pushing', pushPercent(progress), '推送首次提交'))
      }
      operation.phase = 'verifying'; await this.store.save()
      report('verifying', 90, '等待后台接受初始化')
      project = await this.api.request<ProjectView>('POST', `/v1/projects/${encodeURIComponent(project.id)}/initialize`, { idempotencyKey: `${operation.id}-initialize`, commitSha: operation.commitSha }, 180_000)
      if (project.initializationStatus !== 'ready' || project.recognizedHead !== operation.commitSha) throw new Error('后台尚未接受首次提交，请保留现场并重新核对。')
      report('binding', 96, '登记本地项目')
      await this.bind(project, operation)
    } catch (error) {
      const message = error instanceof Error ? error.message : '项目初始化结果未知'
      operation.phase = 'unknown'; operation.message = message; await this.store.save()
      this.progress.fail(operationId, message)
      throw error
    }
  }
  /** Read an accepted fixed material that is already local; the sync lane brings missing objects. */
  async readFixed(projectId: string, commitSha: string, relativePath: string, expectedHash?: string): Promise<Uint8Array> {
    const bytes = await this.localFixed(await this.project(projectId), commitSha, relativePath, expectedHash)
    if (bytes) return bytes
    throw new Error('固定材料正在后台同步，请稍后重试。')
  }
  /**
   * Read a fixed material from what is already local and queue the
   * synchronization it still needs. Returning undefined keeps the render path
   * free of the network: the next read sees the object the lane fetched.
   * @param project - project already authorized by this operation or projection.
   * @param commitSha - accepted fixed commit.
   * @param relativePath - repository-relative file path inside the commit.
   * @param expectedHash - sha256 the bytes must match before they are cached.
   * @returns the bytes, or undefined while the mirror or commit is synchronizing.
   */
  async localFixed(project: ProjectView, commitSha: string, relativePath: string, expectedHash?: string): Promise<Uint8Array | undefined> {
    const cacheKey = `${this.store.directory}:${project.id}:${project.repositoryUrl}:${commitSha}:${relativePath}`
    const cached = this.fixedBytes.get(cacheKey)
    if (cached && expectedHash && createHash('sha256').update(cached).digest('hex') === expectedHash) return new Uint8Array(cached)
    if (project.initializationStatus !== 'ready') throw new Error('项目尚未完成初始化。')
    const local = await this.store.read(), opened = local.projects.find(p => p.id === project.id)
    if (opened && opened.repositoryUrl !== project.repositoryUrl) throw new Error('本地项目与后台仓库身份不一致。')
    const directory = opened?.directory ?? this.caches.get(`${this.store.directory}:${project.id}`)
    if (!directory) { this.lane.schedule(`mirror:${project.id}`, () => this.mirror(project.id, project.repositoryUrl)); return undefined }
    if (!await this.ports.git.hasCommit(directory, commitSha)) { this.lane.schedule(`commit:${directory}:${commitSha}`, () => this.ports.git.fetchCommit(directory, commitSha)); return undefined }
    const bytes = new Uint8Array(await this.ports.git.readBlob(directory, commitSha, relativePath))
    if (expectedHash && createHash('sha256').update(bytes).digest('hex') !== expectedHash) throw new Error('固定材料哈希校验失败')
    if (this.fixedBytes.size >= 128) this.fixedBytes.delete(this.fixedBytes.keys().next().value!)
    if (expectedHash) this.fixedBytes.set(cacheKey, bytes)
    return new Uint8Array(bytes)
  }
  /** Read-only mirror of a project repository for fixed material no local worktree holds yet. */
  private async mirror(projectId: string, repositoryUrl: string): Promise<void> {
    const cacheId = `${this.store.directory}:${projectId}`
    if (this.caches.has(cacheId)) return
    await mkdir(this.store.directory, { recursive: true, mode: 0o700 })
    const directory = await mkdtemp(path.join(this.store.directory, `read-cache-${projectId}-`))
    this.caches.set(cacheId, directory)
    try { await this.ports.git.clone(repositoryUrl, directory) }
    catch (error) { this.caches.delete(cacheId); await rm(directory, { recursive: true, force: true }); throw error }
  }
  /**
   * Fast-forward the main checkout to an accepted head without touching local
   * work. A dirty checkout, another branch or a failed fast-forward is recorded
   * as blocked: the accepted business state is never rolled back and the user's
   * own changes are never stashed, reset, cleaned or overwritten.
   * @param projectId - project whose main checkout is synchronized.
   * @param commit - accepted head the checkout must contain.
   */
  async syncMain(projectId: string, commit: string, expectedAccountId = this.store.accountId): Promise<void> {
    const accountId = this.store.accountId
    if (!accountId || accountId !== expectedAccountId) throw new Error('协同账号已变化，原项目同步待恢复')
    const local = await this.store.read(), project = local.projects.find(p => p.id === projectId)
    if (!project) throw new Error('项目未在本机登记')
    const assertOwner = async (): Promise<void> => {
      if (this.store.accountId !== accountId || await this.store.read() !== local || (await this.ports.account())?.id !== accountId || this.store.accountId !== accountId) throw new Error('协同账号已变化，原项目同步待恢复')
    }
    const record = (status: ProjectSync['status'], detail?: string): void => { project.sync = { status, commit, ...(detail ? { message: detail } : {}) } }
    await assertOwner()
    record('pending'); await this.store.save()
    try {
      const state = await this.ports.git.state(project.directory)
      await assertOwner()
      const stable = (await this.api.request<ProjectState>('GET', `/v1/projects/${encodeURIComponent(projectId)}`)).project.stableBranch
      await assertOwner()
      if (state.branch !== stable) { record('blocked', '主目录不在稳定分支，已记录为已确认待同步'); return }
      if (state.dirty) { record('blocked', '主目录有未提交改动，已记录为已确认待同步'); return }
      if (state.head === commit) { record('synced'); return }
      if (!await this.ports.git.hasCommit(project.directory, commit)) { await assertOwner(); await this.ports.git.fetchCommit(project.directory, commit) }
      await assertOwner()
      await this.ports.git.fastForward(project.directory, commit)
      await assertOwner()
      record('synced')
    } catch (error) {
      if (this.store.accountId === accountId && await this.store.read() === local) record('blocked', `主目录同步未完成：${error instanceof Error ? error.message : '未知原因'}`)
      throw error
    } finally { if (this.store.accountId === accountId && await this.store.read() === local) await this.store.save() }
  }
  async dispose(): Promise<void> { const owned = [...this.caches.values()]; this.caches.clear(); this.fixedBytes.clear(); await Promise.all(owned.map(directory => rm(directory, { recursive: true, force: true }))) }
  private async project(id: string): Promise<ProjectView> { if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(id)) throw new Error('项目身份无效。'); return (await this.api.request<ProjectState>('GET', `/v1/projects/${encodeURIComponent(id)}`)).project }
  private async ownedDirectory(project: ProjectView, operation: ProjectInitialization): Promise<string> {
    const account = await this.ports.account(); if (!account) throw new Error('请先登录协同工作台。')
    if (!operation.workspaceDirectory) throw new Error('项目初始化记录缺少已选定的项目文件夹。')
    const workspace = await this.location.validate(operation.workspaceDirectory)
    const directory = path.join(workspace, 'repo')
    if (operation.directory && operation.directory !== directory) throw new Error('项目初始化目录与当前用户不一致。')
    const marker = path.join(workspace, '.eadp', 'owner.json')
    const metadata = await lstat(path.dirname(marker)).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error })
    if (metadata && (!metadata.isDirectory() || metadata.isSymbolicLink())) throw new Error('项目过程数据目录不能是符号链接或文件。')
    const owner = await readFile(marker, 'utf8').then(value => JSON.parse(value) as { projectId: string; accountId: number }).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error })
    if (owner && (owner.projectId !== project.id || owner.accountId !== account.id)) throw new Error('项目文件夹已属于其他项目或账号，请选择空文件夹。')
    if (!owner) {
      if (await exists(workspace) && (await readdir(workspace)).length) throw new Error('请选择空的项目文件夹，已有文件不会被覆盖。')
      await mkdir(path.dirname(marker), { recursive: true })
      await writeFile(marker, JSON.stringify({ projectId: project.id, accountId: account.id }), { flag: 'wx', mode: 0o600 })
    }
    if (await exists(directory)) {
      if ((await lstat(directory)).isSymbolicLink()) throw new Error('项目目录不能是符号链接，请保留并核对原现场。')
      // The marker names the project the directory belongs to, so a record that no
      // longer holds this operation adopts the directory instead of abandoning it.
      operation.directory = directory; operation.directoryOwned = true; await this.store.save()
    }
    else {
      operation.directory = directory; operation.directoryOwned = false; await this.store.save()
      await mkdir(path.dirname(directory), { recursive: true }); await mkdir(directory)
      // The workspace ownership record survives loss of only its repository directory.
      const previous = await readFile(marker, 'utf8').then(value => JSON.parse(value) as { projectId?: string }).catch(() => undefined)
      if (previous && previous.projectId !== project.id) throw new Error('项目目录归属记录与当前项目不一致，请核对原现场。')
      if (!previous) throw new Error('项目文件夹归属记录缺失。')
      operation.directoryOwned = true; await this.store.save()
    }
    return directory
  }
  private async initializeFiles(directory: string, project: ProjectView): Promise<void> {
    if (!project.generalScenario) throw new Error('后台尚未预留项目通用场景身份，不能初始化项目。')
    for (const name of ['场景', '需求', '交接']) { const target = path.join(directory, name); await mkdir(target, { recursive: true }); if ((await lstat(target)).isSymbolicLink()) throw new Error('初始化目录不能为符号链接。'); await writeInitialFile(path.join(target, '.gitkeep'), '') }
    const templates = path.join(directory, '.template'); await mkdir(templates, { recursive: true }); if ((await lstat(templates)).isSymbolicLink()) throw new Error('模板目录不能为符号链接。')
    await writeInitialFile(path.join(directory, defaultScenarioTemplate.path), defaultScenarioTemplateBody)
    await writeInitialFile(path.join(directory, defaultRequirementTemplate.path), defaultRequirementTemplateBody)
    await writeInitialFile(path.join(directory, '场景/通用场景.md'), generalScenarioDocument(project.generalScenario.entityId))
    const prototype = path.join(directory, '原型代码')
    await this.ports.installTemplate(prototype)
    await writeInitialFile(path.join(directory, '.gitattributes'), '*.md text eol=lf\n*.json text eol=lf\n*.ts text eol=lf\n*.tsx text eol=lf\n')
    await writeInitialFile(path.join(directory, 'project.assets.json'), `${JSON.stringify(expectedManifest(project), null, 2)}\n`)
  }
  private async identity(directory: string) {
    const account = await this.ports.account(); if (!account) throw new Error('请先登录协同工作台。')
    return account.gitlabEmail ? { name: account.name || account.gitlabUsername, email: account.gitlabEmail } : this.ports.git.identity(directory)
  }
  /**
   * Verify a checkout the backend already accepted: its origin is the registered
   * repository, its manifest names this project and an accepted directory layout,
   * and every directory the manifest declares exists.
   */
  private async verify(directory: string, project: ProjectView): Promise<void> {
    const state = await this.ports.git.state(directory)
    if (state.repositoryUrl !== project.repositoryUrl) throw new Error('本地仓库与后台项目地址不一致。')
    const manifest = JSON.parse(await readFile(path.join(directory, 'project.assets.json'), 'utf8')) as unknown
    for (const name of this.checkManifest(manifest, project)) if (!(await stat(path.join(directory, name))).isDirectory()) throw new Error(`项目缺少「${name}」目录，请核对本地现场。`)
  }
  private async verifyFixedManifest(directory: string, project: ProjectView, commitSha: string): Promise<void> { this.checkManifest(JSON.parse((await this.ports.git.readBlob(directory, commitSha, 'project.assets.json')).toString('utf8')), project) }
  /**
   * Check a manifest against the registered project.
   * @returns the business directories the manifest declares, which the caller must find on disk.
   */
  private checkManifest(value: unknown, project: ProjectView): readonly string[] {
    // A manifest outside the current contract is an older project layout; say so
    // instead of reporting a generic invalid manifest.
    if (!isProjectManifest(value)) throw new Error('项目契约版本过旧，不受支持。')
    const actual = value as Record<string, unknown>
    // A valid manifest naming another project means this repository is already that project's.
    if (actual.projectId !== project.id) throw new Error(`该 GitLab 仓库的项目清单属于另一个项目（${String(actual.projectId)}），一个仓库只能对应一个后台项目。`)
    for (const [key, expected] of Object.entries(expectedManifest(project)).filter(([key]) => key !== 'scenarioTemplates' && key !== 'requirementTemplates' && key !== 'directories')) if (JSON.stringify(actual[key]) !== JSON.stringify(expected)) throw new Error('项目清单身份与后台登记不一致。')
    return actual.directories as readonly string[]
  }
  /**
   * Whether the local record still holds the checkout the backend project names.
   * A missing directory, a missing checkout or another project's ownership marker
   * is not a match: the caller acquires the repository again instead of failing.
   */
  private async holdsCheckout(local: LocalProject, project: ProjectView): Promise<boolean> {
    if (local.repositoryUrl !== project.repositoryUrl) throw new Error('本地项目与后台仓库身份不一致。')
    if (!await exists(path.join(local.directory, '.git'))) return false
    const owner = await readFile(path.join(local.workspaceDirectory, '.eadp', 'owner.json'), 'utf8').then(value => JSON.parse(value) as { projectId?: string; accountId?: number }).catch(() => undefined)
    return owner?.projectId === project.id && owner.accountId === this.store.accountId
  }
  /**
   * Move files left in a directory whose checkout is gone, so the clone does not
   * overwrite them and the user can still recover them beside the new checkout.
   */
  private async preserveLeftover(directory: string): Promise<string> {
    const backup = `${directory}.backup-${Date.now()}`
    try { await rename(directory, backup) }
    catch (error) { throw new Error(`本地目录无法移动，请关闭占用该目录的程序后重试：${error instanceof Error ? error.message : '未知原因'}`) }
    await mkdir(directory, { recursive: true })
    return backup
  }
  /** Open a project the backend already accepted: reuse the local checkout or clone it, reporting progress. */
  private async openReady(project: ProjectView, operation: ProjectInitialization, report: (phase: ProjectProgressPhase, percent: number, label: string) => void): Promise<void> {
    const local = await this.store.read(), existing = local.projects.find(p => p.id === project.id)
    if (existing && await this.holdsCheckout(existing, project)) {
      await this.verify(existing.directory, project); local.selectedProjectId = project.id; operation.phase = 'ready'; delete operation.message; await this.store.save()
      this.progress.end(operation.id); return
    }
    report('matching', 2, '正在核对本地项目与后台登记')
    const directory = await this.ownedDirectory(project, operation)
    if (!await exists(path.join(directory, '.git'))) {
      if ((await readdir(directory)).length) {
        // The user may have deleted the checkout and kept files; the clone never
        // overwrites them, so they move beside the directory and stay attributable.
        const backup = await this.preserveLeftover(directory)
        const label = `本地目录缺少 Git 仓库，原文件已移至 ${path.basename(backup)}，正在从 GitLab 恢复`
        report('cloning', 10, label)
        try { await this.ports.git.clone(project.repositoryUrl, directory, undefined, progress => report('cloning', clonePercent(progress), label)) }
        catch (error) { throw new Error(`从 GitLab 恢复失败，原文件保留在 ${backup}：${error instanceof Error ? error.message : '未知原因'}`) }
      } else {
        const label = existing ? '本地项目目录已丢失，正在从 GitLab 恢复' : '从 GitLab 获取项目仓库'
        report('cloning', 10, label)
        await this.ports.git.clone(project.repositoryUrl, directory, undefined, progress => report('cloning', clonePercent(progress), label))
      }
    }
    report('verifying', 85, '校验项目清单')
    await this.verify(directory, project); await this.bind(project, operation)
  }
  private async bind(project: ProjectView, operation: ProjectInitialization): Promise<void> {
    const local = await this.store.read()
    if (!operation.directory || !operation.workspaceDirectory) throw new Error('项目本地目录缺失。')
    const record = local.projects.find(p => p.id === project.id)
    // Reacquiring a checkout replaces the path and the sync verdict the stale record held.
    if (record) { record.name = project.name; record.workspaceDirectory = operation.workspaceDirectory; record.directory = operation.directory; record.repositoryUrl = project.repositoryUrl; delete record.sync }
    else await this.store.registerProject({ id: project.id, name: project.name, workspaceDirectory: operation.workspaceDirectory, directory: operation.directory, repositoryUrl: project.repositoryUrl })
    local.selectedProjectId = project.id; operation.phase = 'ready'; delete operation.message; await this.store.save()
    this.progress.end(operation.id)
  }
}
