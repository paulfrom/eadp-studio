import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { StudioApplication } from '../../packages/studio-plugin/src/host/application/studio.ts'
import { StudioStore } from '../../packages/studio-plugin/src/host/application/state.ts'
import type { HostPorts } from '../../packages/studio-plugin/src/host/application/ports.ts'
import type { CollaborationClient } from '../../packages/studio-plugin/src/host/adapters/collaboration/client.ts'
import type { EntityView, ProjectState } from '@eadp/contracts'

/**
 * An accepted project whose documents predate the current contract: the fixed
 * body stays readable through the projection, but every editing, confirmation,
 * review and reuse entry point refuses it.
 */
const legacyBody = '```eadp-metadata\n{"entityId":"legacy-scenario","kind":"scenario","categoryId":"legacy","templateId":"default"}\n```\n\n# 旧场景\n\n## 核心业务规则\n\n旧契约规则。\n'
const legacyHash = createHash('sha256').update(legacyBody).digest('hex')
const legacy: EntityView = { id: 'legacy-scenario', kind: 'scenario', title: '旧场景', code: 'SC-0001', revision: 1, generation: 1, materialVersion: 1, confirmationStatus: 'confirmed', taskStatus: 'idle', scenarioIds: [], prerequisites: [], authorId: 1,
  legacyCurrent: { version: 1, confirmationId: 'confirmation-legacy', fixed: { commitSha: 'c'.repeat(40), path: '场景/legacy-scenario.md', sha256: legacyHash }, confirmedBy: 1, confirmedAt: '', title: '旧场景', reason: 'INVALID_MATERIAL: Material metadata does not match the confirmation contract' } }
const remote: ProjectState = { project: { id: 'project', name: '旧项目', gitlabProjectId: 1, repositoryUrl: 'https://example.test/project.git', stableBranch: 'main', namespaceId: 1, namespacePath: 'test', initializationStatus: 'ready', recognizedHead: 'a'.repeat(40), revision: 1 }, entities: [legacy], baselines: [], integrations: [] }

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-legacy-material-'))
  const store = new StudioStore(path.join(root, 'state')); store.useUser(1)
  const local = await store.read()
  local.projects.push({ id: 'project', name: '旧项目', directory: root, repositoryUrl: remote.project.repositoryUrl })
  local.selectedProjectId = 'project'
  await store.save()
  const calls: string[] = []
  const api = { request: async (method: string, route: string) => {
    calls.push(`${method} ${route}`)
    if (method !== 'GET') throw new Error(`unexpected write ${method} ${route}`)
    if (route === '/v1/projects') return [remote.project]
    if (route === '/v1/projects/project/templates') return { acceptedHead: remote.project.recognizedHead, scenarios: { templates: [] }, requirements: { templates: [] } }
    if (route === '/v1/projects/project') return remote
    if (route === '/v1/namespaces') return []
    throw new Error(`unexpected read ${route}`)
  } } as unknown as CollaborationClient
  const ports = {
    workspaceRoot: root, account: async () => ({ id: 1 }), stopPreview: async () => {},
    git: { hasCommit: async () => true, readBlob: async () => Buffer.from(legacyBody), fetchCommit: async () => {}, state: async () => ({ head: 'a'.repeat(40), repositoryUrl: remote.project.repositoryUrl, branch: 'main', dirty: false }) },
  } as unknown as HostPorts
  return { root, store, api, ports, calls, app: new StudioApplication(store, api, ports), dispose: () => rm(root, { recursive: true, force: true }) }
}

test('an accepted document from an earlier contract stays readable and is never turned into an editable draft', async () => {
  const f = await fixture()
  try {
    const state = await f.app.state()
    assert.deepEqual(state.legacyMaterials, [{ entityId: 'legacy-scenario', body: legacyBody }])
    assert.equal(state.drafts.length, 0, 'a legacy document never becomes an editable draft')
    assert.deepEqual(state.projectTemplates?.scenarios.templates, [], 'a project without a published catalog reads an empty one')
  } finally { await f.dispose() }
})

test('every editing, confirmation, review and reuse entry point refuses a legacy document', async () => {
  const f = await fixture()
  try {
    const attempted = [
      { action: 'openScenario', entityId: 'legacy-scenario' },
      { action: 'startSession', entityId: 'legacy-scenario', purpose: 'material' },
      { action: 'saveMaterial', entityId: 'legacy-scenario', body: '# 改写', metadata: { entityId: 'legacy-scenario' } },
      { action: 'confirmMaterial', entityId: 'legacy-scenario', expectedHash: legacyHash, method: 'direct' },
      { action: 'requestReview', entityId: 'legacy-scenario', purpose: 'material' },
      { action: 'setEligibility', entityId: 'legacy-scenario', version: 1, enabled: false, reason: '旧契约' },
      { action: 'scenarioRevisionImpact', entityId: 'legacy-scenario' },
    ] as const
    for (const command of attempted) {
      const reply = await f.app.command(command as never)
      assert.equal(reply.ok, false, `${command.action} must be refused`)
      if (!reply.ok) assert.match(reply.message, /只读/, `${command.action}: ${reply.message}`)
    }
    assert.equal(f.calls.filter(call => !call.startsWith('GET ')).length, 0, 'no write reaches the collaboration backend')
  } finally { await f.dispose() }
})

test('a scenario cannot be created before the project publishes its template catalog', async () => {
  const f = await fixture()
  try {
    const reply = await f.app.command({ action: 'createMaterial', operationId: 'operation-1', kind: 'scenario', title: '新场景' })
    assert.equal(reply.ok, false)
    if (!reply.ok) assert.match(reply.message, /尚未发布场景模板/)
    assert.equal(f.calls.includes('POST /v1/projects/project/entities'), false)
  } finally { await f.dispose() }
})
