import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod, access, realpath } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { PlatformRuntime, type RuntimeManifest, type SubprocessProvider } from '../../packages/studio-plugin/src/host/adapters/platform/runtime.ts'
import { GitProgressReader, WorkspaceGit, repositoryAddress } from '../../packages/studio-plugin/src/host/adapters/workspace/git.ts'

// Windows exercises the prepared, locked delivery tools. A worktree can point at
// the same read-only bundle; Unix fixtures bind their explicitly hashed native tools.
async function testRuntime(directory: string, provider: SubprocessProvider) {
  const preparedRoot = process.env.EADP_TEST_RUNTIME_ROOT ?? (process.platform === 'win32' ? path.resolve(import.meta.dirname, '../../.local/build/studio-tools-prepared') : undefined)
  if (preparedRoot) return PlatformRuntime.load(path.join(preparedRoot, 'runtime-manifest.json'), preparedRoot, provider)
  const nodePath = await realpath(process.execPath)
  let gitPath: string | undefined
  for (const entry of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    try { gitPath = await realpath(path.join(entry, 'git')); break }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error }
  }
  if (!gitPath) throw new Error('Native Git is required by this fixture.')
  const resourceRoot = path.parse(nodePath).root
  const entries = await Promise.all([gitPath, nodePath].map(async filename => ({ path: path.relative(resourceRoot, filename), version: 'test', sha256: createHash('sha256').update(await readFile(filename)).digest('hex'), source: 'native test executable', license: 'test' })))
  const manifest: RuntimeManifest = { schemaVersion: 1, platform: process.platform, arch: process.arch, tools: { git: entries[0]!, node: entries[1]!, pnpm: entries[0]!, ssh: entries[0]! } }
  const manifestPath = path.join(directory, 'runtime.json'); await writeFile(manifestPath, JSON.stringify(manifest))
  return PlatformRuntime.load(manifestPath, resourceRoot, provider)
}
const shellPath = (filename: string) => "'" + filename.replaceAll('\\', '/').replaceAll("'", "'\\''") + "'"

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'studio-personal-git-')), home = path.join(directory, 'home')
  await mkdir(home)
  const saved = Object.fromEntries(['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'SEI_GITLAB_TOKEN'].map(name => [name, process.env[name]]))
  Object.assign(process.env, { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'appdata'), LOCALAPPDATA: path.join(home, 'localappdata'), XDG_CONFIG_HOME: path.join(home, '.config'), SEI_GITLAB_TOKEN: 'fixture-management-token-must-not-pass' })
  const environments: NodeJS.ProcessEnv[] = []
  const provider: SubprocessProvider = { spawn(spec) {
    environments.push(spec.env)
    const child = spawn(spec.argv[0]!, spec.argv.slice(1), { cwd: spec.cwd, env: spec.env, signal: spec.signal, windowsHide: true, stdio: [spec.stdio.stdin === 'ignore' ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
    if (spec.stdio.stdin !== 'ignore') child.stdin!.end(spec.stdio.stdin.data)
    const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => { child.once('error', reject); child.once('close', (exitCode, signal) => resolve({ exitCode, signal })) })
    return { stdout: child.stdout ?? undefined, stderr: child.stderr ?? undefined, stdin: child.stdin ?? undefined, done, terminate: () => { child.kill() }, waitForExit: async () => { await done; return true } }
  } }
  let runtime: PlatformRuntime | undefined
  const dispose = async () => { await runtime?.dispose(); for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }; assert.equal(path.dirname(directory), path.resolve(tmpdir())); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
  try {
    runtime = await testRuntime(directory, provider)
    const helper = path.join(directory, 'fixture-helper'), marker = path.join(directory, 'helper-used')
    await writeFile(helper, `#!/bin/sh\nprintf used > ${shellPath(marker)}\nprintf 'username=fixture-user\\npassword=fixture-password\\n\\n'\n`); await chmod(helper, 0o700)
    for (const [key, value] of [['credential.helper', ''], ['credential.helper', `!${shellPath(helper)}`], ['user.name', 'Fixture User'], ['user.email', 'fixture@example.test']]) {
      await runtime.run('git', ['config', '--global', '--add', key!, value!], { cwd: directory, gitUserCredentials: true })
    }
    return { directory, home, runtime, git: new WorkspaceGit(runtime, async () => 'http://gitlab.example.test'), environments, marker, dispose }
  } catch (error) { await dispose(); throw error }
}

test('dedicated Git operations retain trusted global helpers; other tools receive no credentials', async () => {
  const f = await fixture()
  try {
    const credentials = await f.runtime.run('git', ['credential', 'fill'], { cwd: f.directory, gitUserCredentials: true, input: 'protocol=http\nhost=gitlab.example.test\n\n' })
    assert.match(credentials.stdout, /username=fixture-user/); await access(f.marker)
    const repo = path.join(f.directory, 'repo'); await f.git.init(repo, 'http://gitlab.example.test/team/project.git')
    await writeFile(path.join(repo, 'file.md'), '# 固定字节\n')
    const commit = await f.git.commitFiles(repo, ['file.md'], 'fixture commit', await f.git.identity(repo))
    assert.deepEqual(await f.git.readBlob(repo, commit, 'file.md'), Buffer.from('# 固定字节\n'))
    assert.equal((await f.git.state(repo)).repositoryUrl, 'http://gitlab.example.test/team/project.git')
    await f.runtime.run('node', ['-e', 'process.stdout.write("ok")'], { cwd: f.directory })
    const nodeEnvironment = f.environments.at(-1)!
    assert.equal(nodeEnvironment.HOME, undefined); assert.equal(nodeEnvironment.USERPROFILE, undefined); assert.equal(nodeEnvironment.GIT_CONFIG_GLOBAL, process.platform === 'win32' ? 'NUL' : '/dev/null')
    assert.equal(f.environments.every(env => env.SEI_GITLAB_TOKEN === undefined), true)
    await assert.rejects(f.runtime.run('node', ['-e', '0'], { cwd: f.directory, gitUserCredentials: true }), /专用 Git/)
  } finally { await f.dispose() }
})

test('repository-local helper/include/rewrite/hooks/proxy configuration is rejected before execution', async () => {
  const f = await fixture()
  try {
    const repo = path.join(f.directory, 'repo'); await f.git.init(repo, 'http://gitlab.example.test/team/project.git')
    const injected = path.join(f.directory, 'injected'), include = path.join(f.directory, 'injected.config')
    await writeFile(include, `[credential]\n\thelper = !touch ${shellPath(injected)}\n`)
    for (const [key, value] of [['include.path', include], ['credential.helper', `!touch ${shellPath(injected)}`], ['url.http://evil.test/.insteadOf', 'http://gitlab.example.test/'], ['core.hooksPath', f.directory], ['http.extraHeader', 'Authorization: fixture'], ['remote.origin.proxy', 'http://evil.test']]) {
      execFileSync(f.runtime.executable('git'), ['config', '--local', key!, value!], { cwd: repo, windowsHide: true, timeout: 15_000 })
      await assert.rejects(f.git.local(repo, ['status', '--porcelain=v1']), /不允许的凭据命令/)
      execFileSync(f.runtime.executable('git'), ['config', '--local', '--unset-all', key!], { cwd: repo, windowsHide: true, timeout: 15_000 })
      await assert.rejects(access(injected))
    }
    await writeFile(path.join(repo, '.git/hooks/pre-commit'), `#!/bin/sh\ntouch ${shellPath(injected)}\n`); await chmod(path.join(repo, '.git/hooks/pre-commit'), 0o700)
    await writeFile(path.join(repo, 'safe.md'), 'safe\n')
    await f.git.commitFiles(repo, ['safe.md'], 'hooks stay disabled', { name: 'Fixture', email: 'fixture@example.test' })
    await assert.rejects(access(injected))
  } finally { await f.dispose() }
})

test('Git accepts backend HTTP/HTTPS URLs and refuses credential or SSH rewriting paths', () => {
  assert.equal(repositoryAddress('http://gitlab.example.test/team/project.git'), 'http://gitlab.example.test/team/project.git')
  assert.equal(repositoryAddress('https://gitlab.example.test/team/project.git'), 'https://gitlab.example.test/team/project.git')
  for (const value of ['https://token@gitlab.example.test/team/project.git', 'git@gitlab.example.test:team/project.git', 'file:///tmp/a.git', 'https://gitlab.example.test/team/project.git?token=x', 'https://gitlab.example.test/a/../project.git']) assert.throws(() => repositoryAddress(value))
})

test('Git transfer progress survives carriage returns and lines split across chunks', () => {
  const reader = new GitProgressReader()
  assert.equal(reader.push("Cloning into 'project'...\nremote: Enumerating objects: 12, done.\n"), undefined, 'counting alone is not a percentage')
  assert.deepEqual(reader.push('remote: Counting objects: 45% (9/20)\r'), { stage: 'counting', percent: 45 })
  assert.equal(reader.push('remote: Compressing objects: 10'), undefined, 'a split percentage is not read early')
  assert.deepEqual(reader.push('0% (1/10)\rReceiving objects: 37% (74/200)\r'), { stage: 'receiving', percent: 37 })
  assert.deepEqual(reader.push('Receiving objects: 100% (200/200), 1.2 MiB | 3.4 MiB/s, done.\nResolving deltas: 12% (6/50)\r'), { stage: 'resolving', percent: 12 })
  assert.deepEqual(reader.push('Updating files: 100% (30/30), done.\n'), { stage: 'updating', percent: 100 })
})

test('linked worktrees support normal Git configuration and reject effective worktree injection', async () => {
  const f = await fixture()
  try {
    const repo = path.join(f.directory, 'repo'), worktree = path.join(f.directory, 'task')
    await f.git.init(repo, 'http://gitlab.example.test/team/project.git')
    await writeFile(path.join(repo, 'safe.md'), 'synthetic\n')
    const first = await f.git.commitFiles(repo, ['safe.md'], 'root', { name: 'Fixture', email: 'fixture@example.test' })
    await f.git.createWorktree(repo, worktree, 'task', first)
    assert.equal((await f.git.state(worktree)).head, first)
    await writeFile(path.join(worktree, 'safe.md'), 'synthetic revised\n')
    const next = await f.git.commitFiles(worktree, ['safe.md'], 'candidate', { name: 'Fixture', email: 'fixture@example.test' })
    assert.deepEqual(await f.git.changedFiles(worktree, first, next), ['safe.md'])
    execFileSync(f.runtime.executable('git'), ['config', '--local', 'extensions.worktreeConfig', 'true'], { cwd: repo, windowsHide: true })
    assert.equal((await f.git.state(worktree)).head, next)
    for (const [key, value] of [['credential.helper', '!echo forbidden'], ['include.path', path.join(f.directory, 'unread.config')], ['url.http://evil.test/.insteadOf', 'http://gitlab.example.test/']]) {
      execFileSync(f.runtime.executable('git'), ['config', '--worktree', key!, value!], { cwd: worktree, windowsHide: true })
      await assert.rejects(f.git.local(worktree, ['status', '--porcelain=v1']), /不允许的凭据命令/)
      execFileSync(f.runtime.executable('git'), ['config', '--worktree', '--unset-all', key!], { cwd: worktree, windowsHide: true })
    }
  } finally { await f.dispose() }
})
