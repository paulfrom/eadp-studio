import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { EntityView, FixedVersion, PrepareIntegrationRequest, ProjectState } from '@eadp/contracts'
import { StudioApplication } from '../../packages/studio-plugin/src/host/application/studio.ts'
import { StudioStore } from '../../packages/studio-plugin/src/host/application/state.ts'
import type { HostPorts } from '../../packages/studio-plugin/src/host/application/ports.ts'
import { CollaborationError, type CollaborationClient } from '../../packages/studio-plugin/src/host/adapters/collaboration/client.ts'
import { digest, readMaterial, saveMaterial } from '../../packages/studio-plugin/src/host/adapters/assets/materials.ts'
import { validateIntegration } from '../../apps/collaboration-api/src/modules/integration.ts'

const head = 'a'.repeat(40), candidate = 'b'.repeat(40)
const body = '# 材料\n\n## 核心业务规则\n\n用户按固定业务范围检查记录且保留审计依据。\n\n## 验收条件\n\n符合业务规则的记录可以保存，不符合的显示明确错误。\n'
const entity = (id: string, kind: EntityView['kind'] = 'requirement'): EntityView => ({ id, kind, title: id, categoryId: 'cat', revision: 1, generation: 1, materialVersion: 0, confirmationStatus: 'draft', taskStatus: 'active', scenarioIds: [], prerequisites: [], authorId: 1, frozenBy: [], associationRevision: 0 })
const metadata = (value: EntityView) => ({ entityId: value.id, kind: value.kind, title: value.title, categoryId: value.categoryId, scenarioIds: value.scenarioIds, prerequisites: [], sources: [], businessEvidence: [{ label: '合成测试业务依据', reference: 'synthetic:fixture' }], coreRulesPresent: true, acceptanceCriteriaPresent: true, openQuestions: [], referencedAssets: [] })
async function fixture(t: test.TestContext, kind: EntityView['kind'] = 'requirement') {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-asset-workflow-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new StudioStore(path.join(root, 'state')); store.useUser(1)
  const local = await store.read(), value = entity('target', kind), worktree = path.join(root, 'task')
  await mkdir(worktree)
  value.occupation = { occupationId: 'occupation', generation: 1, taskId: 'task', clientId: local.clientId, expectedRevision: 1, entityId: value.id, ownerId: 1, purpose: 'design', inputVersion: 0, prerequisiteBindings: [], createdAt: '' }
  const project = { id: 'project', name: '测试项目', gitlabProjectId: 1, repositoryUrl: 'https://example.test/project.git', stableBranch: 'main', namespaceId: 1, namespacePath: 'test', initializationStatus: 'ready' as const, recognizedHead: head, revision: 1, categories: [{ id: 'cat', name: '测试' }] }
  const remote: ProjectState = { project, entities: [value], integrations: [], baselines: [] }
  local.projects.push({ id: project.id, name: project.name, directory: root, repositoryUrl: project.repositoryUrl }); local.selectedProjectId = project.id
  local.tasks.push({ projectId: project.id, entityId: value.id, worktree, purpose: kind === 'handoff' ? 'handoff' : 'material', inputHash: '', sessionId: 'material-session' })
  await saveMaterial(worktree, metadata(value), body)
  await store.save()
  const sourceEntity = entity('source'), sourceMetadata = metadata(sourceEntity)
  const sourceDirectory = path.join(root, 'source'); await mkdir(sourceDirectory)
  const sourceDraft = await saveMaterial(sourceDirectory, sourceMetadata, body)
  local.projects.push({ id: 'source-project', name: '来源项目', directory: sourceDirectory, repositoryUrl: project.repositoryUrl }); await store.save()
  const source: FixedVersion = { version: 2, fixed: { commitSha: head, path: sourceDraft.path, sha256: sourceDraft.sha256 }, metadata: sourceMetadata, confirmationId: 'source-confirmation', confirmedBy: 1, confirmedAt: '', reuse: { enabled: true, reason: '' } }
  const records = new Map<string, unknown>(), calls = { prompts: [] as string[], sessions: [] as string[], adoptions: 0, successEffects: 0, successRequests: [] as object[], commits: [] as Array<readonly string[]>, prepared: [] as PrepareIntegrationRequest[] }
  const failures = { adoptionResponse: false, successResponse: false, prompt: false, session: false }
  const api = { request: async (method: string, route: string, input?: Record<string, unknown>) => {
    if (method === 'GET' && route === '/v1/projects') return [project]
    if (method === 'GET' && route.endsWith('/versions')) return [source]
    if (method === 'GET' && route.includes('/operations/')) { const result = records.get(route.split('/').at(-1)!); if (!result) throw new CollaborationError('OPERATION_NOT_FOUND', 'missing', 404); return { result } }
    if (method === 'GET' && route.includes('/integrations/')) return remote.integrations.find(integration => integration.id === route.split('/').at(-1))
    if (method === 'GET' && route === '/v1/projects/source-project') return { ...remote, project: { ...project, id: 'source-project' } }
    if (method === 'GET' && route === '/v1/projects/project') return remote
    if (method === 'POST' && route.endsWith('/adoptions')) {
      const operationKey = String(input!.idempotencyKey)
      let result = records.get(operationKey)
      if (!result) { calls.adoptions++; result = { id: 'adoption', ...input, status: 'accepted' }; records.set(operationKey, result) }
      if (failures.adoptionResponse) { failures.adoptionResponse = false; throw new Error('adoption response lost') }
      return result
    }
    if (method === 'POST' && route.endsWith('/adoptions/adoption/success')) {
      calls.successRequests.push(input!)
      const operationKey = String(input!.idempotencyKey)
      let result = records.get(operationKey)
      if (!result) { calls.successEffects++; result = { id: 'adoption', status: 'succeeded', targetConfirmationId: input!.targetConfirmationId }; records.set(operationKey, result) }
      if (failures.successResponse) { failures.successResponse = false; throw new Error('success response lost') }
      return result
    }
    if (method === 'POST' && route.endsWith('/integrations')) {
      const prepared = input as unknown as PrepareIntegrationRequest; calls.prepared.push(prepared)
      validateIntegration(project, remote.entities as EntityView[], { id: 1 } as never, prepared)
      const accepted = { id: 'integration', entityId: value.id, ownerId: 1, status: 'accepted' as const, sourceSha: candidate, expectedHead: head, candidateSha: candidate, stage: prepared.stage, confirmationIds: prepared.confirmations.map(item => 'confirmed-' + item.entityId), createdAt: '' }
      remote.integrations.push(accepted); records.set(prepared.idempotencyKey, accepted)
      for (const item of prepared.confirmations) {
        const changed = remote.entities.find(e => e.id === item.entityId) as EntityView
        changed.current = { version: changed.materialVersion + 1, fixed: item.fixed, metadata: item.metadata, confirmationId: 'confirmed-' + item.entityId, confirmedBy: 1, confirmedAt: '', reuse: { enabled: true, reason: '' } }; changed.materialVersion++; delete changed.occupation
      }
      return accepted
    }
    throw new Error('Unexpected request: ' + method + ' ' + route)
  } } as unknown as CollaborationClient
  const ports = { account: async () => ({ id: 1, name: '作者', gitlabUsername: 'author', gitlabEmail: 'author@example.invalid' }), stopPreview: async () => {},
    session: async (task: { sessionId: string }) => { calls.sessions.push(task.sessionId); if (failures.session) { failures.session = false; throw new Error('session failed') }; return task.sessionId },
    prompt: async (session: string, text: string) => { calls.prompts.push(session + ':' + text); if (failures.prompt) { failures.prompt = false; throw new Error('prompt failed') } },
    gitLocal: async () => ' M material.md',
    git: { commitFiles: async (_directory: string, files: readonly string[]) => { calls.commits.push(files); return candidate }, verifyFile: async () => {}, push: async () => {}, fetch: async () => {}, fetchCommit: async () => {}, readBlob: async (_directory: string, _sha: string, file: string) => { const { readFile } = await import('node:fs/promises'); return readFile(path.join(_directory === sourceDirectory ? sourceDirectory : worktree, file)) }, createWorktree: async () => { throw new Error('prototype intentionally not started') } },
  } as unknown as HostPorts
  const app = (nextStore = store) => new StudioApplication(nextStore, api, ports)
  const adopt = { action: 'adopt' as const, sourceProjectId: 'source-project', sourceEntityId: 'source', version: 2, targetEntityId: value.id, reason: '依据目标业务调整验收条件' }
  return { root, store, local, value, worktree, remote, source, sourceDirectory, calls, failures, app, adopt }
}

