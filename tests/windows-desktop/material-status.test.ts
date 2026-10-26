import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MaterialStatusReports } from '../../packages/studio-plugin/src/host/application/material-status.ts'
import { StudioStore } from '../../packages/studio-plugin/src/host/application/state.ts'
import type { ScenarioRecord } from '../../packages/studio-plugin/src/host/application/scenario-workspaces.ts'
import type { HostPorts } from '../../packages/studio-plugin/src/host/application/ports.ts'
import type { CollaborationClient } from '../../packages/studio-plugin/src/host/adapters/collaboration/client.ts'

const head = 'b'.repeat(40)
test('status reports carry mechanical plus optional AI summaries and recover after failure', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'status-')); t.after(() => rm(root, { recursive: true, force: true }))
  const store = new StudioStore(root); store.useUser(1)
  const owner: ScenarioRecord = { projectId: 'p', entityId: 'e', sources: [], sourcePaths: {} }
  ;(await store.read()).scenarios.push(owner); await store.save()
  const posts: Array<{ url: string; body: { summary: string; worktreeHead: string; changedPathCount: number; idempotencyKey: string } }> = []
  let failing = true
  const api = { async request(method: string, url: string, body: never) { if (failing) throw new Error('网络不可用'); posts.push({ url, body }); return {} } } as unknown as CollaborationClient
  const ports = {
    git: { state: async () => ({ root: 'w', head, branch: 'main', dirty: true, repositoryUrl: 'https://gitlab.test/p.git' }) },
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
  assert.match(posts[0]!.body.summary, /未提交变更 2 个文件：场景\/登录.md（修改）、场景\/新增.md（新增）/)
  assert.match(posts[0]!.body.summary, /本次编辑调整登录场景/)
  assert.ok(posts[0]!.body.summary.length <= 500)
  assert.equal(owner.statusReports![0]!.shared, true)
  reports.resume('p'); assert.equal(pending.length, 2, '已共享记录不再重发')
})
