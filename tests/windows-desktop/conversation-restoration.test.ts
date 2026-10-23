import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { EntityView, ProjectState } from '@eadp/contracts'
import { StudioApplication } from '../../packages/studio-plugin/src/host/application/studio.ts'
import { StudioStore } from '../../packages/studio-plugin/src/host/application/state.ts'
import { initialMetadata, type HostPorts } from '../../packages/studio-plugin/src/host/application/ports.ts'
import { saveMaterial } from '../../packages/studio-plugin/src/host/adapters/assets/materials.ts'
import type { CollaborationClient } from '../../packages/studio-plugin/src/host/adapters/collaboration/client.ts'
import type { StudioCommand, TaskView } from '../../packages/studio-plugin/src/shared/studio.ts'

async function fixture(t: test.TestContext, purpose: 'material' | 'prototype' | 'handoff' = 'material') {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-cold-conversation-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const templateBody = '# 场景模板\n\n## 目标与范围\n'
  const template = { id: 'default', name: '默认场景模板', fixed: { commitSha: 'a'.repeat(40), path: '.template/default.md', sha256: createHash('sha256').update(templateBody).digest('hex') } }
  await mkdir(path.join(root, '.template')); await writeFile(path.join(root, template.fixed.path), templateBody)
  const storeRoot = path.join(root, 'state'), store = new StudioStore(storeRoot); store.useUser(1)
  const local = await store.read()
  const entity: EntityView = { id: 'asset', kind: purpose === 'handoff' ? 'handoff' : 'requirement', title: '恢复材料', revision: 1, generation: 1, materialVersion: 0, confirmationStatus: 'draft', taskStatus: 'active', scenarioIds: [], prerequisites: [], authorId: 1,
    ...(purpose === 'handoff' ? {} : { templateId: template.id, templateRef: template.fixed }),
    occupation: { entityId: 'asset', occupationId: 'owned', generation: 1, taskId: 'task', clientId: local.clientId, ownerId: 1, expectedRevision: 1, purpose: purpose === 'prototype' ? 'prototype' : 'design', inputVersion: 0, prerequisiteBindings: [], createdAt: '' } }
  const project = { id: 'project', name: '恢复项目', gitlabProjectId: 1, repositoryUrl: 'https://example.invalid/project.git', stableBranch: 'main', namespaceId: 1, namespacePath: 'test', initializationStatus: 'ready' as const, recognizedHead: 'a'.repeat(40), revision: 1 }
  const remote: ProjectState = { project, entities: [entity], integrations: [], baselines: [] }
  const worktree = path.join(store.directory, 'worktrees', project.id, 'task'); await mkdir(worktree, { recursive: true })
  const draft = await saveMaterial(worktree, initialMetadata(entity), '# 恢复材料\n\n正文。')
  if (purpose === 'prototype') {
    entity.materialVersion = 1; entity.confirmationStatus = 'confirmed'; entity.occupation!.inputVersion = 1
    entity.current = { version: 1, fixed: { commitSha: project.recognizedHead, path: draft.path, sha256: draft.sha256 }, metadata: draft.metadata, confirmationId: 'confirmation', confirmedBy: 1, confirmedAt: '', reuse: { enabled: true, reason: '' } }
  }
  const task: TaskView = { projectId: project.id, entityId: entity.id, sessionId: 'studio-existing', purpose, inputHash: entity.current?.fixed.sha256 ?? '', worktree }
  local.projects.push({ id: project.id, name: project.name, directory: root, repositoryUrl: project.repositoryUrl }); local.selectedProjectId = project.id; local.tasks.push(task); await store.save()
  const sessions: TaskView[] = [], requests: string[] = [], active = new Set<string>()
  const api = { request: async (method: string, route: string) => { requests.push(method + ' ' + route); if (method !== 'GET') throw new Error('restoration must not mutate collaboration'); if (route === '/v1/projects') return [project]; if (route === '/v1/projects/project') return remote; if (route === '/v1/projects/project/templates') { const catalog = { defaultTemplateId: template.id, templates: [template] }; return { acceptedHead: project.recognizedHead, scenarios: catalog, requirements: catalog } } throw new Error(route) } } as unknown as CollaborationClient
  const ports = { account: async () => ({ id: 1 }), stopPreview: async () => {}, session: async (value: TaskView) => { sessions.push(value); active.add(value.sessionId); return value.sessionId }, git: { hasCommit: async () => true, fetchCommit: async () => {}, readBlob: async (_root: string, _sha: string, file: string) => readFile(path.join(file.startsWith('.template/') ? root : worktree, file)) } } as unknown as HostPorts
  const reboot = () => { const next = new StudioStore(storeRoot); next.useUser(1); return new StudioApplication(next, api, ports) }
  return { store, local, task, entity, remote, sessions, requests, active, reboot, template }
}

