import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import type { MaterialMetadata } from '@eadp/contracts'
import { generalScenarioDocument } from '../../packages/asset-domain/src/index.ts'
import type { Candidate, CandidateTemplate, SplitSource } from '../../packages/studio-plugin/src/shared/requirements.ts'
import { digest, materialText } from '../../packages/studio-plugin/src/host/adapters/assets/materials.ts'
import { RequirementCandidates } from '../../packages/studio-plugin/src/host/application/requirement-candidates.ts'
import { StudioStore } from '../../packages/studio-plugin/src/host/application/state.ts'

const commitSha = 'a'.repeat(40)
const fixed = (relative: string, bytes: string) => ({ commitSha, path: relative, sha256: digest(bytes) })
const templateBody = '# 需求名称\n\n## 目标\n\n## 范围\n\n## 规则\n\n## 验收\n'
const template = (): CandidateTemplate => ({ id: 'requirement-default', fixed: fixed('.template/requirement-default.md', templateBody), body: templateBody })
function scenario(id: string, body: string): { source: SplitSource; bytes: string } {
  const metadata: MaterialMetadata = { entityId: id, kind: 'scenario', title: id, templateId: 'scenario-default', templateRef: fixed('.template/scenario-default.md', '# 场景'),
    scenarioIds: [], prerequisites: [], sources: [], businessEvidence: [],
    flowComplete: true, openQuestions: [], referencedAssets: [] }
  const bytes = materialText(metadata, body)
  return { source: { projectId: 'project-1', entityId: id, title: id, version: 1, confirmationId: `confirmation-${id}`, fixed: fixed(`场景/${id}.md`, bytes) }, bytes }
}
const reply = (sources: Array<{ entityId: string; excerpts: Array<{ startLine: number; endLine: number; text: string }> }>) => ({
  title: '订单支付', summary: '客户完成付款', goal: '保证订单付款可追溯', scope: '已提交订单',
  rules: ['付款成功后订单进入已支付状态'], acceptanceCriteria: ['客户可查看付款结果'], openQuestions: [], sources,
  body: '# 订单支付\n\n保证订单付款可追溯\n\n已提交订单\n\n付款成功后订单进入已支付状态\n\n客户可查看付款结果',
})
const protocol = (value: unknown) => `拆分结论。\n\n\`\`\`eadp-candidates\n${JSON.stringify(value)}\n\`\`\``

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'eadp-requirement-candidates-')), store = new StudioStore(root); store.useUser(1)
  const first = scenario('scenario-1', '# 提交订单\n\n客户提交订单。\n'), second = scenario('scenario-2', '# 支付订单\n\n付款成功后订单进入已支付状态。\n')
  const bytes = new Map([first, second].map(value => [value.source.fixed.sha256, value.bytes]))
  let currentTemplate = template(), createFailure = false, writeFailure = false, promptFailure = false
  const prompts: string[] = [], creates: Candidate[] = [], writes: Array<{ candidate: Candidate; id: string }> = [], identities = new Map<string, string>()
  const service = new RequirementCandidates(store, {
    session: async task => task.sessionId, prompt: async (_session, text) => { prompts.push(text); if (promptFailure) { promptFailure = false; throw new Error('请求投递失败') } },
  }, {
    readFixed: async (_project, reference) => Buffer.from(bytes.get(reference.sha256) ?? '不存在'),
    template: async () => currentTemplate,
    create: async candidate => {
      creates.push(structuredClone(candidate))
      const id = identities.get(candidate.id) ?? `requirement-${identities.size + 1}`; identities.set(candidate.id, id)
      if (createFailure) { createFailure = false; throw new Error('创建成功后响应丢失') }
      return { id }
    },
    write: async (candidate, id) => { if (writeFailure) { writeFailure = false; throw new Error('正文写入失败') }; writes.push({ candidate: structuredClone(candidate), id }) },
  })
  const start = () => service.start({ projectId: 'project-1', worktree: path.join(root, 'project'), sources: [first.source, second.source], existingRequirements: [{ id: 'existing-1', title: '原有能力', summary: '只作补拆参考' }] })
  return { root, store, service, prompts, creates, writes, identities, first, second, bytes, start,
    useTemplate: (value: CandidateTemplate) => { currentTemplate = value }, failCreate: () => { createFailure = true }, failWrite: () => { writeFailure = true }, failPrompt: () => { promptFailure = true },
    dispose: () => rm(root, { recursive: true, force: true }),
  }
}

