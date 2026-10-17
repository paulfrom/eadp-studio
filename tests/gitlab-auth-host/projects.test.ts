import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import type { ProjectView, StudioUser } from '@eadp/contracts'
import { ProjectWorkspaces } from '../../packages/studio-plugin/src/host/application/projects.ts'
import { StudioStore } from '../../packages/studio-plugin/src/host/application/state.ts'
import { StudioApplication } from '../../packages/studio-plugin/src/host/application/studio.ts'
import type { CollaborationClient } from '../../packages/studio-plugin/src/host/adapters/collaboration/client.ts'
import type { HostPorts } from '../../packages/studio-plugin/src/host/application/ports.ts'
import { copyTemplate, verifyTemplate } from '../../packages/studio-plugin/src/host/prototype/template.ts'

const user: StudioUser = { id: 1, username: 'tester', name: '测试管理员', email: 'tester@example.test', admin: true, gitlabUserId: 17, gitlabUsername: 'liu', gitlabEmail: 'liu@example.test' }
const sha = 'a'.repeat(40)
const initial = (): ProjectView => ({ id: 'project-1', gitlabProjectId: 101, repositoryUrl: 'http://gitlab.example.test/team/project.git', stableBranch: 'main', namespaceId: 7, namespacePath: 'team', initializationStatus: 'pending', name: '项目', recognizedHead: null, revision: 0, categories: [] })
const command = { action: 'createProject' as const, name: '项目', namespaceId: 7, path: 'project' }
async function fixture(failure?: 'create-response' | 'push-response' | 'initialize-response') {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-project-recovery-')), storeRoot = path.join(root, 'state'), workspaceRoot = path.join(root, 'workspace')
  let currentUser: StudioUser | undefined = user, project = initial(), remoteHead: string | undefined, localHead: string | undefined
  let failed = false, creates = 0, commits = 0, pushes = 0, initializes = 0, clones = 0
  const creationKeys = new Set<string>(), calls: string[] = []
  const api = { request: async (method: string, route: string, body?: Record<string, unknown>) => {
    calls.push(`${method} ${route}`)
    if (method === 'POST' && route === '/v1/projects') {
      ++creates; creationKeys.add(String(body!.idempotencyKey))
      assert.deepEqual({ name: body!.name, namespaceId: body!.namespaceId, path: body!.path }, { name: '项目', namespaceId: 7, path: 'project' })
      assert.equal('repositoryUrl' in body!, false); assert.equal('gitlabProjectId' in body!, false)
      if (failure === 'create-response' && !failed) { failed = true; throw new Error('建仓响应丢失') }
      return project
    }
    if (method === 'POST' && route.endsWith('/initialize')) {
      ++initializes; assert.equal(body!.commitSha, sha); assert.equal(remoteHead, sha)
      project = { ...project, initializationStatus: 'ready', recognizedHead: sha }
      if (failure === 'initialize-response' && !failed) { failed = true; throw new Error('初始化响应丢失') }
      return project
    }
    if (route === '/v1/projects') return currentUser?.id === 1 ? [project] : []
    if (route === '/v1/namespaces') return [{ id: 7, name: '团队', fullPath: 'team' }]
    return { project, entities: [], baselines: [], integrations: [] }
  } } as unknown as CollaborationClient
  const ports = {
    workspaceRoot,
    account: async () => currentUser,
    stopPreview: async () => {},
    git: {
      init: async (directory: string) => { await mkdir(path.join(directory, '.git')); calls.push('git init') },
      clone: async (_url: string, directory: string) => { ++clones; await mkdir(path.join(directory, '.git')); localHead = remoteHead },
      probeRemoteHead: async () => remoteHead,
      head: async () => localHead,
      fetchCommit: async () => {},
      state: async () => ({ head: localHead, repositoryUrl: project.repositoryUrl, dirty: false, branch: 'main' }),
      readBlob: async (directory: string, _sha: string, file: string) => readFile(path.join(directory, file)),
      commitFiles: async (directory: string, _files: string[], _message: string, identity: object) => {
        ++commits; assert.deepEqual(identity, { name: user.name, email: user.gitlabEmail })
        const manifest = JSON.parse(await readFile(path.join(directory, 'project.assets.json'), 'utf8'))
        assert.deepEqual(manifest, { schemaVersion: 1, projectId: project.id, gitlabProjectId: 101, repositoryUrl: project.repositoryUrl, stableBranch: 'main', directories: ['场景', '需求', '原型代码'] })
        localHead = sha; return sha
      },
      push: async () => { ++pushes; remoteHead = sha; if (failure === 'push-response' && !failed) { failed = true; throw new Error('推送响应丢失') } },
    },
    gitLocal: async () => 'project.assets.json\0.gitattributes\0场景/.gitkeep\0需求/.gitkeep\0原型代码/package.json\0',
    installTemplate: async (directory: string) => { await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, 'package.json'), '{}\n') },
  } as unknown as HostPorts
  const store = new StudioStore(storeRoot); store.useUser(user.id)
  const service = new ProjectWorkspaces(store, api, ports)
  return { root, storeRoot, workspaceRoot, store, service, ports, api, calls, setUser: (next?: StudioUser) => { currentUser = next },
    counts: () => ({ creates, uniqueCreations: creationKeys.size, commits, pushes, initializes, clones }),
    dispose: async () => { await service.dispose(); await rm(root, { recursive: true, force: true }) } }
}