const restore = (app: StudioApplication, sessionId = 'studio-existing') => app.command({ action: 'restoreSession', sessionId } as StudioCommand)

for (const purpose of ['material', 'prototype', 'handoff'] as const) test(`cold ${purpose} conversation restores the existing verified task without claiming`, async t => {
  const f = await fixture(t, purpose), app = f.reboot()
  const results = await Promise.all([restore(app), restore(app)])
  for (const reply of results) { assert.equal(reply.ok, true, JSON.stringify(reply)); if (reply.ok) assert.equal(reply.sessionId, f.task.sessionId) }
  assert.equal(f.sessions.length, 2, 'every restore rechecks authority before idempotent ports.session')
  assert.equal(f.active.size, 1)
  assert.ok(f.requests.every(request => request.startsWith('GET ')))
  assert.equal(f.local.tasks.length, 1)
})

for (const mutation of ['missing', 'other-owner', 'other-client', 'replaced-task', 'wrong-purpose', 'old-hash', 'old-version', 'other-project', 'wrong-worktree'] as const) test(`restoration fails closed for ${mutation} without opening an Agent`, async t => {
  const f = await fixture(t, 'prototype')
  if (mutation === 'missing') delete f.entity.occupation
  if (mutation === 'other-owner') f.entity.occupation!.ownerId = 2
  if (mutation === 'other-client') f.entity.occupation!.clientId = 'other-client'
  if (mutation === 'replaced-task') f.entity.occupation!.taskId = 'replacement'
  if (mutation === 'wrong-purpose') f.entity.occupation!.purpose = 'design'
  if (mutation === 'old-hash') f.entity.current!.fixed.sha256 = 'b'.repeat(64)
  if (mutation === 'old-version') f.entity.occupation!.inputVersion = 0
  if (mutation === 'other-project') f.task.projectId = 'another-project'
  if (mutation === 'wrong-worktree') f.task.worktree = path.join(f.task.worktree, '..', 'wrong')
  await f.store.save()
  const reply = await restore(f.reboot())
  assert.equal(reply.ok, false, JSON.stringify(reply))
  assert.equal(f.sessions.length, 0)
  assert.ok(f.requests.every(request => request.startsWith('GET ')))
})

test('unknown and fixed read-only task sessions cannot use the writable conversation restoration command', async t => {
  const f = await fixture(t)
  assert.equal((await restore(f.reboot(), 'unknown')).ok, false)
  f.task.purpose = 'review'; await f.store.save()
  assert.equal((await restore(f.reboot())).ok, false)
  f.task.purpose = 'split'; await f.store.save()
  assert.equal((await restore(f.reboot())).ok, false)
  assert.equal(f.sessions.length, 0)
})

