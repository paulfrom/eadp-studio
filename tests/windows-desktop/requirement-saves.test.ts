import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { EntityView, MaterialMetadata, OccupationToken, ProjectState, UpdateEntityRequest, UpdateRelationsRequest } from '../../packages/contracts/src/index.ts'
import type { TaskView } from '../../packages/studio-plugin/src/shared/studio.ts'
import { CollaborationError, type CollaborationClient } from '../../packages/studio-plugin/src/host/adapters/collaboration/client.ts'
import { digest, readMaterial, saveMaterial } from '../../packages/studio-plugin/src/host/adapters/assets/materials.ts'
import { RequirementSaves, type RequirementSaveOwner } from '../../packages/studio-plugin/src/host/application/requirement-saves.ts'
import { ScenarioDocumentService } from '../../packages/studio-plugin/src/host/application/scenario-documents.ts'
import { StudioStore } from '../../packages/studio-plugin/src/host/application/state.ts'

const templateRef = { commitSha: 'a'.repeat(40), path: '.template/requirement.md', sha256: digest('template') }
const metadata = (source = 'scene-a'): MaterialMetadata => ({ entityId: 'requirement', kind: 'requirement', title: '审批需求', templateId: 'requirement-template', templateRef, scenarioIds: [source], sources: [{ projectId: 'project', entityId: source, version: 1 }], prerequisites: [], businessEvidence: [], openQuestions: [], coreRulesPresent: false, acceptanceCriteriaPresent: false, referencedAssets: [] })
type Request = UpdateEntityRequest | UpdateRelationsRequest
type Stage = 'relations' | 'directory'

