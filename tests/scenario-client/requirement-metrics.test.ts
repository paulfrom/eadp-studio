import assert from 'node:assert/strict'
import test from 'node:test'
import type { ConsistencyComparisonView, MaterialMetadata } from '../../packages/studio-plugin/src/shared/studio.ts'
import { latestComparison, requirementMetrics } from '../../packages/studio-plugin/src/client/requirements/metrics.ts'

const metadata = (openQuestions: Array<{ blocking: boolean }> = []) => ({ openQuestions: openQuestions.map(question => ({ blocking: question.blocking, limitation: '待澄清', excludedScope: '无' })) }) as unknown as MaterialMetadata

test('counts top-level list entries of the 业务规则 section only', () => {
  const body = ['# 需求', '', '## 目标', '文字', '', '## 业务规则', '- 规则一', '- 规则二', '    - 子项不计', '', '## 验收条件', '- 不算规则'].join('\n')
  assert.deepEqual(requirementMetrics(body, metadata()), { rules: 2, openQuestions: 0, blocking: 0 })
})

test('an unrecognized rules section is unknown, while an explicitly empty section has zero rules', () => {
  assert.equal(requirementMetrics('', metadata()).rules, null)
  assert.equal(requirementMetrics('## 目标\n- 条目', metadata()).rules, null)
  assert.equal(requirementMetrics('## 业务规则\n', metadata()).rules, 0)
})

test('list markers inside fenced code are never counted', () => {
  const body = '## 业务规则\n```\n- 示例不是规则\n```\n- 规则一'
  assert.equal(requirementMetrics(body, metadata()).rules, 1)
})

test('open questions come from metadata with the blocking subset', () => {
  const metrics = requirementMetrics('', metadata([{ blocking: true }, { blocking: false }, { blocking: true }]))
  assert.deepEqual(metrics, { rules: null, openQuestions: 3, blocking: 2 })
})

const comparison = (over: Partial<ConsistencyComparisonView>): ConsistencyComparisonView => ({
  id: 'c1', entityId: 'req-1', trigger: 'manual', result: 'completed', coverage: 'complete',
  summary: '摘要', conflictCount: 0, createdAt: '2026-10-23T01:00:00.000Z',
  creator: { id: 1, account: 'a', name: 'A', at: '2026-10-23T01:00:00.000Z' }, conflicts: [], ...over,
})

test('latest completed comparison gives conflict count and coverage', () => {
  const older = comparison({ id: 'c1', createdAt: '2026-10-22T01:00:00.000Z', conflictCount: 5 })
  const newer = comparison({ id: 'c2', createdAt: '2026-10-23T01:00:00.000Z', conflictCount: 2, coverage: 'partial' })
  assert.deepEqual(latestComparison('req-1', [older, newer]), { status: 'known', conflictCount: 2, coverage: 'partial', createdAt: '2026-10-23T01:00:00.000Z' })
})

test('failed, cancelled or unread comparisons are unknown, never consistent', () => {
  assert.deepEqual(latestComparison('req-1', []), { status: 'unknown' })
  assert.deepEqual(latestComparison('req-1', [comparison({ result: 'failed', failureCode: 'model-failed' })]), { status: 'unknown' })
  assert.deepEqual(latestComparison('req-1', [comparison({ result: 'cancelled', failureCode: 'cancelled' })]), { status: 'unknown' })
  assert.deepEqual(latestComparison('req-2', [comparison({})]), { status: 'unknown' })
})
