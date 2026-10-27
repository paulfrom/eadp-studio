import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { isMaterialIntegrationRequest, type EntityView, type IntegrationView, type MaterialIntegrationRequest, type MaterialMetadata, type ProjectState } from '../../packages/contracts/src/index.ts'
import type { MaterialDraft, StudioCommand, TaskView } from '../../packages/studio-plugin/src/shared/studio.ts'
import { CollaborationError, type CollaborationClient } from '../../packages/studio-plugin/src/host/adapters/collaboration/client.ts'
import { digest, parseMaterial, readMaterial, saveMaterial } from '../../packages/studio-plugin/src/host/adapters/assets/materials.ts'
import type { HostPorts } from '../../packages/studio-plugin/src/host/application/ports.ts'
import { StudioApplication } from '../../packages/studio-plugin/src/host/application/studio.ts'
import { StudioStore } from '../../packages/studio-plugin/src/host/application/state.ts'

const templateBody = '## 业务规则\n\n## 验收条件\n'
const templateRef = { commitSha: 'a'.repeat(40), path: '.template/default.md', sha256: digest(templateBody) }
const evidencePath = '.eadp/evidence/fixture/approved.md'
const evidenceBody = '业务访谈：审批按已记录的规则执行，并保留可核验的确认版本。\n'

