import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { registerStudioExecutionScope, studioToolGuard } from '../../packages/studio-plugin/src/host/adapters/platform/execution-guard.ts'

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-delegation-boundary-'))
  const current = path.join(root, 'review'), outside = path.join(root, 'outside'), nested = path.join(current, 'nested')
  await mkdir(nested, { recursive: true }); await mkdir(outside)
  await writeFile(path.join(current, 'probe.txt'), 'FIXED SNAPSHOT')
  await writeFile(path.join(outside, 'probe.txt'), 'OUTSIDE SNAPSHOT')
  await symlink(current, path.join(root, 'same-directory'), process.platform === 'win32' ? 'junction' : 'dir')
  await symlink(outside, path.join(current, 'external-link'), process.platform === 'win32' ? 'junction' : 'dir')
  const agent = { session: { header: { cwd: current } } }
  const dispose = registerStudioExecutionScope(current, { readRoot: current, writablePaths: [] }, agent)
  t.after(async () => { dispose(); assert.equal(path.dirname(root), path.resolve(tmpdir())); await rm(root, { recursive: true, force: true }) })
  const attempt = (args: unknown) => studioToolGuard({ name: 'spawn_agent', arguments: args, agent })
  return { root, current, outside, nested, agent, attempt }
}

test('Studio child agents can only inherit the exact managed directory', async t => {
  const f = await fixture(t)
  for (const [name, args] of [
    ['omitted cwd', {}], ['absolute same directory', { cwd: f.current }], ['relative same directory', { cwd: './' }],
    ['real-path alias of same directory', { cwd: path.join(f.root, 'same-directory') }],
  ] as const) await t.test(name, () => assert.equal(f.attempt(args), undefined))
  for (const [name, args] of [
    ['absolute outside directory', { cwd: f.outside }], ['relative outside directory', { cwd: '../outside' }],
    ['internal subdirectory', { cwd: 'nested' }], ['link to outside directory', { cwd: 'external-link' }],
    ['null cwd', { cwd: null }], ['numeric cwd', { cwd: 1 }], ['object cwd', { cwd: {} }],
    ['array cwd', { cwd: [] }], ['empty cwd', { cwd: '' }], ['NUL cwd', { cwd: '\0' }],
    ['null arguments', null], ['array arguments', []],
  ] as const) await t.test(name, () => assert.ok(f.attempt(args), name + ' must be rejected before delegation'))
})

// This integration case uses the pinned DSH function, not a mirror of its path
// rules. It never creates an Agent or accesses anything outside this fixture.
const dshRoot = process.env.EADP_TEST_DSH_ROOT
test('the actual DSH effective-cwd resolver cannot read a harmless file outside the fixed snapshot through delegation', { skip: !dshRoot }, async t => {
  const f = await fixture(t)
  const { sessionResolveOptions } = await import(pathToFileURL(path.join(dshRoot!, 'packages/fs/tool-fs/src/session-cwd.ts')).href)
  const denied = f.attempt({ cwd: f.outside })
  let observed = 'delegation denied'
  if (!denied) {
    // DSH childSessionMeta keeps header.cwd; manager applies requested cwd to
    // workingDirectory. Exercise the official file-tool resolver with that state.
    const execution = { name: 'read', arguments: { file_path: 'probe.txt' }, agent: f.agent, signal: new AbortController().signal }
    assert.equal(studioToolGuard(execution), undefined)
    const options = await sessionResolveOptions({ workingDirectory: { ensure: async () => f.outside } }, execution)
    observed = await readFile(path.resolve(options.cwd, 'probe.txt'), 'utf8')
  }
  assert.notEqual(observed, 'OUTSIDE SNAPSHOT', 'delegation escaped: the real DSH resolver read the harmless outside fixture')
  assert.ok(denied)
})


test('root search uses fixed no-follow rg commands while explicit external links remain denied', async t => {
  const f = await fixture(t)
  const globSource = path.resolve('.local/upstream/dsh/packages/fs/tool-fs-search/src/glob.ts')
  const grepSource = path.resolve('.local/upstream/dsh/packages/fs/tool-fs-search/src/grep.ts')
  const source = await Promise.all([globSource, grepSource].map(file => readFile(file, 'utf8')))
  for (const text of source) assert.ok(!text.includes("'--follow'") && !text.includes("'-L'"))
  // Execute the fixed official argv against a real junction, including ignored files.
  const buildGlobCommand = (_input: unknown) => ['--files', '--glob=**/*', '--sort=modified', '--no-ignore', '--hidden', '--glob=!**/.git', '--glob=!**/.git/**', '--glob=!**/.hg', '--glob=!**/.hg/**', '--glob=!**/.svn', '--glob=!**/.svn/**', '--', '.']
  const buildGrepCommand = (_input: unknown) => ['--json', '--regexp=SNAPSHOT', '--', '.']
  for (const name of ['glob', 'grep', 'read', 'write']) {
    const arguments_ = name === 'glob' || name === 'grep' ? { path: 'external-link', pattern: '*' } : { file_path: 'external-link/probe.txt', content: 'forbidden' }
    assert.ok(studioToolGuard({ name, arguments: arguments_, agent: f.agent }))
  }
  for (const [name, args, argv] of [
    ['glob', { pattern: '**/*', path: '.' }, buildGlobCommand({ pattern: '**/*', path: '.' })],
    ['grep', { pattern: 'SNAPSHOT', path: '.' }, buildGrepCommand({ pattern: 'SNAPSHOT', path: '.' })],
  ] as const) {
    assert.equal(studioToolGuard({ name, arguments: args, agent: f.agent }), undefined)
    assert.ok(!argv.includes('--follow') && !argv.includes('-L'))
    const { stdout } = await promisify(execFile)('rg', argv, { cwd: f.current })
    assert.ok(stdout.includes('probe.txt'))
    assert.ok(!stdout.includes('external-link'))
    assert.ok(!stdout.includes('OUTSIDE SNAPSHOT'))
  }
})
