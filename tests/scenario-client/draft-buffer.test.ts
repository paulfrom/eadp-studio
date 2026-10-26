import assert from 'node:assert/strict'
import test from 'node:test'
import type { MaterialDraft, MaterialMetadata } from '../../packages/studio-plugin/src/shared/studio.ts'
import { DraftBuffer } from '../../packages/studio-plugin/src/client/scenarios/DraftBuffer.ts'
import { isRevising, selectCatalog } from '../../packages/studio-plugin/src/client/scenarios/catalog.ts'
import type { EntityView } from '../../packages/studio-plugin/src/shared/studio.ts'

const metadata = { entityId: 'scenario', kind: 'scenario', title: '测试场景', flowComplete: false, businessEvidence: [], openQuestions: [] } as unknown as MaterialMetadata
const draft = (body = '', sha256 = 'hash-0'): MaterialDraft => ({ entityId: 'scenario', metadata, body, sha256, path: '场景/scenario.md' })

test('debounces 800ms local editing and leaves an unchanged projection out of the input buffer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const saves: string[] = []
  const buffer = new DraftBuffer(draft(), async input => { saves.push(input.body); return draft(input.body, 'hash-1') })
  t.after(() => buffer.dispose())
  buffer.edit({ body: '第一段', metadata })
  t.mock.timers.tick(799)
  assert.equal(saves.length, 0)
  buffer.edit({ body: '最新输入', metadata })
  buffer.receive(draft())
  t.mock.timers.tick(799)
  assert.equal(saves.length, 0)
  t.mock.timers.tick(1)
  assert.deepEqual(saves, ['最新输入'])
  await buffer.flush()
  assert.equal(buffer.getSnapshot().dirty, false)
})

test('serializes writes and flush waits for input made during an in-flight save', async t => {
  let finish: ((value: MaterialDraft) => void) | undefined
  const calls: Array<{ body: string; hash: string }> = []
  const buffer = new DraftBuffer(draft(), async input => {
    calls.push({ body: input.body, hash: input.expectedHash })
    if (calls.length === 1) return new Promise(resolve => { finish = resolve })
    return draft(input.body, 'hash-2')
  })
  t.after(() => buffer.dispose())
  buffer.edit({ body: '第一版', metadata })
  const saving = buffer.flush()
  buffer.edit({ body: '第二版', metadata })
  assert.equal(calls.length, 1)
  finish!(draft('第一版', 'hash-1'))
  assert.equal(await saving, true)
  assert.deepEqual(calls, [{ body: '第一版', hash: 'hash-0' }, { body: '第二版', hash: 'hash-1' }])
  assert.equal(buffer.getSnapshot().body, '第二版')
  assert.equal(buffer.getSnapshot().sha256, 'hash-2')
})

test('failed saves preserve input and reuse the operation identity for an explicit retry', async t => {
  const operations: string[] = []
  const buffer = new DraftBuffer(draft(), async input => {
    operations.push(input.operationId)
    if (operations.length === 1) throw new Error('磁盘不可写')
    return draft(input.body, 'hash-1')
  })
  t.after(() => buffer.dispose())
  buffer.edit({ body: '必须保留', metadata })
  assert.equal(await buffer.flush(), false)
  assert.equal(buffer.getSnapshot().body, '必须保留')
  assert.equal(buffer.getSnapshot().dirty, true)
  assert.match(buffer.getSnapshot().error, /磁盘不可写/)
  assert.equal(await buffer.flush(), true)
  assert.equal(operations[0], operations[1])
})

test('external changes preserve both copies and block flush until explicit resolution', async t => {
  let calls = 0
  const buffer = new DraftBuffer(draft(), async input => { calls++; return draft(input.body, 'hash-1') })
  t.after(() => buffer.dispose())
  buffer.edit({ body: '用户未保存输入', metadata })
  buffer.receive(draft('外部修改', 'external-hash'))
  assert.equal(await buffer.flush(), false)
  assert.equal(calls, 0)
  assert.equal(buffer.getSnapshot().body, '用户未保存输入')
  assert.equal(buffer.getSnapshot().conflict?.body, '外部修改')
  buffer.accept(draft('手工合并', 'merged-hash'))
  assert.equal(buffer.getSnapshot().conflict, undefined)
  assert.equal(buffer.getSnapshot().body, '手工合并')
})

test('a successful in-flight response cannot discard a separately observed external change', async t => {
  let finish: ((value: MaterialDraft) => void) | undefined
  const buffer = new DraftBuffer(draft(), async () => new Promise(resolve => { finish = resolve }))
  t.after(() => buffer.dispose())
  buffer.edit({ body: '本次保存', metadata })
  const saving = buffer.flush()
  buffer.receive(draft('并发外部修改', 'external-hash'))
  finish!(draft('本次保存', 'hash-1'))
  assert.equal(await saving, false)
  assert.equal(buffer.getSnapshot().conflict?.body, '并发外部修改')
})

