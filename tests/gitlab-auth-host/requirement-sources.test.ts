import assert from 'node:assert/strict'
import test from 'node:test'
import { generalScenarioDocument, generalScenarioMetadata } from '../../packages/asset-domain/src/index.ts'
import type { EntityView, FixedVersion, MaterialMetadata } from '../../packages/contracts/src/index.ts'
import { digest, materialText } from '../../packages/studio-plugin/src/host/adapters/assets/materials.ts'
import { readRequirementSource } from '../../packages/studio-plugin/src/host/application/requirement-sources.ts'

const metadata: MaterialMetadata = { entityId: 'scene', kind: 'scenario', title: '审批场景', templateId: 'default',
  templateRef: { commitSha: 'a'.repeat(40), path: '.template/default.md', sha256: 'b'.repeat(64) },
  scenarioIds: [], prerequisites: [], sources: [], businessEvidence: [], referencedAssets: [], flowComplete: true, openQuestions: [] }
const requirement = { id: 'requirement', kind: 'requirement', scenarioSources: [{ projectId: 'project', entityId: 'scene', version: 1 }] } as EntityView
function version(body: string, number: number): { value: FixedVersion; bytes: string } {
  const bytes = materialText(metadata, body)
  return { bytes, value: { version: number, confirmationId: `confirmation-${number}`, metadata,
    fixed: { commitSha: String(number).repeat(40), path: '场景/审批场景.md', sha256: digest(bytes) },
    confirmedBy: 1, confirmedAt: '', reuse: { enabled: true, reason: '' } } }
}

test('source inspection reads the pinned accepted version when the scenario has newer content', async () => {
  const pinned = version('已确认旧规则。', 1), current = version('已确认新规则。', 2)
  const read = await readRequirementSource('project', requirement, 'scene', 1, {
    versions: async id => { assert.equal(id, 'scene'); return [current.value, pinned.value] },
    read: async fixed => { assert.deepEqual(fixed, pinned.value.fixed); return Buffer.from(pinned.bytes) },
  })
  assert.equal(read.body, '已确认旧规则。')
  assert.equal(read.version, 1)
  assert.equal(read.confirmationId, 'confirmation-1')
  assert.deepEqual(requirement.scenarioSources, [{ projectId: 'project', entityId: 'scene', version: 1 }])
})

test('source inspection rejects unbound, cross-project, missing and mismatching fixed inputs', async () => {
  const pinned = version('固定规则。', 1)
  let reads = 0
  const reader = { versions: async () => [pinned.value], read: async () => { reads++; return Buffer.from('被改写') } }
  await assert.rejects(readRequirementSource('project', requirement, 'other', 1, reader), /正式场景来源/)
  await assert.rejects(readRequirementSource('other-project', requirement, 'scene', 1, reader), /正式场景来源/)
  await assert.rejects(readRequirementSource('project', requirement, 'scene', 2, reader), /来源版本与正式关系不一致/)
  await assert.rejects(readRequirementSource('project', requirement, 'scene', 1, { ...reader, versions: async () => [] }), /固定确认版本/)
  assert.equal(reads, 0)
  await assert.rejects(readRequirementSource('project', requirement, 'scene', 1, reader), /哈希不符/)
  assert.equal(reads, 1)
})

test('system-provisioned source inspection uses the strict builtin contract', async () => {
  const bytes = generalScenarioDocument('scene'), value: FixedVersion = { ...version('', 1).value,
    metadata: generalScenarioMetadata('scene'), builtin: true,
    fixed: { commitSha: 'a'.repeat(40), path: '场景/通用场景.md', sha256: digest(bytes) } }
  const read = await readRequirementSource('project', requirement, 'scene', 1, { versions: async () => [value], read: async () => Buffer.from(bytes) })
  assert.equal(read.builtin, true)
  assert.match(read.body, /本说明只提供需求的场景归属/)
  assert.equal(read.body.includes('eadp-metadata'), false)
  const changed = bytes + '篡改'
  await assert.rejects(readRequirementSource('project', requirement, 'scene', 1, {
    versions: async () => [{ ...value, fixed: { ...value.fixed, sha256: digest(changed) } }], read: async () => Buffer.from(changed),
  }), /Built-in general scenario/)
})
