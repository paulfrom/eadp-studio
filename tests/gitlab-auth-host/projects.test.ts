import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import type { ProjectView, StudioUser } from '@eadp/contracts'
import { ProjectWorkspaces } from '../../packages/studio-plugin/src/host/application/projects.ts'
import { StudioStore } from '../../packages/studio-plugin/src/host/application/state.ts'
import { StudioApplication } from '../../packages/studio-plugin/src/host/application/studio.ts'
import { BackgroundLane } from '../../packages/studio-plugin/src/host/application/background-lane.ts'
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
    if (method === 'GET' && route === '/v1/projects/project-1/templates') {
      const file = '.template/default.md'
      const bytes = await readFile(path.join(workspaceRoot, 'users/1/project-project-1', file))
      return { defaultTemplateId: 'default', templates: [{ id: 'default', name: '默认场景模板', fixed: { commitSha: sha, path: file, sha256: createHash('sha256').update(bytes).digest('hex') } }] }
    }
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
      hasCommit: async () => true,
      fetchCommit: async () => {},
      state: async () => ({ head: localHead, repositoryUrl: project.repositoryUrl, dirty: false, branch: 'main' }),
      readBlob: async (directory: string, _sha: string, file: string) => readFile(path.join(directory, file)),
      commitFiles: async (directory: string, _files: string[], _message: string, identity: object) => {
        ++commits; assert.deepEqual(identity, { name: user.name, email: user.gitlabEmail })
        const manifest = JSON.parse(await readFile(path.join(directory, 'project.assets.json'), 'utf8'))
        assert.deepEqual(manifest, { schemaVersion: 1, projectId: project.id, gitlabProjectId: 101, repositoryUrl: project.repositoryUrl, stableBranch: 'main', directories: ['场景', '需求', '交接', '原型代码'], scenarioTemplates: { defaultTemplateId: 'default', templates: [{ id: 'default', name: '默认场景模板', path: '.template/default.md' }] } })
        assert.ok(_files.includes('.template/default.md'), 'initial commit must include the declared default template')
        assert.match(await readFile(path.join(directory, '.template/default.md'), 'utf8'), /目标与范围/)
        localHead = sha; return sha
      },
      push: async () => { ++pushes; remoteHead = sha; if (failure === 'push-response' && !failed) { failed = true; throw new Error('推送响应丢失') } },
    },
    gitLocal: async () => 'project.assets.json\0.gitattributes\0.template/default.md\0场景/.gitkeep\0需求/.gitkeep\0交接/.gitkeep\0原型代码/package.json\0',
    installTemplate: async (directory: string) => { await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, 'package.json'), '{}\n') },
  } as unknown as HostPorts
  const store = new StudioStore(storeRoot); store.useUser(user.id)
  const lane = new BackgroundLane()
  const service = new ProjectWorkspaces(store, api, ports, lane)
  return { settlement: () => lane.settle(), root, storeRoot, workspaceRoot, store, service, ports, api, calls, setUser: (next?: StudioUser) => { currentUser = next },
    counts: () => ({ creates, uniqueCreations: creationKeys.size, commits, pushes, initializes, clones }),
    dispose: async () => { await lane.settle(); await service.dispose(); await rm(root, { recursive: true, force: true }) } }
}

/**
 * Queue one creation and wait for the background lane. `create` returns at once,
 * so the test observes the project initialization it recorded.
 */
async function queued(f: Awaited<ReturnType<typeof fixture>>) {
  await f.service.create(command)
  await f.settlement()
  return (await f.store.read()).projectInitializations[0]!
}
/** A restarted Host service over the same local store, with its own fresh lane. */
function restarted(f: Awaited<ReturnType<typeof fixture>>) {
  const store = new StudioStore(f.storeRoot); store.useUser(1)
  const lane = new BackgroundLane()
  return { store, lane, service: new ProjectWorkspaces(store, f.api, f.ports, lane) }
}

