import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MaterialStatusReports } from '../../packages/studio-plugin/src/host/application/material-status.ts'
import { StudioStore } from '../../packages/studio-plugin/src/host/application/state.ts'
import type { ScenarioRecord } from '../../packages/studio-plugin/src/host/application/scenario-workspaces.ts'
import type { HostPorts } from '../../packages/studio-plugin/src/host/application/ports.ts'
import type { CollaborationClient } from '../../packages/studio-plugin/src/host/adapters/collaboration/client.ts'

const head = 'b'.repeat(40)
async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !condition(); attempt++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(condition())
}
test('status reports carry mechanical plus optional AI summaries and recover after failure', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'status-')); t.after(() => rm(root, { recursive: true, force: true }))
  const store = new StudioStore(root); store.useUser(1)
  const workspaceDirectory = path.join(root, 'project'), directory = path.join(workspaceDirectory, 'repo')
  await mkdir(directory, { recursive: true })
  ;(await store.read()).projects.push({ id: 'p', name: '项目', workspaceDirectory, directory, repositoryUrl: 'https://gitlab.test/p.git' })
  const owner: ScenarioRecord = { projectId: 'p', entityId: 'e', sources: [], sourcePaths: {} }
  ;(await store.read()).scenarios.push(owner); await store.save()
  const posts: Array<{ url: string; body: { summary: string; worktreeHead: string; changedPathCount: number; idempotencyKey: string } }> = []
  let failing = true
  const api = { async request(method: string, url: string, body: never) { if (failing) throw new Error('网络不可用'); posts.push({ url, body }); return {} } } as unknown as CollaborationClient
  const ports = {
    git: { state: async () => ({ root: 'w', head, branch: 'main', dirty: true, repositoryUrl: 'https://gitlab.test/p.git' }), changedPathStatuses: async () => [] },
    gitLocal: async () => ' M 场景/登录.md\0?? 场景/新增.md\0',
    summarize: async () => '本次编辑调整登录场景并新增一个场景草稿',
  } as unknown as HostPorts
  const pending: Array<() => Promise<void>> = []
  const reports = new MaterialStatusReports(store, api, ports, { record: async () => owner, deliver: work => { pending.push(work) } })
  await reports.report({ projectId: 'p', entityId: 'e', trigger: 'save', worktree: '/w', baseHead: 'a'.repeat(40) })
  assert.equal(pending.length, 1); await pending[0]!()
  assert.equal(posts.length, 0, '首次上报失败不得发成功')
  assert.equal(owner.statusReports![0]!.message, '网络不可用')
  failing = false; reports.resume('p'); await Promise.resolve(); assert.equal(pending.length, 2); await pending[1]!()
  assert.equal(posts.length, 1)
  assert.equal(posts[0]!.url, '/v1/projects/p/entities/e/status-reports')
  assert.equal(posts[0]!.body.worktreeHead, head)
  assert.equal(posts[0]!.body.changedPathCount, 2)
  assert.match(posts[0]!.body.summary, /变更 2 个文件：场景\/登录.md（修改）、场景\/新增.md（新增）/)
  assert.match(posts[0]!.body.summary, /本次编辑调整登录场景/)
  assert.ok(posts[0]!.body.summary.length <= 500)
  assert.equal(owner.statusReports![0]!.shared, true)
  reports.resume('p'); assert.equal(pending.length, 2, '已共享记录不再重发')
})