async function fixture(t: test.TestContext) {
  const parent = await mkdtemp(path.join(tmpdir(), 'eadp-requirement-confirmation-')), root = path.join(parent, 'task')
  await mkdir(root)
  await mkdir(path.dirname(path.join(root, templateRef.path)), { recursive: true }); await writeFile(path.join(root, templateRef.path), templateBody)
  await mkdir(path.dirname(path.join(root, evidencePath)), { recursive: true }); await writeFile(path.join(root, evidencePath), evidenceBody)
  const stateRoot = path.join(parent, 'state'), store = new StudioStore(stateRoot); store.useUser(1)
  const local = await store.read()
  local.selectedProjectId = 'project'
  local.projects.push({ id: 'project', name: '项目', directory: root, repositoryUrl: 'https://git.test/project.git' })
  const entity: EntityView = { id: 'requirement', kind: 'requirement', generation: 1, revision: 1, title: '审批需求', scenarioIds: ['scene'], scenarioSources: [{ projectId: 'project', entityId: 'scene', version: 1 }], prerequisites: [], templateId: 'default', templateRef, materialVersion: 0,
    authorId: 1, confirmationStatus: 'draft', taskStatus: 'active',
    occupation: { occupationId: 'occupation', generation: 1, entityId: 'requirement', taskId: 'task', clientId: local.clientId, expectedRevision: 1, ownerId: 1, purpose: 'design', inputVersion: 0, prerequisiteBindings: [], createdAt: '' } }
  const task: TaskView = { projectId: 'project', entityId: entity.id, sessionId: 'session', purpose: 'material', inputHash: '', worktree: root }
  local.tasks.push(task)
  const metadata: MaterialMetadata = { entityId: entity.id, kind: 'requirement', title: entity.title, templateId: 'default', templateRef, scenarioIds: entity.scenarioIds, sources: entity.scenarioSources!, prerequisites: [],
    businessEvidence: [{ label: '审批业务访谈', reference: 'synthetic:approved', files: [{ path: evidencePath, sha256: digest(evidenceBody) }], ranges: [{ path: evidencePath, startLine: 1, endLine: 1 }] }],
    openQuestions: [], coreRulesPresent: true, acceptanceCriteriaPresent: true, referencedAssets: [] }
  const draft = await saveMaterial(root, metadata, '原正文')
  await store.save()
  const project: ProjectState['project'] = { id: 'project', name: '项目', gitlabProjectId: 1, namespaceId: 1, namespacePath: 'test', repositoryUrl: local.projects[0]!.repositoryUrl, initializationStatus: 'ready', recognizedHead: 'a'.repeat(40), revision: 1, stableBranch: 'main' }
  const remote = { project, entities: [entity], integrations: [], baselines: [] } as ProjectState
  const otherProject = { ...project, id: 'other-project', name: '另一个项目', repositoryUrl: 'https://git.test/other-project.git' }
  const otherRoot = path.join(parent, 'other-project')
  const receipts = new Map<string, { action: string; result: EntityView | IntegrationView }>(), writes: Array<{ route: string; key: string }> = []
  const apiWrites: string[] = [], commits: string[] = []
  const confirmed: MaterialDraft[] = [], apps: StudioApplication[] = [], integrations = new Map<string, { request: MaterialIntegrationRequest; view: IntegrationView }>()
  async function workingFiles(directory = root, prefix = ''): Promise<Map<string, Buffer>> {
    const files = new Map<string, Buffer>()
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix + entry.name, target = path.join(directory, entry.name)
      if (entry.isDirectory()) for (const [name, bytes] of await workingFiles(target, relative + '/')) files.set(name, bytes)
      else if (entry.isFile()) files.set(relative, await readFile(target))
    }
    return files
  }
  let gitHead = project.recognizedHead!, remoteHead = gitHead
  const trees = new Map<string, Map<string, Buffer>>([[gitHead, await workingFiles()]])
  const changed = (before: Map<string, Buffer>, after: Map<string, Buffer>) => [...new Set([...before.keys(), ...after.keys()])].filter(file => !before.get(file)?.equals(after.get(file) ?? Buffer.alloc(0)) || !after.has(file))
  const blob = (sha: string, file: string): Buffer => { const bytes = trees.get(sha)?.get(file); if (!bytes) throw Object.assign(new Error('fixed blob missing'), { code: 'ENOENT' }); return Buffer.from(bytes) }
  let failDirectory = false, loseCompletionReply = false, directoryGate: (() => Promise<void>) | undefined, claims = 0
  const api = { async request(method: string, route: string, input?: Record<string, unknown>) {
    if (method !== 'GET') { apiWrites.push(route); assert.ok(route.startsWith('/v1/projects/project/'), `write crossed projects: ${route}`) }
    if (method === 'GET' && route === '/v1/projects') return [project, otherProject]
    if (method === 'GET' && route === '/v1/projects/project') return structuredClone(remote)
    if (method === 'GET' && route === '/v1/projects/other-project') return { project: otherProject, entities: [], integrations: [], baselines: [] }
    if (method === 'GET' && route === '/v1/projects/other-project/templates') return { acceptedHead: otherProject.recognizedHead, scenarios: { templates: [] }, requirements: { templates: [] } }
    if (method === 'GET' && route.endsWith('/templates')) return { acceptedHead: project.recognizedHead, scenarios: { templates: [] }, requirements: { templates: [{ id: 'default', name: '默认需求', fixed: templateRef }] } }
    if (method === 'GET' && route.includes('/operations/')) {
      const receipt = receipts.get(route.split('/').at(-1)!)
      if (!receipt) throw new CollaborationError('OPERATION_NOT_FOUND', 'missing', 404)
      return structuredClone(receipt)
    }
    if (method === 'GET' && route.includes('/integrations/')) {
      const integration = integrations.get(route.split('/').at(-1)!)
      if (!integration) throw new CollaborationError('INTEGRATION_NOT_FOUND', 'missing', 404)
      return structuredClone(integration.view)
    }
    if (method === 'POST' && route.endsWith('/integrations')) {
      assert.ok(isMaterialIntegrationRequest(input), JSON.stringify(input))
      const request = input as MaterialIntegrationRequest
      assert.equal(request.token.expectedRevision, entity.revision)
      assert.equal(request.token.occupationId, entity.occupation!.occupationId)
      assert.equal(request.token.taskId, path.basename(task.worktree))
      assert.equal(request.stage, 'material')
      assert.ok(trees.has(request.candidateSha))
      const view: IntegrationView = { id: `integration-${request.idempotencyKey}`, entityId: entity.id, ownerId: 1, status: 'prepared', stage: request.stage,
        sourceSha: request.sourceSha, expectedHead: request.expectedHead, candidateSha: request.candidateSha, confirmationIds: [], createdAt: '' }
      integrations.set(view.id, { request: structuredClone(request), view }); remote.integrations.push(view)
      receipts.set(request.idempotencyKey, { action: 'integration.prepare', result: structuredClone(view) })
      return structuredClone(view)
    }
    if (method === 'POST' && route.endsWith('/complete')) {
      const integration = integrations.get(route.split('/').at(-2)!)!
      assert.ok(integration)
      assert.deepEqual(input!.token, integration.request.token)
      assert.equal(remoteHead, integration.request.candidateSha)
      if (integration.view.status !== 'accepted') {
        integration.view.status = 'accepted'
        integration.view.confirmationIds = integration.request.confirmations.map(value => `confirmed-${integration.view.id}-${value.entityId}`)
        for (const [index, confirmation] of integration.request.confirmations.entries()) {
          const accepted = parseMaterial(blob(confirmation.fixed.commitSha, confirmation.fixed.path), confirmation.fixed.path)
          assert.equal(accepted.sha256, confirmation.fixed.sha256)
          assert.equal(confirmation.readHash, accepted.sha256)
          assert.equal(confirmation.authorConfirmed, true)
          confirmed.push(accepted)
          entity.materialVersion++; entity.revision++
          entity.confirmationStatus = 'confirmed'; entity.taskStatus = 'idle'
          entity.current = { version: entity.materialVersion, confirmationId: integration.view.confirmationIds[index]!, fixed: confirmation.fixed, metadata: accepted.metadata, confirmedBy: 1, confirmedAt: '', reuse: { enabled: true, reason: '' } }
          delete entity.occupation
        }
        project.recognizedHead = integration.view.candidateSha
      }
      if (loseCompletionReply) { loseCompletionReply = false; throw new Error('后台已接受，但完成答复丢失') }
      return structuredClone(integration.view)
    }
    if (method === 'POST' && route.endsWith('/claim')) { claims++; throw new Error('recovery must not acquire an occupation') }
    if (method === 'PUT' && input) {
      const relations = route.endsWith('/relations')
      const key = String(input.idempotencyKey)
      writes.push({ route, key })
      if (!relations) { if (failDirectory) throw new Error('目录网络中断'); await directoryGate?.() }
      const token = input.token as { expectedRevision: number }
      assert.equal(token.expectedRevision, entity.revision)
      if (relations) { entity.scenarioIds = input.scenarioIds as string[]; entity.scenarioSources = input.sources as EntityView['scenarioSources']; entity.prerequisites = input.prerequisites as EntityView['prerequisites'] }
      else { entity.title = String(input.title); if (input.summary !== undefined) entity.summary = String(input.summary) }
      entity.revision++; entity.occupation!.expectedRevision = entity.revision
      receipts.set(key, { action: `${relations ? 'relations.write' : 'entity.update'}:${entity.id}`, result: structuredClone(entity) })
      return structuredClone(entity)
    }
    throw new Error(`unexpected ${method} ${route}`)
  } } as unknown as CollaborationClient
  const ports = { workspaceRoot: parent, account: async () => ({ id: 1, name: '作者', gitlabUsername: 'author', gitlabEmail: 'author@example.test' }), stopPreview: async () => {},
    gitLocal: async () => {
      const current = await workingFiles(), before = trees.get(gitHead)!
      return changed(before, current).map(file => `${!current.has(file) ? ' D' : before.has(file) ? ' M' : '??'} ${file}\0`).join('')
    },
    git: {
      state: async (directory: string) => ({ root: directory, dirty: changed(trees.get(gitHead)!, await workingFiles()).length > 0, branch: 'main', head: gitHead, repositoryUrl: project.repositoryUrl }),
      hasCommit: async (_directory: string, sha: string) => trees.has(sha),
      readBlob: async (_directory: string, sha: string, file: string) => blob(sha, file),
      changedFiles: async (_directory: string, from: string, to: string) => changed(trees.get(from)!, trees.get(to)!),
      commitFiles: async (directory: string, files: readonly string[]) => {
        commits.push(directory); assert.equal(directory, root)
        const tree = await workingFiles(), changes = changed(trees.get(gitHead)!, tree)
        assert.ok(changes.filter(file => tree.has(file)).every(file => files.includes(file)))
        gitHead = digest(JSON.stringify([...tree].map(([file, bytes]) => [file, digest(bytes)]))).slice(0, 40)
        trees.set(gitHead, tree); return gitHead
      },
      verifyFile: async (_directory: string, sha: string, file: string) => { assert.deepEqual(blob(sha, file), await readFile(path.join(root, file))) },
      push: async (_directory: string, sha: string) => { assert.ok(trees.has(sha)) },
      remoteHead: async () => remoteHead,
      conditionalUpdate: async (_directory: string, _branch: string, expected: string, candidate: string) => { assert.equal(remoteHead, expected); remoteHead = candidate },
      createWorktree: async () => { throw new Error('原型启动失败，材料接受事实仍然成立') },
    },
  } as unknown as HostPorts
  const create = (nextStore: StudioStore) => {
    const app = new StudioApplication(nextStore, api, ports)
    apps.push(app)
    return app
  }
  t.after(async () => { for (const app of apps) await app.dispose(); await rm(parent, { recursive: true, force: true }) })
  const command = (operationId: string, current = draft, body = '用户当前正文', nextMetadata = current.metadata): StudioCommand => ({ action: 'confirmRequirement', entityId: entity.id, operationId, expectedHash: current.sha256, body, metadata: nextMetadata, method: 'direct' })
  const app = create(store)
  assert.equal((await app.command({ action: 'openRequirement', entityId: entity.id })).ok, true)
  return { root, stateRoot, store, entity, draft, api, create, app, confirmed, writes, apiWrites, commits, command,
    async selectOtherProject() { await mkdir(otherRoot); local.projects.push({ id: otherProject.id, name: otherProject.name, directory: otherRoot, repositoryUrl: otherProject.repositoryUrl }); local.selectedProjectId = otherProject.id; await store.save() },
    directoryFailure(value: boolean) { failDirectory = value }, directoryWait(value: () => Promise<void>) { directoryGate = value }, loseCompletion() { loseCompletionReply = true }, get claims() { return claims } }
}

