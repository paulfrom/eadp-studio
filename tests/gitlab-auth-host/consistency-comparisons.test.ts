import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { generalScenarioDocument } from '../../packages/asset-domain/src/index.ts'
import type { ConsistencyComparisonView, ConsistencyContextView, MaterialMetadata, SubmitConsistencyComparisonRequest } from '../../packages/contracts/src/index.ts'
import type { ConsistencyModelInput } from '../../packages/studio-plugin/src/shared/consistency.ts'
import type { HostPorts } from '../../packages/studio-plugin/src/host/application/ports.ts'
import { ConsistencyComparisons } from '../../packages/studio-plugin/src/host/application/consistency-comparisons.ts'
import { readComparisonBytes } from '../../packages/studio-plugin/src/host/application/consistency-inputs.ts'
import { StudioStore } from '../../packages/studio-plugin/src/host/application/state.ts'
import { CollaborationError, type CollaborationClient } from '../../packages/studio-plugin/src/host/adapters/collaboration/client.ts'
import { digest, saveMaterial } from '../../packages/studio-plugin/src/host/adapters/assets/materials.ts'

const noConflicts = JSON.stringify({ summary: '本次已读范围未发现冲突', conflicts: [] })
const identity = (entityId: string, kind: 'scenario' | 'requirement', title: string): MaterialMetadata => ({ entityId, kind, title,
  templateId: `${kind}-default`, templateRef: { commitSha: 'a'.repeat(40), path: `.template/${kind}-default.md`, sha256: 'b'.repeat(64) },
  scenarioIds: kind === 'requirement' ? ['scene'] : [], prerequisites: [], sources: [], referencedAssets: [], businessEvidence: [], openQuestions: [], ...(kind === 'scenario' ? { flowComplete: false } : { coreRulesPresent: false, acceptanceCriteriaPresent: false }) } as MaterialMetadata)

async function fixture(t: { after(fn: () => Promise<unknown>): unknown }) {
  const root = await mkdtemp(path.join(tmpdir(), 'eadp-consistency-host-')), worktree = path.join(root, 'project')
  await mkdir(worktree)
  const store = new StudioStore(path.join(root, 'local')); store.useUser(1)
  const local = await store.read()
  const scene = await saveMaterial(worktree, identity('scene', 'scenario', '审批场景'), 'SCENE-BUSINESS-CONTENT：允许提交后退回。')
  const requirement = await saveMaterial(worktree, identity('requirement', 'requirement', '提交审批'), 'REQUIREMENT-BUSINESS-CONTENT：退回后允许再次提交。')
  const context: ConsistencyContextView = {
    entity: { id: 'scene', kind: 'scenario', title: '审批场景', revision: 1, materialVersion: 1, confirmationStatus: 'confirmed', occupied: false },
    sources: [], prerequisites: [],
    requirements: [{ id: 'requirement', title: '提交审批', revision: 1, materialVersion: 1, confirmationStatus: 'confirmed', occupied: false, sources: [{ projectId: 'project', entityId: 'scene', version: 1 }] }],
  }
  const calls: Array<{ method: string; route: string; body?: SubmitConsistencyComparisonRequest }> = [], models: ConsistencyModelInput[] = []
  const accepted = new Map<string, ConsistencyComparisonView>()
  let runModel: (input: ConsistencyModelInput, signal: AbortSignal) => Promise<string> = async () => noConflicts
  let readContext: (() => Promise<ConsistencyContextView>) | undefined
  let responseLoss: 'before' | 'after' | undefined, contextError: Error | undefined
  const api = { async request(method: string, route: string, body?: SubmitConsistencyComparisonRequest) {
    calls.push({ method, route, ...(body ? { body: structuredClone(body) } : {}) })
    if (method === 'GET' && route === '/v1/projects/project/entities/scene/consistency-context') { if (contextError) throw contextError; return readContext ? readContext() : context }
    if (method === 'GET' && route.startsWith('/v1/projects/project/consistency-comparisons?')) {
      const params = new URLSearchParams(route.split('?')[1]), entityId = params.get('entityId')
      const items = [...accepted.values()].filter(value => !entityId || value.entityId === entityId)
      const latest = params.get('latestPerEntity') === 'true' ? [...new Map(items.map(value => [value.entityId, value])).values()] : items
      const offset = Number(params.get('offset') ?? 0), limit = Number(params.get('limit') ?? 100)
      return latest.slice(offset, offset + limit)
    }
    if (method === 'GET' && route.startsWith('/v1/projects/project/consistency-comparisons/')) {
      const value = accepted.get(route.split('/').at(-1)!)
      if (!value) throw new CollaborationError('COMPARISON_NOT_FOUND', '未找到对比记录', 404)
      return value
    }
    if (method === 'POST' && route === '/v1/projects/project/consistency-comparisons' && body) {
      if (responseLoss === 'before') { responseLoss = undefined; throw new Error('请求未送达') }
      const { idempotencyKey: _key, ...fields } = body
      const value = { ...fields, conflictCount: body.conflicts.length, creator: { id: 1, name: '作者', username: 'author' }, createdAt: new Date().toISOString() } as ConsistencyComparisonView
      accepted.set(body.id, value)
      if (responseLoss === 'after') { responseLoss = undefined; throw new Error('接受响应丢失') }
      return value
    }
    throw new Error(`Unexpected capability: ${method} ${route}`)
  } } as unknown as CollaborationClient
  const forbidden = () => { throw new Error('比较流程不应执行 Git、终端或材料会话') }
  const ports = { async account() { return { id: 1 } }, async compareConsistency(input: ConsistencyModelInput, signal: AbortSignal) { models.push(structuredClone(input)); return runModel(input, signal) },
    git: new Proxy({}, { get() { return forbidden } }), gitLocal: forbidden, session: forbidden, prompt: forbidden, checks: forbidden, installTemplate: forbidden,
  } as unknown as HostPorts
  const comparisons = new ConsistencyComparisons(store, api, ports)
  t.after(async () => { await comparisons.dispose(); await rm(root, { recursive: true, force: true }) })
  const start = (trigger: 'manual' | 'confirmation' = 'manual', confirmationId?: string) => comparisons.start({ projectId: 'project', entityId: 'scene', worktree, trigger, ...(confirmationId ? { confirmationId } : {}) })
  const latest = async () => (await comparisons.views('project')).at(-1)!
  const submissions = () => calls.filter(call => call.method === 'POST').map(call => call.body!)
  return { root, worktree, scene, requirement, store, local, context, comparisons, calls, models, accepted, start, latest, submissions,
    model(value: typeof runModel) { runModel = value }, contextReader(value: typeof readContext) { readContext = value }, loseResponse(value: typeof responseLoss) { responseLoss = value }, failContext(value: Error) { contextError = value } }
}