test('committed changes join uncommitted changes and uncommitted status wins per path', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'status-committed-')); t.after(() => rm(root, { recursive: true, force: true }))
  const store = new StudioStore(root); store.useUser(1)
  const workspaceDirectory = path.join(root, 'project'), directory = path.join(workspaceDirectory, 'repo')
  await mkdir(directory, { recursive: true })
  ;(await store.read()).projects.push({ id: 'p', name: '项目', workspaceDirectory, directory, repositoryUrl: 'https://gitlab.test/p.git' })
  const owner: ScenarioRecord = { projectId: 'p', entityId: 'e', sources: [], sourcePaths: {} }
  ;(await store.read()).scenarios.push(owner); await store.save()
  const posts: Array<{ summary: string; changedPathCount: number }> = []
  const api = { async request(method: string, url: string, body: { summary: string; changedPathCount: number }) { posts.push(body); return {} } } as unknown as CollaborationClient
  const committed = [
    { path: '场景/已提交新增.md', status: 'A' },
    { path: '场景/已提交删除.md', status: 'D' },
    { path: '场景/覆盖.md', status: 'M' },
  ]
  let committedCollections = 0
  const ports = {
    git: {
      state: async () => ({ root: 'w', head, branch: 'main', dirty: true, repositoryUrl: 'https://gitlab.test/p.git' }),
      changedPathStatuses: async () => { committedCollections++; return committed },
    },
    gitLocal: async () => ' D 场景/覆盖.md\0?? 场景/未提交.md\0',
  } as unknown as HostPorts
  const pending: Array<() => Promise<void>> = []
  const reports = new MaterialStatusReports(store, api, ports, { record: async () => owner, deliver: work => { pending.push(work) } })
  await reports.report({ projectId: 'p', entityId: 'e', trigger: 'save', worktree: '/w', baseHead: 'a'.repeat(40) })
  await pending[0]!()
  assert.equal(posts.length, 1)
  assert.equal(posts[0]!.changedPathCount, 4)
  assert.equal(committedCollections, 1, '已提交状态只采集一次，不逐路径读取 blob')
  assert.match(posts[0]!.summary, /场景\/已提交新增.md（新增）/)
  assert.match(posts[0]!.summary, /场景\/已提交删除.md（删除）/)
  assert.match(posts[0]!.summary, /场景\/覆盖.md（删除）/)
  assert.doesNotMatch(posts[0]!.summary, /场景\/覆盖.md（修改）/)
  assert.match(posts[0]!.summary, /场景\/未提交.md（新增）/)
})

test('collection failures persist their input and resume recollects before submitting', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'status-recollect-')); t.after(() => rm(root, { recursive: true, force: true }))
  const store = new StudioStore(root); store.useUser(1)
  const workspaceDirectory = path.join(root, 'project'), directory = path.join(workspaceDirectory, 'repo')
  await mkdir(directory, { recursive: true })
  ;(await store.read()).projects.push({ id: 'p', name: '项目', workspaceDirectory, directory, repositoryUrl: 'https://gitlab.test/p.git' })
  const owner: ScenarioRecord = { projectId: 'p', entityId: 'e', sources: [], sourcePaths: {} }
  ;(await store.read()).scenarios.push(owner); await store.save()
  const posts: Array<{ changedPathCount: number }> = []
  const api = { async request(method: string, url: string, body: { changedPathCount: number }) { posts.push(body); return {} } } as unknown as CollaborationClient
  let failCollection = true, collections = 0
  const ports = {
    git: { state: async () => ({ root: 'w', head, branch: 'main', dirty: true, repositoryUrl: 'https://gitlab.test/p.git' }), changedPathStatuses: async () => [] },
    gitLocal: async () => { collections++; if (failCollection) { failCollection = false; throw new Error('采集失败') } return ' M 场景/恢复.md\0' },
  } as unknown as HostPorts
  const pending: Array<() => Promise<void>> = []
  const reports = new MaterialStatusReports(store, api, ports, { record: async () => owner, deliver: work => { pending.push(work) } })
  const input = { projectId: 'p', entityId: 'e', trigger: 'save' as const, worktree: '/w', baseHead: 'a'.repeat(40) }
  await reports.report(input); await pending[0]!()
  assert.equal(owner.statusReports![0]!.submission, undefined)
  assert.equal(owner.statusReports![0]!.worktree, '/w')
  assert.equal(owner.statusReports![0]!.baseHead, input.baseHead)
  reports.resume('p'); await Promise.resolve(); await Promise.resolve()
  assert.equal(pending.length, 2); await pending[1]!()
  assert.equal(collections, 2)
  assert.equal(posts.length, 1)
  assert.equal(posts[0]!.changedPathCount, 1)
  assert.equal(owner.statusReports![0]!.shared, true)
})

