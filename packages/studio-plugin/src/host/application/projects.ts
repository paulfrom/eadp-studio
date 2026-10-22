import { randomUUID, createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isProjectManifest, type ProjectState, type ProjectView } from '@eadp/contracts'
import type { StudioCommand, LocalProject } from '../../shared/studio.ts'
import type { CollaborationClient } from '../adapters/collaboration/client.ts'
import type { HostPorts } from './ports.ts'
import type { BackgroundLane } from './background-lane.ts'
import { StudioStore, type ProjectInitialization } from './state.ts'

const exists = async (target: string) => stat(target).then(() => true, error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return false })
const defaultScenarioTemplate = { id: 'default', name: '默认场景模板', path: '.template/default.md' }
const defaultScenarioTemplateBody = "# 场景名称\n\n## 目标与范围\n\n<!-- 说明业务目标、适用范围及不适用范围，明确本场景为后续细化需求提供的共同业务边界。 -->\n\n## 角色\n\n<!-- 说明参与角色、业务职责及交互关系；保留用户明确提供的约束，不把 AI 推导的实现直接写成既定前提。 -->\n\n## 流程\n\n<!-- 整理触发条件、业务步骤及结果；可以表达分支、退回、重试与循环，并说明相应业务条件。 -->\n\n## 业务规则\n\n<!-- 记录可判断的业务规则与用户明确约束，可用稳定编号及 GIVEN / WHEN / THEN 辅助表达。 -->\n\n## 异常\n\n<!-- 说明异常触发条件、业务影响、处理路径及恢复条件，区分已明确规则与仍待澄清的问题。 -->\n\n## 验收条件\n\n<!-- 描述能够由用户判断的业务结果与验收条件，覆盖主要路径、边界及异常；必要时关联对应业务规则。 -->\n\n## 依据\n\n<!-- 记录用户选定的正式依据及来源；来源、归档相对路径、文件 hash 和引用范围随材料保存，依据文件随同一 Git 提交归档。会话及未选定的临时资料保持本地，不自动成为正式依据。 -->\n\n## 待澄清项\n\n<!-- 列明问题及其影响。使核心规则或验收条件不能判断的问题阻断确认；非阻断项须明确保留限制及不适用范围，不把假设写成已解决结论。 -->\n"
const expectedManifest = (project: ProjectView) => ({ schemaVersion: 1, projectId: project.id, gitlabProjectId: project.gitlabProjectId, repositoryUrl: project.repositoryUrl, stableBranch: project.stableBranch, directories: ['场景', '需求', '交接', '原型代码'], scenarioTemplates: { defaultTemplateId: defaultScenarioTemplate.id, templates: [defaultScenarioTemplate] } })
async function writeInitialFile(target: string, value: string): Promise<void> {
  try { await writeFile(target, value, { flag: 'wx' }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; if ((await lstat(target)).isSymbolicLink() || await readFile(target, 'utf8') !== value) throw new Error('初始化文件已被修改，请保留并核对原现场。') }
}

/** Backend owns repository provisioning. This service owns only attributable local Git workspaces. */
export class ProjectWorkspaces {
  private readonly caches = new Map<string, string>()
  private readonly fixedBytes = new Map<string, Uint8Array>()
  constructor(private readonly store: StudioStore, private readonly api: CollaborationClient, private readonly ports: HostPorts, private readonly lane: BackgroundLane) {}
  async create(command: Extract<StudioCommand, { action: 'createProject' }>): Promise<void> {
    if (!command.name.trim() || command.name.length > 200 || !Number.isSafeInteger(command.namespaceId) || command.namespaceId <= 0 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(command.path) || command.path.length > 100) throw new Error('请填写项目名称、群组和有效的仓库路径。')
    const local = await this.store.read()
    const previous = local.projectInitializations.find(op => op.namespaceId === command.namespaceId && op.path === command.path)
    if (previous) { if (previous.name !== command.name.trim()) throw new Error('此仓库路径已有创建记录，请从待处理记录恢复。'); this.start(previous.id); return }
    const operation: ProjectInitialization = { id: randomUUID(), name: command.name.trim(), namespaceId: command.namespaceId, path: command.path, phase: 'creating' }
    local.projectInitializations.push(operation); await this.store.save()
    this.start(operation.id)
  }
  async open(projectId: string): Promise<void> {
    const project = await this.project(projectId), local = await this.store.read()
    if (project.initializationStatus === 'pending') {
      let operation = local.projectInitializations.find(op => op.projectId === project.id)
      if (!operation) { operation = { id: randomUUID(), name: project.name, namespaceId: project.namespaceId, path: project.repositoryUrl.split('/').at(-1)!.replace(/\.git$/, ''), projectId: project.id, phase: 'initializing' }; local.projectInitializations.push(operation); await this.store.save() }
      this.start(operation.id); return
    }
    const existing = local.projects.find(p => p.id === project.id)
    if (existing) { await this.verify(existing.directory, project); local.selectedProjectId = project.id; await this.store.save(); return }
    let operation = local.projectInitializations.find(op => op.projectId === project.id)
    if (!operation) { operation = { id: randomUUID(), name: project.name, namespaceId: project.namespaceId, path: '', projectId: project.id, phase: 'initializing' }; local.projectInitializations.push(operation); await this.store.save() }
    this.start(operation.id)
  }
  /** Retry a recorded initialization on the Git lane; the reply reports the record, not the download. */
  async retry(operationId: string): Promise<void> {
    const local = await this.store.read()
    if (!local.projectInitializations.some(op => op.id === operationId)) throw new Error('未找到当前用户的项目创建记录。')
    this.start(operationId)
  }
  /** Queue one initialization. Every clone, fetch and push it performs runs on that lane, never in a reply. */
  private start(operationId: string): void {
    this.lane.schedule(`project-init:${operationId}`, () => this.resume(operationId))
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
   */
  private async resume(operationId: string): Promise<void> {
    const local = await this.store.read(), operation = local.projectInitializations.find(op => op.id === operationId)
    if (!operation) throw new Error('未找到当前用户的项目创建记录。')
    try {
      let project: ProjectView
      if (!operation.projectId) {
        // Exactly the original body and key survive a lost response or desktop restart.
        project = await this.api.request<ProjectView>('POST', '/v1/projects', { idempotencyKey: operation.id, name: operation.name, namespaceId: operation.namespaceId, path: operation.path }, 180_000)
        operation.projectId = project.id; operation.phase = 'initializing'; await this.store.save()
      } else project = await this.project(operation.projectId)
      if (project.initializationStatus === 'ready') { await this.openReady(project, operation); return }
      const directory = await this.ownedDirectory(project, operation)
      // A prior push can have succeeded with a lost reply, on this or another machine.
      const remoteHead = await this.ports.git.probeRemoteHead(project.repositoryUrl, project.stableBranch, path.dirname(directory))
      const hasGit = await exists(path.join(directory, '.git'))
      if (remoteHead) {
        if (!hasGit) {
          if ((await readdir(directory)).length) throw new Error('远端已有提交，本地保留了未完成文件；请核对原现场后恢复。')
          await this.ports.git.clone(project.repositoryUrl, directory)
        } else {
          await this.ports.git.fetchCommit(directory, remoteHead)
          const localHead = await this.ports.git.head(directory)
          if (localHead !== remoteHead) throw new Error('远端已有首次提交，本地提交尚不一致；原文件已保留，请核对现场。')
        }
        if (operation.commitSha && operation.commitSha !== remoteHead) throw new Error('远端已存在其他提交，未覆盖原初始化现场。')
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
          await this.initializeFiles(directory, project)
          const files = (await this.ports.gitLocal(['ls-files', '--others', '--exclude-standard', '-z'], directory)).split('\0').filter(Boolean)
          operation.commitSha = await this.ports.git.commitFiles(directory, files, '初始化项目资产与指定原型模板', await this.identity(directory))
        }
        operation.phase = 'pushing'; await this.store.save()
        // Regular push never bypasses GitLab repository or protected-branch permissions.
        await this.ports.git.push(directory, operation.commitSha, project.stableBranch)
      }
      operation.phase = 'verifying'; await this.store.save()
      project = await this.api.request<ProjectView>('POST', `/v1/projects/${encodeURIComponent(project.id)}/initialize`, { idempotencyKey: `${operation.id}-initialize`, commitSha: operation.commitSha }, 180_000)
      if (project.initializationStatus !== 'ready' || project.recognizedHead !== operation.commitSha) throw new Error('后台尚未接受首次提交，请保留现场并重新核对。')
      await this.bind(project, operation)
    } catch (error) { operation.phase = 'unknown'; operation.message = error instanceof Error ? error.message : '项目初始化结果未知'; await this.store.save(); throw error }
  }
  /** Read an accepted fixed material that is already local; the sync lane brings missing objects. */
  async readFixed(projectId: string, commitSha: string, relativePath: string, expectedHash?: string): Promise<Uint8Array> {
    const bytes = await this.localFixed(projectId, commitSha, relativePath, expectedHash)
    if (bytes) return bytes
    throw new Error('固定材料正在后台同步，请稍后重试。')
  }
  /**
   * Read a fixed material from what is already local and queue the
   * synchronization it still needs. Returning undefined keeps the render path
   * free of the network: the next read sees the object the lane fetched.
   * @param projectId - project holding the fixed commit.
   * @param commitSha - accepted fixed commit.
   * @param relativePath - repository-relative file path inside the commit.
   * @param expectedHash - sha256 the bytes must match before they are cached.
   * @returns the bytes, or undefined while the mirror or commit is synchronizing.
   */
  async localFixed(projectId: string, commitSha: string, relativePath: string, expectedHash?: string): Promise<Uint8Array | undefined> {
    const project = await this.project(projectId)
    const cacheKey = `${this.store.directory}:${projectId}:${commitSha}:${relativePath}`
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
  async dispose(): Promise<void> { const owned = [...this.caches.values()]; this.caches.clear(); this.fixedBytes.clear(); await Promise.all(owned.map(directory => rm(directory, { recursive: true, force: true }))) }
  private async project(id: string): Promise<ProjectView> { if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(id)) throw new Error('项目身份无效。'); return (await this.api.request<ProjectState>('GET', `/v1/projects/${encodeURIComponent(id)}`)).project }
  private async ownedDirectory(project: ProjectView, operation: ProjectInitialization): Promise<string> {
    const account = await this.ports.account(); if (!account) throw new Error('请先登录协同工作台。')
    const directory = path.join(this.ports.workspaceRoot, 'users', String(account.id), `project-${project.id}`)
    if (operation.directory && operation.directory !== directory) throw new Error('项目初始化目录与当前用户不一致。')
    const marker = `${directory}.studio-owner.json`
    if (await exists(directory)) {
      if ((await lstat(directory)).isSymbolicLink()) throw new Error('项目目录不能是符号链接，请保留并核对原现场。')
      // The marker names the project the directory belongs to, so a record that no
      // longer holds this operation adopts the directory instead of abandoning it.
      const owner = await readFile(marker, 'utf8').then(value => JSON.parse(value) as { projectId: string }).catch(() => undefined)
      if (owner?.projectId !== project.id) throw new Error('项目目录缺少本项目的持久归属记录，请保留并核对原现场。')
      operation.directory = directory; operation.directoryOwned = true; await this.store.save()
    }
    else {
      operation.directory = directory; operation.directoryOwned = false; await this.store.save()
      await mkdir(path.dirname(directory), { recursive: true }); await mkdir(directory)
      await writeFile(marker, JSON.stringify({ projectId: project.id }), { flag: 'wx', mode: 0o600 })
      operation.directoryOwned = true; await this.store.save()
    }
    return directory
  }
  private async initializeFiles(directory: string, project: ProjectView): Promise<void> {
    for (const name of ['场景', '需求', '交接']) { const target = path.join(directory, name); await mkdir(target, { recursive: true }); if ((await lstat(target)).isSymbolicLink()) throw new Error('初始化目录不能为符号链接。'); await writeInitialFile(path.join(target, '.gitkeep'), '') }
    const templates = path.join(directory, '.template'); await mkdir(templates, { recursive: true }); if ((await lstat(templates)).isSymbolicLink()) throw new Error('模板目录不能为符号链接。')
    await writeInitialFile(path.join(templates, 'default.md'), defaultScenarioTemplateBody)
    const prototype = path.join(directory, '原型代码')
    await this.ports.installTemplate(prototype)
    await writeInitialFile(path.join(directory, '.gitattributes'), '*.md text eol=lf\n*.json text eol=lf\n*.ts text eol=lf\n*.tsx text eol=lf\n')
    await writeInitialFile(path.join(directory, 'project.assets.json'), `${JSON.stringify(expectedManifest(project), null, 2)}\n`)
  }
  private async identity(directory: string) {
    const account = await this.ports.account(); if (!account) throw new Error('请先登录协同工作台。')
    return account.gitlabEmail ? { name: account.name || account.gitlabUsername, email: account.gitlabEmail } : this.ports.git.identity(directory)
  }
  private async verify(directory: string, project: ProjectView): Promise<void> {
    const state = await this.ports.git.state(directory)
    if (state.repositoryUrl !== project.repositoryUrl) throw new Error('本地仓库与后台项目地址不一致。')
    const manifest = JSON.parse(await readFile(path.join(directory, 'project.assets.json'), 'utf8')) as unknown
    this.checkManifest(manifest, project)
    for (const name of ['场景', '需求', '交接', '原型代码']) if (!(await stat(path.join(directory, name))).isDirectory()) throw new Error('项目不符合工作台目录契约。')
  }
  private async verifyFixedManifest(directory: string, project: ProjectView, commitSha: string): Promise<void> { this.checkManifest(JSON.parse((await this.ports.git.readBlob(directory, commitSha, 'project.assets.json')).toString('utf8')), project) }
  private checkManifest(value: unknown, project: ProjectView): void {
    if (!isProjectManifest(value)) throw new Error('项目清单无效。')
    const actual = value as Record<string, unknown>
    for (const [key, expected] of Object.entries(expectedManifest(project)).filter(([key]) => key !== 'scenarioTemplates')) if (JSON.stringify(actual[key]) !== JSON.stringify(expected)) throw new Error('项目清单身份与后台登记不一致。')
  }
  private async openReady(project: ProjectView, operation: ProjectInitialization): Promise<void> {
    const local = await this.store.read(), existing = local.projects.find(p => p.id === project.id)
    if (existing) { await this.verify(existing.directory, project); local.selectedProjectId = project.id; operation.phase = 'ready'; delete operation.message; await this.store.save(); return }
    const directory = await this.ownedDirectory(project, operation)
    if (!await exists(path.join(directory, '.git'))) {
      if ((await readdir(directory)).length) throw new Error('本地目录有未核对内容，已保留现场。')
      await this.ports.git.clone(project.repositoryUrl, directory)
    }
    await this.verify(directory, project); await this.bind(project, operation)
  }
  private async bind(project: ProjectView, operation: ProjectInitialization): Promise<void> {
    const local = await this.store.read()
    if (!operation.directory) throw new Error('项目本地目录缺失。')
    if (!local.projects.some(p => p.id === project.id)) local.projects.push({ id: project.id, name: project.name, directory: operation.directory, repositoryUrl: project.repositoryUrl })
    local.selectedProjectId = project.id; operation.phase = 'ready'; delete operation.message; await this.store.save()
  }
}