// This fixture supplies ordinary runtime metadata and real material files; the
// assertions exercise capability and persistence boundaries, not prompt text.
test('comparison hashes and model text use the same bytes, rank formal inputs first, and never read other worktrees', async t => {
  const f = await fixture(t)
  const potential = await saveMaterial(f.worktree, identity('potential', 'requirement', '潜在关联'), 'POTENTIAL-BUSINESS-CONTENT')
  await mkdir(path.join(f.worktree, '原型代码'))
  await writeFile(path.join(f.worktree, '原型代码', '不得读取.md'), 'PROTOTYPE-SECRET')
  const privateRoot = path.join(f.root, 'another-member')
  await mkdir(privateRoot)
  await saveMaterial(privateRoot, identity('private', 'requirement', '其他成员草稿'), 'OTHER-WORKTREE-SECRET')
  f.local.tasks.push({ projectId: 'project', entityId: 'scene', purpose: 'material', sessionId: 'scene-session', inputHash: '', worktree: f.worktree }, { projectId: 'project', entityId: 'private', purpose: 'material', sessionId: 'private-session', inputHash: '', worktree: privateRoot })
  await f.start(); await f.comparisons.settle()
  const input = f.models[0]!
  assert.equal(input.coverage, 'complete')
  assert.deepEqual(input.materials.map(material => [material.entityId, material.relation]), [['scene', 'target'], ['requirement', 'formal'], ['potential', 'potential']])
  assert.equal(input.materials[0]!.state, 'local-draft')
  for (const material of input.materials) {
    const bytes = await readFile(path.join(f.worktree, material.path))
    assert.equal(material.text, bytes.toString('utf8'))
    assert.equal(material.sha256, digest(bytes))
    assert.equal(path.isAbsolute(material.path), false)
  }
  assert.equal(await readFile(path.join(f.worktree, potential.path), 'utf8'), input.materials[2]!.text)
  assert.equal((await f.latest()).phase, 'shared')
  assert.equal((await f.latest()).freshness, 'current')
  const payload = f.submissions()[0]!
  assert.deepEqual(Object.keys(payload).sort(), ['conflicts', 'coverage', 'entityId', 'id', 'idempotencyKey', 'result', 'summary', 'trigger'])
  const persisted = JSON.stringify((await f.store.read()).consistencyComparisons)
  for (const material of input.materials) { assert.equal(persisted.includes(material.text), false); assert.equal(persisted.includes(material.sha256), false) }
  for (const text of ['SCENE-BUSINESS-CONTENT', 'REQUIREMENT-BUSINESS-CONTENT', 'PROTOTYPE-SECRET', 'OTHER-WORKTREE-SECRET', f.worktree]) assert.equal(JSON.stringify(payload).includes(text), false)
  assert.equal(f.calls.every(call => /\/consistency-context$|\/consistency-comparisons(?:\/|$)/.test(call.route)), true)
})

