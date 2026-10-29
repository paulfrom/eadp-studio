import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFile } from 'node:child_process'
import { mkdtemp, writeFile, rm, mkdir, symlink, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { WorkspaceGit } from '../../packages/studio-plugin/src/host/adapters/workspace/git.ts'
import type { PlatformRuntime, ProcessResult } from '../../packages/studio-plugin/src/host/adapters/platform/runtime.ts'

const exec = promisify(execFile)
const identity = { name: 'Tester', email: 'tester@example.test' }
const runtime = (() => {
  const run = (file: string, args: string[], options: { cwd: string; input?: string }): Promise<ProcessResult> => new Promise(resolve => {
    const child = execFile(file, args, { cwd: options.cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ exitCode: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout, stderr, stdoutBytes: Buffer.from(stdout) } as ProcessResult)
    })
    child.stdin?.end(options.input)
  })
  return { run, start: (file: string, args: string[], options: { cwd: string; input?: string }) => ({ done: run(file, args, options), onOutput: () => () => {} }) } as unknown as PlatformRuntime
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
  await git.switchBranch(root, 'candidate', clean.commit)
  assert.equal((await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim(), clean.commit)
  assert.equal((await exec('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: root })).stdout.trim(), 'candidate')
  assert.equal((await exec('git', ['rev-list', '--parents', '-n', '1', 'HEAD'], { cwd: root })).stdout.trim(), cleanParents.join(' '))
  await git.deleteBranch(root, 'studio-merge/test', clean.commit)
  assert.equal((await exec('git', ['branch', '--list', 'studio-merge/test'], { cwd: root })).stdout.trim(), '')
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

test('changed path statuses use committed tree metadata for large, special and non-regular files', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'git-status-')); t.after(() => rm(root, { recursive: true, force: true }))
  await exec('git', ['init', '--initial-branch', 'main'], { cwd: root })
  await exec('git', ['config', 'user.name', identity.name], { cwd: root }); await exec('git', ['config', 'user.email', identity.email], { cwd: root })
  const commitAll = async (message: string) => { await exec('git', ['add', '-A'], { cwd: root }); await exec('git', ['commit', '-m', message], { cwd: root }); return (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim() }
  await writeFile(path.join(root, 'modify.md'), 'base')
  await writeFile(path.join(root, 'delete.md'), 'base')
  const base = await commitAll('base')

  await writeFile(path.join(root, 'modify.md'), 'head')
  await unlink(path.join(root, 'delete.md'))
  const large = '.eadp/evidence/large.md'
  await mkdir(path.dirname(path.join(root, large)), { recursive: true })
  await writeFile(path.join(root, large), Buffer.alloc(1_048_577, 97))
  const special = process.platform === 'win32' ? '场景/特殊 空格与中文.md' : '场景/特殊\n换行\t制表.md'
  await mkdir(path.dirname(path.join(root, special)), { recursive: true })
  await writeFile(path.join(root, special), 'special')
  await mkdir(path.join(root, 'bulk'))
  await Promise.all(Array.from({ length: 1200 }, (_, index) => writeFile(path.join(root, 'bulk', `${index}.md`), String(index))))
  if (process.platform !== 'win32') await symlink('modify.md', path.join(root, 'link.md'))
  const head = await commitAll('large change set')

  const statuses = await new WorkspaceGit(runtime).changedPathStatuses(root, base, head)
  const byPath = new Map(statuses.map(value => [value.path, value.status]))
  assert.equal(statuses.length, process.platform === 'win32' ? 1204 : 1205)
  assert.equal(byPath.get('modify.md'), 'M')
  assert.equal(byPath.get('delete.md'), 'D')
  assert.equal(byPath.get(large), 'A')
  assert.equal(byPath.get(special), 'A')
  assert.equal(byPath.get('bulk/1199.md'), 'A')
  if (process.platform !== 'win32') assert.equal(byPath.get('link.md'), 'A')
})

test('working fingerprint detects tracked and untracked content even when Git status is unchanged', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'git-fingerprint-')); t.after(() => rm(root, { recursive: true, force: true }))
  await exec('git', ['init', '--initial-branch', 'main'], { cwd: root })
  await exec('git', ['config', 'user.name', identity.name], { cwd: root }); await exec('git', ['config', 'user.email', identity.email], { cwd: root })
  await writeFile(path.join(root, 'tracked.txt'), 'base'); await exec('git', ['add', '-A'], { cwd: root }); await exec('git', ['commit', '-m', 'base'], { cwd: root })
  const git = new WorkspaceGit(runtime)
  await writeFile(path.join(root, 'tracked.txt'), 'first'); await writeFile(path.join(root, 'untracked.txt'), 'first')
  const before = await git.workingFingerprint(root)
  assert.equal(await git.workingFingerprint(root), before)
  await writeFile(path.join(root, 'tracked.txt'), 'other')
  const tracked = await git.workingFingerprint(root); assert.notEqual(tracked, before)
  await writeFile(path.join(root, 'untracked.txt'), 'other')
  assert.notEqual(await git.workingFingerprint(root), tracked)
})