test('project creation persists its key before POST and initializes the backend-created private repository', async () => {
  const f = await fixture()
  try {
    const operation = await queued(f)
    assert.equal(operation.phase, 'ready')
    assert.deepEqual(f.counts(), { creates: 1, uniqueCreations: 1, commits: 1, pushes: 1, initializes: 1, clones: 0 })
    const saved = await f.store.read(); assert.equal(saved.projects[0]!.id, 'project-1'); assert.equal(saved.projectInitializations[0]!.phase, 'ready')
    assert.equal(JSON.stringify(saved).includes('studio_'), false)
  } finally { await f.dispose() }
})

test('lost create response is retried with the original body/key after restarting the local store', async () => {
  const f = await fixture('create-response')
  try {
    const failed = await queued(f)
    assert.equal(failed.phase, 'unknown'); assert.match(failed.message ?? '', /响应丢失/)
    const next = restarted(f)
    await next.service.create(command); await next.lane.settle()
    assert.equal(f.counts().creates, 2); assert.equal(f.counts().uniqueCreations, 1); assert.equal(f.counts().commits, 1)
    assert.equal((await next.store.read()).projectInitializations.length, 1)
  } finally { await f.dispose() }
})

test('lost push response is reconciled from the real remote head without committing or pushing again', async () => {
  const f = await fixture('push-response')
  try {
    const failed = await queued(f)
    assert.match(failed.message ?? '', /响应丢失/)
    const next = restarted(f)
    await next.service.retry(failed.id); await next.lane.settle()
    assert.equal(f.counts().creates, 1); assert.equal(f.counts().pushes, 1); assert.equal(f.counts().commits, 1); assert.equal(f.counts().initializes, 1)
    assert.equal((await next.store.read()).projects.length, 1)
  } finally { await f.dispose() }
})

test('lost initialize response opens the accepted project without a second initialization or remote creation', async () => {
  const f = await fixture('initialize-response')
  try {
    const failed = await queued(f)
    assert.match(failed.message ?? '', /响应丢失/)
    await f.service.retry(failed.id); await f.settlement()
    assert.equal(f.counts().initializes, 1); assert.equal(f.counts().creates, 1); assert.equal((await f.store.read()).projects.length, 1)
  } finally { await f.dispose() }
})

test('an unknown existing directory is preserved and never adopted by an initialization', async () => {
  const f = await fixture()
  try {
    const directory = path.join(f.workspaceRoot, 'users/1/project-project-1'); await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, 'private.txt'), 'preserve me')
    const failed = await queued(f)
    assert.match(failed.message ?? '', /缺少本项目的持久归属记录/)
    assert.equal(await readFile(path.join(directory, 'private.txt'), 'utf8'), 'preserve me')
    assert.equal(f.counts().commits, 0); assert.equal(f.counts().pushes, 0)
  } finally { await f.dispose() }
})

test('a rebuilt local record adopts the directory its marker names instead of initializing again', async () => {
  const f = await fixture()
  try {
    await queued(f)
    const directory = path.join(f.workspaceRoot, 'users/1/project-project-1')
    await readFile(path.join(directory, 'project.assets.json'))
    // The previous version left an unusable record: the next start preserves it and rebuilds.
    await writeFile(path.join(f.storeRoot, 'users/1/studio-state.json'), '{"clientId":1}')
    const next = restarted(f)
    try {
      assert.deepEqual((await next.store.read()).projects, [])
      assert.ok(next.store.preservedRecord)
      await next.service.open('project-1'); await next.lane.settle()
      const local = await next.store.read()
      assert.deepEqual(local.projects.map(project => project.directory), [directory], 'the marker-named directory is adopted')
      assert.equal(local.selectedProjectId, 'project-1')
      assert.equal(local.projectInitializations[0]!.phase, 'ready')
      assert.equal(f.counts().initializes, 1, 'an already accepted initialization is not sent again')
      assert.equal(f.counts().clones, 0, 'the existing clone is reused')
    } finally { await next.lane.settle(); await next.service.dispose() }
  } finally { await f.dispose() }
})