test('missing formal files, invalid UTF-8 and identity, and escaping links report partial scope without filling files', async t => {
  const f = await fixture(t)
  await rm(path.join(f.worktree, f.requirement.path))
  await writeFile(path.join(f.worktree, '需求', '损坏编码.md'), Buffer.from([0xff, 0xfe, 0x80]))
  await writeFile(path.join(f.worktree, '需求', '伪造身份.md'), '# 无效身份\n')
  const privateRoot = path.join(f.root, 'other-task')
  await mkdir(privateRoot)
  const outside = await saveMaterial(privateRoot, identity('requirement', 'requirement', '外部来源'), 'OUTSIDE-LINK-SECRET')
  await symlink(process.platform === 'win32' ? privateRoot : path.join(privateRoot, outside.path), path.join(f.worktree, '需求', '越界链接.md'), process.platform === 'win32' ? 'junction' : 'file')
  const before = await readdir(path.join(f.worktree, '需求'))
  await f.start(); await f.comparisons.settle()
  const input = f.models[0]!
  assert.equal(input.coverage, 'partial')
  assert.deepEqual(input.materials.map(material => material.entityId), ['scene'])
  assert.ok(input.limitations.length)
  assert.equal((await f.latest()).result!.coverage, 'partial')
  assert.deepEqual(await readdir(path.join(f.worktree, '需求')), before)
  assert.equal(f.models.some(value => JSON.stringify(value).includes('OUTSIDE-LINK-SECRET')), false)
  await assert.rejects(readFile(path.join(f.worktree, f.requirement.path)), { code: 'ENOENT' })
})

test('an unreadable target becomes a finite failed comparison without running the model', async t => {
  const f = await fixture(t)
  await writeFile(path.join(f.worktree, f.scene.path), Buffer.from([0xff]))
  await f.start(); await f.comparisons.settle()
  assert.equal(f.models.length, 0)
  assert.equal((await f.latest()).result!.result, 'failed')
  assert.equal((await f.latest()).result!.failureCode, 'read-failed')
})

