import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { PlatformRuntime } from '../../packages/studio-plugin/src/host/adapters/platform/runtime.ts'
import type { PrototypeCheckResult } from '../../packages/studio-plugin/src/host/prototype/checks.ts'
import { startPrototypePreview } from '../../packages/studio-plugin/src/host/prototype/preview.ts'
import { prototypeInputHash, sha256 } from '../../packages/studio-plugin/src/host/prototype/template.ts'
import type { PrototypeCheckDiagnostic } from '../../packages/studio-plugin/src/shared/prototype.ts'

async function availablePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const port = address.port
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

test('preview process that exits before ready retains its output and failure step', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'prototype-preview-output-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const prototypeRoot = path.join(root, 'prototype')
  const manifestPath = path.resolve('packages/studio-plugin/assets/prototype-template.manifest.json')
  await cp(path.resolve('packages/studio-plugin/assets/prototype-template'), prototypeRoot, { recursive: true, filter: source => !/[\\/](?:node_modules|dist)[\\/]?$/.test(source) })
  await mkdir(path.join(prototypeRoot, 'dist'))
  await writeFile(path.join(prototypeRoot, 'dist', 'index.html'), '<!doctype html>')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { version: string }
  const input = { projectId: 'project', prototypeTaskId: 'task', sessionId: 'session', sourceSha: 'sha', prototypeRoot, manifestPath }
  const checks: PrototypeCheckResult = {
    ...input, templateVersion: manifest.version, inputHash: await prototypeInputHash(prototypeRoot), outputHash: await prototypeInputHash(path.join(prototypeRoot, 'dist')),
    rulesSha256: sha256(await readFile(path.join(prototypeRoot, 'AGENT.md'))), startedAt: 'start', completedAt: 'complete', commands: [{ name: 'build', exitCode: 0 }],
  }
  const process = {
    done: Promise.resolve({ stdout: '', stderr: 'preview failed\n', stdoutBytes: Buffer.alloc(0), exitCode: 1 }),
    stop: async () => {},
    onOutput: (listener: (channel: 'stdout' | 'stderr', text: string) => void) => { listener('stderr', 'preview failed\n'); return () => {} },
  }
  const runtime = { start: async () => process } as unknown as PlatformRuntime
  const events: Array<{ status: string; diagnostic?: PrototypeCheckDiagnostic }> = []
  await assert.rejects(startPrototypePreview(runtime, input, checks, await availablePort(), undefined, async (_name, status, _exitCode, diagnostic) => { events.push({ status, diagnostic }) }), /exited before becoming ready/)
  const failed = events.findLast(event => event.status === 'failed')
  assert.equal(failed?.diagnostic?.stderr, 'preview failed\n')
  assert.match(failed?.diagnostic?.error ?? '', /exited before becoming ready/)
  assert.equal(events.some(event => event.status === 'passed'), false)
})
