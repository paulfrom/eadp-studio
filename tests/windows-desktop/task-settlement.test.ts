import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { WorkspaceGit } from '../../packages/studio-plugin/src/host/adapters/workspace/git.ts'
import type { ProcessResult } from '../../packages/studio-plugin/src/host/adapters/platform/runtime.ts'
import { StudioStore } from '../../packages/studio-plugin/src/host/application/state.ts'
import { ProjectWorkspaces } from '../../packages/studio-plugin/src/host/application/projects.ts'
import { TaskMaintenance } from '../../packages/studio-plugin/src/host/application/task-maintenance.ts'
import { BackgroundLane } from '../../packages/studio-plugin/src/host/application/background-lane.ts'
import type { HostPorts } from '../../packages/studio-plugin/src/host/application/ports.ts'
import type { LocalProject, TaskView } from '../../packages/studio-plugin/src/shared/studio.ts'
import type { CollaborationClient } from '../../packages/studio-plugin/src/host/adapters/collaboration/client.ts'
import type { ProjectState } from '@eadp/contracts'

const digest = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const exists = (target: string): Promise<boolean> => stat(target).then(() => true, () => false)
const origin = 'http://gitlab.example.test/team/project.git'

/** A Git runtime that executes the native binary the fixture hashes into its own config. */
function nativeRuntime(): { run(tool: string, args: string[], options: { cwd: string }): Promise<ProcessResult>; start(tool: string, args: string[], options: { cwd: string }): { done: Promise<ProcessResult> } } {
  const start = (tool: string, args: string[], options: { cwd: string }) => ({ done: new Promise<ProcessResult>(resolve => {
    execFile(tool, args, { cwd: options.cwd, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = typeof (error as NodeJS.ErrnoException | null)?.code === 'number' ? (error as unknown as { code: number }).code : error ? 1 : 0
      resolve({ stdout, stderr, stdoutBytes: Buffer.from(stdout), exitCode: code })
    })
  }) })
  return {
    start,
    run: async (tool, args, options) => {
      const result = await start(tool, args, options).done
      if (result.exitCode !== 0) throw new Error(`${tool} 执行失败（退出码 ${result.exitCode}）。`)
      return result
    },
  }
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-settlement-'))
  const savedHome = process.env.HOME
  const home = path.join(root, 'home'); await mkdir(home)
  await writeFile(path.join(home, '.gitconfig'), '[user]\n\tname = Fixture User\n\temail = fixture@example.test\n[init]\n\tdefaultBranch = main\n')
  process.env.HOME = home
  const runtime = nativeRuntime(), git = new WorkspaceGit(runtime as never, async () => 'http://gitlab.example.test')
  const repo = path.join(root, 'repo')
  await git.init(repo, origin)
  await mkdir(path.join(repo, '场景'))
  await writeFile(path.join(repo, '场景/scene.md'), '# 场景一\n')
  await writeFile(path.join(repo, '.gitignore'), '*.log\n')
  const base = await git.commitFiles(repo, ['场景/scene.md', '.gitignore'], 'base', await git.identity(repo))
  const worktree = path.join(root, 'worktrees', 't1')
  await git.createWorktree(repo, worktree, 'studio/scenario/1', base)
  const storeRoot = path.join(root, 'state'), store = new StudioStore(storeRoot); store.useUser(1)
  const local = await store.read()
  const project: LocalProject = { id: 'project', name: '测试项目', directory: repo, repositoryUrl: origin }
  local.projects.push(project); local.selectedProjectId = 'project'
  const task: TaskView = { projectId: 'project', entityId: 'scenario', sessionId: 'session-1', purpose: 'material', inputHash: '', worktree }
  local.tasks.push(task)
  await store.save()
  let recognizedHead = base
  const remote: ProjectState = { project: { id: 'project', name: '测试项目', gitlabProjectId: 1, repositoryUrl: origin, stableBranch: 'main', namespaceId: 1, namespacePath: 'test', initializationStatus: 'ready', recognizedHead: base, revision: 1 }, entities: [], baselines: [], integrations: [] }
  const api = { request: async (method: string, route: string) => route === '/v1/projects/project' ? { ...remote, project: { ...remote.project, recognizedHead } } : remote } as unknown as CollaborationClient
  const ports = { git, gitLocal: (args: string[], cwd: string) => git.local(cwd, args), stopPreview: async () => {} } as unknown as HostPorts
  const projects = new ProjectWorkspaces(store, api, ports, new BackgroundLane())
  const released: string[] = []
  const maintenance = new TaskMaintenance(store, ports, { sync: (projectId, commit) => projects.syncMain(projectId, commit), release: async value => { released.push(value.worktree) } })
  const dispose = async () => { process.env.HOME = savedHome; await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
  return { root, repo, worktree, base, git, store, local, task, maintenance, released, setRecognized: (sha: string) => { recognizedHead = sha }, dispose }
}

test('acceptance settles the machine: main checkout fast-forwards, worktree bytes are archived with SHA-256, and the task registration is removed', async () => {
  const f = await fixture()
  try {
    await writeFile(path.join(f.worktree, '场景/scene.md'), '# 场景一\n\n已确认。\n')
    const candidate = await f.git.commitFiles(f.worktree, ['场景/scene.md'], 'candidate', await f.git.identity(f.worktree))
    f.setRecognized(candidate)
    await writeFile(path.join(f.worktree, '场景/调研.md'), '# 调研\n')
    await writeFile(path.join(f.worktree, 'debug.log'), 'ignored bytes')

    await f.maintenance.settle(f.task, candidate)

    assert.equal((await f.git.state(f.repo)).head, candidate, '主目录必须包含本次接受提交')
    assert.equal(await exists(f.worktree), false, '任务目录必须被清理')
    const manifest = JSON.parse(await readFile(path.join(f.store.directory, 'archive/project/t1/manifest.json'), 'utf8')) as { entries: Array<{ path: string; kind: string; sha256?: string }> }
    const note = manifest.entries.find(entry => entry.path === '场景/调研.md')
    const ignored = manifest.entries.find(entry => entry.path === 'debug.log')
    assert.equal(note?.sha256, digest('# 调研\n'), '未跟踪材料必须按字节归档')
    assert.equal(ignored?.sha256, digest('ignored bytes'), '被忽略材料同样不得静默丢弃')
    assert.equal(await readFile(path.join(f.store.directory, 'archive/project/t1/场景/调研.md'), 'utf8'), '# 调研\n')
    assert.equal(f.released.includes(f.worktree), true, '任务资源按任务释放')
    assert.equal(f.local.tasks.length, 1, '历史会话记录必须保留')
    assert.equal(f.local.tasks[0]!.cleanup?.status, 'done', '任务状态必须标明本机收整完成')
    assert.equal((await f.git.local(f.repo, ['for-each-ref', '--format=%(refname)', 'refs/eadp/archive'])).trim(), 'refs/eadp/archive/project/t1')
    assert.equal((await f.git.local(f.repo, ['for-each-ref', '--format=%(refname)', 'refs/heads/studio/scenario/1'])).trim(), '', '临时分支必须删除')

    await f.maintenance.settle(f.task, candidate)
    assert.equal(f.released.filter(value => value === f.worktree).length, 1, '重复收整不得重复执行')
  } finally { await f.dispose() }
})

test('a dirty main checkout is recorded as pending synchronization and never overwritten', async () => {
  const f = await fixture()
  try {
    await writeFile(path.join(f.worktree, '场景/scene.md'), '# 场景一\n\n已确认。\n')
    const candidate = await f.git.commitFiles(f.worktree, ['场景/scene.md'], 'candidate', await f.git.identity(f.worktree))
    const userBytes = '# 用户正在写的内容\n'
    await writeFile(path.join(f.repo, '场景/scene.md'), userBytes)
    f.setRecognized(candidate)

    await f.maintenance.settle(f.task, candidate)

    assert.equal((await f.git.state(f.repo)).head, f.base, '脏主目录不得被同步覆盖')
    assert.equal(await readFile(path.join(f.repo, '场景/scene.md'), 'utf8'), userBytes, '用户改动必须原样保留')
    assert.equal(f.local.projects[0]!.sync?.status, 'blocked')
    assert.match(f.local.projects[0]!.sync?.message ?? '', /待同步/)
    assert.equal(await exists(f.worktree), false, '主目录待同步不阻塞本任务收整')
  } finally { await f.dispose() }
})

test('a missing worktree without an archive record keeps the task scene instead of reporting success', async () => {
  const f = await fixture()
  try {
    const missing = path.join(f.root, 'worktrees', 'gone')
    const task: TaskView = { ...f.task, sessionId: 'session-2', worktree: missing }
    f.local.tasks.push(task); await f.store.save()

    await assert.rejects(() => f.maintenance.settle(task, f.base), /任务目录不存在且没有归档记录/)
    assert.equal(f.local.tasks.some(value => value.worktree === missing), true, '无归档证据时不得移除执行登记')
  } finally { await f.dispose() }
})