test('project creation persists its key before POST and initializes the backend-created private repository', async () => {
  const f = await fixture()
  try {
    await f.service.create(command)
    assert.deepEqual(f.counts(), { creates: 1, uniqueCreations: 1, commits: 1, pushes: 1, initializes: 1, clones: 0 })
    const saved = await f.store.read(); assert.equal(saved.projects[0]!.id, 'project-1'); assert.equal(saved.projectInitializations[0]!.phase, 'ready')
    assert.equal(JSON.stringify(saved).includes('studio_'), false)
  } finally { await f.dispose() }
})

test('lost create response is retried with the original body/key after restarting the local store', async () => {
  const f = await fixture('create-response')
  try {
    await assert.rejects(f.service.create(command), /响应丢失/)
    const rebooted = new StudioStore(f.storeRoot); rebooted.useUser(1)
    const service = new ProjectWorkspaces(rebooted, f.api, f.ports)
    await service.create(command)
    assert.equal(f.counts().creates, 2); assert.equal(f.counts().uniqueCreations, 1); assert.equal(f.counts().commits, 1)
    assert.equal((await rebooted.read()).projectInitializations.length, 1)
  } finally { await f.dispose() }
})

test('lost push response is reconciled from the real remote head without committing or pushing again', async () => {
  const f = await fixture('push-response')
  try {
    await assert.rejects(f.service.create(command), /响应丢失/)
    const operation = (await f.store.read()).projectInitializations[0]!
    const rebooted = new StudioStore(f.storeRoot); rebooted.useUser(1)
    await new ProjectWorkspaces(rebooted, f.api, f.ports).resume(operation.id)
    assert.equal(f.counts().creates, 1); assert.equal(f.counts().pushes, 1); assert.equal(f.counts().commits, 1); assert.equal(f.counts().initializes, 1)
    assert.equal((await rebooted.read()).projects.length, 1)
  } finally { await f.dispose() }
})

test('lost initialize response opens the accepted project without a second initialization or remote creation', async () => {
  const f = await fixture('initialize-response')
  try {
    await assert.rejects(f.service.create(command), /响应丢失/)
    await f.service.resume((await f.store.read()).projectInitializations[0]!.id)
    assert.equal(f.counts().initializes, 1); assert.equal(f.counts().creates, 1); assert.equal((await f.store.read()).projects.length, 1)
  } finally { await f.dispose() }
})

test('an unknown existing directory is preserved and cannot be adopted by a pending initialization', async () => {
  const f = await fixture()
  try {
    const directory = path.join(f.workspaceRoot, 'users/1/project-project-1'); await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, 'private.txt'), 'preserve me')
    await assert.rejects(f.service.create(command), /不属于本任务/)
    assert.equal(await readFile(path.join(directory, 'private.txt'), 'utf8'), 'preserve me')
    assert.equal(f.counts().commits, 0); assert.equal(f.counts().pushes, 0)
  } finally { await f.dispose() }
})

test('signed-out and other users never receive old local projects, tasks or pending operations', async () => {
  const f = await fixture()
  try {
    await f.service.create(command)
    const app = new StudioApplication(f.store, f.api, f.ports)
    assert.equal((await app.state()).projects.length, 1)
    f.calls.length = 0; f.setUser()
    assert.deepEqual((await app.state()).availableProjects, []); assert.equal(f.calls.length, 0)
    f.setUser({ ...user, id: 2, username: 'other' })
    const state = await app.state(); assert.deepEqual(state.projects, []); assert.deepEqual(state.tasks, []); assert.deepEqual(state.pending, []); assert.deepEqual(state.projectInitializations, [])
    f.setUser(user); assert.equal((await app.state()).projects.length, 1)
  } finally { await f.dispose() }
})

test('template copying resumes identical partial bytes, refuses changed files and preserves the original', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-template-resume-'))
  const templateRoot = path.resolve('packages/studio-plugin/assets/prototype-template'), manifestPath = `${templateRoot}.manifest.json`, destinationRoot = path.join(root, 'prototype')
  try {
    const manifest = await verifyTemplate(templateRoot, manifestPath), first = [...manifest.files, ...manifest.addedFiles][0]!
    await mkdir(path.dirname(path.join(destinationRoot, first.path)), { recursive: true }); await writeFile(path.join(destinationRoot, first.path), await readFile(path.join(templateRoot, first.path)))
    await copyTemplate({ templateRoot, manifestPath, destinationRoot }); await copyTemplate({ templateRoot, manifestPath, destinationRoot })
    await writeFile(path.join(destinationRoot, first.path), 'preserve user change')
    await assert.rejects(copyTemplate({ templateRoot, manifestPath, destinationRoot }), /differs/)
    assert.equal(await readFile(path.join(destinationRoot, first.path), 'utf8'), 'preserve user change')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('state polling never re-reads the namespace catalogue and the project dialog fetches it on demand', async () => {
  const f = await fixture()
  try {
    const app = new StudioApplication(f.store, f.api, f.ports)
    const polled = await app.command({ action: 'state' })
    assert.equal(polled.ok, true)
    assert.equal(f.calls.includes('GET /v1/namespaces'), false)
    assert.deepEqual(polled.ok && polled.state.namespaces, [])
    const offered = await app.command({ action: 'namespaces' })
    assert.equal(offered.ok, true)
    assert.deepEqual(offered.ok && offered.state.namespaces, [{ id: 7, name: '团队', fullPath: 'team' }])
    const refreshed = await app.command({ action: 'state' })
    assert.deepEqual(refreshed.ok && refreshed.state.namespaces, [{ id: 7, name: '团队', fullPath: 'team' }])
    assert.equal(f.calls.filter(call => call === 'GET /v1/namespaces').length, 1)
  } finally { await f.dispose() }
})
