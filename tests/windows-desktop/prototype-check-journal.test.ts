import assert from 'node:assert/strict'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { StudioStore } from '../../packages/studio-plugin/src/host/application/state.ts'
import { PrototypeCheckJournal } from '../../packages/studio-plugin/src/host/prototype/check-journal.ts'
import { installPrototypeDependencies } from '../../packages/studio-plugin/src/host/prototype/checks.ts'
import type { PlatformRuntime } from '../../packages/studio-plugin/src/host/adapters/platform/runtime.ts'
import type { TaskView } from '../../packages/studio-plugin/src/shared/studio.ts'

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'prototype-check-journal-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new StudioStore(path.join(root, 'state')); store.useUser(1)
  const registered = await store.read(); registered.projects.push({ id: 'project', name: '项目', workspaceDirectory: root, directory: path.join(root, 'repo'), repositoryUrl: 'https://git.test/project.git' }); await store.save()
  const task = { projectId: 'project', entityId: 'task', worktree: root, sessionId: 'session', purpose: 'prototype', inputHash: '' } as TaskView
  const source = { projectId: 'project', prototypeTaskId: 'task' }
  return { root, store, task, source }
}

test('failed command retains bounded output and exit code after Host restart', async t => {
  const f = await fixture(t)
  const prototypeRoot = path.join(f.root, 'prototype')
  const manifestPath = path.resolve('packages/studio-plugin/assets/prototype-template.manifest.json')
  await cp(path.resolve('packages/studio-plugin/assets/prototype-template'), prototypeRoot, { recursive: true, filter: source => !/[\\/]node_modules[\\/]?$/.test(source) })
  const journal = new PrototypeCheckJournal(f.store, 'tools')
  const operation = await journal.begin(f.task, 'sha', 'operation', 'checks')
  const runtime = { start: async (_tool: string, args: string[], options: { env: Record<string, string> }) => {
    assert.deepEqual(args, ['install', '--frozen-lockfile', '--virtual-store-dir=node_modules/.pnpm'])
    assert.equal(options.env.CI, 'true')
    return { onOutput: () => () => {}, done: Promise.resolve({ stdout: 'x'.repeat(70000), stderr: 'dependency failed', exitCode: 7 }) }
  } } as unknown as PlatformRuntime
  await assert.rejects(installPrototypeDependencies(runtime, { ...f.source, prototypeRoot, manifestPath, sessionId: 'session', sourceSha: 'sha' }, undefined, operation.step), /退出码 7/)
  await operation.finish('failed', undefined, new Error('dependency failed'))
  const restarted = new PrototypeCheckJournal(f.store, 'tools')
  const report = (await restarted.latest([f.source]))[0]!
  assert.equal(report.status, 'failed')
  assert.equal(report.steps[0]!.exitCode, 7)
  assert.equal(report.steps[0]!.diagnostic!.stdout.length, 65536)
  assert.equal(report.steps[0]!.diagnostic!.stderr, 'dependency failed')
  assert.equal(report.steps[0]!.diagnostic!.truncated, true)
  assert.equal(report.message, 'dependency failed')
})

test('running command publishes bounded output before completion without duplicating final output', async t => {
  const f = await fixture(t)
  const prototypeRoot = path.join(f.root, 'prototype')
  const manifestPath = path.resolve('packages/studio-plugin/assets/prototype-template.manifest.json')
  await cp(path.resolve('packages/studio-plugin/assets/prototype-template'), prototypeRoot, { recursive: true, filter: source => !/[\\/]node_modules[\\/]?$/.test(source) })
  const journal = new PrototypeCheckJournal(f.store, 'tools')
  const operation = await journal.begin(f.task, 'sha', 'live-operation', 'preview')
  let emit: ((channel: 'stdout' | 'stderr', text: string) => void) | undefined
  let complete: ((result: { stdout: string; stderr: string; exitCode: number }) => void) | undefined
  const done = new Promise<{ stdout: string; stderr: string; exitCode: number }>(resolve => { complete = resolve })
  const runtime = { start: async () => ({ onOutput: (listener: typeof emit) => { emit = listener; return () => {} }, done }) } as unknown as PlatformRuntime
  const running = installPrototypeDependencies(runtime, { ...f.source, prototypeRoot, manifestPath, sessionId: 'session', sourceSha: 'sha' }, undefined, operation.step)
  for (let attempt = 0; attempt < 100 && !emit; attempt += 1) await delay(10)
  assert.ok(emit)
  emit('stdout', 'dependency install started\n')
  let live = (await journal.latest([f.source]))[0]!
  for (let attempt = 0; attempt < 100 && !live.steps[0]?.diagnostic?.stdout; attempt += 1) {
    await delay(10)
    live = (await journal.latest([f.source]))[0]!
  }
  assert.equal(live.status, 'running')
  assert.equal(live.steps[0]!.diagnostic!.stdout, 'dependency install started\n')
  emit!('stderr', 'registry warning\n')
  complete!({ stdout: 'dependency install started\n', stderr: 'registry warning\n', exitCode: 0 })
  await running
  await operation.finish('passed', { inputHash: 'input', outputHash: 'output', rulesSha256: 'rules' } as never)
  const finished = (await journal.latest([f.source]))[0]!
  assert.equal(finished.steps[0]!.status, 'passed')
  assert.equal(finished.steps[0]!.diagnostic!.stdout, 'dependency install started\n')
  assert.equal(finished.steps[0]!.diagnostic!.stderr, 'registry warning\n')
})

test('restart marks unfinished operations interrupted and keeps another account isolated', async t => {
  const f = await fixture(t), journal = new PrototypeCheckJournal(f.store, 'tools')
  await journal.begin(f.task, 'sha', 'operation', 'preview')
  assert.equal((await journal.latest([f.source]))[0]!.status, 'running')
  const restarted = new PrototypeCheckJournal(f.store, 'tools')
  assert.equal((await restarted.latest([f.source]))[0]!.status, 'interrupted')
  f.store.useUser(2)
  const second = await f.store.read(); second.projects.push({ id: 'project', name: '项目', workspaceDirectory: f.root, directory: path.join(f.root, 'repo'), repositoryUrl: 'https://git.test/project.git' }); await f.store.save()
  assert.deepEqual(await restarted.latest([f.source]), [])
})

test('repeated history reads and Host restart preserve recorded outcomes without inspecting the engineering workspace', async t => {
  const f = await fixture(t)
  const journal = new PrototypeCheckJournal(f.store, 'tools')
  const operation = await journal.begin({ ...f.task, worktree: path.join(f.root, 'missing-engineering-workspace') }, 'sha', 'operation', 'checks')
  await operation.finish('passed', { inputHash: 'input', outputHash: 'output', rulesSha256: 'rules' } as never)
  const reports = await journal.latest([f.source])
  assert.equal(reports[0]!.status, 'passed')
  assert.equal(reports[0]!.inputHash, 'input')
  assert.equal(reports[0]!.toolsHash, 'tools')
  assert.equal('validity' in reports[0]!, false)
  assert.deepEqual(await journal.latest([f.source]), reports)
  assert.deepEqual(await new PrototypeCheckJournal(f.store, 'different-tools').latest([f.source]), reports)
})
