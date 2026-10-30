import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ProjectRecord } from '../../packages/studio-plugin/src/host/adapters/project-record.ts'
import { StudioStore } from '../../packages/studio-plugin/src/host/application/state.ts'
import { PrototypeCheckJournal } from '../../packages/studio-plugin/src/host/prototype/check-journal.ts'

test('project record isolation preserves other projects when a workspace is deleted', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'eadp-project-record-'))
  try {
    const store = new StudioStore(path.join(root, 'program')); store.useUser(1)
    for (const id of ['one', 'two']) {
      const workspaceDirectory = path.join(root, id); await mkdir(workspaceDirectory)
      await store.registerProject({ id, name: id, workspaceDirectory, directory: path.join(workspaceDirectory, 'repo'), repositoryUrl: 'https://example.test/' + id })
    }
    type Entry = { projectId: string; body: string }
    const record = new ProjectRecord<Entry[]>(store, 'drafts.json', () => [], (values, id) => values.filter(value => value.projectId === id), values => values.flat())
    const values = [{ projectId: 'one', body: 'one-private' }, { projectId: 'two', body: 'two-private' }]
    await record.write(values)
    assert.equal((await readFile(path.join(await store.projectDirectory('one'), 'drafts.json'), 'utf8')).includes('two-private'), false)
    await rm(path.join(root, 'one'), { recursive: true })
    await record.write(values)
    await assert.rejects(stat(path.join(root, 'one')), { code: 'ENOENT' })
    const restarted = new StudioStore(path.join(root, 'program')); restarted.useUser(1)
    assert.equal((await restarted.read()).projects.length, 2)
    assert.deepEqual(await record.read(), [values[1]])
    await assert.rejects(stat(path.join(store.directory, 'drafts.json')), { code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('finishing a check cannot recreate a project folder removed during execution', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'eadp-project-journal-'))
  try {
    const store = new StudioStore(path.join(root, 'program')); store.useUser(1)
    const workspaceDirectory = path.join(root, 'project'); await mkdir(workspaceDirectory)
    await store.registerProject({ id: 'project', name: '项目', workspaceDirectory, directory: path.join(workspaceDirectory, 'repo'), repositoryUrl: 'https://example.test/project' })
    const journal = await new PrototypeCheckJournal(store, 'tools').begin({ projectId: 'project', entityId: 'task', sessionId: 'session', purpose: 'prototype', inputHash: '', worktree: path.join(workspaceDirectory, 'worktree') }, 'a'.repeat(40), 'operation', 'checks')
    await rm(workspaceDirectory, { recursive: true })
    await assert.rejects(journal.finish('passed'), { code: 'ENOENT' })
    await assert.rejects(stat(workspaceDirectory), { code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})
