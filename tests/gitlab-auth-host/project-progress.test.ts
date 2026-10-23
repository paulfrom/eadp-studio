import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import type { ProjectView, StudioUser } from '@eadp/contracts'
import { ProjectWorkspaces } from '../../packages/studio-plugin/src/host/application/projects.ts'
import { StudioStore } from '../../packages/studio-plugin/src/host/application/state.ts'
import { BackgroundLane } from '../../packages/studio-plugin/src/host/application/background-lane.ts'
import { ProjectProgressTracker, clonePercent, pushPercent } from '../../packages/studio-plugin/src/host/application/progress.ts'
import type { CollaborationClient } from '../../packages/studio-plugin/src/host/adapters/collaboration/client.ts'
import type { HostPorts } from '../../packages/studio-plugin/src/host/application/ports.ts'
import type { GitProgress } from '../../packages/studio-plugin/src/host/adapters/workspace/git.ts'

const user: StudioUser = { id: 1, username: 'tester', name: '测试管理员', email: 'tester@example.test', admin: true, gitlabUserId: 17, gitlabUsername: 'liu', gitlabEmail: 'liu@example.test' }
const sha = 'a'.repeat(40)
const accepted = (): ProjectView => ({ id: 'project-1', name: '项目', gitlabProjectId: 101, repositoryUrl: 'http://gitlab.example.test/team/project.git', stableBranch: 'main', namespaceId: 7, namespacePath: 'team', initializationStatus: 'ready', recognizedHead: sha, revision: 2, categories: [] })
const directories = ['场景', '需求', '交接', '原型代码']
/** Write the checkout a clone and an initialization both have to leave behind. */
async function checkout(directory: string, project: ProjectView): Promise<void> {
  await mkdir(path.join(directory, '.git'), { recursive: true })
  for (const name of directories) await mkdir(path.join(directory, name), { recursive: true })
  const manifest = { schemaVersion: 1, projectId: project.id, gitlabProjectId: project.gitlabProjectId, repositoryUrl: project.repositoryUrl, stableBranch: project.stableBranch, directories, scenarioTemplates: { defaultTemplateId: 'default', templates: [{ id: 'default', name: '默认场景模板', path: '.template/default.md' }] } }
  await writeFile(path.join(directory, 'project.assets.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}

async function fixture(pending = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-project-progress-')), storeRoot = path.join(root, 'state'), workspaceRoot = path.join(root, 'workspace')
  let project = pending ? { ...accepted(), initializationStatus: 'pending' as const, recognizedHead: null, revision: 0 } : accepted()
  const tracker = new ProjectProgressTracker()
  // The clone and the push pause until the test has read the bar the tracker reports.
  let entered: () => void = () => {}
  const enteredClone = new Promise<void>(resolve => { entered = resolve })
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const seen: Array<{ phase: string; percent: number }> = []
  const labels: string[] = []
  let clones = 0
  const api = { request: async (method: string, route: string) => {
    if (method === 'GET' && route === '/v1/projects/project-1') return { project, entities: [], baselines: [], integrations: [] }
    if (method === 'POST' && route === '/v1/projects/project-1/initialize') { project = { ...project, initializationStatus: 'ready', recognizedHead: sha }; return project }
    return { project, entities: [], baselines: [], integrations: [] }
  } } as unknown as CollaborationClient
  const ports = {
    workspaceRoot,
    account: async () => user,
    stopPreview: async () => {},
    git: {
      probeRemoteHead: async () => undefined,
      init: async (directory: string) => { await mkdir(path.join(directory, '.git'), { recursive: true }) },
      clone: async (_url: string, directory: string, _signal?: AbortSignal, onProgress?: (progress: GitProgress) => void) => {
        ++clones
        onProgress?.({ stage: 'receiving', percent: 50 }); seen.push(...tracker.views().map(view => ({ phase: view.phase, percent: view.percent }))); labels.push(...tracker.views().map(view => view.label))
        entered(); await gate
        await checkout(directory, project)
      },
      head: async () => undefined,
      fetchCommit: async () => {},
      hasCommit: async () => true,
      state: async () => ({ head: sha, repositoryUrl: project.repositoryUrl, dirty: false, branch: 'main' }),
      commitFiles: async () => sha,
      push: async (_directory: string, _commit: string, _branch: string, onProgress?: (progress: GitProgress) => void) => {
        onProgress?.({ stage: 'writing', percent: 60 }); seen.push(...tracker.views().map(view => ({ phase: view.phase, percent: view.percent })))
        entered(); await gate
      },
    },
    gitLocal: async () => 'project.assets.json\0',
    installTemplate: async (directory: string) => { await mkdir(directory, { recursive: true }) },
  } as unknown as HostPorts
  const store = new StudioStore(storeRoot); store.useUser(user.id)
  const lane = new BackgroundLane()
  const service = new ProjectWorkspaces(store, api, ports, lane, tracker)
  return { root, store, lane, tracker, service, directories, release, enteredClone, seen, labels, clones: () => clones,
    // A failed assertion must not leave the lane waiting on the gate the test held.
    dispose: async () => { release(); await lane.settle(); await service.dispose(); await rm(root, { recursive: true, force: true }) } }
}

test('opening an accepted project this machine does not hold clones it and reports the transfer', async () => {
  const f = await fixture()
  try {
    await f.service.open('project-1')
    await f.enteredClone
    const [bar] = f.tracker.views()
    assert.equal(bar?.projectName, '项目')
    assert.equal(bar?.phase, 'cloning')
    assert.equal(bar?.label, '从 GitLab 获取项目仓库')
    assert.equal(bar?.percent, Math.round(clonePercent({ stage: 'receiving', percent: 50 })))
    f.release(); await f.lane.settle()
    assert.deepEqual(f.tracker.views(), [], 'the bar leaves once the record reaches ready')
    const local = await f.store.read()
    assert.equal(local.projects.length, 1)
    assert.equal(local.selectedProjectId, 'project-1')
    assert.equal(local.projectInitializations[0]!.phase, 'ready')
  } finally { await f.dispose() }
})

test('a project whose local checkout disappeared is acquired again instead of failing', async () => {
  const f = await fixture()
  try {
    await f.service.open('project-1'); f.release(); await f.lane.settle()
    const opened = await f.store.read(), directory = opened.projects[0]!.directory
    assert.equal(f.clones(), 1)
    await rm(directory, { recursive: true, force: true }); await rm(`${directory}.studio-owner.json`, { force: true })
    await f.service.open('project-1'); await f.lane.settle()
    const reopened = await f.store.read()
    assert.equal(f.clones(), 2, 'a checkout that is gone is cloned again, not assumed to exist')
    assert.ok(f.labels.some(label => label.includes('本地项目目录已丢失，正在从 GitLab 恢复')), 'the bar says the checkout is being recovered')
    assert.equal(reopened.selectedProjectId, 'project-1')
    assert.deepEqual(reopened.projects.map(project => project.directory), [directory])
    assert.equal(reopened.projectInitializations.filter(op => op.phase !== 'ready').length, 0)
  } finally { await f.dispose() }
})

test('files left behind when only the checkout metadata was deleted are preserved beside the new clone', async () => {
  const f = await fixture()
  try {
    await f.service.open('project-1'); f.release(); await f.lane.settle()
    const opened = await f.store.read(), directory = opened.projects[0]!.directory
    await rm(path.join(directory, '.git'), { recursive: true, force: true })
    await writeFile(path.join(directory, 'private.txt'), 'preserve me')
    await f.service.open('project-1'); await f.lane.settle()
    assert.ok(f.labels.some(label => label.includes('原文件已移至')), 'the bar says where the leftover files went')
    const backups = (await readdir(path.dirname(directory))).filter(name => name.startsWith(`${path.basename(directory)}.backup-`))
    assert.equal(backups.length, 1)
    assert.equal(await readFile(path.join(path.dirname(directory), backups[0]!, 'private.txt'), 'utf8'), 'preserve me')
    assert.equal(f.clones(), 2)
    assert.equal((await f.store.read()).selectedProjectId, 'project-1')
  } finally { await f.dispose() }
})

test('a deleted checkout whose sibling ownership marker survived is acquired again', async () => {
  const f = await fixture()
  try {
    await f.service.open('project-1'); f.release(); await f.lane.settle()
    const opened = await f.store.read(), directory = opened.projects[0]!.directory
    assert.equal(f.clones(), 1)
    // Deleting the folder does not delete the marker stored next to it.
    await rm(directory, { recursive: true, force: true })
    await f.service.open('project-1'); await f.lane.settle()
    const reopened = await f.store.read()
    assert.equal(f.clones(), 2, 'the leftover marker must not block acquiring the checkout again')
    assert.equal(reopened.selectedProjectId, 'project-1')
    assert.equal(reopened.projectInitializations.filter(op => op.phase !== 'ready').length, 0)
  } finally { await f.dispose() }
})

test('initializing a pending project reports the push instead of only the phase', async () => {
  const f = await fixture(true)
  try {
    await f.service.open('project-1')
    await f.enteredClone
    assert.ok(f.seen.some(step => step.phase === 'pushing' && step.percent >= 45), 'the bar follows the push')
    f.release(); await f.lane.settle()
    assert.deepEqual(f.tracker.views(), [])
    const local = await f.store.read()
    assert.equal(local.projects.length, 1)
    assert.equal(local.projects[0]!.id, 'project-1')
  } finally { await f.dispose() }
})

test('a stopped operation keeps its bar with the reason so the record can be retried', async () => {
  const f = await fixture()
  try {
    // A directory with foreign bytes is preserved, never adopted by the clone.
    const directory = path.join(f.root, 'workspace', 'users', '1', 'project-project-1')
    await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, 'private.txt'), 'preserve me')
    await f.service.open('project-1'); await f.lane.settle().catch(() => undefined)
    const [bar] = f.tracker.views()
    assert.equal(bar?.phase, 'failed')
    assert.match(bar?.label ?? '', /缺少本项目的持久归属记录/)
    const local = await f.store.read()
    assert.equal(local.projectInitializations[0]!.phase, 'unknown')
    assert.match(local.projectInitializations[0]!.message ?? '', /缺少本项目的持久归属记录/)
    assert.deepEqual(local.projects, [])
  } finally { await f.dispose() }
})

test('the bar never moves backwards within one operation', () => {
  const tracker = new ProjectProgressTracker()
  tracker.begin('operation', '项目')
  tracker.report('operation', 'cloning', 40, '从 GitLab 获取项目仓库')
  tracker.report('operation', 'cloning', 20, '从 GitLab 获取项目仓库')
  assert.equal(tracker.views()[0]!.percent, 40)
  tracker.report('operation', 'verifying', 85, '校验项目清单')
  tracker.fail('operation', '推送失败')
  assert.deepEqual(tracker.views()[0], { operationId: 'operation', projectName: '项目', phase: 'failed', percent: 85, label: '推送失败' })
  tracker.end('operation')
  assert.deepEqual(tracker.views(), [])
})

test('clone and push progress stay inside their own windows', () => {
  for (const stage of ['counting', 'compressing', 'receiving', 'resolving', 'checking', 'updating'] as const) {
    let last = -1
    for (const percent of [0, 50, 100]) {
      const value = clonePercent({ stage, percent })
      assert.ok(value >= last && value >= 10 && value <= 80, `${stage} ${percent}% -> ${value}`)
      last = value
    }
  }
  for (const stage of ['enumerating', 'counting', 'compressing', 'writing'] as const) {
    let last = -1
    for (const percent of [0, 50, 100]) {
      const value = pushPercent({ stage, percent })
      assert.ok(value >= last && value >= 45 && value <= 85, `${stage} ${percent}% -> ${value}`)
      last = value
    }
  }
  assert.equal(clonePercent({ stage: 'updating', percent: 100 }), 80, 'a finished clone leaves room for the verification that follows')
  assert.equal(pushPercent({ stage: 'writing', percent: 100 }), 85, 'a finished push leaves room for the backend acceptance')
})
