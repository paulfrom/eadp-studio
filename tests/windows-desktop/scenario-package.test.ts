import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { MaterialMetadata } from '../../packages/contracts/src/index.ts'
import { digest } from '../../packages/studio-plugin/src/host/adapters/assets/materials.ts'
import { syncProjectContext } from '../../packages/studio-plugin/src/host/application/scenario-package.ts'

const templateRef = { commitSha: 'a'.repeat(40), path: '.template/default.md', sha256: 'b'.repeat(64) }
function metadata(kind: MaterialMetadata['kind'] = 'scenario'): MaterialMetadata {
  const shared = { entityId: 'scenario-one', kind, title: '退回申请', scenarioIds: [], prerequisites: [], sources: [], businessEvidence: [], coreRulesPresent: false, acceptanceCriteriaPresent: false, openQuestions: [], referencedAssets: [], files: [{ path: '场景/附件.txt', sha256: 'c'.repeat(64) }] }
  return (kind === 'scenario' || kind === 'requirement' ? { ...shared, kind, templateId: 'default', templateRef } : shared) as MaterialMetadata
}
async function fixture(t: { after(fn: () => Promise<unknown>): unknown }) {
  const root = await mkdtemp(path.join(tmpdir(), 'eadp-scenario-package-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

for (const kind of ['scenario', 'requirement'] as const) test(`the project CONTEXT.md joins the ${kind} manifest with its exact bytes hash and never displaces other files`, async t => {
  const root = await fixture(t), bytes = Buffer.from('# 项目上下文\n\n已明确规则。\n')
  await writeFile(path.join(root, 'CONTEXT.md'), bytes)
  const synced = await syncProjectContext(root, metadata(kind))
  assert.deepEqual(synced.files, [
    { path: '场景/附件.txt', sha256: 'c'.repeat(64) },
    { path: 'CONTEXT.md', sha256: digest(bytes) },
  ])
  const updated = Buffer.from('# 项目上下文\n\n新规则。\n')
  await writeFile(path.join(root, 'CONTEXT.md'), updated)
  const resynced = await syncProjectContext(root, synced)
  assert.equal(resynced.files?.find(file => file.path === 'CONTEXT.md')?.sha256, digest(updated))
  assert.equal(resynced.files?.length, 2)
})

test('removing the context file removes stale declarations from design materials; handoffs remain untouched', async t => {
  const root = await fixture(t)
  for (const kind of ['scenario', 'requirement'] as const) {
    const withContext = { ...metadata(kind), files: [{ path: 'CONTEXT.md', sha256: 'd'.repeat(64) }] } as MaterialMetadata
    assert.deepEqual((await syncProjectContext(root, withContext)).files, [])
  }
  const handoff = metadata('handoff')
  assert.equal(await syncProjectContext(root, handoff), handoff)
})
