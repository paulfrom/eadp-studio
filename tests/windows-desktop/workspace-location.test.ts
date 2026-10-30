import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { WorkspaceLocation } from '../../packages/studio-plugin/src/host/application/workspace-location.ts'

test('default project location persists independently from project folders', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'eadp-locations-'))
  try {
    const program = path.join(root, 'program'), initial = path.join(root, 'projects'), chosen = path.join(root, 'my work')
    const location = new WorkspaceLocation(program, [program], initial)
    assert.equal((await location.view()).defaultDirectory, initial)
    const original = await location.project('abcdefgh-1234', 'https://example.test/team/purchase.git')
    await location.set(chosen)
    assert.equal((await new WorkspaceLocation(program, [program], initial).view()).defaultDirectory, chosen)
    assert.equal(await location.project('abcdefgh-1234', 'purchase'), path.join(chosen, 'purchase-abcdefgh'))
    assert.equal(original, path.join(initial, 'purchase-abcdefgh'))
    assert.deepEqual(await readdir(chosen), [])
    assert.equal(await location.project('different-id', 'purchase', path.join(root, 'custom')), path.join(root, 'custom'))
    assert.deepEqual(JSON.parse(await readFile(path.join(program, 'workspace-location.json'), 'utf8')), { defaultDirectory: chosen })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('program directories and aliases cannot become project storage', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'eadp-locations-boundary-'))
  try {
    const program = path.join(root, 'program'), tools = path.join(root, 'installed')
    await mkdir(program); await mkdir(tools)
    const location = new WorkspaceLocation(program, [program, tools], path.join(root, 'projects'))
    await assert.rejects(location.set(path.join(program, 'project')), /程序/)
    await assert.rejects(location.set(root), /程序/)
    await assert.rejects(location.set('relative'), /绝对路径/)
    const alias = path.join(root, 'alias')
    await symlink(tools, alias, process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(location.set(path.join(alias, 'new')), /程序/)
    assert.deepEqual(await readdir(program), [])
  } finally { await rm(root, { recursive: true, force: true }) }
})
