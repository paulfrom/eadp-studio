/**
 * Background work never blocks a projection read: the lane owns Git
 * synchronization, and a read that misses an object reports the miss and gets
 * the bytes on the next read.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { ProjectView } from '@eadp/contracts'
import { BackgroundLane } from '../../packages/studio-plugin/src/host/application/background-lane.ts'
import { ProjectWorkspaces } from '../../packages/studio-plugin/src/host/application/projects.ts'
import { StudioStore } from '../../packages/studio-plugin/src/host/application/state.ts'
import type { CollaborationClient } from '../../packages/studio-plugin/src/host/adapters/collaboration/client.ts'
import type { HostPorts } from '../../packages/studio-plugin/src/host/application/ports.ts'

test('identical work runs once, in submission order, and a failed key is retried', async () => {
  const lane = new BackgroundLane(), ran: string[] = []
  const gate: Array<() => void> = []
  const blocked = (): Promise<void> => new Promise<void>(resolve => { gate.push(resolve) })
  lane.schedule('first', async () => { ran.push('first'); await blocked() })
  // The projection reads the same key twice while the first is still queued.
  lane.schedule('first', async () => { ran.push('first-again') })
  lane.schedule('second', async () => { ran.push('second') })
  const settling = lane.settle()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(ran, ['first'], 'work runs one piece at a time, and a duplicate key is dropped')
  gate[0]!()
  await settling
  assert.deepEqual(ran, ['first', 'second'])
  // A remembered key is not repeated: the next read reuses what already ran.
  lane.schedule('first', async () => { ran.push('first-again') })
  await lane.settle()
  assert.deepEqual(ran, ['first', 'second'])
  // A failure is not remembered, so the next projection read retries the work.
  let attempts = 0
  lane.schedule('flaky', async () => { attempts += 1; throw new Error('网络不可用') })
  await lane.settle()
  lane.schedule('flaky', async () => { attempts += 1 })
  await lane.settle()
  assert.equal(attempts, 2)
})

test('appended work runs after a failed piece and is awaited when queued during settling', async () => {
  const lane = new BackgroundLane(), ran: string[] = []
  lane.schedule('fails', async () => { throw new Error('失败') })
  lane.append(async () => { ran.push('after-failure') })
  lane.schedule('queues-more', async () => { ran.push('outer'); lane.append(async () => { ran.push('inner') }) })
  await lane.settle()
  assert.deepEqual(ran, ['after-failure', 'outer', 'inner'])
})

const project: ProjectView = { id: 'project', gitlabProjectId: 1, repositoryUrl: 'http://gitlab.example.test/team/project.git', stableBranch: 'main', namespaceId: 7, namespacePath: 'team', initializationStatus: 'ready', name: '项目', recognizedHead: 'b'.repeat(40), revision: 1 }
const commit = 'a'.repeat(40)
const body = '固定场景内容'
const hash = createHash('sha256').update(body).digest('hex')

async function fixture(t: test.TestContext) {
  const workspace = await mkdtemp(path.join(tmpdir(), 'studio-background-lane-')), root = path.join(workspace, 'repo'); await mkdir(root, { recursive: true })
  const store = new StudioStore(path.join(root, 'state')); store.useUser(1); await store.read()
  let haveCommit = false
  const calls: string[] = []
  const api = { request: async () => { throw new Error('local fixed reads must not request project details') } } as unknown as CollaborationClient
  const ports = {
    workspaceRoot: path.join(root, 'workspace'),
    git: {
      hasCommit: async () => haveCommit,
      fetchCommit: async () => { calls.push('fetch'); haveCommit = true },
      clone: async (_url: string, directory: string) => { calls.push('clone'); await mkdir(directory, { recursive: true }) },
      readBlob: async () => { calls.push('read'); return Buffer.from(body) },
    },
  } as unknown as HostPorts
  const lane = new BackgroundLane()
  const service = new ProjectWorkspaces(store, api, ports, lane)
  t.after(async () => { await lane.settle(); await service.dispose(); await rm(workspace, { recursive: true, force: true }) })
  return { store, lane, service, calls, root }
}

test('a fixed material read answers without the network and delivers it once the lane caught up', async t => {
  const f = await fixture(t)
  // No local worktree yet: the read reports the miss and queues the read-only mirror.
  assert.equal(await f.service.localFixed(project, commit, '场景/scene.md', hash), undefined)
  assert.deepEqual(f.calls, [], 'the read itself performs no Git work')
  await f.lane.settle()
  assert.deepEqual(f.calls, ['clone'])
  // The mirror has no such commit yet: the read misses again and queues the fetch.
  assert.equal(await f.service.localFixed(project, commit, '场景/scene.md', hash), undefined)
  await f.lane.settle()
  assert.deepEqual(f.calls, ['clone', 'fetch'])
  assert.equal(Buffer.from((await f.service.localFixed(project, commit, '场景/scene.md', hash))!).toString('utf8'), body)
  // A known material is served from memory.
  f.calls.length = 0
  assert.equal(Buffer.from((await f.service.localFixed(project, commit, '场景/scene.md', hash))!).toString('utf8'), body)
  assert.deepEqual(f.calls, [], 'a cached material needs no Git work')
})

test('a material copied into the local project is read from it and a hash mismatch is refused', async t => {
  const f = await fixture(t)
  const local = await f.store.read()
  local.projects.push({ id: 'project', name: '项目', directory: path.join(f.root, 'workspace', 'repo'), workspaceDirectory: f.root, repositoryUrl: project.repositoryUrl })
  await f.store.save()
  assert.equal(await f.service.localFixed(project, commit, '场景/scene.md', hash), undefined)
  await f.lane.settle()
  assert.deepEqual(f.calls, ['fetch'])
  assert.equal(Buffer.from((await f.service.localFixed(project, commit, '场景/scene.md', hash))!).toString('utf8'), body)
  await assert.rejects(f.service.localFixed(project, commit, '场景/scene.md', 'c'.repeat(64)), /哈希校验失败/)
})

test('the mirror is removed when the workspace is disposed', async t => {
  const f = await fixture(t)
  await f.service.localFixed(project, commit, '场景/scene.md')
  await f.lane.settle()
  assert.ok((await readdir(f.store.directory)).some(name => name.startsWith('read-cache-project-')), 'the mirror lives under the user record')
  await f.service.dispose()
  assert.equal((await readdir(f.store.directory)).some(name => name.startsWith('read-cache-')), false)
})


test('multiple fixed materials and repeated cached reads reuse the authorized project without HTTP', async t => {
  const f = await fixture(t)
  const local = await f.store.read()
  local.projects.push({ id: project.id, name: project.name, directory: f.root, workspaceDirectory: f.root, repositoryUrl: project.repositoryUrl })
  await f.store.save()
  await f.service.localFixed(project, commit, 'first.md', hash)
  await f.lane.settle()
  for (const file of ['first.md', 'second.md', 'first.md', 'second.md']) {
    assert.equal(Buffer.from((await f.service.localFixed(project, commit, file, hash))!).toString(), body)
  }
  assert.deepEqual(f.calls, ['fetch', 'read', 'read'])
  await assert.rejects(f.service.localFixed({ ...project, repositoryUrl: 'http://other.example/repo.git' }, commit, 'first.md', hash), /仓库身份不一致/)
})
