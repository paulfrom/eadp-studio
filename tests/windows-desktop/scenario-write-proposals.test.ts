import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { MaterialMetadata } from '../../packages/contracts/src/index.ts'
import { readMaterial, saveMaterial } from '../../packages/studio-plugin/src/host/adapters/assets/materials.ts'
import { ScenarioDocumentService } from '../../packages/studio-plugin/src/host/application/scenario-documents.ts'
import { conclusionKey, hasWriteProposal, parseWriteProposal, proposalInvalidReason, summarizeWrite } from '../../packages/studio-plugin/src/host/application/scenario-write-proposals.ts'

const templateRef = { commitSha: 'a'.repeat(40), path: '.template/default.md', sha256: 'b'.repeat(64) }
function metadata(): MaterialMetadata { return { entityId: 'scenario-one', kind: 'scenario', title: '退回申请', templateId: 'default', templateRef, scenarioIds: [], prerequisites: [], sources: [], businessEvidence: [], coreRulesPresent: false, acceptanceCriteriaPresent: false, openQuestions: [], referencedAssets: [] } }
async function fixture(t: { after(fn: () => Promise<unknown>): unknown }) {
  const parent = await mkdtemp(path.join(tmpdir(), 'eadp-write-proposals-'))
  const root = path.join(parent, 'project'), localRoot = path.join(parent, 'local')
  await mkdir(root); t.after(() => rm(parent, { recursive: true, force: true }))
  return { root, localRoot, draft: await saveMaterial(root, metadata(), '旧正文') }
}
const response = (value: unknown) => '已整理结论。\n```eadp-write-proposal\n' + JSON.stringify(value) + '\n```'
const proposal = (draft: { entityId: string }) => ({ entityId: draft.entityId, conclusions: [{ id: 'C1', text: '仅允许已审批的退回申请' }], evidenceIds: ['source-one'], body: '新正文' })

test('the model supplies content only; Host-owned identity or hash fields are rejected rather than ignored', async t => {
  const { draft } = await fixture(t)
  assert.deepEqual(parseWriteProposal(response(proposal(draft)), draft, ['source-one']), { conclusions: [{ id: 'C1', text: '仅允许已审批的退回申请' }], evidenceIds: ['source-one'], body: '新正文' })
  for (const extra of [{ id: 'forged' }, { baseHash: 'c'.repeat(64) }, { authorization: true }, { templateRef }]) {
    assert.throws(() => parseWriteProposal(response({ ...proposal(draft), ...extra }), draft, ['source-one']), /字段无效/)
  }
})

test('a proposal cannot cite evidence the user has not had read, or another scenario', async t => {
  const { draft } = await fixture(t)
  assert.throws(() => parseWriteProposal(response(proposal(draft)), draft, []), /未实际读取/)
  assert.throws(() => parseWriteProposal(response({ ...proposal(draft), entityId: 'scenario-two' }), draft, ['source-one']), /身份不一致/)
  assert.throws(() => parseWriteProposal(response({ ...proposal(draft), body: '旧正文' }), draft, ['source-one']), /与当前正文相同/)
  assert.throws(() => parseWriteProposal(`${response(proposal(draft))}\n${response(proposal(draft))}`, draft, ['source-one']), /需要且仅允许一个/)
  // A stream cut before the closing fence never yields a writable proposal.
  assert.throws(() => parseWriteProposal('```eadp-write-proposal\n' + JSON.stringify(proposal(draft)), draft, ['source-one']), /需要且仅允许一个/)
})

test('the block is read from anywhere in the answer, after trailing text, CRLF and tag delimiters', async t => {
  const { draft } = await fixture(t)
  const expected = { conclusions: [{ id: 'C1', text: '仅允许已审批的退回申请' }], evidenceIds: ['source-one'], body: '新正文' }
  assert.deepEqual(parseWriteProposal(`${response(proposal(draft))}\n\n点击「写入」后才会生效。`, draft, ['source-one']), expected)
  assert.deepEqual(parseWriteProposal(response(proposal(draft)).replace(/\n/g, '\r\n'), draft, ['source-one']), expected)
  const tagged = `已整理。\n<eadp-write-proposal>\n${JSON.stringify(proposal(draft))}\n</eadp-write-proposal>`
  assert.deepEqual(parseWriteProposal(tagged, draft, ['source-one']), expected)
})

test('a payload that is not JSON fails with a retryable message instead of a parser trace', async t => {
  const { draft } = await fixture(t)
  assert.throws(() => parseWriteProposal('```eadp-write-proposal\n{"entityId":\n```', draft, ['source-one']), /不是合法 JSON/)
  assert.equal(hasWriteProposal('是否写入？'), false)
  assert.equal(hasWriteProposal('上一条回复末尾的 `eadp-write-proposal` 代码块即提议'), false)
  assert.equal(hasWriteProposal('<eadp-write-proposal>\n{}'), true)
  assert.equal(hasWriteProposal('```eadp-write-proposal\n{}'), true)
})

