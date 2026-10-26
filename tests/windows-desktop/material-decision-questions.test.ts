import assert from 'node:assert/strict'
import test from 'node:test'
import { identifyMaterialQuestions, hasMaterialDecisionQuestions, parseMaterialDecisionQuestions } from '../../packages/studio-plugin/src/host/application/material-decision-questions.ts'

const payload = (value: unknown) => `\`\`\`eadp-material-questions\n${JSON.stringify(value)}\n\`\`\``
const questionBlock = (overrides: Record<string, unknown> = {}) => ({
  entityId: 'requirement-one',
  questions: [{ key: 'Q1', title: '退款金额由谁审批？', reason: '现有资料没有说明审批角色。', evidenceIds: ['source-one'], options: [
    { key: 'A', label: '客服主管', description: '由客服主管审批退款。' },
    { key: 'B', label: '财务主管', description: '由财务主管审批退款。' },
  ] }],
  ...overrides,
})

test('material question blocks validate their entity and actual-read evidence, then receive Host-owned turn identities', () => {
  const parsed = parseMaterialDecisionQuestions(`还缺一个业务决定。\n${payload(questionBlock())}`, 'requirement-one', ['source-one'])
  assert.equal(parsed.questions[0]!.title, '退款金额由谁审批？')
  const identified = identifyMaterialQuestions('turn-1', parsed.questions)
  assert.equal(identified[0]!.id, 'turn-1:Q1')
  assert.equal(identified[0]!.options[1]!.id, 'turn-1:Q1:B')

  assert.throws(() => parseMaterialDecisionQuestions(payload(questionBlock({ entityId: 'requirement-two' })), 'requirement-one', ['source-one']), /身份不一致/)
  assert.throws(() => parseMaterialDecisionQuestions(payload(questionBlock()), 'requirement-one', []), /未实际读取/)
})

test('question blocks reject ambiguous IDs, incomplete choices, extra trust fields and malformed fences', () => {
  const duplicate = questionBlock()
  duplicate.questions[0]!.options[1]!.key = 'A'
  assert.throws(() => parseMaterialDecisionQuestions(payload(duplicate), 'requirement-one', ['source-one']), /重复选项 ID/)

  const oneChoice = questionBlock()
  oneChoice.questions[0]!.options.pop()
  assert.throws(() => parseMaterialDecisionQuestions(payload(oneChoice), 'requirement-one', ['source-one']), /选项数量无效/)
  assert.throws(() => parseMaterialDecisionQuestions(payload({ ...questionBlock(), turnId: 'model-owned' }), 'requirement-one', ['source-one']), /字段无效/)
  assert.throws(() => parseMaterialDecisionQuestions('```eadp-material-questions\n{"entityId":\n```', 'requirement-one', []), /不是合法 JSON/)
  assert.throws(() => parseMaterialDecisionQuestions(`${payload(questionBlock())}\n${payload(questionBlock())}`, 'requirement-one', ['source-one']), /需要且仅允许一个/)
  assert.equal(hasMaterialDecisionQuestions('这是一段普通讨论。'), false)
  assert.equal(hasMaterialDecisionQuestions('```eadp-material-questions invalid\n{}\n```'), true)
})

test('an empty question list is a valid explicit end to the current question round', () => {
  assert.deepEqual(parseMaterialDecisionQuestions(payload({ entityId: 'requirement-one', questions: [] }), 'requirement-one', []), { questions: [] })
})
