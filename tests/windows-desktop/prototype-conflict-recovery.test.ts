import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { WorkspaceGit, type PrototypeConflictWriteback } from '../../packages/studio-plugin/src/host/adapters/workspace/git.ts'
import type { PlatformRuntime, ProcessResult } from '../../packages/studio-plugin/src/host/adapters/platform/runtime.ts'

const exec = promisify(execFile)
const pinnedVersion = '2.56.0.windows.2'

function runtime(): PlatformRuntime {
  const start = (tool: string, args: string[], options: { cwd: string; input?: string }) => ({
    done: new Promise<ProcessResult>(resolve => {
      const child = execFile(tool, args, { cwd: options.cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
        const exitCode = typeof (error as NodeJS.ErrnoException | null)?.code === 'number' ? (error as unknown as { code: number }).code : error ? 1 : 0
        resolve({ stdout, stderr, stdoutBytes: Buffer.from(stdout), exitCode })
      })
      child.stdin?.end(options.input)
    }),
    onOutput: () => () => {},
  })
  return {
    manifest: { tools: { git: { version: pinnedVersion } } },
    run: async (tool: string, args: string[], options: { cwd: string; input?: string }) => {
      const result = await start(tool, args, options).done
      if (result.exitCode !== 0) throw new Error(`${tool} failed: ${result.exitCode}`)
      return result
    },
    start: (tool: string, args: string[], options: { cwd: string; input?: string }) => {
      if (args[0] === '--no-replace-objects' && args.at(-1) === '--version') return { done: Promise.resolve({ stdout: `git version ${pinnedVersion}\n`, stderr: '', stdoutBytes: Buffer.from(`git version ${pinnedVersion}\n`), exitCode: 0 }), onOutput: () => () => {} }
      return start(tool, args, options)
    },
  } as unknown as PlatformRuntime
}

