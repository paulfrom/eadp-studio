import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { PrototypeFiles, type PrototypeFileWorkspace } from '../../packages/studio-plugin/src/host/prototype/files.ts'

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'eadp-prototype-files-'))
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(tmpdir())); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
  const workspace: PrototypeFileWorkspace = { root, source: { kind: 'task', projectId: 'project', prototypeTaskId: 'task' }, writablePaths: [''], manifestPath: fileURLToPath(new URL('../../packages/studio-plugin/assets/prototype-template.manifest.json', import.meta.url)) }
  const files = new PrototypeFiles()
  const read = (name: string, lineRange?: { start: number; end: number }) => files.read(workspace, { action: 'readPrototypeFile', source: workspace.source, path: name, ...(lineRange ? { lineRange } : {}) })
  const list = (cursor?: string) => files.read(workspace, { action: 'listPrototypeDirectory', source: workspace.source, limit: 1, ...(cursor ? { cursor } : {}) })
  return { root, workspace, files, read, list }
}

test('content observation changes when bytes change at the same size and mtime', async t => {
  const f = await fixture(t), name = path.join(f.root, 'material.txt'), stamp = new Date('2026-01-01T00:00:00Z')
  await writeFile(name, 'alpha\n'); await utimes(name, stamp, stamp)
  const before = await stat(name), first = await f.read('material.txt')
  await writeFile(name, 'bravo\n'); await utimes(name, stamp, stamp)
  const after = await stat(name), second = await f.read('material.txt')
  assert.equal(after.size, before.size); assert.equal(after.mtimeMs, before.mtimeMs)
  assert.ok(first.kind === 'file' && second.kind === 'file')
  assert.equal(first.content, 'alpha\n'); assert.equal(second.content, 'bravo\n')
  assert.notEqual(first.hash, second.hash); assert.notEqual(first.observation, second.observation)
})

test('directory pagination rejects a cursor after content changes and permits a fresh read', async t => {
  const f = await fixture(t)
  for (const name of ['a.txt', 'b.txt', 'c.txt']) await writeFile(path.join(f.root, name), 'old\n')
  const first = await f.list()
  assert.ok(first.kind === 'directory' && first.nextCursor)
  await writeFile(path.join(f.root, 'b.txt'), 'new\n')
  await assert.rejects(f.list(first.nextCursor), /工程或查询已变化/)
  const restarted = await f.list()
  assert.ok(restarted.kind === 'directory' && restarted.nextCursor)
  assert.notEqual(restarted.observation, first.observation)
  const second = await f.list(restarted.nextCursor)
  assert.ok(second.kind === 'directory'); assert.deepEqual(second.entries.map(entry => entry.path), ['b.txt'])
})

test('search pagination also rejects observations from prior file bytes', async t => {
  const f = await fixture(t)
  await writeFile(path.join(f.root, 'a.txt'), 'match old\nmatch old\n')
  const search = (cursor?: string) => f.files.read(f.workspace, { action: 'searchPrototypeFiles', source: f.workspace.source, query: 'match', limit: 1, ...(cursor ? { cursor } : {}) })
  const first = await search(); assert.ok(first.kind === 'search' && first.nextCursor)
  await writeFile(path.join(f.root, 'a.txt'), 'match new\nmatch new\n')
  await assert.rejects(search(first.nextCursor), /工程或查询已变化/)
  const restarted = await search(); assert.ok(restarted.kind === 'search' && restarted.nextCursor)
  const second = await search(restarted.nextCursor)
  assert.ok(second.kind === 'search'); assert.equal(second.matches[0]?.line, 2)
  assert.match(second.matches[0]!.excerpt, /new/)
})

test('line ranges return exact UTF-8 lines, a continuation and an unterminated final line', async t => {
  const f = await fixture(t)
  await writeFile(path.join(f.root, 'lines.txt'), '第一行\n第二行\n第三行\n末行')
  const middle = await f.read('lines.txt', { start: 2, end: 3 })
  assert.ok(middle.kind === 'file')
  assert.equal(middle.content, '第二行\n第三行\n'); assert.equal(middle.rangeComplete, true)
  assert.equal(middle.truncated, false); assert.equal(middle.nextLine, 4)
  const tail = await f.read('lines.txt', { start: 4, end: 10 })
  assert.ok(tail.kind === 'file'); assert.equal(tail.content, '末行'); assert.equal(tail.nextLine, undefined)
  assert.equal(tail.rangeComplete, true)
})

for (const range of [{ start: 0, end: 1 }, { start: 3, end: 2 }, { start: 1, end: 2001 }]) {
  test(`invalid line range ${range.start}-${range.end} is rejected`, async t => {
    const f = await fixture(t); await writeFile(path.join(f.root, 'lines.txt'), 'line\n')
    await assert.rejects(f.read('lines.txt', range), /行范围无效或超过 2000 行/)
  })
}

test('a 1 MiB file is readable, while one extra byte requires a bounded range', async t => {
  const f = await fixture(t), size = 1024 * 1024
  await writeFile(path.join(f.root, 'boundary.txt'), Buffer.alloc(size, 97))
  const exact = await f.read('boundary.txt')
  assert.ok(exact.kind === 'file'); assert.equal(exact.truncated, false); assert.equal(Buffer.byteLength(exact.content!), size)
  await writeFile(path.join(f.root, 'boundary.txt'), Buffer.alloc(size + 1, 97))
  const oversized = await f.read('boundary.txt')
  assert.ok(oversized.kind === 'file'); assert.equal(oversized.truncated, true); assert.equal(oversized.content, undefined)
  const range = await f.read('boundary.txt', { start: 1, end: 1 })
  assert.ok(range.kind === 'file'); assert.equal(range.truncated, true); assert.equal(range.rangeComplete, false)
  assert.equal(range.nextLine, undefined); assert.ok(Buffer.byteLength(range.content!) <= size)
})

test('a bounded line range can read beyond the normal whole-file limit', async t => {
  const f = await fixture(t), prefix = 'x'.repeat(1024 * 1024)
  await writeFile(path.join(f.root, 'large.txt'), `${prefix}\ntarget line\nfollowing line\n`)
  const range = await f.read('large.txt', { start: 2, end: 2 })
  assert.ok(range.kind === 'file'); assert.equal(range.content, 'target line\n')
  assert.equal(range.rangeComplete, true); assert.equal(range.truncated, false); assert.equal(range.nextLine, 3)
})

test('symbolic files are hidden and parent-directory links cannot expose external bytes', async t => {
  const f = await fixture(t), external = await mkdtemp(path.join(tmpdir(), 'eadp-prototype-files-external-'))
  t.after(async () => { assert.equal(path.dirname(external), path.resolve(tmpdir())); await rm(external, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
  const target = path.join(external, 'secret.txt'); await writeFile(target, 'external private bytes\n')
  try {
    await symlink(target, path.join(f.root, 'linked.txt'), 'file')
    await symlink(external, path.join(f.root, 'linked-directory'), process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('Platform does not permit symbolic-link fixtures'); return }
    throw error
  }
  const listed = await f.list(); assert.ok(listed.kind === 'directory'); assert.deepEqual(listed.entries, [])
  await assert.rejects(f.read('linked.txt'), /不存在或不可读取/)
  await assert.rejects(f.read('linked-directory/secret.txt'), /符号链接/)
  assert.equal(await readFile(target, 'utf8'), 'external private bytes\n')
})