test('controlled reads reject absolute paths, traversal and directory links outside the selected worktree', async t => {
  const f = await fixture(t)
  await assert.rejects(readComparisonBytes(f.worktree, path.join(f.worktree, f.scene.path)), /路径无效/)
  await assert.rejects(readComparisonBytes(f.worktree, '../outside.md'), /路径无效/)
  await writeFile(path.join(f.root, 'outside.md'), '外部资料')
  await symlink(f.root, path.join(f.worktree, '外部目录'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(readComparisonBytes(f.worktree, '外部目录/outside.md'), /超出项目范围/)
})

test('context limits keep the target and report partial scope rather than truncating material content', async t => {
  const f = await fixture(t)
  const requirement = await saveMaterial(f.worktree, identity('requirement', 'requirement', '提交审批'), '需求内容'.repeat(35_000))
  await f.start(); await f.comparisons.settle()
  const input = f.models[0]!
  assert.equal(input.coverage, 'partial')
  assert.ok(input.limitations.some(message => /上下文读取边界/.test(message)))
  assert.deepEqual(input.materials.map(material => material.entityId), ['scene'])
  assert.equal((await readFile(path.join(f.worktree, requirement.path), 'utf8')).includes('需求内容'.repeat(35_000)), true)
  assert.equal((await f.latest()).result!.coverage, 'partial')
})

test('file-count limits read catalog target and formal paths before alphabetically earlier potential materials', async t => {
  const f = await fixture(t)
  f.context.entity.path = f.scene.path
  f.context.requirements[0]!.path = f.requirement.path
  await Promise.all(Array.from({ length: 205 }, (_, index) => saveMaterial(f.worktree,
    identity(`potential-${index}`, 'scenario', `000-潜在场景-${String(index).padStart(3, '0')}`), `潜在内容${index}`)))
  await f.start(); await f.comparisons.settle()
  const input = f.models[0]!
  assert.equal(input.coverage, 'partial')
  assert.ok(input.limitations.some(value => /材料数量/.test(value)))
  assert.deepEqual(input.materials.slice(0, 2).map(value => [value.entityId, value.relation]), [['scene', 'target'], ['requirement', 'formal']])
  assert.equal(input.materials.length, 200)
  assert.equal((await f.latest()).result!.result, 'completed')
})

test('a valid local material with a conflicting catalog kind is excluded from formal comparison input', async t => {
  const f = await fixture(t)
  await rm(path.join(f.worktree, f.requirement.path))
  await saveMaterial(f.worktree, identity('requirement', 'scenario', '伪造类型'), '伪造的正式关系内容')
  await f.start(); await f.comparisons.settle()
  const input = f.models[0]!
  assert.equal(input.coverage, 'partial')
  assert.deepEqual(input.materials.map(value => value.entityId), ['scene'])
  assert.equal(JSON.stringify(input).includes('伪造的正式关系内容'), false)
})

test('system-provisioned general scene bytes use their strict read contract without ordinary material fallback', async t => {
  const f = await fixture(t)
  await rm(path.join(f.worktree, f.scene.path))
  f.context.entity.builtinKey = 'general'
  f.context.builtinScenario = { entityId: 'scene', path: '场景/通用场景.md' }
  await writeFile(path.join(f.worktree, '场景', '通用场景.md'), generalScenarioDocument('scene'))
  await f.start(); await f.comparisons.settle()
  assert.equal(f.models.length, 1)
  assert.equal(f.models[0]!.materials[0]!.text, generalScenarioDocument('scene'))
  assert.equal((await f.latest()).result!.result, 'completed')
  await writeFile(path.join(f.worktree, '场景', '通用场景.md'), `${generalScenarioDocument('scene')}伪造附加内容`)
  await f.start(); await f.comparisons.settle()
  assert.equal(f.models.length, 1)
  assert.equal((await f.latest()).result!.result, 'failed')
})

test('model extras, unread entities, formalizing potential relations and oversized summaries are rejected', async t => {
  const values = [
    { summary: '不应接受正文', conflicts: [], material: 'MODEL-RAW-CONTENT' },
    { summary: '额外冲突字段', conflicts: [{ summary: '分歧', relation: 'formal', entities: ['scene'], resolved: true }] },
    { summary: '未读依据', conflicts: [{ summary: '分歧', relation: 'formal', entities: ['unknown'] }] },
    { summary: '越界摘要'.repeat(200), conflicts: [] },
    { summary: '潜在冒充正式', conflicts: [{ summary: '分歧', relation: 'formal', entities: ['potential'] }] },
  ]
  for (const value of values) await t.test(value.summary.slice(0, 20), async sub => {
    const f = await fixture(sub)
    await saveMaterial(f.worktree, identity('potential', 'requirement', '潜在材料'), '潜在内容')
    f.model(async () => JSON.stringify(value))
    await f.start(); await f.comparisons.settle()
    assert.equal((await f.latest()).result!.result, 'failed')
    assert.equal((await f.latest()).result!.failureCode, 'model-failed')
    assert.equal(f.submissions()[0]!.conflicts.length, 0)
    assert.equal(JSON.stringify((await f.store.read()).consistencyComparisons).includes('MODEL-RAW-CONTENT'), false)
  })
})

test('formal and potential conflict digests are shared as separate immutable observations and remain queryable', async t => {
  const f = await fixture(t)
  await saveMaterial(f.worktree, identity('potential', 'requirement', '潜在材料'), '潜在需求内容')
  f.model(async () => JSON.stringify({ summary: '发现两处需要作者判断的业务分歧', conflicts: [
    { summary: '场景与需求的退回条件不同', relation: 'formal', entities: ['scene', 'requirement'] },
    { summary: '潜在需求的重试边界不同', relation: 'potential', entities: ['scene', 'potential'] },
  ] }))
  await f.start(); await f.comparisons.settle()
  const result = (await f.latest()).result!
  assert.equal(result.result, 'completed')
  assert.equal(result.conflictCount, 2)
  assert.deepEqual(result.conflicts.map(conflict => [conflict.ordinal, conflict.relation, conflict.entities]), [[1, 'formal', ['scene', 'requirement']], [2, 'potential', ['scene', 'potential']]])
  assert.equal(result.conflicts.some(conflict => 'status' in conflict || 'resolved' in conflict), false)
  await f.comparisons.list('project', 'scene', 10, 0)
  assert.deepEqual(f.comparisons.historyViews('project', 'scene').map(value => value.id), [result.id])
  assert.deepEqual(f.comparisons.historyViews('project'), [])
  assert.deepEqual(f.comparisons.historyViews('other-project'), [])
  await assert.rejects(f.comparisons.list('project', 'scene', 101, 0), /分页无效/)
  assert.equal(f.context.entity.confirmationStatus, 'confirmed')
})

test('entity-scoped history queries are cached per scope and never evict the project-level projection', async t => {
  const f = await fixture(t)
  await f.start(); await f.comparisons.settle()
  const result = (await f.latest()).result!
  await f.comparisons.list('project', undefined, 10, 0)
  assert.deepEqual(f.comparisons.historyViews('project').map(value => value.id), [result.id])
  await f.comparisons.list('project', 'scene', 10, 0)
  assert.deepEqual(f.comparisons.historyViews('project', 'scene').map(value => value.id), [result.id])
  assert.deepEqual(f.comparisons.historyViews('project').map(value => value.id), [result.id], '实体级查询不能冲掉项目级历史')
  await f.comparisons.list('project', 'requirement', 10, 0)
  assert.deepEqual(f.comparisons.historyViews('project', 'requirement'), [])
  assert.deepEqual(f.comparisons.historyViews('project').map(value => value.id), [result.id])
})

test('latest-per-entity observations page independently of history without losing materials beyond the first hundred', async t => {
  const f = await fixture(t)
  await f.start(); await f.comparisons.settle()
  const first = (await f.latest()).result!
  for (let index = 0; index < 105; index++) {
    const result = { ...first, id: `comparison-${index}`, entityId: `requirement-${index}` }
    f.accepted.set(result.id, result)
  }
  await f.comparisons.listLatest('project')
  assert.equal(f.comparisons.latestViews('project').length, 106)
  assert.equal(new Set(f.comparisons.latestViews('project').map(value => value.entityId)).size, 106)
  assert.equal(f.calls.filter(call => call.route.includes('latestPerEntity=true')).length, 2)
  await f.comparisons.list('project', 'scene', 1, 0)
  await f.comparisons.list('project', undefined, 10, 100)
  assert.equal(f.comparisons.latestViews('project').length, 106, '翻阅任何历史页都不能替换目录最近结论')
  assert.deepEqual(f.comparisons.latestViews('another-project'), [])
})

for (const loss of ['before', 'after'] as const) test(`unknown comparison submission ${loss} backend acceptance reconciles before retrying the same finite result`, async t => {
  const f = await fixture(t)
  f.loseResponse(loss)
  await f.start(); await f.comparisons.settle()
  const first = await f.latest()
  assert.equal(first.phase, 'pending-sync')
  assert.match(first.message ?? '', /尚未共享/)
  assert.equal(first.result, undefined)
  assert.equal(first.outcome!.result, 'completed')
  assert.equal(first.outcome!.summary, '本次已读范围未发现冲突')
  assert.equal(first.outcome!.conflictCount, 0)
  assert.equal('submission' in first, false)
  assert.equal(f.models.length, 1)
  const firstBody = structuredClone(f.submissions()[0])
  const previousCount = f.calls.length
  await f.comparisons.retry(first.id, 'project')
  assert.equal((await f.latest()).phase, 'shared')
  assert.equal(f.models.length, 1)
  assert.equal(f.calls[previousCount]!.method, 'GET')
  assert.match(f.calls[previousCount]!.route, new RegExp(`/consistency-comparisons/${first.id}$`))
  assert.equal(f.submissions().length, loss === 'before' ? 2 : 1)
  if (loss === 'before') assert.deepEqual(f.submissions()[1], firstBody)
  await assert.rejects(f.comparisons.retry(first.id, 'another-project'), /不属于当前项目/)
})

test('one accepted confirmation starts one independent asynchronous comparison and replay does not rerun it', async t => {
  const f = await fixture(t)
  let entered!: () => void, release!: (value: string) => void
  const started = new Promise<void>(resolve => { entered = resolve })
  f.model(async () => { entered(); return new Promise(resolve => { release = resolve }) })
  await f.start('confirmation', 'confirmation-event')
  await started
  assert.equal((await f.latest()).phase, 'running')
  await f.start('confirmation', 'confirmation-event')
  assert.equal((await f.comparisons.views('project')).length, 1)
  assert.equal(f.models.length, 1)
  release(noConflicts); await f.comparisons.settle()
  assert.equal((await f.latest()).result!.confirmationId, 'confirmation-event')
  await f.start('confirmation', 'confirmation-event')
  assert.equal(f.models.length, 1)
})

test('cancellation and model failure leave material bytes and business confirmation untouched', async t => {
  const f = await fixture(t)
  const original = await readFile(path.join(f.worktree, f.scene.path))
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  f.model(async () => { entered(); return new Promise<string>(() => {}) })
  await f.start(); await started
  await f.comparisons.cancel((await f.latest()).id, 'project'); await f.comparisons.settle()
  assert.equal((await f.latest()).result!.result, 'cancelled')
  assert.equal((await f.latest()).result!.failureCode, 'cancelled')
  f.model(async () => { throw new Error('MODEL-PRIVATE-ERROR') })
  await f.start(); await f.comparisons.settle()
  assert.equal((await f.latest()).result!.result, 'failed')
  assert.deepEqual(await readFile(path.join(f.worktree, f.scene.path)), original)
  assert.equal(f.context.entity.confirmationStatus, 'confirmed')
  assert.equal(f.context.entity.occupied, false)
  assert.equal(f.calls.some(call => /integrations|\/claim|\/cancel$/.test(call.route)), false)
  assert.equal(JSON.stringify(f.submissions()).includes('MODEL-PRIVATE-ERROR'), false)
})

test('cancellation finishes while the relationship request is unresolved and does not start reading or model execution', async t => {
  const f = await fixture(t)
  let entered!: () => void, release!: (value: ConsistencyContextView) => void
  const pending = new Promise<void>(resolve => { entered = resolve })
  f.contextReader(async () => { entered(); return new Promise(resolve => { release = resolve }) })
  await f.start(); await pending
  await f.comparisons.cancel((await f.latest()).id, 'project')
  let timer: ReturnType<typeof setTimeout> | undefined
  let finished: boolean
  try {
    finished = await Promise.race([f.comparisons.settle().then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 1000) })])
  } finally { if (timer) clearTimeout(timer); release(f.context) }
  await f.comparisons.settle()
  assert.equal(finished, true, 'cancellation must not wait for the directory request to finish')
  assert.equal(f.models.length, 0)
  assert.equal((await f.latest()).result!.result, 'cancelled')
})