test('resume does not duplicate slow collection and shared records stay idle', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'status-collect-inflight-')); t.after(() => rm(root, { recursive: true, force: true }))
  const store = new StudioStore(root); store.useUser(1)
  const workspaceDirectory = path.join(root, 'project'), directory = path.join(workspaceDirectory, 'repo')
  await mkdir(directory, { recursive: true })
  ;(await store.read()).projects.push({ id: 'p', name: '项目', workspaceDirectory, directory, repositoryUrl: 'https://gitlab.test/p.git' })
  const owner: ScenarioRecord = { projectId: 'p', entityId: 'e', sources: [], sourcePaths: {} }
  ;(await store.read()).scenarios.push(owner); await store.save()
  let release!: () => void, summaries = 0, requests = 0
  const blocked = new Promise<void>(resolve => { release = resolve })
  t.after(() => release())
  const api = { async request() { requests++; return {} } } as unknown as CollaborationClient
  const ports = {
    git: { state: async () => ({ root: 'w', head, branch: 'main', dirty: true, repositoryUrl: 'https://gitlab.test/p.git' }), changedPathStatuses: async () => [] },
    gitLocal: async () => ' M 场景/慢采集.md\0',
    summarize: async () => { summaries++; await blocked; return '慢速摘要' },
  } as unknown as HostPorts
  const pending: Array<() => Promise<void>> = []
  const reports = new MaterialStatusReports(store, api, ports, { record: async () => owner, deliver: work => { pending.push(work) } })
  await reports.report({ projectId: 'p', entityId: 'e', trigger: 'save', worktree: '/w' })
  const initial = pending[0]!(); await waitFor(() => summaries === 1)
  reports.resume('p'); reports.resume('p'); await new Promise(resolve => setImmediate(resolve))
  assert.equal(pending.length, 1, '慢速采集期间不得重复排队')
  assert.equal(summaries, 1)
  release(); await initial
  assert.equal(requests, 1)
  assert.equal(owner.statusReports![0]!.shared, true)
  reports.resume('p'); await new Promise(resolve => setImmediate(resolve))
  assert.equal(pending.length, 1, '已共享记录不得重新采集')
  assert.equal(summaries, 1)
})

test('resume does not duplicate an inflight submission', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'status-inflight-')); t.after(() => rm(root, { recursive: true, force: true }))
  const store = new StudioStore(root); store.useUser(1)
  const workspaceDirectory = path.join(root, 'project'), directory = path.join(workspaceDirectory, 'repo')
  await mkdir(directory, { recursive: true })
  ;(await store.read()).projects.push({ id: 'p', name: '项目', workspaceDirectory, directory, repositoryUrl: 'https://gitlab.test/p.git' })
  const owner: ScenarioRecord = { projectId: 'p', entityId: 'e', sources: [], sourcePaths: {} }
  ;(await store.read()).scenarios.push(owner); await store.save()
  let release!: () => void, requests = 0
  const blocked = new Promise<void>(resolve => { release = resolve })
  const api = { async request() { requests++; await blocked; return {} } } as unknown as CollaborationClient
  const ports = {
    git: { state: async () => ({ root: 'w', head, branch: 'main', dirty: true, repositoryUrl: 'https://gitlab.test/p.git' }), changedPathStatuses: async () => [] },
    gitLocal: async () => ' M 场景/在途.md\0',
  } as unknown as HostPorts
  const pending: Array<() => Promise<void>> = []
  const reports = new MaterialStatusReports(store, api, ports, { record: async () => owner, deliver: work => { pending.push(work) } })
  await reports.report({ projectId: 'p', entityId: 'e', trigger: 'save', worktree: '/w' })
  const initial = pending[0]!(); await waitFor(() => requests === 1)
  reports.resume('p'); reports.resume('p'); await new Promise(resolve => setImmediate(resolve))
  assert.equal(pending.length, 1)
  assert.equal(requests, 1)
  release(); await initial
  assert.equal(owner.statusReports![0]!.shared, true)
})

test('changed path count is capped while the mechanical summary keeps the actual total', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'status-limit-')); t.after(() => rm(root, { recursive: true, force: true }))
  const store = new StudioStore(root); store.useUser(1)
  const workspaceDirectory = path.join(root, 'project'), directory = path.join(workspaceDirectory, 'repo')
  await mkdir(directory, { recursive: true })
  ;(await store.read()).projects.push({ id: 'p', name: '项目', workspaceDirectory, directory, repositoryUrl: 'https://gitlab.test/p.git' })
  const owner: ScenarioRecord = { projectId: 'p', entityId: 'e', sources: [], sourcePaths: {} }
  ;(await store.read()).scenarios.push(owner); await store.save()
  const posts: Array<{ summary: string; changedPathCount: number }> = []
  const api = { async request(method: string, url: string, body: { summary: string; changedPathCount: number }) { posts.push(body); return {} } } as unknown as CollaborationClient
  const paths = Array.from({ length: 3001 }, (_, index) => `场景/${index}.md`)
  const ports = {
    git: { state: async () => ({ root: 'w', head, branch: 'main', dirty: true, repositoryUrl: 'https://gitlab.test/p.git' }), changedPathStatuses: async () => [] },
    gitLocal: async () => paths.map(file => ` M ${file}`).join('\0') + '\0',
  } as unknown as HostPorts
  const pending: Array<() => Promise<void>> = []
  const reports = new MaterialStatusReports(store, api, ports, { record: async () => owner, deliver: work => { pending.push(work) } })
  await reports.report({ projectId: 'p', entityId: 'e', trigger: 'save', worktree: '/w' }); await pending[0]!()
  assert.equal(posts[0]!.changedPathCount, 3000)
  assert.match(posts[0]!.summary, /3001 个文件/)
  assert.ok(posts[0]!.summary.length <= 500)
})

