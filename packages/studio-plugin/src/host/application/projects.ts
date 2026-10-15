import { randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ProjectState, ProjectView } from '@eadp/contracts'
import type { StudioCommand } from '../../shared/studio.ts'
import type { CollaborationClient } from '../adapters/collaboration/client.ts'
import type { HostPorts } from './ports.ts'
import { StudioStore, type ProjectInitialization } from './state.ts'

const exists = async (target: string) => stat(target).then(() => true, error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return false })
const expectedManifest = (project: ProjectView) => ({ schemaVersion: 1, projectId: project.id, gitlabProjectId: project.gitlabProjectId, repositoryUrl: project.repositoryUrl, stableBranch: project.stableBranch, directories: ['场景', '需求', '原型代码'] })
async function writeInitialFile(target: string, value: string): Promise<void> {
  try { await writeFile(target, value, { flag: 'wx' }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; if ((await lstat(target)).isSymbolicLink() || await readFile(target, 'utf8') !== value) throw new Error('初始化文件已被修改，请保留并核对原现场。') }
}

/** Backend owns repository provisioning. This service owns only attributable local Git workspaces. */
export class ProjectWorkspaces {
  private readonly caches = new Map<string, string>()
  constructor(private readonly store: StudioStore, private readonly api: CollaborationClient, private readonly ports: HostPorts) {}
  async create(command: Extract<StudioCommand, { action: 'createProject' }>): Promise<void> {
    if (!command.name.trim() || command.name.length > 200 || !Number.isSafeInteger(command.namespaceId) || command.namespaceId <= 0 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(command.path) || command.path.length > 100) throw new Error('请填写项目名称、群组和有效的仓库路径。')
    const local = await this.store.read()
    const previous = local.projectInitializations.find(op => op.namespaceId === command.namespaceId && op.path === command.path)
    if (previous) { if (previous.name !== command.name.trim()) throw new Error('此仓库路径已有创建记录，请从待处理记录恢复。'); await this.resume(previous.id); return }
    const operation: ProjectInitialization = { id: randomUUID(), name: command.name.trim(), namespaceId: command.namespaceId, path: command.path, phase: 'creating' }
    local.projectInitializations.push(operation); await this.store.save()
    await this.resume(operation.id)
  }
  async open(projectId: string): Promise<void> {
    const project = await this.project(projectId), local = await this.store.read()
    if (project.initializationStatus === 'pending') {
      let operation = local.projectInitializations.find(op => op.projectId === project.id)
      if (!operation) { operation = { id: randomUUID(), name: project.name, namespaceId: project.namespaceId, path: project.repositoryUrl.split('/').at(-1)!.replace(/\.git$/, ''), projectId: project.id, phase: 'initializing' }; local.projectInitializations.push(operation); await this.store.save() }
      await this.resume(operation.id); return
    }
    const existing = local.projects.find(p => p.id === project.id)
    if (existing) { await this.verify(existing.directory, project); local.selectedProjectId = project.id; await this.store.save(); return }
    let operation = local.projectInitializations.find(op => op.projectId === project.id)
    if (!operation) { operation = { id: randomUUID(), name: project.name, namespaceId: project.namespaceId, path: '', projectId: project.id, phase: 'initializing' }; local.projectInitializations.push(operation); await this.store.save() }
    await this.resume(operation.id)
  }
  async resume(operationId: string): Promise<void> {
    const local = await this.store.read(), operation = local.projectInitializations.find(op => op.id === operationId)
    if (!operation) throw new Error('未找到当前用户的项目创建记录。')
    try {
      let project: ProjectView
      if (!operation.projectId) {
        // Exactly the original body and key survive a lost response or desktop restart.
        project = await this.api.request<ProjectView>('POST', '/v1/projects', { idempotencyKey: operation.id, name: operation.name, namespaceId: operation.namespaceId, path: operation.path })
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
      project = await this.api.request<ProjectView>('POST', `/v1/projects/${encodeURIComponent(project.id)}/initialize`, { idempotencyKey: `${operation.id}-initialize`, commitSha: operation.commitSha })
      if (project.initializationStatus !== 'ready' || project.recognizedHead !== operation.commitSha) throw new Error('后台尚未接受首次提交，请保留现场并重新核对。')
      await this.bind(project, operation)
    } catch (error) { operation.phase = 'unknown'; operation.message = error instanceof Error ? error.message : '项目初始化结果未知'; await this.store.save(); throw error }
  }
  async readFixed(projectId: string, commitSha: string, relativePath: string): Promise<Uint8Array> {
    const project = await this.project(projectId)
    if (project.initializationStatus !== 'ready') throw new Error('项目尚未完成初始化。')
    const local = await this.store.read(), opened = local.projects.find(p => p.id === project.id)
    let directory = opened?.directory
    if (opened && opened.repositoryUrl !== project.repositoryUrl) throw new Error('本地项目与后台仓库身份不一致。')
    if (!directory) {
      const cacheId = `${this.store.directory}:${project.id}`
      directory = this.caches.get(cacheId)
      if (!directory) {
        await mkdir(this.store.directory, { recursive: true, mode: 0o700 })
        directory = await mkdtemp(path.join(this.store.directory, `read-cache-${project.id}-`))
        this.caches.set(cacheId, directory)
        try { await this.ports.git.clone(project.repositoryUrl, directory) }
        catch (error) { this.caches.delete(cacheId); await rm(directory, { recursive: true, force: true }); throw error }
      }
    }
    await this.ports.git.fetchCommit(directory, commitSha)
    return new Uint8Array(await this.ports.git.readBlob(directory, commitSha, relativePath))
  }
  async dispose(): Promise<void> { const owned = [...this.caches.values()]; this.caches.clear(); await Promise.all(owned.map(directory => rm(directory, { recursive: true, force: true }))) }
  private async project(id: string): Promise<ProjectView> { if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(id)) throw new Error('项目身份无效。'); return (await this.api.request<ProjectState>('GET', `/v1/projects/${encodeURIComponent(id)}`)).project }
  private async ownedDirectory(project: ProjectView, operation: ProjectInitialization): Promise<string> {
    const account = await this.ports.account(); if (!account) throw new Error('请先登录协同工作台。')
    const directory = path.join(this.ports.workspaceRoot, 'users', String(account.id), `project-${project.id}`)
    if (operation.directory && operation.directory !== directory) throw new Error('项目初始化目录与当前用户不一致。')
    const marker = `${directory}.studio-owner.json`
    if (await exists(directory)) {
      if (operation.directory !== directory || (await lstat(directory)).isSymbolicLink()) throw new Error('项目目录已存在且不属于本任务，请保留并核对原现场。')
      const owner = await readFile(marker, 'utf8').then(value => JSON.parse(value) as { operationId: string; projectId: string }).catch(() => undefined)
      if (!owner || owner.operationId !== operation.id || owner.projectId !== project.id) throw new Error('项目目录缺少本任务的持久归属记录，请保留并核对原现场。')
      operation.directoryOwned = true
    }
    else {
      operation.directory = directory; operation.directoryOwned = false; await this.store.save()
      await mkdir(path.dirname(directory), { recursive: true }); await mkdir(directory)
      await writeFile(marker, JSON.stringify({ operationId: operation.id, projectId: project.id }), { flag: 'wx', mode: 0o600 })
      operation.directoryOwned = true; await this.store.save()
    }
    return directory
  }
  private async initializeFiles(directory: string, project: ProjectView): Promise<void> {
    for (const name of ['场景', '需求']) { const target = path.join(directory, name); await mkdir(target, { recursive: true }); if ((await lstat(target)).isSymbolicLink()) throw new Error('初始化目录不能为符号链接。'); await writeInitialFile(path.join(target, '.gitkeep'), '') }
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
    for (const name of ['场景', '需求', '原型代码']) if (!(await stat(path.join(directory, name))).isDirectory()) throw new Error('项目不符合工作台三目录契约。')
  }
  private async verifyFixedManifest(directory: string, project: ProjectView, commitSha: string): Promise<void> { this.checkManifest(JSON.parse((await this.ports.git.readBlob(directory, commitSha, 'project.assets.json')).toString('utf8')), project) }
  private checkManifest(value: unknown, project: ProjectView): void {
    if (!value || typeof value !== 'object') throw new Error('项目清单无效。')
    const actual = value as Record<string, unknown>
    for (const [key, expected] of Object.entries(expectedManifest(project))) if (JSON.stringify(actual[key]) !== JSON.stringify(expected)) throw new Error('项目清单身份与后台登记不一致。')
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