test('retained merge-tree conflicts restore exact files and modes without touching other project trees', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'prototype-conflict-recovery-'))
  const home = process.env.HOME
  t.after(async () => { process.env.HOME = home; await rm(directory, { recursive: true, force: true }) })
  const homeDirectory = path.join(directory, 'home'); process.env.HOME = homeDirectory
  await mkdir(homeDirectory)
  await writeFile(path.join(homeDirectory, '.gitconfig'), '[user]\n\tname = Conflict Tester\n\temail = conflict@example.test\n[init]\n\tdefaultBranch = main\n')
  const root = path.join(directory, 'repository'), scene = path.join(directory, 'scenes')
  await mkdir(path.join(root, '原型代码'), { recursive: true }); await mkdir(path.join(root, '需求'))
  await exec('git', ['init', '--initial-branch', 'main'], { cwd: root })
  await writeFile(path.join(root, '原型代码/app.txt'), 'base\n')
  await writeFile(path.join(root, '原型代码/delete.txt'), 'delete me\n')
  await writeFile(path.join(root, '需求/keep.md'), 'unchanged business material\n')
  const commit = async (message: string) => {
    await exec('git', ['add', '-A'], { cwd: root }); await exec('git', ['commit', '-m', message], { cwd: root })
    return (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()
  }
  const sourceBaseHead = await commit('base')
  await writeFile(path.join(root, '原型代码/app.txt'), 'accepted head\n')
  const expectedHead = await commit('accepted head')
  await exec('git', ['checkout', '-b', 'studio/prototype/task', sourceBaseHead], { cwd: root })
  await writeFile(path.join(root, '原型代码/app.txt'), 'author source\n')
  await unlink(path.join(root, '原型代码/delete.txt'))
  await writeFile(path.join(root, '原型代码/new.sh'), '#!/bin/sh\necho author\n')
  await chmod(path.join(root, '原型代码/new.sh'), 0o755)
  const git = new WorkspaceGit(runtime()), writeScope = ['app.txt', 'delete.txt', 'new.sh']
  const source = await git.prototypeSource(root, sourceBaseHead, 'conflict-operation', writeScope, await git.identity(root))
  const merged = await git.prototypeCleanMerge(root, { operationRoot: scene, operationId: 'conflict-operation', sourceBaseHead, sourceSha: source.sha, expectedHead, writeScope, identity: await git.identity(root) })
  if (merged.status !== 'conflicted') assert.fail('expected a real merge-tree conflict')
  assert.deepEqual(merged.conflictFiles, ['app.txt'])
  const input = { directory: merged.directory, operationId: 'conflict-operation', sourceBaseHead, sourceSha: source.sha, expectedHead, mergeBaseSha: merged.mergeBaseSha, writeScope }
  let writeback: PrototypeConflictWriteback | undefined
  const restore = () => git.prototypeRestoreConflict(root, {
    ...input, ...(writeback ? { writeback: structuredClone(writeback) } : {}),
    onPlan: async plan => { writeback = structuredClone(plan) },
    onPathRestored: async filePath => { const entry = writeback?.files.find(value => value.path === filePath); assert.ok(entry); entry.status = 'written' },
  })

  await restore()
  const conflictText = await readFile(path.join(root, '原型代码/app.txt'), 'utf8')
  assert.match(conflictText, /<<<<<<<|=======|>>>>>>>/)
  assert.equal(await readFile(path.join(root, '原型代码/delete.txt'), 'utf8').then(() => 'present', error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent'; throw error }), 'absent')
  assert.equal(await readFile(path.join(root, '需求/keep.md'), 'utf8'), 'unchanged business material\n')
  assert.equal(await readFile(path.join(root, '原型代码/new.sh'), 'utf8'), '#!/bin/sh\necho author\n')
  if (process.platform !== 'win32') assert.ok((await stat(path.join(root, '原型代码/new.sh'))).mode & 0o111)
  assert.ok(writeback?.files.every(value => value.status === 'written'))

  await writeFile(path.join(root, '原型代码/app.txt'), 'author source\n')
  await restore()
  assert.equal(await readFile(path.join(root, '原型代码/app.txt'), 'utf8'), conflictText)
  assert.equal(await readFile(path.join(root, '原型代码/delete.txt'), 'utf8').then(() => 'present', error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent'; throw error }), 'absent')

  const temporary = writeback!.files.find(value => value.path === 'app.txt')!.temporary
  const temporaryPath = path.join(root, '原型代码', temporary), otherTemporary = path.join(root, '原型代码/.other-operation.tmp')
  await writeFile(temporaryPath, 'interrupted temporary bytes'); await writeFile(otherTemporary, 'unrelated user bytes')
  await restore()
  assert.equal(await stat(temporaryPath).then(() => true, error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }), false)
  assert.equal(await readFile(otherTemporary, 'utf8'), 'unrelated user bytes'); await unlink(otherTemporary)
  const resolved = await git.prototypeSource(root, expectedHead, 'resolved-operation', writeScope, await git.identity(root))
  assert.equal(resolved.changedPaths.some(value => value.includes('.eadp-conflict-')), false)
  assert.equal((await exec('git', ['rev-parse', 'refs/eadp/archive/prototype-source/conflict-operation'], { cwd: root })).stdout.trim(), source.sha)
  assert.equal(JSON.parse(await readFile(path.join(merged.directory, 'identity.json'), 'utf8')).operationId, 'conflict-operation')

  await writeFile(path.join(root, '原型代码/app.txt'), 'external edit between recovery attempts\n')
  await assert.rejects(restore(), /外部新改动/)
  assert.equal(await readFile(path.join(root, '原型代码/app.txt'), 'utf8'), 'external edit between recovery attempts\n')
  await writeFile(path.join(root, '原型代码/app.txt'), conflictText)
  if (process.platform !== 'win32') {
    await unlink(path.join(root, '原型代码/new.sh')); await symlink('../需求/keep.md', path.join(root, '原型代码/new.sh'))
    await assert.rejects(restore(), /符号链接|普通文件/)
    assert.equal(await readFile(path.join(root, '需求/keep.md'), 'utf8'), 'unchanged business material\n')
  }
})