test('joint splitting accepts ordinary flows without evidence attachments and adopts the complete selected capability only once', async t => {
  const f = await fixture(); t.after(f.dispose)
  const task = await f.start()
  assert.equal(f.creates.length, 0)
  assert.match(f.prompts[0]!, /原有能力/); assert.match(f.prompts[0]!, /3: 付款成功后订单进入已支付状态。/)
  assert.equal(task.split!.sources.length, 2)
  const value = reply([{ entityId: f.second.source.entityId, excerpts: [{ startLine: 3, endLine: 3, text: '付款成功后订单进入已支付状态。' }] }])
  await f.service.accept(task.sessionId, protocol([value]))
  const candidate = (await f.store.read()).candidates[0]!
  assert.deepEqual(candidate.sources.map(source => source.entityId), [f.second.source.entityId])
  assert.equal(candidate.sources[0]!.confirmationId, 'confirmation-scenario-2')
  assert.match(candidate.body, /场景来源追溯/); assert.match(candidate.body, /付款成功后订单进入已支付状态。/)
  assert.match(candidate.body, /正文第 3—3 行/)
  await assert.rejects(f.service.select(candidate.id, 'project-1', 'stale-input'), /候选输入已变化/)
  assert.equal(f.creates.length, 0)
  assert.equal(await f.service.select(candidate.id, 'project-1', candidate.inputHash), 'requirement-1')
  assert.equal(await f.service.select(candidate.id, 'project-1', candidate.inputHash), 'requirement-1')
  assert.equal(f.creates.length, 1); assert.equal(f.writes.length, 1)
  assert.deepEqual(f.writes[0]!.candidate.quality, { coreRulesPresent: true, acceptanceCriteriaPresent: true, openQuestions: [] })
  assert.equal(f.writes[0]!.candidate.body, candidate.body)
  assert.equal(f.creates[0]!.id, candidate.id)
})

test('restoring a failed request keeps its identity and exact prompt, while a sent session is never prompted again', async t => {
  const f = await fixture(); t.after(f.dispose)
  f.failPrompt()
  await assert.rejects(f.start(), /投递失败/)
  const task = (await f.store.read()).tasks[0]!
  assert.equal(task.split!.status, 'failed')
  assert.equal(await f.service.resume(task.sessionId), task.sessionId)
  assert.equal(task.split!.status, 'sent')
  assert.equal(f.prompts.length, 2)
  assert.equal(f.prompts[0], f.prompts[1])
  await f.service.resume(task.sessionId)
  assert.equal(f.prompts.length, 2)
  assert.equal((await f.store.read()).tasks.length, 1)
})

test('each explicit supplemental split preserves older rounds and their historical fixed sources', async t => {
  const f = await fixture(); t.after(f.dispose)
  const first = await f.start()
  const value = reply([{ entityId: f.first.source.entityId, excerpts: [{ startLine: 3, endLine: 3, text: '客户提交订单。' }] }])
  await f.service.accept(first.sessionId, protocol([value]))
  const candidate = (await f.store.read()).candidates[0]!
  f.first.source.version = 2; f.first.source.confirmationId = 'confirmation-new'
  const advancedTemplate = template()
  advancedTemplate.fixed.commitSha = 'f'.repeat(40)
  f.useTemplate(advancedTemplate)
  const second = await f.start()
  assert.notEqual(first.sessionId, second.sessionId)
  assert.equal(first.split!.sources[0]!.version, 1)
  assert.equal(candidate.sources[0]!.version, 1)
  assert.equal(await f.service.select(candidate.id, 'project-1', candidate.inputHash), 'requirement-1')
  assert.equal(f.creates[0]!.sources[0]!.version, 1)
  assert.equal(f.creates[0]!.template.fixed.commitSha, candidate.template.fixed.commitSha)
  assert.notEqual(f.creates[0]!.template.fixed.commitSha, advancedTemplate.fixed.commitSha)
})

