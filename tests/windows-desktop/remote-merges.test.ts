import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import type { PlatformRuntime, ProcessResult } from '../../packages/studio-plugin/src/host/adapters/platform/runtime.ts'
import { WorkspaceGit } from '../../packages/studio-plugin/src/host/adapters/workspace/git.ts'
import type { HostPorts } from '../../packages/studio-plugin/src/host/application/ports.ts'
import { RemoteMerges, RemoteSyncPending } from '../../packages/studio-plugin/src/host/application/remote-merges.ts'

const head = 'a'.repeat(40), target = 'b'.repeat(40), preserved = 'c'.repeat(40)
const author = { name: '作者', email: 'author@example.test' }

async function fixture(t: test.TestContext, conflicts: readonly string[], mergeConflict?: (input: { path: string }) => Promise<{ content?: string; delete?: true }>, unchanged = false) {
  const worktree = await mkdtemp(path.join(tmpdir(), 'eadp-remote-merge-'))
  t.after(() => rm(worktree, { recursive: true, force: true }))
  await mkdir(path.join(worktree, '场景'))
  const calls: string[] = []
  const git = {
    state: async () => { calls.push('state'); return { head } },
    remoteHead: async () => target,
    hasCommit: async () => true,
    isAncestor: async (_root: string, from: string, to: string) => from === head && to === target,
    commits: async () => [{ sha: 'd'.repeat(40), title: '补充其他场景' }],
    changedFiles: async () => ['场景/其他.md'],
    identity: async () => ({ name: '作者', email: 'author@example.test' }),
    commitAll: async () => { calls.push('commitAll'); return unchanged ? head : preserved },
    fastForward: async () => { calls.push('fastForward') },
    applyCommit: async () => { calls.push('applyCommit'); return [...conflicts] },
    conflictStages: async () => ({ base: Buffer.from('旧'), ours: Buffer.from('远端'), theirs: Buffer.from('本地') }),
    resolvePath: async (_root: string, file: string) => { calls.push(`resolve:${file}`) },
    quitApply: async () => { calls.push('quitApply') },
    unstage: async () => { calls.push('unstage') },
    abortApply: async () => { calls.push('abortApply') },
    restore: async () => { calls.push('restore') },
    moveHead: async () => { calls.push('moveHead') },
  }
  const merges = new RemoteMerges({ git, ...(mergeConflict ? { mergeConflict } : {}) } as unknown as Pick<HostPorts, 'git' | 'mergeConflict'>)
  return { worktree, calls, merges }
}

test('a clean remote advance preserves local bytes and reports the applied commits', async t => {
  const f = await fixture(t, [])
  const report = await f.merges.align({ worktree: f.worktree, target, identity: author })
  assert.deepEqual(report?.files, ['场景/其他.md'])
  assert.deepEqual(report?.aiFiles, [])
  assert.deepEqual(f.calls, ['state', 'commitAll', 'applyCommit', 'quitApply', 'moveHead', 'unstage'])
})

test('AI merges a text conflict and the resolved bytes are applied', async t => {
  const f = await fixture(t, ['场景/其他.md'], async () => ({ content: '双方内容\n' }))
  const report = await f.merges.align({ worktree: f.worktree, target, identity: author })
  assert.deepEqual(report?.aiFiles, ['场景/其他.md'])
  assert.equal(await readFile(path.join(f.worktree, '场景/其他.md'), 'utf8'), '双方内容\n')
  assert.ok(f.calls.includes('resolve:场景/其他.md'))
})

test('AI merges a conflict on this confirmation material', async t => {
  const f = await fixture(t, ['场景/场景02.md'], async () => ({ content: '合并后的材料\n' }))
  const report = await f.merges.align({ worktree: f.worktree, target, identity: author })
  assert.deepEqual(report?.aiFiles, ['场景/场景02.md'])
  assert.equal(await readFile(path.join(f.worktree, '场景/场景02.md'), 'utf8'), '合并后的材料\n')
  assert.ok(f.calls.includes('resolve:场景/场景02.md'))
  assert.ok(!f.calls.includes('abortApply'))
})

test('a conflicted file symlink cannot write outside the worktree', async t => {
  const f = await fixture(t, ['场景/场景02.md'], async () => ({ content: '越界写入\n' }))
  const externalRoot = await mkdtemp(path.join(tmpdir(), 'eadp-remote-merge-external-'))
  t.after(() => rm(externalRoot, { recursive: true, force: true }))
  const external = path.join(externalRoot, 'outside.md')
  await writeFile(external, '外部原内容\n')
  await symlink(external, path.join(f.worktree, '场景/场景02.md'))
  await assert.rejects(f.merges.align({ worktree: f.worktree, target, identity: author }), /普通文件|超出项目范围/)
  assert.equal(await readFile(external, 'utf8'), '外部原内容\n')
})

test('a conflicted parent directory symlink cannot write outside the worktree', async t => {
  const f = await fixture(t, ['场景/场景02.md'], async () => ({ content: '越界写入\n' }))
  const externalRoot = await mkdtemp(path.join(tmpdir(), 'eadp-remote-merge-external-'))
  t.after(() => rm(externalRoot, { recursive: true, force: true }))
  const external = path.join(externalRoot, '场景02.md')
  await writeFile(external, '外部原内容\n')
  await rm(path.join(f.worktree, '场景'), { recursive: true })
  await symlink(externalRoot, path.join(f.worktree, '场景'))
  await assert.rejects(f.merges.align({ worktree: f.worktree, target, identity: author }), /普通文件|超出项目范围/)
  assert.equal(await readFile(external, 'utf8'), '外部原内容\n')
})