test('a requirement session restores only through its own design occupation, never another entity occupation', async t => {
  const f = await fixture(t)
  const scenario: EntityView = { ...f.entity, id: 'scenario', kind: 'scenario', code: 'SC-001', sequence: 1, materialVersion: 1, occupation: { ...f.entity.occupation!, entityId: 'scenario', purpose: 'design', inputVersion: 1 } }
  delete f.entity.occupation
  f.remote.entities.push(scenario)
  await f.store.save()
  assert.equal((await restore(f.reboot())).ok, false, 'another entity occupation cannot authorize this requirement session')
  assert.equal(f.sessions.length, 0)
  f.entity.occupation = { ...scenario.occupation!, entityId: f.entity.id, inputVersion: 0 }
  assert.equal((await restore(f.reboot())).ok, true)
  assert.equal(f.sessions.length, 1)
  f.entity.occupation!.taskId = 'replaced'
  assert.equal((await restore(f.reboot())).ok, false)
  assert.equal(f.sessions.length, 1)
})

test('a repeated restore checks new authority even after the same Host has opened the session', async t => {
  const f = await fixture(t), app = f.reboot()
  assert.equal((await restore(app)).ok, true)
  f.entity.occupation!.ownerId = 2
  assert.equal((await restore(app)).ok, false)
  assert.equal(f.sessions.length, 1)
})

for (const purpose of ['material', 'handoff'] as const) test(`${purpose} restoration preserves the author's unconfirmed edited draft`, async t => {
  const f = await fixture(t, purpose)
  const saved = await saveMaterial(f.task.worktree, initialMetadata(f.entity), '# 作者后续修改\n\n未确认的现场。')
  const before = await readFile(path.join(f.task.worktree, saved.path), 'utf8')
  assert.equal((await restore(f.reboot())).ok, true)
  assert.equal(await readFile(path.join(f.task.worktree, saved.path), 'utf8'), before)
})

test('prototype restoration rejects modified local requirement bytes even while the remote hash is unchanged', async t => {
  const f = await fixture(t, 'prototype')
  await saveMaterial(f.task.worktree, initialMetadata(f.entity), '# 本地需求被修改\n')
  assert.equal((await restore(f.reboot())).ok, false)
  assert.equal(f.sessions.length, 0)
})

for (const change of ['missing-completion', 'confirmation', 'integration', 'version', 'unconfirmed-input'] as const) test(`prototype restoration rejects changed prerequisite basis: ${change}`, async t => {
  const f = await fixture(t, 'prototype')
  const completion = { version: 1, confirmationId: 'prerequisite-confirmation', integrationSha: 'c'.repeat(40), baselineId: 'baseline' }
  const prerequisite: EntityView = { ...f.entity, id: 'prerequisite', occupation: undefined, completions: [completion] }
  f.remote.entities.push(prerequisite)
  f.entity.prerequisites = [{ requirementId: prerequisite.id, version: 1 }]
  f.entity.occupation!.prerequisiteBindings = [{ requirementId: prerequisite.id, version: 1, confirmationId: completion.confirmationId, integrationSha: completion.integrationSha }]
  if (change === 'missing-completion') prerequisite.completions = []
  if (change === 'confirmation') completion.confirmationId = 'new-confirmation'
  if (change === 'integration') completion.integrationSha = 'd'.repeat(40)
  if (change === 'version') { f.entity.prerequisites[0]!.version = 2; prerequisite.completions!.push({ ...completion, version: 2 }) }
  if (change === 'unconfirmed-input') f.entity.confirmationStatus = 'draft'
  assert.equal((await restore(f.reboot())).ok, false)
  assert.equal(f.sessions.length, 0)
})

test('prototype restoration retains an accepted fixed prerequisite version when its source has a newer current version', async t => {
  const f = await fixture(t, 'prototype')
  const binding = { requirementId: 'prerequisite', version: 1, confirmationId: 'accepted-v1', integrationSha: 'c'.repeat(40) }
  f.entity.prerequisites = [{ requirementId: binding.requirementId, version: 1 }]; f.entity.occupation!.prerequisiteBindings = [binding]
  f.remote.entities.push({ ...f.entity, id: binding.requirementId, materialVersion: 2, current: undefined, occupation: undefined, prerequisites: [], completions: [{ ...binding, baselineId: 'baseline-v1' }] })
  assert.equal((await restore(f.reboot())).ok, true)
  assert.equal(f.sessions.length, 1)
})