test('one confirmation saves the selected input before accepting its exact hash', async t => {
  const f = await fixture(t), reply = await f.app.command(f.command('confirm-once'))
  assert.equal(reply.ok, true)
  await f.app.settle()
  assert.equal(f.confirmed.length, 1, JSON.stringify((await f.store.read()).scenarios[0]!.materialConfirmations))
  assert.equal(f.confirmed[0]!.body, '用户当前正文')
  assert.equal((await f.store.read()).scenarios[0]!.materialConfirmations!.at(-1)!.phase, 'accepted')
  assert.equal((await f.store.read()).operations[0]!.phase, 'accepted', '原型启动失败不改变材料接受事实')
})

test('a file changed outside the workbench is saved and confirmed with the submitted input', async t => {
  const f = await fixture(t)
  await saveMaterial(f.root, f.draft.metadata, '外部修改')
  const first = await f.app.command(f.command('initial-confirmation'))
  assert.equal(first.ok, true)
  await f.app.settle()
  assert.equal(f.confirmed.length, 1)
  assert.deepEqual(f.confirmed[0]!.body, '用户当前正文')
  assert.equal((await readMaterial(f.root, 'requirement', f.entity.id)).body, '用户当前正文')
})

test('a confirmation writes its submitted body over an externally edited file and keeps it after a restart', async t => {
  const f = await fixture(t)
  await saveMaterial(f.root, f.draft.metadata, '磁盘上的外部内容')
  await f.app.command(f.command('unwritten-confirmation', f.draft, '用户提交的正文'))
  await f.app.dispose()
  const restarted = new StudioStore(f.stateRoot); restarted.useUser(1)
  const app = f.create(restarted)
  const reply = await app.command({ action: 'openRequirement', entityId: f.entity.id })
  assert.equal(reply.ok, true)
  assert.equal(reply.ok && reply.state.requirement?.draft.body, '用户提交的正文')
  assert.equal((await readMaterial(f.root, 'requirement', f.entity.id)).body, '用户提交的正文')
  assert.equal(f.confirmed.length, 1)
})

