import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFile } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { WorkspaceGit } from '../../packages/studio-plugin/src/host/adapters/workspace/git.ts'
import type { PlatformRuntime, ProcessResult } from '../../packages/studio-plugin/src/host/adapters/platform/runtime.ts'

const exec = promisify(execFile)
const identity = { name: 'Tester', email: 'tester@example.test' }
const runtime = (() => {
  const run = (file: string, args: string[], options: { cwd: string }): Promise<ProcessResult> => new Promise(resolve => {
    execFile(file, args, { cwd: options.cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ exitCode: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout, stderr, stdoutBytes: Buffer.from(stdout) } as ProcessResult)
    })
  })
  return { run, start: (file: string, args: string[], options: { cwd: string }) => ({ done: run(file, args, options), onOutput: () => () => {} }) } as unknown as PlatformRuntime
})()

test('merge reports a clean merge commit and conflicted files, completeMerge finishes them', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'git-merge-')); t.after(() => rm(root, { recursive: true, force: true }))
  await exec('git', ['init', '--initial-branch', 'main'], { cwd: root })
  await exec('git', ['config', 'user.name', identity.name], { cwd: root }); await exec('git', ['config', 'user.email', identity.email], { cwd: root })
  const git = new WorkspaceGit(runtime)
  const commitAll = async (message: string) => { await exec('git', ['add', '-A'], { cwd: root }); await exec('git', ['commit', '-m', message], { cwd: root }); return (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim() }
  await writeFile(path.join(root, 'a.md'), 'base\n'); const base = await commitAll('base')
  await exec('git', ['checkout', '-b', 'candidate'], { cwd: root })
  await writeFile(path.join(root, 'a.md'), 'base\ncandidate\n'); const candidate = await commitAll('candidate')
  await exec('git', ['checkout', 'main'], { cwd: root })
  await writeFile(path.join(root, 'b.md'), 'remote\n'); const remote = await commitAll('remote')
  await git.checkoutBranch(root, 'studio-merge/test', remote)
  const clean = await git.merge(root, candidate, identity)
  if (clean.status !== 'merged') assert.fail('expected a clean merge')
  const cleanHead = (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()
  assert.equal(clean.commit, cleanHead)
  const cleanParents = (await exec('git', ['rev-list', '--parents', '-n', '1', 'HEAD'], { cwd: root })).stdout.trim().split(' ')
  assert.equal(cleanParents.length, 3)
  assert.ok(cleanParents.every(sha => /^[a-f0-9]{40}$/.test(sha)))
  assert.equal(cleanParents[1], remote)
  assert.equal(cleanParents[2], candidate)
  // 冲突场景：双方改同一行
  await exec('git', ['checkout', '-b', 'conflict', base], { cwd: root })
  await writeFile(path.join(root, 'a.md'), 'candidate line\n'); await commitAll('candidate edit')
  await exec('git', ['checkout', 'main'], { cwd: root })
  await writeFile(path.join(root, 'a.md'), 'remote line\n'); const remote2 = await commitAll('remote edit')
  await exec('git', ['checkout', 'conflict'], { cwd: root })
  const conflicted = await git.merge(root, remote2, identity)
  assert.equal(conflicted.status, 'conflicted')
  assert.deepEqual(conflicted.files, ['a.md'])
  await writeFile(path.join(root, 'a.md'), 'merged line\n')
  const stagedBeforeInvalidIdentity = (await exec('git', ['diff', '--cached', '--name-only'], { cwd: root })).stdout
  await assert.rejects(git.completeMerge(root, ['a.md'], { ...identity, name: '' }), /Git 提交身份无效。/)
  assert.equal((await exec('git', ['diff', '--cached', '--name-only'], { cwd: root })).stdout, stagedBeforeInvalidIdentity)
  const merged = await git.completeMerge(root, ['a.md'], identity)
  assert.match(merged, /^[a-f0-9]{40}$/)
  assert.equal((await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim(), merged)
})