test('an AI deletion also refuses a conflicted file symlink', async t => {
  const f = await fixture(t, ['场景/场景02.md'], async () => ({ delete: true }))
  const externalRoot = await mkdtemp(path.join(tmpdir(), 'eadp-remote-merge-external-'))
  t.after(() => rm(externalRoot, { recursive: true, force: true }))
  const external = path.join(externalRoot, 'outside.md')
  await writeFile(external, '外部原内容\n')
  const linked = path.join(f.worktree, '场景/场景02.md')
  await symlink(external, linked)
  await assert.rejects(f.merges.align({ worktree: f.worktree, target, identity: author }), /普通文件|超出项目范围/)
  assert.equal(await readFile(linked, 'utf8'), '外部原内容\n')
})

test('a clean worktree moves to the accepted head without replaying its own history', async t => {
  const f = await fixture(t, [], undefined, true)
  const report = await f.merges.align({ worktree: f.worktree, target, identity: author })
  assert.ok(report)
  assert.ok(!f.calls.includes('applyCommit'))
  assert.ok(f.calls.includes('fastForward'))
})

for (const localChanges of [false, true]) {
  test(`real Git alignment updates accepted bytes and ${localChanges ? 'preserves local edits' : 'keeps a clean checkout clean'}`, async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'eadp-remote-merge-real-'))
    t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
    const execute = promisify(execFile)
    const run = async (args: readonly string[], cwd = root): Promise<ProcessResult> => {
      try {
        const result = await execute('git', [...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } })
        return { ...result, stdoutBytes: Buffer.from(result.stdout), exitCode: 0 }
      } catch (error) {
        const failure = error as { code: number | string; stdout: string; stderr: string }
        if (typeof failure.code !== 'number') throw error
        return { stdout: failure.stdout, stderr: failure.stderr, stdoutBytes: Buffer.from(failure.stdout), exitCode: failure.code }
      }
    }
    const setup = async (...args: string[]) => { const result = await run(args); assert.equal(result.exitCode, 0, result.stderr); return result.stdout.trim() }
    await setup('init', '--initial-branch=main')
    await setup('config', 'user.name', author.name); await setup('config', 'user.email', author.email)
    await setup('config', 'commit.gpgsign', 'false'); await setup('config', 'core.autocrlf', 'false')
    await setup('remote', 'add', 'origin', 'https://example.test/project.git')
    await writeFile(path.join(root, 'material.md'), 'old accepted material\n')
    await writeFile(path.join(root, 'local.md'), 'original local material\n')
    await setup('add', '--all'); await setup('commit', '-m', 'base')
    const original = await setup('rev-parse', 'HEAD')
    await writeFile(path.join(root, 'material.md'), 'new accepted remote material\n')
    await setup('add', '--all'); await setup('commit', '-m', 'accepted remote update')
    const accepted = await setup('rev-parse', 'HEAD')
    await setup('reset', '--hard', original)
    if (localChanges) await writeFile(path.join(root, 'local.md'), 'uncommitted author edit\n')
    const runtime = {
      start: async (_tool: string, args: readonly string[], options: { cwd: string }) => ({ done: run(args, options.cwd) }),
      run: async (_tool: string, args: readonly string[], options: { cwd: string }) => run(args, options.cwd),
    } as unknown as PlatformRuntime
    const git = new WorkspaceGit(runtime)
    const merges = new RemoteMerges({ git } as unknown as Pick<HostPorts, 'git' | 'mergeConflict'>)
    const report = await merges.align({ worktree: root, target: accepted, identity: author })
    assert.deepEqual(report?.files, ['material.md'])
    assert.equal(await setup('rev-parse', 'HEAD'), accepted)
    assert.equal(await readFile(path.join(root, 'material.md'), 'utf8'), 'new accepted remote material\n')
    assert.equal(await readFile(path.join(root, 'local.md'), 'utf8'), localChanges ? 'uncommitted author edit\n' : 'original local material\n')
    assert.equal(await setup('status', '--porcelain'), localChanges ? 'M local.md' : '')
    assert.equal(await setup('diff', '--cached', '--name-only'), '')
  })
}

test('a leftover candidate commit is reclaimed as local bytes without a merge', async t => {
  const f = await fixture(t, [])
  const git = { state: async () => ({ head: preserved }), hasCommit: async () => true, isAncestor: async (_root: string, from: string, to: string) => from === target && to === preserved, moveHead: async (_root: string, sha: string) => { assert.equal(sha, target); f.calls.push('moveHead') }, unstage: async () => { f.calls.push('unstage') } }
  const merges = new RemoteMerges({ git } as unknown as Pick<HostPorts, 'git' | 'mergeConflict'>)
  const report = await merges.align({ worktree: f.worktree, target, identity: author })
  assert.equal(report, undefined)
  assert.deepEqual(f.calls, ['moveHead', 'unstage'])
})

test('a missing accepted commit is reported as a background sync', async t => {
  const f = await fixture(t, [])
  const git = { state: async () => ({ head }), remoteHead: async () => target, hasCommit: async () => false }
  const merges = new RemoteMerges({ git } as unknown as Pick<HostPorts, 'git' | 'mergeConflict'>)
  await assert.rejects(merges.align({ worktree: f.worktree, target, identity: author }), (error: unknown) => error instanceof RemoteSyncPending && error.target === target)
})

test('a rewritten remote history is never merged as if it were an advance', async t => {
  const f = await fixture(t, [])
  const git = { state: async () => ({ head }), remoteHead: async () => target, hasCommit: async () => true, isAncestor: async () => false }
  const merges = new RemoteMerges({ git } as unknown as Pick<HostPorts, 'git' | 'mergeConflict'>)
  await assert.rejects(merges.align({ worktree: f.worktree, target, identity: author }), /独立提交/)
})