/** Rewrite the accepted local manifest as one recorded before the template catalog existed. */
async function withoutTemplateCatalog(directory: string): Promise<void> {
  const manifest = JSON.parse(await readFile(path.join(directory, 'project.assets.json'), 'utf8')) as Record<string, unknown>
  delete manifest.scenarioTemplates
  await writeFile(path.join(directory, 'project.assets.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await rm(path.join(directory, '.template'), { recursive: true, force: true })
}

test('an accepted project whose manifest predates the template catalog opens instead of failing initialization', async () => {
  const f = await fixture()
  try {
    await queued(f)
    const directory = path.join(f.workspaceRoot, 'users/1/project-project-1')
    await withoutTemplateCatalog(directory)
    // A rebuilt local record re-adopts the marker-named directory, exactly as the
    // production case where the accepted manifest has no `scenarioTemplates`.
    await writeFile(path.join(f.storeRoot, 'users/1/studio-state.json'), '{"clientId":1}')
    const next = restarted(f)
    try {
      await next.service.open('project-1'); await next.lane.settle()
      const local = await next.store.read()
      assert.deepEqual(local.projects.map(project => project.directory), [directory], 'the legacy accepted project is opened')
      assert.equal(local.projectInitializations[0]!.phase, 'ready')
      assert.equal(local.projectInitializations[0]!.message, undefined, 'opening does not report an invalid manifest')
      assert.equal(f.counts().initializes, 1, 'the accepted initialization is not sent again')
      assert.equal(f.counts().clones, 0, 'the existing clone is reused')
    } finally { await next.lane.settle(); await next.service.dispose() }
  } finally { await f.dispose() }
})

test('signed-out and other users never receive old local projects, tasks or pending operations', async () => {
  const f = await fixture()
  try {
    await f.service.create(command); await f.settlement()
    const app = new StudioApplication(f.store, f.api, f.ports)
    assert.equal((await app.state()).projects.length, 1)
    f.calls.length = 0; f.setUser()
    assert.deepEqual((await app.state()).availableProjects, []); assert.equal(f.calls.length, 0)
    f.setUser({ ...user, id: 2, username: 'other' })
    const state = await app.state(); assert.deepEqual(state.projects, []); assert.deepEqual(state.tasks, []); assert.deepEqual(state.pending, []); assert.deepEqual(state.projectInitializations, [])
    f.setUser(user); assert.equal((await app.state()).projects.length, 1)
  } finally { await f.dispose() }
})

test('late image read evidence is rejected immediately after the account changes, before the next state poll', async () => {
  const f = await fixture()
  try {
    await f.service.create(command); await f.settlement()
    const local = await f.store.read(), sourcePath = path.join(f.store.directory, 'scenario-sources', 'image.png')
    const source = { id: 'image', name: 'image.png', format: 'png', sha256: 'a'.repeat(64), status: 'failed' as const, ranges: [] as string[], text: '', selected: true, formal: false }
    local.tasks.push({ projectId: 'project-1', entityId: 'scene', sessionId: 'user-one-session', purpose: 'material', inputHash: '', worktree: local.projects[0]!.directory })
    local.scenarios.push({ projectId: 'project-1', entityId: 'scene', sources: [source], sourcePaths: { image: sourcePath } })
    await f.store.save()
    const app = new StudioApplication(f.store, f.api, f.ports)
    const before = await readFile(path.join(f.store.directory, 'studio-state.json'), 'utf8')
    f.setUser({ ...user, id: 2, username: 'other' })
    await app.acceptSessionOutput('user-one-session', { kind: 'source-read', path: sourcePath, attachmentId: 'old-user-attachment', ranges: ['image:1'] })
    assert.equal(source.status, 'failed', 'late output cannot mutate the previous account while polling has not switched store scope')
    const firstUser = new StudioStore(f.storeRoot); firstUser.useUser(1)
    assert.equal(await readFile(path.join(firstUser.directory, 'studio-state.json'), 'utf8'), before)
    assert.deepEqual((await firstUser.read()).scenarios[0]!.sources[0]!.ranges, [])
  } finally { await f.dispose() }
})

test('template copying resumes identical partial bytes, refuses changed files and preserves the original', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-template-resume-'))
  const templateRoot = path.resolve(import.meta.dirname, '../../packages/studio-plugin/assets/prototype-template'), manifestPath = `${templateRoot}.manifest.json`, destinationRoot = path.join(root, 'prototype')
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
