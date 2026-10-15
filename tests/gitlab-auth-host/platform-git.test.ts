import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod, access } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { PlatformRuntime, type RuntimeManifest, type SubprocessProvider } from '../../packages/studio-plugin/src/host/adapters/platform/runtime.ts'
import { WorkspaceGit, repositoryAddress } from '../../packages/studio-plugin/src/host/adapters/workspace/git.ts'

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'studio-personal-git-')), home = path.join(directory, 'home')
  await mkdir(home)
  const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, SEI_GITLAB_TOKEN: process.env.SEI_GITLAB_TOKEN }
  process.env.HOME = home; process.env.XDG_CONFIG_HOME = path.join(home, '.config'); process.env.SEI_GITLAB_TOKEN = 'fixture-management-token-must-not-pass'
  const environments: NodeJS.ProcessEnv[] = []
  const provider: SubprocessProvider = { spawn(spec) {
    environments.push(spec.env)
    const child = spawn(spec.argv[0]!, spec.argv.slice(1), { cwd: spec.cwd, env: spec.env, stdio: [spec.stdio.stdin === 'ignore' ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
    if (spec.stdio.stdin !== 'ignore') child.stdin!.end(spec.stdio.stdin.data)
    const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => { child.once('error', reject); child.once('close', (exitCode, signal) => resolve({ exitCode, signal })) })
    return { stdout: child.stdout ?? undefined, stderr: child.stderr ?? undefined, stdin: child.stdin ?? undefined, done, terminate: () => { child.kill() }, waitForExit: async () => { await done; return true } }
  } }
  const gitPath = execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), nodePath = process.execPath
  const entries = await Promise.all([gitPath, nodePath].map(async filename => ({ path: filename.slice(1), version: 'test', sha256: createHash('sha256').update(await readFile(filename)).digest('hex'), source: 'test', license: 'test' })))
  const manifest: RuntimeManifest = { schemaVersion: 1, platform: process.platform, arch: process.arch, tools: { git: entries[0]!, node: entries[1]!, pnpm: entries[0]!, ssh: entries[0]! } }
  const manifestPath = path.join(directory, 'runtime.json'); await writeFile(manifestPath, JSON.stringify(manifest))
  const runtime = await PlatformRuntime.load(manifestPath, '/', provider)
  const helper = path.join(directory, 'fixture-helper'), marker = path.join(directory, 'helper-used')
  await writeFile(helper, `#!/bin/sh\nprintf used > '${marker}'\nprintf 'username=fixture-user\\npassword=fixture-password\\n\\n'\n`); await chmod(helper, 0o700)
  await writeFile(path.join(home, '.gitconfig'), `[credential]\n\thelper =\n\thelper = ${helper}\n[user]\n\tname = Fixture User\n\temail = fixture@example.test\n`)
  return { directory, home, runtime, git: new WorkspaceGit(runtime, async () => 'http://gitlab.example.test'), environments, marker, dispose: async () => { await runtime.dispose(); for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }; await rm(directory, { recursive: true, force: true }) } }
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
    assert.equal(nodeEnvironment.HOME, undefined); assert.equal(nodeEnvironment.GIT_CONFIG_GLOBAL, '/dev/null')
    assert.equal(f.environments.every(env => env.SEI_GITLAB_TOKEN === undefined), true)
    await assert.rejects(f.runtime.run('node', ['-e', '0'], { cwd: f.directory, gitUserCredentials: true }), /专用 Git/)
  } finally { await f.dispose() }
})

test('repository-local helper/include/rewrite/hooks/proxy configuration is rejected before execution', async () => {
  const f = await fixture()
  try {
    const repo = path.join(f.directory, 'repo'); await f.git.init(repo, 'http://gitlab.example.test/team/project.git')
    const injected = path.join(f.directory, 'injected'), include = path.join(f.directory, 'injected.config')
    await writeFile(include, `[credential]\n\thelper = !touch ${injected}\n`)
    for (const [key, value] of [['include.path', include], ['credential.helper', `!touch ${injected}`], ['url.http://evil.test/.insteadOf', 'http://gitlab.example.test/'], ['core.hooksPath', f.directory], ['http.extraHeader', 'Authorization: fixture'], ['remote.origin.proxy', 'http://evil.test']]) {
      execFileSync('git', ['config', '--local', key!, value!], { cwd: repo })
      await assert.rejects(f.git.local(repo, ['status', '--porcelain=v1']), /不允许的凭据命令/)
      execFileSync('git', ['config', '--local', '--unset-all', key!], { cwd: repo })
      await assert.rejects(access(injected))
    }
    await writeFile(path.join(repo, '.git/hooks/pre-commit'), `#!/bin/sh\ntouch '${injected}'\n`); await chmod(path.join(repo, '.git/hooks/pre-commit'), 0o700)
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
