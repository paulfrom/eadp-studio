import assert from 'node:assert/strict'
import test from 'node:test'
import type { PendingOperation } from '../../packages/studio-plugin/src/host/application/state.ts'
import type { MaterialConfirmationOperation } from '../../packages/studio-plugin/src/host/application/material-confirmations.ts'
import { confirmationStep, MaterialConfirmations } from '../../packages/studio-plugin/src/host/application/material-confirmations.ts'
import type { ScenarioRecord } from '../../packages/studio-plugin/src/host/application/scenario-workspaces.ts'

const operation = (phase: MaterialConfirmationOperation['phase'], extra: Partial<MaterialConfirmationOperation> = {}): MaterialConfirmationOperation => ({
  operationId: 'confirmation', accountId: 1, projectId: 'project', entityId: 'scenario',
  request: { operationId: 'confirmation', entityId: 'scenario', expectedHash: 'a'.repeat(64) },
  fingerprint: '', task: {} as MaterialConfirmationOperation['task'], occupation: { occupationId: 'o', generation: 1, taskId: 't', clientId: 'c' },
  phase, ...extra,
})
const owner = (value: MaterialConfirmationOperation): ScenarioRecord => ({ entityId: value.entityId, projectId: value.projectId, sources: [], sourcePaths: [], materialConfirmations: [value] })
const view = Object.create(MaterialConfirmations.prototype) as MaterialConfirmations

test('an integrating confirmation surfaces the child operation failure instead of the generic pending text', () => {
  const value = operation('integrating', { operationId: 'c1', projectId: 'p', entityId: 'e', integrationId: 'i1',
    message: '已自动合并远端变更：场景/remote.md，正在核对集成结果', mergeNote: { remoteFiles: ['场景/remote.md'], aiFiles: [] } })
  const child = { id: 'i1', projectId: 'p', phase: 'unknown', message: 'GitLab 拒绝推送：凭据失效' } as PendingOperation
  assert.equal(view.view(owner(value), [child])?.message, 'GitLab 拒绝推送：凭据失效')
  assert.equal(view.view(owner(value), [])?.message, '已自动合并远端变更：场景/remote.md，正在核对集成结果')
  assert.equal(view.view(owner(value), [{ ...child, projectId: 'other' }])?.message, value.message, '其他项目的子操作不得覆盖本确认')
  assert.equal(view.view(owner(value), [{ ...child, phase: 'rejected' }])?.message, child.message, '明确拒绝同样显示真实错误')
})

test('confirmation view keeps operation precedence and terminal boundaries', () => {
  const value = operation('recovery', { operationId: 'c1', projectId: 'p', entityId: 'e', message: '原保存失败' })
  const record = owner(value)
  assert.equal(view.view(record, [])?.message, '原保存失败', '无 integrationId 时显示原操作错误')
  value.phase = 'integrating'; value.integrationId = 'i1'
  const child = { id: 'i1', projectId: 'p', phase: 'prepared', message: '子操作提示' } as PendingOperation
  assert.equal(view.view(record, [child])?.message, '原保存失败', 'child 非错误状态不得覆盖原操作提示')
  value.phase = 'accepted'
  assert.equal(view.view(record, [child]), undefined)
  value.phase = 'superseded'
  assert.equal(view.view(record, [child]), undefined)
})

test('a waiting confirmation reports its actual step instead of an endless confirming line', () => {
  assert.equal(view.view(owner(operation('integrating')))?.message, '已提交，正在等待协同后台接受')
  assert.equal(view.view(owner(operation('checking')))?.message, '正在核对确认条件')
  assert.equal(view.view(owner(operation('accepted'))), undefined)
})

test('the exact child failure is surfaced on the confirmation notice', () => {
  const child = { id: 'confirmation', projectId: 'project', phase: 'unknown', message: 'One eadp-metadata JSON block is required' } as PendingOperation
  const result = view.view(owner(operation('integrating', { integrationId: 'confirmation' })), [child])
  assert.equal(result?.message, 'One eadp-metadata JSON block is required')
  assert.equal(result?.phase, 'integrating')
})

test('a merged confirmation tells the author what was merged and where AI resolved conflicts', () => {
  const value = operation('checking', { merge: { head: 'b'.repeat(40), commits: [{ sha: 'c'.repeat(40), title: '补充其他场景' }], files: ['场景/其他.md', '场景/其他二.md'], aiFiles: ['场景/其他二.md'] } })
  assert.equal(confirmationStep(value), '正在核对确认条件；已自动合并远端 1 个提交（2 个文件），其中 1 个冲突文件由 AI 合并')
})

test('a repaired duplicate identity is reported beside the current step', () => {
  assert.equal(confirmationStep(operation('checking', { recovered: '已移除正文中重复的材料身份块' })), '正在核对确认条件；已移除正文中重复的材料身份块')
})