test('a directory-only failure survives restart and automatically resumes the original confirmation', async t => {
  const f = await fixture(t)
  f.directoryFailure(true)
  const first = await f.app.command(f.command('directory-confirmation', f.draft, '新正文', { ...f.draft.metadata, title: '新需求名称' }))
  assert.equal(first.ok, true)
  assert.ok(first.ok && first.state.requirement?.requirementSave?.documentSaved)
  await f.app.dispose()
  assert.equal(f.confirmed.length, 0)
  const restarted = new StudioStore(f.stateRoot); restarted.useUser(1)
  const app = f.create(restarted)
  f.directoryFailure(false)
  await app.command({ action: 'state' })
  await app.settle()
  assert.equal(f.confirmed.length, 1)
  assert.equal(f.confirmed[0]!.body, '新正文')
  assert.equal((await restarted.read()).scenarios[0]!.materialConfirmations!.at(-1)!.phase, 'accepted')
  assert.equal(new Set(f.writes.map(write => write.key)).size, 1, 'directory recovery reuses the original exact request')
})

test('automatic directory recovery keeps the projection readable and confirms the current file', async t => {
  const f = await fixture(t)
  f.directoryFailure(true)
  await f.app.command(f.command('waiting-directory', f.draft, '用户正文', { ...f.draft.metadata, title: '等待目录' }))
  await f.app.settle()
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  f.directoryFailure(false); f.directoryWait(async () => { entered(); await gate })
  try {
    await f.app.command({ action: 'state' })
    await started
    const reply = await Promise.race([f.app.command({ action: 'state' }), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('projection waited for directory recovery')), 1000))])
    assert.equal(reply.ok, true)
    const current = await readMaterial(f.root, 'requirement', f.entity.id)
    await saveMaterial(f.root, current.metadata, '新的外部编辑')
  } finally { release() }
  await f.app.settle()
  assert.equal((await readMaterial(f.root, 'requirement', f.entity.id)).body, '新的外部编辑')
  assert.equal((await f.store.read()).scenarios[0]!.requirementSaves!.at(-1)!.status, 'applied')
  assert.equal(f.confirmed.length, 1)
  assert.equal(f.confirmed[0]!.body, '新的外部编辑', 'the edited file is the content that gets confirmed')
  await f.app.dispose()
  assert.equal((f.app as unknown as { scenarios: { observer?: unknown } }).scenarios.observer, undefined)
})

