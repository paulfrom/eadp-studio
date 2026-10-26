import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mergeNoticeFor } from '../../packages/studio-plugin/src/host/application/material-confirmations.ts'
import { mergeNoteText } from '../../packages/studio-plugin/src/host/application/candidate-merges.ts'
import type { ScenarioRecord } from '../../packages/studio-plugin/src/host/application/scenario-workspaces.ts'

const owner = (phase: string, note?: { remoteFiles: string[]; aiFiles: string[] }) => ({
  materialConfirmations: [{ operationId: 'c1', phase, mergeNote: note }],
}) as ScenarioRecord

test('merge notes tell the user exactly which files were merged automatically and by AI', () => {
  assert.equal(mergeNoteText({ remoteFiles: ['场景/a.md'], aiFiles: [] }), '已自动合并远端变更：场景/a.md')
  assert.equal(mergeNoteText({ remoteFiles: ['场景/a.md'], aiFiles: ['场景/b.md'] }), '已自动合并远端变更：场景/a.md；AI 解决冲突：场景/b.md')
  assert.equal(mergeNoticeFor(owner('accepted', { remoteFiles: ['场景/a.md'], aiFiles: [] })), '已自动合并远端变更：场景/a.md')
  const remoteMerged = owner('accepted')
  remoteMerged.materialConfirmations![0]!.merge = { head: 'b'.repeat(40), commits: [{ sha: 'c'.repeat(40), title: '远端修改' }], files: ['场景/a.md'], aiFiles: ['场景/a.md'] }
  assert.equal(mergeNoticeFor(remoteMerged), '已自动合并远端 1 个提交（1 个文件），其中 1 个冲突文件由 AI 合并')
  assert.equal(mergeNoticeFor(owner('accepted')), undefined)
  assert.equal(mergeNoticeFor(owner('integrating', { remoteFiles: ['场景/a.md'], aiFiles: [] })), undefined)
  assert.equal(mergeNoticeFor({} as ScenarioRecord), undefined, '完全无操作时不显示提示')
  const restarted = owner('accepted', { remoteFiles: ['场景/a.md'], aiFiles: [] })
  restarted.materialConfirmations!.push({ operationId: 'c2', phase: 'saving' } as never)
  assert.equal(mergeNoticeFor(restarted), undefined, '新确认开始后清除旧 accepted 提示')
})