test('local freshness checks mark changed inputs stale and missing files unknown without a new model or Git call', async t => {
  const f = await fixture(t)
  f.model(async input => { await writeFile(path.join(f.worktree, f.scene.path), `${input.materials[0]!.text}\n作者外部修改`); return noConflicts })
  await f.start(); await f.comparisons.settle()
  const result = await f.latest()
  assert.equal(result.result!.result, 'completed')
  assert.equal(result.freshness, 'stale')
  await rm(path.join(f.worktree, f.scene.path))
  const count = f.calls.length
  await f.comparisons.checkFreshness(result.id, 'project')
  assert.equal((await f.latest()).freshness, 'unknown')
  assert.equal(f.models.length, 1)
  assert.equal(f.calls.length, count)
})

test('relationship lookup failure reports partial scope; denied permissions skip model execution', async t => {
  const f = await fixture(t)
  f.failContext(new Error('directory unavailable'))
  await f.start(); await f.comparisons.settle()
  assert.equal(f.models[0]!.coverage, 'partial')
  assert.ok(f.models[0]!.limitations.some(value => /关系目录/.test(value)))
  f.failContext(new CollaborationError('PROJECT_PERMISSION_DENIED', 'denied', 403))
  await f.start(); await f.comparisons.settle()
  assert.equal(f.models.length, 1)
  assert.equal((await f.latest()).result!.failureCode, 'permission-denied')
})