test('lost occupation offers recovery without silently reacquiring editing rights', async t => {
  const f = await fixture(t)
  f.directoryFailure(true)
  await f.app.command(f.command('lost-occupation', f.draft, '用户正文', { ...f.draft.metadata, title: '编辑权变化' }))
  await f.app.settle()
  f.entity.current = { version: 1, fixed: { commitSha: 'a'.repeat(40), path: f.draft.path, sha256: f.draft.sha256 }, metadata: f.draft.metadata, confirmedBy: 1, confirmedAt: '' } as NonNullable<EntityView['current']>
  f.entity.materialVersion = 1
  delete f.entity.occupation
  f.directoryFailure(false)
  await f.app.command({ action: 'state' }); await f.app.settle()
  assert.equal(f.claims, 0)
  assert.equal(f.confirmed.length, 0)
  const state = await f.app.command({ action: 'state' })
  assert.ok(state.ok && state.state.requirement?.requirementSave)
  assert.equal(state.ok && state.state.requirement?.requirementSave?.reason, 'occupation')
  assert.equal(state.ok && state.state.requirement?.readOnly, true)
  assert.equal(state.ok && state.state.requirement?.draft.body, '用户正文')
})

test('a lost acceptance reply resumes the original fixed candidate without accepting twice', async t => {
  const f = await fixture(t)
  f.loseCompletion()
  assert.equal((await f.app.command(f.command('lost-acceptance'))).ok, true)
  await f.app.settle()
  assert.equal(f.confirmed.length, 1)
  const operation = (await f.store.read()).operations[0]!
  assert.equal(operation.phase, 'unknown')
  const originalCandidate = operation.candidateSha
  await f.app.dispose()
  const restarted = new StudioStore(f.stateRoot); restarted.useUser(1)
  const app = f.create(restarted)
  assert.equal((await app.command({ action: 'retryOperation', operationId: operation.id })).ok, true)
  await app.settle()
  assert.equal(f.confirmed.length, 1)
  assert.equal((await restarted.read()).operations[0]!.candidateSha, originalCandidate)
  assert.equal((await restarted.read()).scenarios[0]!.materialConfirmations!.at(-1)!.phase, 'accepted')
})

