import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { EntityView, ProjectState } from '@eadp/contracts'
import { generalScenarioMetadata } from '../../packages/asset-domain/src/index.ts'
import type { CollaborationClient } from '../../packages/studio-plugin/src/host/adapters/collaboration/client.ts'
import type { HostPorts } from '../../packages/studio-plugin/src/host/application/ports.ts'
import type { ProjectWorkspaces } from '../../packages/studio-plugin/src/host/application/projects.ts'
import { ScenarioWorkspaces } from '../../packages/studio-plugin/src/host/application/scenario-workspaces.ts'
import { StudioStore } from '../../packages/studio-plugin/src/host/application/state.ts'

test('a builtin scenario cannot open by direct identity or become a material workspace projection', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'eadp-builtin-workspace-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new StudioStore(root); store.useUser(1)
  const fixed = { commitSha: 'a'.repeat(40), path: '场景/通用场景.md', sha256: 'b'.repeat(64) }
  const builtin: EntityView = { id: 'general', kind: 'scenario', title: '通用场景', builtinKey: 'general', revision: 1, generation: 0, materialVersion: 1, confirmationStatus: 'confirmed', taskStatus: 'idle', scenarioIds: [], prerequisites: [], authorId: 1,
    current: { version: 1, confirmationId: 'general-confirmation', fixed, metadata: generalScenarioMetadata('general'), confirmedBy: 1, confirmedAt: '', builtin: true, reuse: { enabled: false, reason: '系统内置' } } }
  const ordinary: EntityView = { ...builtin, id: 'ordinary', title: '普通场景', builtinKey: undefined,
    current: { ...builtin.current!, builtin: false, metadata: { entityId: 'ordinary', kind: 'scenario', title: '普通场景', flowComplete: true, templateId: 'default', templateRef: { ...fixed, path: '.template/default.md' }, scenarioIds: [], prerequisites: [], sources: [], businessEvidence: [], openQuestions: [], referencedAssets: [] } } }
  const remote: ProjectState = { project: { id: 'project', name: '项目', gitlabProjectId: 1, repositoryUrl: 'https://example.test/project.git', stableBranch: 'main', namespaceId: 1, namespacePath: 'team', initializationStatus: 'ready', revision: 1 }, entities: [builtin, ordinary], baselines: [], integrations: [] }
  let tasks = 0, occupations = 0
  const workspaces = new ScenarioWorkspaces(store, {} as CollaborationClient, {} as HostPorts, {} as ProjectWorkspaces, {
    entity: async id => ({ entity: remote.entities.find(value => value.id === id)! as EntityView, remote }),
    task: async () => { tasks++; throw new Error('must not create a task') },
    owned: async () => { occupations++; throw new Error('must not acquire editing rights') },
    deliver: () => {},
  })
  t.after(() => workspaces.dispose())
  await workspaces.open(ordinary.id)
  assert.equal(workspaces.activeEntityId, ordinary.id)
  await assert.rejects(workspaces.open(builtin.id), /可整理的场景或需求/)
  assert.equal(workspaces.activeEntityId, ordinary.id, 'a rejected direct ID must preserve the current material')
  workspaces.activeEntityId = builtin.id
  assert.equal(await workspaces.snapshot(remote), undefined, 'a stale or injected selection cannot expose a builtin editor')
  assert.equal(tasks, 0); assert.equal(occupations, 0)
  assert.deepEqual(builtin.current!.metadata, generalScenarioMetadata('general'), 'the builtin fixed source identity is retained')
})
