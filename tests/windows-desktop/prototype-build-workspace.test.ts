import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { preparePrototypeBuildWorkspace } from '../../packages/studio-plugin/src/host/prototype/build-workspace.ts'

test('short build snapshot preserves exact dirty source and identity without dependencies or generated output', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'prototype-build-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await cp(path.resolve('packages/studio-plugin/assets/prototype-template'), root, { recursive: true, filter: p => !/[\\/]node_modules([\\/]|$)/.test(p) })
  const page = path.join(root, 'src/pages/Dirty.tsx')
  await writeFile(page, 'export default () => "unsaved commit source"')
  await mkdir(path.join(root, 'node_modules'), { recursive: true })
  await writeFile(path.join(root, 'node_modules/cache'), 'do not copy')
  await mkdir(path.join(root, 'dist'), { recursive: true }); await writeFile(path.join(root, 'dist/generated.js'), 'do not copy')
  const source = { prototypeRoot: root, manifestPath: path.resolve('packages/studio-plugin/assets/prototype-template.manifest.json'), projectId: 'project', prototypeTaskId: 'task', sessionId: 'session', sourceSha: 'a'.repeat(40) }
  const snapshot = await preparePrototypeBuildWorkspace(source)
  t.after(() => snapshot.dispose())
  assert.deepEqual({ ...snapshot.input, prototypeRoot: root }, source)
  assert.equal(await readFile(path.join(snapshot.input.prototypeRoot, 'src/pages/Dirty.tsx'), 'utf8'), await readFile(page, 'utf8'))
  await assert.rejects(stat(path.join(snapshot.input.prototypeRoot, 'node_modules')), { code: 'ENOENT' })
  await assert.rejects(stat(path.join(snapshot.input.prototypeRoot, 'dist')), { code: 'ENOENT' })
  await snapshot.verify()
  await writeFile(page, 'changed while building')
  await assert.rejects(snapshot.verify(), /源码在构建期间发生变化/)
  await Promise.all([snapshot.dispose(), snapshot.dispose()])
  assert.equal(await readFile(page, 'utf8'), 'changed while building')
  assert.equal(await readFile(path.join(root, 'node_modules/cache'), 'utf8'), 'do not copy')
})

