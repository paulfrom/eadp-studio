import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ProjectWorkspaces } from '../../packages/studio-plugin/src/host/application/projects.ts'
import { StudioStore } from '../../packages/studio-plugin/src/host/application/state.ts'
import { BackgroundLane } from '../../packages/studio-plugin/src/host/application/background-lane.ts'
import { ProjectProgressTracker } from '../../packages/studio-plugin/src/host/application/progress.ts'
import { WorkspaceLocation } from '../../packages/studio-plugin/src/host/application/workspace-location.ts'
import type { CollaborationClient } from '../../packages/studio-plugin/src/host/adapters/collaboration/client.ts'
import type { HostPorts } from '../../packages/studio-plugin/src/host/application/ports.ts'

async function fixture(t: { after(fn: () => Promise<unknown>): unknown }) {
  const root = await mkdtemp(path.join(tmpdir(), 'eadp-location-lifecycle-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const stateRoot = path.join(root, 'state'), defaultRoot = path.join(root, 'default')
  const project = { id: 'project-1', name: '项目', gitlabProjectId: 11, namespaceId: 1, repositoryUrl: 'https://git.test/team/sample.git', stableBranch: 'main', initializationStatus: 'ready', recognizedHead: 'a'.repeat(40), revision: 1 }
  let clones = 0, failClone = false
  const api = { request: async () => ({ project }) } as unknown as CollaborationClient
  const create = (accountId = 1) => {
    const store = new StudioStore(stateRoot); store.useUser(accountId)
    const lane = new BackgroundLane()
    const ports = { workspaceRoot: defaultRoot, account: async () => ({ id: accountId }), git: {
      state: async () => ({ repositoryUrl: project.repositoryUrl, head: project.recognizedHead, dirty: false, branch: 'main' }),
      clone: async (_url: string, directory: string) => {
        clones++
        if (failClone) throw new Error('network unavailable')
        for (const name of ['.git', '场景', '需求', '交接', '原型代码']) await mkdir(path.join(directory, name), { recursive: true })
        await writeFile(path.join(directory, 'project.assets.json'), JSON.stringify({ schemaVersion: 1, projectId: project.id, gitlabProjectId: 11, repositoryUrl: project.repositoryUrl, stableBranch: 'main', directories: ['场景', '需求', '交接', '原型代码'], scenarioTemplates: { defaultTemplateId: 'default', templates: [{ id: 'default', name: '默认', path: '.template/default.md' }] }, requirementTemplates: { defaultTemplateId: 'requirement', templates: [{ id: 'requirement', name: '需求', path: '.template/requirement.md' }] } }))
      },
    } } as unknown as HostPorts
    return { store, lane, workspaces: new ProjectWorkspaces(store, api, ports, lane, new ProjectProgressTracker()) }
  }
  return { root, stateRoot, defaultRoot, create, clones: () => clones, failClone: (value: boolean) => { failClone = value }, location: new WorkspaceLocation(stateRoot, [stateRoot], defaultRoot) }
}

test('custom project folder owns its repo and survives reopening and full-folder loss', async t => {
  const f = await fixture(t), custom = path.join(f.root, 'custom')
  let app = f.create()
  await app.workspaces.open('project-1', custom); await app.lane.settle()
  assert.equal((await app.store.read()).projects[0]?.directory, path.join(custom, 'repo'))
  assert.deepEqual(JSON.parse(await readFile(path.join(custom, '.eadp/owner.json'), 'utf8')), { accountId: 1, projectId: 'project-1' })
  await f.location.set(path.join(f.root, 'changed-default'))
  await app.workspaces.open('project-1'); await app.lane.settle()
  assert.equal(f.clones(), 1)
  await assert.rejects(app.workspaces.open('project-1', path.join(f.root, 'elsewhere')), /不能.*移动/)
  ;(await app.store.read()).tasks.push({ projectId: 'project-1', entityId: 'draft', sessionId: 'session', purpose: 'material', inputHash: '', worktree: path.join(custom, 'worktree') })
  await app.store.save()
  await rm(custom, { recursive: true })
  app = f.create()
  assert.equal((await app.store.read()).tasks.length, 0)
  assert.equal((await app.store.read()).projects[0]?.workspaceDirectory, custom)
  await assert.rejects(readFile(path.join(custom, '.eadp/owner.json')), { code: 'ENOENT' })
  await app.workspaces.open('project-1', custom); await app.lane.settle()
  assert.equal(f.clones(), 2)
  assert.equal((await app.store.read()).projects[0]?.workspaceDirectory, custom)
})

test('opening captures the default folder before background execution', async t => {
  const f = await fixture(t), app = f.create()
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  app.lane.append(() => blocked)
  await app.workspaces.open('project-1')
  const selected = (await app.store.read()).projectInitializations[0]!.workspaceDirectory
  assert.equal(selected, path.join(f.defaultRoot, 'sample-project-'))
  await f.location.set(path.join(f.root, 'new-default'))
  release(); await app.lane.settle()
  assert.equal((await app.store.read()).projects[0]?.workspaceDirectory, selected)
})

test('rejects another account owner without changing user files', async t => {
  const f = await fixture(t), custom = path.join(f.root, 'occupied'), app = f.create(2)
  await mkdir(custom)
  await writeFile(path.join(custom, 'sentinel.txt'), 'unique draft')
  await mkdir(path.join(custom, '.eadp')); await writeFile(path.join(custom, '.eadp/owner.json'), JSON.stringify({ projectId: 'project-1', accountId: 1 }))
  await app.workspaces.open('project-1', custom); await app.lane.settle()
  const state = await app.store.read()
  assert.equal(state.projects.length, 0)
  assert.match(state.projectInitializations[0]!.message!, /其他项目或账号/)
  assert.equal(await readFile(path.join(custom, 'sentinel.txt'), 'utf8'), 'unique draft')
  assert.equal(f.clones(), 0)
})

for (const checkout of [false, true]) test(`initializing in a nonempty folder clones Git and preserves existing ${checkout ? 'checkout' : 'files'}`, async t => {
  const f = await fixture(t), custom = path.join(f.root, 'occupied'), app = f.create()
  await mkdir(path.join(custom, 'repo'), { recursive: true })
  await writeFile(path.join(custom, 'sentinel.txt'), 'root draft')
  await writeFile(path.join(custom, 'repo', 'draft.txt'), 'unique checkout draft')
  if (checkout) await mkdir(path.join(custom, 'repo', '.git'))
  await app.workspaces.open('project-1', custom); await app.lane.settle()
  const state = await app.store.read()
  assert.equal(state.projectInitializations[0]?.phase, 'ready', state.projectInitializations[0]?.message)
  assert.equal(f.clones(), 1)
  assert.equal(await readFile(path.join(custom, 'sentinel.txt'), 'utf8'), 'root draft')
  const preserved = (await readdir(custom)).find(name => name.startsWith('repo.backup-'))
  assert.ok(preserved)
  assert.equal(await readFile(path.join(custom, preserved, 'draft.txt'), 'utf8'), 'unique checkout draft')
})

test('root files do not prevent cloning into the project repo', async t => {
  const f = await fixture(t), custom = path.join(f.root, 'occupied'), app = f.create()
  await mkdir(custom)
  await writeFile(path.join(custom, 'sentinel.txt'), 'unique draft')
  await app.workspaces.open('project-1', custom); await app.lane.settle()
  assert.equal((await app.store.read()).projectInitializations[0]?.phase, 'ready')
  assert.equal(f.clones(), 1)
  assert.equal(await readFile(path.join(custom, 'sentinel.txt'), 'utf8'), 'unique draft')
  assert.equal((await readdir(custom)).filter(name => name.startsWith('repo.backup-')).length, 0)
})

test('failed clone preserves the old repo draft through a successful retry', async t => {
  const f = await fixture(t), custom = path.join(f.root, 'occupied'), app = f.create()
  await mkdir(path.join(custom, 'repo'), { recursive: true })
  await writeFile(path.join(custom, 'repo', 'draft.txt'), 'unique draft')
  f.failClone(true)
  await app.workspaces.open('project-1', custom); await app.lane.settle()
  const operation = (await app.store.read()).projectInitializations[0]!
  assert.match(operation.message!, /network unavailable/)
  const preserved = (await readdir(custom)).find(name => name.startsWith('repo.backup-'))
  assert.ok(preserved)
  assert.equal(await readFile(path.join(custom, preserved, 'draft.txt'), 'utf8'), 'unique draft')
  f.failClone(false)
  await app.workspaces.retry(operation.id); await app.lane.settle()
  assert.equal((await app.store.read()).projectInitializations[0]?.phase, 'ready')
  assert.equal(f.clones(), 2)
  assert.equal(await readFile(path.join(custom, preserved, 'draft.txt'), 'utf8'), 'unique draft')
})