async function fixture(t: { after(work: () => Promise<unknown>): unknown }) {
  const parent = await mkdtemp(path.join(tmpdir(), 'eadp-requirement-saves-')), root = path.join(parent, 'worktree'), localRoot = path.join(parent, 'local')
  await mkdir(root)
  const store = new StudioStore(localRoot); store.useUser(1)
  const local = await store.read(); local.selectedProjectId = 'project'
  local.projects.push({ id: 'project', name: '项目', directory: root, workspaceDirectory: path.dirname(root), repositoryUrl: 'https://git.test/project.git' })
  const token = { occupationId: 'occupation', generation: 1, taskId: path.basename(root), clientId: local.clientId, expectedRevision: 1 }
  const entity = { id: 'requirement', kind: 'requirement', title: '审批需求', revision: 1, generation: 1, materialVersion: 0, templateId: 'requirement-template', templateRef, scenarioIds: ['scene-a'], scenarioSources: metadata().sources, prerequisites: [], occupation: { ...token, ownerId: 1, purpose: 'design' } } as unknown as EntityView
  const task: TaskView = { projectId: 'project', entityId: entity.id, purpose: 'material', sessionId: 'session', worktree: root, inputHash: '' }
  local.tasks.push(task)
  const owner = { projectId: 'project', entityId: entity.id, sources: [], sourcePaths: {} } as RequirementSaveOwner & { projectId: string; entityId: string; sources: []; sourcePaths: Record<string, string> }
  local.scenarios.push(owner)
  await store.save()
  const draft = await saveMaterial(root, metadata(), '原始正文')
  const requests: Array<{ stage: Stage; input: Request }> = [], lookups: string[] = []
  const receipts = new Map<string, { action: string; result: EntityView }>()
  let lose: Stage | undefined, fail: Stage | undefined, unavailable = false, afterRelations: (() => Promise<void>) | undefined, afterDirectory: (() => Promise<void>) | undefined
  const api = { request: async (method: string, route: string, input?: Request) => {
    if (method === 'GET') {
      const key = route.split('/').at(-1)!; lookups.push(key)
      if (unavailable) throw new Error('network unavailable')
      const receipt = receipts.get(key)
      if (!receipt) throw new CollaborationError('OPERATION_NOT_FOUND', 'missing', 404)
      return structuredClone(receipt)
    }
    assert.equal(method, 'PUT'); assert.ok(input)
    const stage: Stage = route.endsWith('/relations') ? 'relations' : 'directory'
    requests.push({ stage, input: structuredClone(input) })
    if (fail === stage) throw new Error('network unavailable')
    assert.equal(input.token.expectedRevision, entity.revision)
    if (stage === 'relations') {
      const relations = input as UpdateRelationsRequest
      entity.scenarioIds = structuredClone(relations.scenarioIds); entity.scenarioSources = structuredClone(relations.sources); entity.prerequisites = structuredClone(relations.prerequisites)
    } else {
      const directory = input as UpdateEntityRequest
      entity.title = directory.title; if (directory.summary !== undefined) entity.summary = directory.summary
    }
    entity.revision++; entity.occupation!.expectedRevision = entity.revision
    const receipt = { action: `${stage === 'relations' ? 'relations.write' : 'entity.update'}:${entity.id}`, result: structuredClone(entity) }
    receipts.set(input.idempotencyKey, receipt)
    const work = stage === 'relations' ? afterRelations : afterDirectory
    if (stage === 'relations') afterRelations = undefined; else afterDirectory = undefined
    await work?.()
    if (lose === stage) { lose = undefined; throw new Error('response lost') }
    return structuredClone(receipt.result)
  } } as unknown as CollaborationClient
  const create = (scoped: StudioStore) => new RequirementSaves(scoped, api, {
    context: async () => ({ remote: { project: { id: 'project' }, entities: [structuredClone(entity)] } as unknown as ProjectState, entity: structuredClone(entity), task: { ...task } }),
    owned: async value => {
      if (!value.occupation || value.occupation.ownerId !== scoped.accountId) throw new Error('occupation missing')
      const { occupationId, generation, taskId, clientId } = value.occupation
      return { occupationId, generation, taskId, clientId, expectedRevision: value.revision }
    },
    record: async entityId => {
      const record = (await scoped.read()).scenarios.find(value => value.entityId === entityId)
      if (!record) throw new Error('missing record')
      return record
    },
    documents: async projectId => new ScenarioDocumentService(await scoped.projectDirectory(projectId)),
  })
  const saves = create(store)
  const command = (operationId = 'save', changes: Partial<MaterialMetadata> = {}, body = '用户正文') => ({ action: 'saveRequirement' as const, entityId: entity.id, operationId, metadata: { ...metadata(), ...changes } as MaterialMetadata, body })
  t.after(() => rm(parent, { recursive: true, force: true }))
  return { root, store, local, localRoot, draft, entity, owner, saves, requests, lookups, receipts, command, create,
    loseResponse(stage: Stage) { lose = stage }, failRequests(stage?: Stage) { fail = stage }, unavailable(value: boolean) { unavailable = value },
    duringRelations(work: () => Promise<void>) { afterRelations = work }, duringDirectory(work: () => Promise<void>) { afterDirectory = work },
  }
}

test('one save coordinates relations, exact file bytes and directory fields with fresh revision tokens', async t => {
  const f = await fixture(t), input = f.command('complete', { ...metadata('scene-b'), title: '新的需求', summary: '摘要' })
  await f.saves.save(input)
  assert.equal(f.saves.view(f.owner), undefined)
  assert.deepEqual(f.entity.scenarioIds, ['scene-b'])
  assert.equal(f.entity.title, '新的需求')
  const draft = await readMaterial(f.root, 'requirement', f.entity.id)
  assert.equal(draft.body, input.body)
  assert.equal(draft.metadata.title, f.entity.title)
  assert.deepEqual(f.requests.map(value => [value.stage, value.input.token.expectedRevision]), [['relations', 1], ['directory', 2]])
  assert.equal(f.saves.result(f.owner, 'complete')!.sha256, draft.sha256)
  await f.saves.save(input)
  assert.equal(f.requests.length, 2, 'repeated complete input has no side effects')
  await assert.rejects(f.saves.save({ ...input, body: 'different' }), /不同输入/)
})

