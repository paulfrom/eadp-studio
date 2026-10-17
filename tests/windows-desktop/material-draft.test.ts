import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'
import { ConfirmationInputSchema, FixedManifestSchema } from '../../packages/contracts/src/index.ts'
import { parseMaterial as parseConfirmedMaterial } from '../../packages/asset-domain/src/index.ts'
import { checkMaterial, saveMaterial } from '../../packages/studio-plugin/src/host/adapters/assets/materials.ts'
import { initialMetadata } from '../../packages/studio-plugin/src/host/application/ports.ts'
const { Value } = createRequire(new URL('../../packages/contracts/package.json', import.meta.url))('@sinclair/typebox/value')

test('a new material can be saved and reopened as a draft without inventing business evidence', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'eadp-material-draft-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const metadata = initialMetadata({ id: 'draft', kind: 'scenario', title: '合成场景', categoryId: 'test' })
  const draft = await saveMaterial(root, metadata, '# 待整理场景\n')
  assert.deepEqual(draft.metadata, metadata)
  assert.equal(draft.path, '场景/draft.md')
  assert.throws(() => checkMaterial(draft))
})

test('confirmation requires real business evidence at Host, wire and backend boundaries', () => {
  const metadata = { ...initialMetadata({ id: 'draft', kind: 'requirement', title: '合成需求', categoryId: 'test' }), coreRulesPresent: true, acceptanceCriteriaPresent: true }
  const body = '## 核心业务规则\n只有授权用户才能提交该合成申请。\n\n## 验收条件\n未获授权的提交必须被拒绝并显示原因。\n'
  const fixed = { commitSha: 'a'.repeat(40), path: '需求/draft.md', sha256: 'b'.repeat(64) }
  for (const businessEvidence of [[], [{ label: '   ', reference: ' \n' }], [{ label: '依据', reference: '   ' }], [{ label: '   ', reference: 'test:approved' }], [{ label: '合成业务依据', reference: 'test:approved' }]]) {
    const current = { ...metadata, businessEvidence }
    const valid = businessEvidence.length > 0 && businessEvidence.every(x => x.label.trim() && x.reference.trim())
    const draft = { entityId: current.entityId, metadata: current, body, path: fixed.path, sha256: fixed.sha256 }
    const markdown = '```eadp-metadata\n' + JSON.stringify(current) + '\n```\n\n' + body
    assert.equal(Value.Check(ConfirmationInputSchema, { entityId: current.entityId, expectedRevision: 0, fixed, metadata: current, authorConfirmed: true, confirmationMethod: 'direct' }), valid)
    assert.equal(Value.Check(FixedManifestSchema, { schemaVersion: 1, metadata: current }), valid)
    if (valid) { checkMaterial(draft); assert.deepEqual(parseConfirmedMaterial(markdown), current) }
    else { assert.throws(() => checkMaterial(draft)); assert.throws(() => parseConfirmedMaterial(markdown)) }
  }
})
