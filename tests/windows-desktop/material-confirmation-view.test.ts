import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MaterialConfirmations } from '../../packages/studio-plugin/src/host/application/material-confirmations.ts'
import type { ScenarioRecord } from '../../packages/studio-plugin/src/host/application/scenario-workspaces.ts'
import type { PendingOperation } from '../../packages/studio-plugin/src/host/application/state.ts'
import { StudioStore } from '../../packages/studio-plugin/src/host/application/state.ts'

test('an integrating confirmation surfaces the child operation failure instead of the generic pending text', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'confirm-view-')); t.after(() => rm(root, { recursive: true, force: true }))
  const store = new StudioStore(root); store.useUser(1)
  const confirmations = new MaterialConfirmations(store, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never)
  const owner = { projectId: 'p', entityId: 'e', sources: [], sourcePaths: [],
    materialConfirmations: [{ operationId: 'c1', accountId: 1, projectId: 'p', entityId: 'e', request: {}, fingerprint: '', task: {}, occupation: {}, phase: 'integrating', integrationId: 'i1',
      message: '已自动合并远端变更：场景/remote.md，正在核对集成结果', mergeNote: { remoteFiles: ['场景/remote.md'], aiFiles: [] } }] } as ScenarioRecord
  const child = { id: 'i1', projectId: 'p', phase: 'unknown', message: 'GitLab 拒绝推送：凭据失效' } as PendingOperation
  assert.equal(confirmations.view(owner, [child])?.message, 'GitLab 拒绝推送：凭据失效')
  assert.equal(confirmations.view(owner, [])?.message, '已自动合并远端变更：场景/remote.md，正在核对集成结果')
})

test('confirmation view keeps operation precedence and terminal boundaries', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'confirm-view-boundary-')); t.after(() => rm(root, { recursive: true, force: true }))
  const store = new StudioStore(root); store.useUser(1)
  const confirmations = new MaterialConfirmations(store, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never)
  const operation = { operationId: 'c1', accountId: 1, projectId: 'p', entityId: 'e', request: {}, fingerprint: '', task: {}, occupation: {}, phase: 'recovery', message: '原保存失败' }
  const owner = { projectId: 'p', entityId: 'e', sources: [], sourcePaths: [], materialConfirmations: [operation] } as ScenarioRecord
  assert.equal(confirmations.view(owner, [])?.message, '原保存失败', '无 integrationId 时显示原操作错误')
  operation.phase = 'integrating'; operation.integrationId = 'i1'
  const child = { id: 'i1', projectId: 'p', phase: 'prepared', message: '子操作提示' } as PendingOperation
  assert.equal(confirmations.view(owner, [child])?.message, '原保存失败', 'child 非 unknown 不得覆盖原操作提示')
  operation.phase = 'accepted'
  assert.equal(confirmations.view(owner, [child]), undefined)
  operation.phase = 'superseded'
  assert.equal(confirmations.view(owner, [child]), undefined)
})