for (const changeSource of [false, true]) test(`adoption provenance remains in the document and outside formal relations${changeSource ? ' during receipt recovery' : ''}`, async t => {
  const f = await fixture(t), formal = metadata(changeSource ? 'scene-b' : 'scene-a')
  const adoptionSources = [{ projectId: 'library-project', entityId: 'library-requirement', version: 3 }, { projectId: 'project', entityId: 'other-requirement', version: 2 }]
  const input = f.command(`adopted-${changeSource}`, { ...formal, sources: [...formal.sources, ...adoptionSources] })
  if (changeSource) f.loseResponse('relations')
  await f.saves.save(input)
  if (changeSource) {
    assert.equal(f.saves.view(f.owner)!.status, 'pending')
    assert.deepEqual((f.requests[0]!.input as UpdateRelationsRequest).sources, formal.sources)
    await f.saves.retry(f.entity.id, input.operationId)
    assert.equal(f.requests.length, 1, 'receipt recovery does not resend or include adoption provenance')
  } else assert.equal(f.requests.length, 0, 'adoption provenance alone does not change formal relations')
  assert.equal(f.saves.view(f.owner), undefined)
  assert.deepEqual(f.entity.scenarioSources, formal.sources)
  assert.deepEqual((await readMaterial(f.root, 'requirement', f.entity.id)).metadata.sources, input.metadata.sources)
  assert.deepEqual(f.saves.result(f.owner, input.operationId)!.metadata.sources, input.metadata.sources)
})

test('template validation and existing conflicts happen before relation changes', async t => {
  const f = await fixture(t)
  await f.saves.save(f.command('wrong-template', { ...metadata('scene-b'), templateId: 'other' }))
  assert.equal(f.saves.view(f.owner)!.reason, 'invalid')
  assert.equal(f.requests.length, 0)
  assert.deepEqual(f.entity.scenarioIds, ['scene-a'])
  assert.equal((await readMaterial(f.root, 'requirement', f.entity.id)).body, '原始正文')
})

test('a file changed outside the workbench is replaced by the save the author submitted', async t => {
  const f = await fixture(t)
  await saveMaterial(f.root, metadata(), '外部正文')
  const input = f.command('changed-file', metadata('scene-b'))
  await f.saves.save(input)
  assert.equal(f.saves.view(f.owner), undefined)
  assert.equal(f.requests.filter(value => value.stage === 'relations').length, 1)
  assert.equal((await readMaterial(f.root, 'requirement', f.entity.id)).body, input.body)
  assert.deepEqual(f.entity.scenarioIds, ['scene-b'])
})

test('accepted relations survive a file change; the submitted document stays the saved version', async t => {
  const f = await fixture(t), input = f.command('accepted-relations', metadata('scene-b'))
  f.duringRelations(async () => { await saveMaterial(f.root, metadata(), '外部编辑') })
  await f.saves.save(input)
  assert.deepEqual(f.entity.scenarioIds, ['scene-b'])
  assert.equal(f.saves.view(f.owner), undefined)
  assert.equal((await readMaterial(f.root, 'requirement', f.entity.id)).body, input.body)
  assert.ok(f.owner.requirementSaves![0]!.relations!.accepted)
})

test('a lost relations reply is reconciled through its exact receipt before continuing', async t => {
  const f = await fixture(t), input = f.command('lost-relations', metadata('scene-b'))
  f.loseResponse('relations')
  await f.saves.save(input)
  assert.equal(f.saves.view(f.owner)!.status, 'pending')
  assert.equal((await readMaterial(f.root, 'requirement', f.entity.id)).body, '原始正文')
  const request = structuredClone(f.owner.requirementSaves![0]!.relations!.request)
  await f.saves.retry(f.entity.id, input.operationId)
  assert.equal(f.saves.view(f.owner), undefined)
  assert.equal(f.requests.filter(value => value.stage === 'relations').length, 1)
  assert.deepEqual(f.owner.requirementSaves![0]!.relations!.request, request)
  assert.ok(f.lookups.filter(value => value === request.idempotencyKey).length >= 2)
})

test('a new user save first reconciles an unknown predecessor and never changes its input', async t => {
  const f = await fixture(t), old = f.command('old', metadata('scene-b'))
  f.loseResponse('relations')
  await f.saves.save(old)
  f.unavailable(true)
  await f.saves.save(f.command('new', metadata('scene-c')))
  assert.equal(f.requests.length, 1, 'unresolved old remote work prevents issuing a new mutation')
  assert.equal(f.saves.view(f.owner)!.status, 'pending')
  f.unavailable(false)
  await f.saves.retry(f.entity.id, 'new')
  assert.deepEqual(f.entity.scenarioIds, ['scene-c'])
  assert.equal(f.requests.filter(value => value.stage === 'relations').length, 2)
  assert.deepEqual(f.owner.requirementSaves![0]!.request, old)
  assert.equal(f.owner.requirementSaves![0]!.status, 'superseded')
})