test('adoption success binds the accepted target confirmation and survives a lost response without duplicate acceptance', async t => {
  const f = await fixture(t)
  f.failures.adoptionResponse = true
  assert.equal((await f.app().command(f.adopt)).ok, false)
  const rebooted = new StudioStore(path.join(f.root, 'state')); rebooted.useUser(1)
  assert.equal((await f.app(rebooted).command(f.adopt)).ok, true)
  assert.equal(f.calls.adoptions, 1, 'restart must resolve the original adoption instead of accepting a new record')
  const draft = await readMaterial(f.worktree, 'requirement', f.value.id)
  const checked = await saveMaterial(f.worktree, { ...draft.metadata, coreRulesPresent: true, acceptanceCriteriaPresent: true }, draft.body)
  f.failures.successResponse = true
  assert.equal((await f.app(rebooted).command({ action: 'confirmMaterial', entityId: f.value.id, expectedHash: checked.sha256, method: 'direct' })).ok, false)
  const pending = (await rebooted.read()).operations[0]!
  assert.equal(pending.phase, 'accepted', 'the target confirmation remains accepted if success acknowledgement is lost')
  const second = new StudioStore(path.join(f.root, 'state')); second.useUser(1)
  assert.equal((await f.app(second).command({ action: 'retryOperation', operationId: pending.id })).ok, true)
  assert.equal(f.calls.successEffects, 1)
  assert.equal(f.calls.successRequests.length, 2)
  assert.deepEqual(f.calls.successRequests[0], f.calls.successRequests[1], 'retries retain the exact confirmation and idempotency key')
})

