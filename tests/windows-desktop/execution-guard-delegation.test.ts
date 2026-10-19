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
