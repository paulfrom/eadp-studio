import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { StudioStore } from '../../packages/studio-plugin/src/host/application/state.ts'

test('project drafts persist in the selected project, and damaged project records remain intact', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eadp-project-state-'))
  try {
    const store = new StudioStore(path.join(root, 'program')); store.useUser(1)
    const state = await store.read()
    await mkdir(path.join(root, 'one'))
    state.projects.push({ id: 'p1', name: 'One', directory: path.join(root, 'one', 'repo'), workspaceDirectory: path.join(root, 'one'), repositoryUrl: 'https://example.test/one.git' })
    state.scenarios.push({ projectId: 'p1', entityId: 'e1', sources: [], sourcePaths: {}, rejectedConclusions: ['unique draft'] })
    await store.save()
    const index = await readFile(path.join(store.directory, 'studio-state.json'), 'utf8')
    assert.ok(!index.includes('unique draft'))
    const projectFile = path.join(await store.projectDirectory('p1'), 'local-state.json')
    assert.ok((await readFile(projectFile, 'utf8')).includes('unique draft'))
    const restored = new StudioStore(path.join(root, 'program')); restored.useUser(1)
    assert.equal((await restored.read()).scenarios[0]?.entityId, 'e1')
    await writeFile(projectFile, '{broken')
    const damaged = new StudioStore(path.join(root, 'program')); damaged.useUser(1)
    await assert.rejects(damaged.read())
    assert.equal(await readFile(projectFile, 'utf8'), '{broken')
  } finally { await rm(root, { recursive: true, force: true }) }
})


test('missing project folder keeps its index and never recreates the folder on read or save', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eadp-deleted-project-'))
  try {
    const store = new StudioStore(path.join(root, 'program')); store.useUser(1)
    const state = await store.read()
    for (const id of ['one', 'two']) {
      await mkdir(path.join(root, id))
      state.projects.push({ id, name: id, directory: path.join(root, id, 'repo'), workspaceDirectory: path.join(root, id), repositoryUrl: 'https://example.test/' + id + '.git' })
      state.scenarios.push({ projectId: id, entityId: id, sources: [], sourcePaths: {} })
    }
    await store.save()
    await rm(path.join(root, 'one'), { recursive: true })
    const restored = new StudioStore(path.join(root, 'program')); restored.useUser(1)
    const actual = await restored.read()
    assert.equal(actual.projects.length, 2)
    assert.deepEqual(actual.scenarios.map(item => item.projectId), ['two'])
    await restored.save()
    await assert.rejects(stat(path.join(root, 'one')), { code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})


test('registering an orphaned private project restores drafts before writing the index', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eadp-orphan-project-'))
  try {
    const store = new StudioStore(path.join(root, 'program')); store.useUser(1)
    const value = await store.read()
    const project = { id: 'one', name: 'One', directory: path.join(root, 'one', 'repo'), workspaceDirectory: path.join(root, 'one'), repositoryUrl: 'https://example.test/one.git' }
    await mkdir(project.workspaceDirectory)
    value.projects.push(project)
    value.scenarios.push({ projectId: 'one', entityId: 'draft', sources: [], sourcePaths: {} })
    await store.save()
    const indexPath = path.join(store.directory, 'studio-state.json')
    const index = JSON.parse(await readFile(indexPath, 'utf8')); index.projects = []
    await writeFile(indexPath, JSON.stringify(index))
    const rebound = new StudioStore(path.join(root, 'program')); rebound.useUser(1)
    await rebound.registerProject(project)
    assert.equal((await rebound.read()).scenarios[0]?.entityId, 'draft')
    const reloaded = new StudioStore(path.join(root, 'program')); reloaded.useUser(1)
    assert.equal((await reloaded.read()).scenarios[0]?.entityId, 'draft')
  } finally { await rm(root, { recursive: true, force: true }) }
})