test('catalog sequence ordering is numeric and revision status follows the draft state of a confirmed material', () => {
  const entities = [
    { id: 'a', kind: 'scenario', sequence: 10000, code: 'SC-10000', title: '退款', materialVersion: 1, confirmationStatus: 'confirmed', scenarioIds: ['scene-a'] },
    { id: 'b', kind: 'scenario', sequence: 9999, code: 'SC-9999', title: '退款', materialVersion: 0, confirmationStatus: 'draft', scenarioIds: [] },
    { id: 'c', kind: 'scenario', sequence: 10001, code: 'SC-10001', title: '退款', materialVersion: 1, confirmationStatus: 'draft', scenarioIds: [] },
  ] as EntityView[]
  const options = { search: '退款', status: 'all', revision: 'all', sort: 'sequence' as const, source: 'all' }
  assert.deepEqual(selectCatalog(entities, options).map(entity => entity.id), ['b', 'a', 'c'])
  assert.equal(isRevising(entities[0]!), false)
  assert.equal(isRevising(entities[2]!), true)
  assert.deepEqual(selectCatalog(entities, { ...options, revision: 'revising', status: 'all' }).map(entity => entity.id), ['c'])
  assert.deepEqual(selectCatalog(entities, { ...options, source: 'scene-a' }).map(entity => entity.id), ['a'])
})

test('acknowledges Host newline normalization without resaving the same input forever', async t => {
  let calls = 0
  const buffer = new DraftBuffer(draft(), async input => { calls++; return draft(input.body.replace(/\r\n/g, '\n').replace(/^\uFEFF/, ''), 'hash-1') })
  t.after(() => buffer.dispose())
  buffer.edit({ body: '\uFEFF第一行\r\n第二行', metadata })
  assert.equal(await buffer.flush(), true)
  assert.equal(calls, 1)
  assert.equal(buffer.getSnapshot().body, '第一行\n第二行')
  assert.equal(buffer.getSnapshot().dirty, false)
})

test('preparing an explicit write cancels the debounce without saving the new input', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  const buffer = new DraftBuffer(draft(), async input => { calls++; return draft(input.body, 'hash-1') })
  t.after(() => buffer.dispose())
  buffer.edit({ body: '由确认动作保存', metadata })
  await buffer.prepareWrite()
  t.mock.timers.tick(1000)
  assert.equal(calls, 0)
  assert.equal(buffer.getSnapshot().body, '由确认动作保存')
  assert.equal(buffer.getSnapshot().dirty, true)
})

test('an explicit write can proceed after the in-flight automatic save failed', async t => {
  let fail: ((error: Error) => void) | undefined
  const buffer = new DraftBuffer(draft(), async () => new Promise((_resolve, reject) => { fail = reject }))
  t.after(() => buffer.dispose())
  buffer.edit({ body: '异常后仍保留的输入', metadata })
  const saving = buffer.flush()
  let prepared = false
  const explicit = buffer.prepareWrite().then(() => { prepared = true })
  await Promise.resolve()
  assert.equal(prepared, false)
  fail!(new Error('网络异常'))
  assert.equal(await saving, false)
  await explicit
  assert.equal(prepared, true)
  assert.equal(buffer.getSnapshot().body, '异常后仍保留的输入')
  assert.equal(buffer.getSnapshot().sha256, 'hash-0')
})

test('an explicit write acknowledgement preserves later input and an independent external projection', t => {
  const buffer = new DraftBuffer(draft(), async input => draft(input.body, 'unused'))
  t.after(() => buffer.dispose())
  const submitted = { body: '明确提交的正文', metadata }
  buffer.edit(submitted)
  buffer.edit({ body: '在途的新输入', metadata: { ...metadata, title: '新标题' } })
  buffer.receive(draft('另一个编辑器的正文', 'external-hash'))
  buffer.acknowledge(draft(submitted.body, 'submitted-hash'), submitted)
  assert.equal(buffer.getSnapshot().body, '在途的新输入')
  assert.equal(buffer.getSnapshot().metadata.title, '新标题')
  assert.equal(buffer.getSnapshot().sha256, 'submitted-hash')
  assert.equal(buffer.getSnapshot().dirty, true)
  assert.equal(buffer.getSnapshot().conflict?.sha256, 'external-hash')
})

test('restored recovery input keeps the actual file hash and never schedules a save', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let saves = 0
  const actual = draft('磁盘实际内容', 'actual-file-hash')
  const buffer = new DraftBuffer(actual, async input => { saves++; return draft(input.body, 'unused') })
  t.after(() => buffer.dispose())
  buffer.restoreInput({ body: '持久保存操作中的未写入正文', metadata }, actual)
  assert.equal(buffer.getSnapshot().body, '持久保存操作中的未写入正文')
  assert.equal(buffer.getSnapshot().sha256, 'actual-file-hash')
  assert.equal(buffer.getSnapshot().dirty, true)
  assert.equal(buffer.getSnapshot().conflict?.body, actual.body)
  t.mock.timers.tick(1000)
  await Promise.resolve()
  assert.equal(saves, 0)
})