test('accepted handoff generation is durable per fixed baseline and never overwrites author edits on retry', async t => {
  const f = await fixture(t, 'handoff')
  f.value.title = '交接 baseline'
  const requirement = entity('requirement'); requirement.materialVersion = 2
  f.remote.entities.push(requirement)
  f.remote.baselines.push({ id: 'baseline', entityId: requirement.id, version: 2, commitSha: candidate, confirmationId: 'completed', createdAt: '' })
  assert.equal((await f.app().command({ action: 'generateHandoff', baselineId: 'baseline' })).ok, true)
  const generated = await readMaterial(f.worktree, 'handoff', f.value.id)
  await saveMaterial(f.worktree, generated.metadata, '作者修改必须保留\n' + body)
  const rebooted = new StudioStore(path.join(f.root, 'state')); rebooted.useUser(1)
  assert.equal((await f.app(rebooted).command({ action: 'generateHandoff', baselineId: 'baseline' })).ok, true)
  assert.match((await readMaterial(f.worktree, 'handoff', f.value.id)).body, /作者修改必须保留/)
  assert.equal(f.calls.prompts.length, 1)
})

test('scenario revision confirms every unstarted frozen requirement atomically and preserves completed requirements', async t => {
  const f = await fixture(t, 'scenario')
  f.value.materialVersion = 1; f.value.occupation!.purpose = 'scenario-batch'; f.value.occupation!.inputVersion = 1
  const unstarted = entity('unstarted'), completed = entity('completed'), unrelated = entity('unrelated')
  for (const requirement of [unstarted, completed]) { requirement.scenarioIds = [f.value.id]; requirement.frozenBy = ['occupation'] }
  completed.materialVersion = 2; completed.completedVersion = 2
  unrelated.scenarioIds = [f.value.id]
  f.remote.entities.push(unstarted, completed, unrelated)
  await saveMaterial(f.worktree, metadata(unstarted), body)
  const draft = await readMaterial(f.worktree, 'scenario', f.value.id)
  const reply = await f.app().command({ action: 'confirmMaterial', entityId: f.value.id, expectedHash: draft.sha256, method: 'direct' })
  assert.equal(reply.ok, true, JSON.stringify(reply))
  const request = f.calls.prepared[0]!
  assert.deepEqual(request.batchRequirementIds?.sort(), ['completed', 'unstarted'])
  assert.deepEqual(request.confirmations.map(item => item.entityId).sort(), ['target', 'unstarted'])
  assert.deepEqual([...f.calls.commits[0]!].sort(), ['场景/target.md', '需求/unstarted.md'])
  assert.ok(request.confirmations.every(item => item.fixed.commitSha === candidate))
})