test('status report setup failures stay local and never reject', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'status-setup-')); t.after(() => rm(root, { recursive: true, force: true }))
  const store = new StudioStore(root); store.useUser(1)
  const workspaceDirectory = path.join(root, 'project'), directory = path.join(workspaceDirectory, 'repo')
  await mkdir(directory, { recursive: true })
  ;(await store.read()).projects.push({ id: 'p', name: '项目', workspaceDirectory, directory, repositoryUrl: 'https://gitlab.test/p.git' })
  const owner: ScenarioRecord = { projectId: 'p', entityId: 'e', sources: [], sourcePaths: {} }
  ;(await store.read()).scenarios.push(owner); await store.save()
  const api = {} as CollaborationClient, ports = {} as HostPorts
  const input = { projectId: 'p', entityId: 'e', trigger: 'save' as const, worktree: '/w' }
  const missing = new MaterialStatusReports(store, api, ports, { record: async () => { throw new Error('本地记录不可读') }, deliver: () => { throw new Error('不应投递') } })
  await assert.doesNotReject(missing.report(input))
  const persist = store.save.bind(store)
  let failSave = true
  store.save = async () => { if (failSave) { failSave = false; throw new Error('本地持久化失败') } await persist() }
  const pending: Array<() => Promise<void>> = []
  const reports = new MaterialStatusReports(store, api, ports, { record: async () => owner, deliver: work => { pending.push(work) } })
  await assert.doesNotReject(reports.report(input))
  assert.equal(owner.statusReports![0]!.message, '本地持久化失败')
  const undelivered = new MaterialStatusReports(store, api, ports, { record: async () => owner, deliver: () => { throw new Error('后台投递失败') } })
  await assert.doesNotReject(undelivered.report(input))
  assert.equal(owner.statusReports![1]!.message, '后台投递失败')
})

test('AI summary failures and overlong results preserve bounded mechanical submissions', async t => {
  for (const kind of ['failure', 'long'] as const) {
    const root = await mkdtemp(path.join(tmpdir(), 'status-summary-')); t.after(() => rm(root, { recursive: true, force: true }))
    const store = new StudioStore(root); store.useUser(1)
  const workspaceDirectory = path.join(root, 'project'), directory = path.join(workspaceDirectory, 'repo')
  await mkdir(directory, { recursive: true })
  ;(await store.read()).projects.push({ id: 'p', name: '项目', workspaceDirectory, directory, repositoryUrl: 'https://gitlab.test/p.git' })
    const owner: ScenarioRecord = { projectId: 'p', entityId: 'e', sources: [], sourcePaths: {} }
    ;(await store.read()).scenarios.push(owner); await store.save()
    const posts: Array<{ summary: string }> = []
    const api = { async request(method: string, url: string, body: { summary: string }) { posts.push(body); return {} } } as unknown as CollaborationClient
    const ports = {
      git: { state: async () => ({ root: 'w', head, branch: 'main', dirty: true, repositoryUrl: 'https://gitlab.test/p.git' }), changedPathStatuses: async () => [] },
      gitLocal: async () => ' M 场景/登录.md\0',
      summarize: async () => { if (kind === 'failure') throw new Error('模型不可用'); return '补'.repeat(600) },
    } as unknown as HostPorts
    const pending: Array<() => Promise<void>> = []
    const reports = new MaterialStatusReports(store, api, ports, { record: async () => owner, deliver: work => { pending.push(work) } })
    await reports.report({ projectId: 'p', entityId: 'e', trigger: 'save', worktree: '/w' })
    await pending[0]!()
    const mechanical = '变更 1 个文件：场景/登录.md（修改）'
    assert.equal(posts.length, 1)
    if (kind === 'failure') assert.equal(posts[0]!.summary, mechanical)
    else {
      assert.equal(posts[0]!.summary.length, 500)
      assert.equal(posts[0]!.summary, `${mechanical}；${'补'.repeat(600)}`.slice(0, 500))
    }
  }
})