test('save recovery cannot replace the original confirmation task with another session for the same material', async t => {
  const f = await fixture(t)
  f.directoryFailure(true)
  await f.app.command(f.command('original-session-confirmation', f.draft, '原编辑现场中的正文', { ...f.draft.metadata, title: '等待恢复的需求' }))
  await f.app.settle()
  const local = await f.store.read(), original = local.scenarios[0]!.materialConfirmations!.at(-1)!
  const sessionId = original.task.sessionId
  local.tasks.find(task => task.sessionId === sessionId)!.sessionId = 'replacement-session'
  await f.store.save()
  f.directoryFailure(false)
  await f.app.command({ action: 'retryRequirementSave', entityId: f.entity.id, operationId: original.operationId })
  await f.app.settle()
  assert.equal(f.confirmed.length, 0)
  assert.equal(original.task.sessionId, sessionId)
  assert.equal(original.phase, 'recovery')
  assert.match(original.message!, /原编辑任务现场缺失/)
  assert.equal(f.claims, 0)
})

test('confirmation leaves an unopened workspace unselected while accepting the exact material', async t => {
  const f = await fixture(t), app = f.create(f.store)
  const before = await app.command({ action: 'state' })
  assert.equal(before.ok, true)
  assert.equal(before.ok && before.state.requirement, undefined)
  const reply = await app.command(f.command('unselected-confirmation'))
  assert.equal(reply.ok, true)
  assert.equal(reply.ok && reply.state.requirement, undefined)
  await app.settle()
  assert.equal(f.confirmed.length, 1)
  assert.equal(f.confirmed[0]!.body, '用户当前正文')
  const after = await app.command({ action: 'state' })
  assert.equal(after.ok, true)
  assert.equal(after.ok && after.state.requirement, undefined)
  assert.equal((await f.store.read()).scenarios[0]!.materialConfirmations!.at(-1)!.phase, 'accepted')
})

test('confirmation recovery keeps the original project and task after the author selects another project', async t => {
  const f = await fixture(t)
  f.directoryFailure(true)
  await f.app.command(f.command('original-project-confirmation', f.draft, '原项目中明确提交的正文', { ...f.draft.metadata, title: '待恢复的原项目需求' }))
  await f.app.settle()
  const operation = (await f.store.read()).scenarios[0]!.materialConfirmations!.at(-1)!
  assert.equal(operation.phase, 'saving')
  await f.selectOtherProject()
  const selected = await f.app.command({ action: 'state' })
  assert.equal(selected.ok && selected.state.project?.id, 'other-project')
  f.directoryFailure(false)
  const retry = await f.app.command({ action: 'retryOperation', operationId: operation.operationId })
  assert.equal(retry.ok, true, JSON.stringify(retry))
  await f.app.settle()
  assert.equal(f.confirmed.length, 1, operation.message)
  assert.equal(f.confirmed[0]!.body, '原项目中明确提交的正文')
  assert.equal(operation.phase, 'accepted')
  assert.equal(operation.projectId, 'project')
  assert.equal(operation.task.worktree, f.root)
  assert.equal((await f.store.read()).selectedProjectId, 'other-project')
  assert.deepEqual(f.commits, [f.root])
  assert.ok(f.apiWrites.length > 0)
  assert.ok(f.apiWrites.every(route => route.startsWith('/v1/projects/project/')))
})

test('a late confirmation of an accepted material cannot silently reacquire a design occupation', async t => {
  const f = await fixture(t)
  f.entity.current = { version: 1, confirmationId: 'accepted-before-late-confirmation', fixed: { commitSha: templateRef.commitSha, path: f.draft.path, sha256: f.draft.sha256 }, metadata: f.draft.metadata,
    confirmedBy: 1, confirmedAt: '', reuse: { enabled: true, reason: '' } }
  f.entity.materialVersion = 1; f.entity.confirmationStatus = 'confirmed'; delete f.entity.occupation
  const reply = await f.app.command(f.command('late-confirmation'))
  assert.equal(reply.ok, false)
  if (!reply.ok) assert.match(reply.message, /占用|编辑权/)
  await f.app.settle()
  assert.equal(f.claims, 0)
  assert.equal(f.confirmed.length, 0)
  assert.deepEqual(f.apiWrites, [])
  assert.deepEqual(f.commits, [])
})
