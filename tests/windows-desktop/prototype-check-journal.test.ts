import assert from 'node:assert/strict'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
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
  const task = { projectId: 'project', entityId: 'task', worktree: root, sessionId: 'session', purpose: 'prototype', inputHash: '' } as TaskView
  const source = { projectId: 'project', prototypeTaskId: 'task' }
  return { root, store, task, source }
}

test('failed command retains bounded output and exit code after Host restart', async t => {
  const f = await fixture(t)
  const prototypeRoot = path.join(f.root, 'prototype')
  const manifestPath = path.resolve('packages/studio-plugin/assets/prototype-template.manifest.json')
  await cp(path.resolve('packages/studio-plugin/assets/prototype-template'), prototypeRoot, { recursive: true })
  const journal = new PrototypeCheckJournal(f.store, 'tools', async () => true)
  const operation = await journal.begin(f.task, 'sha', 'operation', 'checks')
  const runtime = { start: async () => ({ onOutput: () => () => {}, done: Promise.resolve({ stdout: 'x'.repeat(70000), stderr: 'dependency failed', exitCode: 7 }) }) } as unknown as PlatformRuntime
  await assert.rejects(installPrototypeDependencies(runtime, { ...f.source, prototypeRoot, manifestPath, sessionId: 'session', sourceSha: 'sha' }, undefined, operation.step), /退出码 7/)
  await operation.finish('failed', undefined, new Error('dependency failed'))
  const restarted = new PrototypeCheckJournal(f.store, 'tools', async () => true)
  const report = (await restarted.latest([f.source]))[0]!
  assert.equal(report.status, 'failed')
  assert.equal(report.steps[0]!.exitCode, 7)
  assert.equal(report.steps[0]!.diagnostic!.stdout.length, 65536)
  assert.equal(report.steps[0]!.diagnostic!.stderr, 'dependency failed')
  assert.equal(report.steps[0]!.diagnostic!.truncated, true)
  assert.equal(report.message, 'dependency failed')
})

test('restart marks unfinished operations interrupted and keeps another account isolated', async t => {
  const f = await fixture(t), journal = new PrototypeCheckJournal(f.store, 'tools', async () => true)
  await journal.begin(f.task, 'sha', 'operation', 'preview')
  assert.equal((await journal.latest([f.source]))[0]!.status, 'running')
  const restarted = new PrototypeCheckJournal(f.store, 'tools', async () => true)
  assert.equal((await restarted.latest([f.source]))[0]!.status, 'interrupted')
  f.store.useUser(2)
  assert.deepEqual(await restarted.latest([f.source]), [])
})

test('completed evidence is diagnosed stale after fingerprint or tool changes', async t => {
  const f = await fixture(t)
  let current = true
  const journal = new PrototypeCheckJournal(f.store, 'tools', async () => current)
  const operation = await journal.begin(f.task, 'sha', 'operation', 'checks')
  await operation.finish('passed', { inputHash: 'input', outputHash: 'output', rulesSha256: 'rules' } as never)
  assert.equal((await journal.latest([f.source]))[0]!.validity, 'current')
  current = false
  assert.equal((await journal.latest([f.source]))[0]!.validity, 'stale')
  assert.equal((await new PrototypeCheckJournal(f.store, 'different-tools', async () => true).latest([f.source]))[0]!.validity, 'stale')
})