test('body, template, CONTEXT.md or evidence changing voids the proposal instead of rebinding it', async t => {
  const { draft } = await fixture(t)
  const state = { baseHash: draft.sha256, templateRef, contextHash: 'absent', evidenceIds: ['source-one'] }
  assert.equal(proposalInvalidReason(state, { draftHash: draft.sha256, templateRef, contextHash: 'absent', evidenceIds: ['source-one'] }), undefined)
  assert.match(proposalInvalidReason(state, { draftHash: 'c'.repeat(64), templateRef, contextHash: 'absent', evidenceIds: ['source-one'] })!, /正文已变化/)
  assert.match(proposalInvalidReason(state, { draftHash: draft.sha256, templateRef: { ...templateRef, sha256: 'd'.repeat(64) }, contextHash: 'absent', evidenceIds: ['source-one'] })!, /模板已变化/)
  assert.match(proposalInvalidReason(state, { draftHash: draft.sha256, templateRef, contextHash: 'e'.repeat(64), evidenceIds: ['source-one'] })!, /CONTEXT\.md 已变化/)
  assert.match(proposalInvalidReason(state, { draftHash: draft.sha256, templateRef, contextHash: 'absent', evidenceIds: ['source-two'] })!, /依据集合已变化/)
})

test('a context proposal targets the project file and is bound only to CONTEXT.md and evidence', async t => {
  const { draft } = await fixture(t)
  const parsed = parseWriteProposal(response({ ...proposal(draft), target: 'context', body: '# 项目上下文' }), draft, ['source-one'])
  assert.deepEqual(parsed, { conclusions: [{ id: 'C1', text: '仅允许已审批的退回申请' }], evidenceIds: ['source-one'], body: '# 项目上下文', target: 'context' })
  // The scenario body is not this proposal's target, so equal bytes there do not make it a no-op.
  assert.equal(parseWriteProposal(response({ ...proposal(draft), target: 'context', body: '旧正文' }), draft, ['source-one']).target, 'context')
  assert.throws(() => parseWriteProposal(response({ ...proposal(draft), target: 'elsewhere' }), draft, ['source-one']), /目标无效/)
  const state = { baseHash: 'absent', templateRef, contextHash: 'absent', evidenceIds: ['source-one'], target: 'context' as const }
  assert.equal(proposalInvalidReason(state, { draftHash: 'c'.repeat(64), templateRef: { ...templateRef, sha256: 'd'.repeat(64) }, contextHash: 'absent', evidenceIds: ['source-one'] }), undefined)
  assert.match(proposalInvalidReason(state, { draftHash: draft.sha256, templateRef, contextHash: 'e'.repeat(64), evidenceIds: ['source-one'] })!, /CONTEXT\.md 已变化/)
  assert.match(proposalInvalidReason(state, { draftHash: draft.sha256, templateRef, contextHash: 'absent', evidenceIds: ['source-two'] })!, /依据集合已变化/)
})

test('the same rejected conclusion cannot return under a new model-chosen ID', async t => {
  const { draft } = await fixture(t)
  const first = parseWriteProposal(response(proposal(draft)), draft, ['source-one'])
  const again = parseWriteProposal(response({ ...proposal(draft), conclusions: [{ id: 'C9', text: '仅允许已审批的退回申请' }] }), draft, ['source-one'])
  assert.equal(conclusionKey(first.conclusions[0]!), conclusionKey(again.conclusions[0]!))
  assert.notEqual(conclusionKey(again.conclusions[0]!), conclusionKey({ id: 'C9', text: '允许口头申请' }))
})

test('the change summary names added, changed and removed chapters, used evidence and open answers', () => {
  const before = '开头\n\n## 核心业务规则\n旧规则\n\n## 验收条件\n旧条件\n\n## 待删除\n无需保留'
  const after = '开头\n\n## 核心业务规则\n新规则\n\n## 验收条件\n旧条件\n\n## 新增章节\n新增内容'
  assert.deepEqual(summarizeWrite(before, after, ['资料甲'], ['谁审批？']), {
    added: ['新增章节'], removed: ['待删除'], changed: ['核心业务规则'], evidence: ['资料甲'], unanswered: ['谁审批？'],
  })
  assert.deepEqual(summarizeWrite('', '## 核心业务规则\n首稿', [], []), { added: ['核心业务规则'], removed: [], changed: [], evidence: [], unanswered: [] })
})

test('undo is a new hash-checked whole-body write back to the previous body', async t => {
  const { root, localRoot, draft } = await fixture(t)
  const service = new ScenarioDocumentService(localRoot)
  const written = await service.save({ root, metadata: draft.metadata, body: '写入后正文', expectedHash: draft.sha256, operationId: 'write-one' })
  const undone = await service.save({ root, metadata: draft.metadata, body: '旧正文', expectedHash: written.sha256, operationId: 'undo-one' })
  assert.equal(undone.body, '旧正文')
  assert.equal(undone.sha256, draft.sha256)
  await assert.rejects(service.save({ root, metadata: draft.metadata, body: '旧正文', expectedHash: written.sha256, operationId: 'undo-two' }), /外部修改/)
})

test('consuming the same proposal twice writes once and returns the original result', async t => {
  const { root, localRoot, draft } = await fixture(t)
  const service = new ScenarioDocumentService(localRoot), input = { root, metadata: draft.metadata, body: '新正文', expectedHash: draft.sha256, operationId: 'proposal-one' }
  const [first, repeated] = await Promise.all([service.save(input), service.save(input)])
  assert.deepEqual(first, repeated)
  assert.deepEqual(await service.save(input), first)
  assert.equal((await readMaterial(root, 'scenario', draft.entityId)).body, '新正文')
})