test('directory-only network work survives a Host restart and recovers without writing the document again', async t => {
  const f = await fixture(t), input = f.command('directory', { title: '更新标题' })
  f.failRequests('directory')
  await f.saves.save(input)
  const saved = await readMaterial(f.root, 'requirement', f.entity.id)
  assert.equal(saved.body, input.body)
  assert.equal(f.entity.title, '审批需求')
  assert.deepEqual(await f.saves.automatic('project'), [{ entityId: f.entity.id, operationId: input.operationId }])
  const originalRequest = structuredClone(f.owner.requirementSaves![0]!.directory!.request)
  const restartedStore = new StudioStore(f.localRoot); restartedStore.useUser(1)
  const restarted = f.create(restartedStore)
  f.failRequests()
  await restarted.retry(f.entity.id, input.operationId)
  const owner = (await restartedStore.read()).scenarios[0]!
  assert.equal(restarted.view(owner), undefined)
  assert.deepEqual(owner.requirementSaves![0]!.directory!.request, originalRequest)
  assert.equal(f.entity.title, input.metadata.title)
  assert.equal((await readMaterial(f.root, 'requirement', f.entity.id)).sha256, saved.sha256)
  assert.deepEqual(await restarted.automatic('project'), [])
})

test('a lost directory response is queried rather than posted with a newer token', async t => {
  const f = await fixture(t), input = f.command('lost-directory', { title: '更新标题' })
  f.loseResponse('directory')
  await f.saves.save(input)
  assert.equal(f.saves.view(f.owner)!.phase, 'directory')
  assert.equal(f.entity.revision, 2)
  await f.saves.retry(f.entity.id, input.operationId)
  assert.equal(f.saves.view(f.owner), undefined)
  assert.equal(f.requests.length, 1)
  assert.equal(f.requests[0]!.input.token.expectedRevision, 1)
})

test('a process stopped after the document rename recovers its existing file receipt', async t => {
  const f = await fixture(t), input = f.command('document-receipt', { title: '更新标题' })
  f.failRequests('directory')
  await f.saves.save(input)
  const actual = await readMaterial(f.root, 'requirement', f.entity.id), operation = f.owner.requirementSaves![0]!
  delete operation.document; operation.phase = 'document'
  await f.store.save()
  const restartedStore = new StudioStore(f.localRoot); restartedStore.useUser(1)
  const restarted = f.create(restartedStore)
  f.failRequests()
  await restarted.retry(f.entity.id, input.operationId)
  const owner = (await restartedStore.read()).scenarios[0]!
  assert.equal(restarted.result(owner, input.operationId)!.sha256, actual.sha256)
  assert.equal((await readMaterial(f.root, 'requirement', f.entity.id)).sha256, actual.sha256)
})

test('directory recovery re-asserts a changed document and still publishes its title', async t => {
  const f = await fixture(t), input = f.command('changed-content', { title: '更新标题' })
  f.failRequests('directory')
  await f.saves.save(input)
  await saveMaterial(f.root, input.metadata, '恢复前的新编辑')
  f.failRequests()
  await f.saves.retry(f.entity.id, input.operationId)
  assert.equal(f.saves.view(f.owner), undefined)
  assert.equal(f.entity.title, '更新标题')
  assert.equal((await readMaterial(f.root, 'requirement', f.entity.id)).body, input.body)
})

test('directory recovery stops for a changed occupation and retains user recovery choices', async t => {
  const f = await fixture(t), input = f.command('changed-occupation', { title: '更新标题' })
  f.failRequests('directory')
  await f.saves.save(input)
  f.entity.occupation!.generation++
  f.failRequests()
  await f.saves.retry(f.entity.id, input.operationId)
  assert.equal(f.saves.view(f.owner)!.status, 'recovery')
  assert.equal(f.saves.view(f.owner)!.reason, 'occupation')
  assert.equal(f.requests.length, 1, 'the stale directory request is not retried')
  assert.deepEqual(await f.saves.automatic('project'), [])
})