test('candidate adoption recovers creation response loss and first-body write failure with the original operation and identity', async t => {
  const f = await fixture(); t.after(f.dispose)
  const task = await f.start()
  await f.service.accept(task.sessionId, protocol([reply([{ entityId: f.first.source.entityId, excerpts: [{ startLine: 3, endLine: 3, text: '客户提交订单。' }] }])]))
  const candidate = (await f.store.read()).candidates[0]!
  f.failCreate()
  await assert.rejects(f.service.select(candidate.id, 'project-1', candidate.inputHash), /响应丢失/)
  f.failWrite()
  await assert.rejects(f.service.select(candidate.id, 'project-1', candidate.inputHash), /正文写入失败/)
  assert.equal(candidate.reservedEntityId, 'requirement-1')
  // Once reserved, recovery finishes that original write even if the project default changes.
  f.useTemplate({ ...template(), id: 'next-default' })
  assert.equal(await f.service.select(candidate.id, 'project-1', candidate.inputHash), 'requirement-1')
  assert.equal(f.identities.size, 1); assert.equal(f.creates.length, 2); assert.equal(f.writes.length, 1)
  assert.equal(f.creates[0]!.id, f.creates[1]!.id)
})

test('unselected sources and invented or incomplete excerpts are rejected before creating candidates', async t => {
  const f = await fixture(); t.after(f.dispose)
  const task = await f.start()
  const unknown = reply([{ entityId: 'not-selected', excerpts: [{ startLine: 1, endLine: 1, text: '编造' }] }])
  await assert.rejects(f.service.accept(task.sessionId, protocol([unknown])), /未读取、未选择/)
  const forged = reply([{ entityId: f.first.source.entityId, excerpts: [{ startLine: 3, endLine: 3, text: '不是固定原文' }] }])
  await assert.rejects(f.service.accept(task.sessionId, protocol([forged])), /原文不一致/)
  const partial = reply([{ entityId: f.first.source.entityId, excerpts: [{ startLine: 3, endLine: 3, text: '客户提交订单。' }] }])
  partial.body = '# 只有标题'
  await assert.rejects(f.service.accept(task.sessionId, protocol([partial])), /未完整承接/)
  assert.equal((await f.store.read()).candidates.length, 0); assert.equal(f.creates.length, 0)
})

test('template context changes invalidate pending reports and unadopted candidates without replacing their fixed inputs', async t => {
  const f = await fixture(); t.after(f.dispose)
  const task = await f.start(), value = reply([{ entityId: f.first.source.entityId, excerpts: [{ startLine: 3, endLine: 3, text: '客户提交订单。' }] }])
  f.useTemplate({ ...template(), id: 'changed' })
  await assert.rejects(f.service.accept(task.sessionId, protocol([value])), /模板上下文已变化/)
  f.useTemplate(template())
  await f.service.accept(task.sessionId, protocol([value]))
  const candidate = (await f.store.read()).candidates[0]!
  f.useTemplate({ ...template(), id: 'changed' })
  await assert.rejects(f.service.select(candidate.id, 'project-1', candidate.inputHash), /模板上下文已变化/)
  assert.equal(candidate.template.id, 'requirement-default'); assert.equal(f.creates.length, 0)
})

test('cross-project, duplicate, builtin and mismatching fixed-byte inputs cannot enter a split', async t => {
  const f = await fixture(); t.after(f.dispose)
  const request = { projectId: 'project-1', worktree: f.root, sources: [f.first.source], existingRequirements: [] }
  await assert.rejects(f.service.start({ ...request, sources: [{ ...f.first.source, projectId: 'other-project' }] }), /同项目/)
  await assert.rejects(f.service.start({ ...request, sources: [f.first.source, f.first.source] }), /不同/)
  f.bytes.set(f.first.source.fixed.sha256, '篡改的固定输入')
  await assert.rejects(f.service.start(request), /哈希/)
  const raw = generalScenarioDocument('general')
  const source = { ...f.first.source, entityId: 'general', fixed: fixed('场景/通用场景.md', raw) }
  f.bytes.set(source.fixed.sha256, raw)
  await assert.rejects(f.service.start({ ...request, sources: [source] }), /材料缺少 eadp 元数据|元数据无效|普通场景/)
  assert.equal((await f.store.read()).tasks.length, 0)
})