test('an adoption acknowledgement cannot overwrite a target edited while its response was lost', async t => {
  const f = await fixture(t)
  f.failures.adoptionResponse = true
  assert.equal((await f.app().command(f.adopt)).ok, false)
  const original = await readMaterial(f.worktree, 'requirement', f.value.id)
  await saveMaterial(f.worktree, original.metadata, '作者保留的新内容\n' + body)
  const rebooted = new StudioStore(path.join(f.root, 'state')); rebooted.useUser(1)
  assert.equal((await f.app(rebooted).command(f.adopt)).ok, false)
  assert.equal(f.calls.adoptions, 1)
  assert.match((await readMaterial(f.worktree, 'requirement', f.value.id)).body, /作者保留的新内容/)
  assert.equal(f.calls.successEffects, 0)
})

test('a confirmed target without the exact adopted source cannot report reuse success', async t => {
  const f = await fixture(t)
  assert.equal((await f.app().command(f.adopt)).ok, true)
  const draft = await readMaterial(f.worktree, 'requirement', f.value.id)
  const checked = await saveMaterial(f.worktree, { ...draft.metadata, sources: [], coreRulesPresent: true, acceptanceCriteriaPresent: true }, draft.body)
  assert.equal((await f.app().command({ action: 'confirmMaterial', entityId: f.value.id, expectedHash: checked.sha256, method: 'direct' })).ok, true)
  assert.equal(f.calls.successEffects, 0)
})

for (const failure of ['session', 'prompt'] as const) test('failed handoff ' + failure + ' retries its fixed task without replacing author content', async t => {
  const f = await fixture(t, 'handoff')
  f.value.title = '交接 baseline'
  const requirement = entity('requirement'); requirement.materialVersion = 2
  f.remote.entities.push(requirement)
  f.remote.baselines.push({ id: 'baseline', entityId: requirement.id, version: 2, commitSha: candidate, confirmationId: 'completed', createdAt: '' })
  f.failures[failure] = true
  assert.equal((await f.app().command({ action: 'generateHandoff', baselineId: 'baseline' })).ok, false)
  const draft = await readMaterial(f.worktree, 'handoff', f.value.id)
  await saveMaterial(f.worktree, draft.metadata, '失败后作者补充\n' + body)
  const rebooted = new StudioStore(path.join(f.root, 'state')); rebooted.useUser(1)
  assert.equal((await f.app(rebooted).command({ action: 'generateHandoff', baselineId: 'baseline' })).ok, true)
  assert.match((await readMaterial(f.worktree, 'handoff', f.value.id)).body, /失败后作者补充/)
  assert.ok(f.calls.sessions.every(id => id === 'material-session'))
})

test('an incomplete frozen batch fails before creating any candidate commit', async t => {
  const f = await fixture(t, 'scenario')
  f.value.materialVersion = 1; f.value.occupation!.purpose = 'scenario-batch'; f.value.occupation!.inputVersion = 1
  const missing = entity('missing'); missing.scenarioIds = [f.value.id]; missing.frozenBy = ['occupation']
  f.remote.entities.push(missing)
  const draft = await readMaterial(f.worktree, 'scenario', f.value.id)
  assert.equal((await f.app().command({ action: 'confirmMaterial', entityId: f.value.id, expectedHash: draft.sha256, method: 'direct' })).ok, false)
  assert.equal(f.calls.commits.length, 0)
})

test('frozen unstarted requirements remain editable only through the owned scenario worktree', async t => {
  const f = await fixture(t, 'scenario')
  f.value.materialVersion = 1; f.value.occupation!.purpose = 'scenario-batch'; f.value.occupation!.inputVersion = 1
  const related = entity('related'); related.scenarioIds = [f.value.id]; related.frozenBy = ['occupation']
  f.remote.entities.push(related)
  const state = await f.app().state()
  const draft = state.drafts.find(value => value.entityId === related.id)!
  assert.ok(draft)
  assert.equal(state.tasks.find(value => value.entityId === related.id)!.worktree, f.worktree)
  assert.equal((await f.app().command({ action: 'saveMaterial', entityId: related.id, metadata: draft.metadata, body })).ok, true)
  assert.equal(related.occupation, undefined)
})