test('a document changed during directory submission still completes its save', async t => {
  const f = await fixture(t), input = f.command('directory-race', { title: '更新标题' })
  f.duringDirectory(async () => { await saveMaterial(f.root, input.metadata, '请求期间的编辑') })
  await f.saves.save(input)
  assert.equal(f.entity.title, '更新标题')
  assert.equal(f.saves.view(f.owner), undefined)
  assert.equal((await readMaterial(f.root, 'requirement', f.entity.id)).body, '请求期间的编辑')
  assert.ok(f.owner.requirementSaves![0]!.directory!.accepted)
})

for (const failure of ['deleted', 'corrupted'] as const) test(`a ${failure} file is recorded as recoverable without losing the original request`, async t => {
  const f = await fixture(t), input = f.command(`file-${failure}`, { title: '更新标题' })
  f.failRequests('directory')
  await f.saves.save(input)
  const saved = await readMaterial(f.root, 'requirement', f.entity.id), file = path.join(f.root, saved.path)
  if (failure === 'deleted') await rm(file)
  else await writeFile(file, 'unreadable material')
  f.failRequests()
  await f.saves.retry(f.entity.id, input.operationId)
  assert.equal(f.saves.view(f.owner)!.reason, 'invalid')
  assert.equal(f.saves.view(f.owner)!.status, 'recovery')
  assert.equal(f.requests.length, 1)
  assert.deepEqual(f.owner.requirementSaves![0]!.request, input)
  const restarted = new StudioStore(f.localRoot); restarted.useUser(1)
  assert.equal((await restarted.read()).scenarios[0]!.requirementSaves![0]!.reason, 'invalid')
})

test('project context changing during relations acceptance leaves the document untouched for an explicit new choice', async t => {
  const f = await fixture(t)
  f.duringRelations(() => writeFile(path.join(f.root, 'CONTEXT.md'), '新的领域上下文'))
  await f.saves.save(f.command('context-race', metadata('scene-b')))
  assert.deepEqual(f.entity.scenarioIds, ['scene-b'])
  assert.equal(f.saves.view(f.owner)!.reason, 'invalid')
  assert.equal((await readMaterial(f.root, 'requirement', f.entity.id)).body, '原始正文')
})

for (const change of ['relations', 'revision'] as const) test(`directory recovery does not overwrite a separate ${change} change under the same occupation`, async t => {
  const f = await fixture(t), input = f.command(`remote-${change}`, { title: '更新标题' })
  f.failRequests('directory'); await f.saves.save(input)
  if (change === 'relations') { f.entity.scenarioIds = ['scene-c']; f.entity.scenarioSources = metadata('scene-c').sources }
  f.entity.revision++; f.entity.occupation!.expectedRevision = f.entity.revision
  f.failRequests()
  await f.saves.retry(f.entity.id, input.operationId)
  assert.equal(f.saves.view(f.owner)!.status, 'recovery')
  assert.equal(f.saves.view(f.owner)!.reason, change === 'relations' ? 'relations' : 'occupation')
  assert.equal(f.requests.length, 1)
})

test('a receipt for another action cannot complete a save', async t => {
  const f = await fixture(t), input = f.command('wrong-receipt', metadata('scene-b'))
  f.loseResponse('relations')
  await f.saves.save(input)
  const key = f.owner.requirementSaves![0]!.relations!.request.idempotencyKey
  f.receipts.get(key)!.action = 'entity.update:other'
  await f.saves.retry(f.entity.id, input.operationId)
  assert.equal(f.saves.view(f.owner)!.reason, 'invalid')
  assert.equal(f.requests.length, 1)
  assert.equal((await readMaterial(f.root, 'requirement', f.entity.id)).body, '原始正文')
})

test('switching accounts cannot replay a previous user save', async t => {
  const f = await fixture(t), input = f.command('user-switch', { title: '更新标题' })
  f.failRequests('directory'); await f.saves.save(input)
  f.store.useUser(2)
  await assert.rejects(f.saves.retry(f.entity.id, input.operationId), /missing record/)
  assert.equal(f.requests.length, 1)
  assert.deepEqual((await f.store.read()).scenarios, [])
})
