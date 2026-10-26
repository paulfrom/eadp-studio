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
  assert.equal(mergeNoticeFor(owner('accepted')), undefined)
  assert.equal(mergeNoticeFor(owner('integrating', { remoteFiles: ['场景/a.md'], aiFiles: [] })), undefined)
})
