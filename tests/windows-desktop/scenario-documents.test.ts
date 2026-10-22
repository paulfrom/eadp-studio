import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { MaterialMetadata } from '../../packages/contracts/src/index.ts'
import type { ScenarioSource, ScenarioSuggestionBatch } from '../../packages/studio-plugin/src/shared/scenarios.ts'
import { digest, materialText, readMaterial, saveMaterial } from '../../packages/studio-plugin/src/host/adapters/assets/materials.ts'
import { ScenarioDocumentConflictError, ScenarioDocumentService, checkScenarioDocument, scenarioFileErrors } from '../../packages/studio-plugin/src/host/application/scenario-documents.ts'
import { parseSuggestionBatch, suggestionBody } from '../../packages/studio-plugin/src/host/application/scenario-suggestions.ts'
import { archiveSelectedEvidence } from '../../packages/studio-plugin/src/host/application/scenario-evidence.ts'

const templateRef = { commitSha: 'a'.repeat(40), path: '.template/default.md', sha256: 'b'.repeat(64) }
function metadata(): MaterialMetadata { return { entityId: 'scenario-one', kind: 'scenario', title: '退回申请', templateId: 'default', templateRef, scenarioIds: [], prerequisites: [], sources: [], businessEvidence: [], coreRulesPresent: false, acceptanceCriteriaPresent: false, openQuestions: [], referencedAssets: [] } }
async function fixture(t: { after(fn: () => Promise<unknown>): unknown }, body = '甲乙丙丁') {
  const parent = await mkdtemp(path.join(tmpdir(), 'eadp-scenario-documents-'))
  const root = path.join(parent, 'project'), localRoot = path.join(parent, 'local')
  const { mkdir } = await import('node:fs/promises'); await mkdir(root)
  t.after(() => rm(parent, { recursive: true, force: true }))
  const draft = await saveMaterial(root, metadata(), body)
  return { root, localRoot, draft, service: new ScenarioDocumentService(localRoot) }
}
function batch(draft: Awaited<ReturnType<typeof readMaterial>>): ScenarioSuggestionBatch {
  return { id: 'batch-one', entityId: draft.entityId, baseHash: draft.sha256, status: 'current', groups: [{ id: 'rules', title: '规则', items: [
    { id: 'first', start: 0, end: 1, original: '甲', replacement: '第一', evidenceIds: ['source-one'] },
    { id: 'second', start: 2, end: 4, original: '丙丁', replacement: '第三四', evidenceIds: [] },
  ] }] }
}
/** Wire shape the Agent sends: ranges plus anchors, never the replaced text itself. */
function wireBatch(draft: Awaited<ReturnType<typeof readMaterial>>) {
  return { id: 'batch-one', entityId: draft.entityId, baseHash: draft.sha256, groups: [{ id: 'rules', title: '规则', items: [
    { id: 'first', start: 0, end: 1, anchor: '甲', replacement: '第一', evidenceIds: ['source-one'] },
    { id: 'second', start: 2, end: 4, anchor: '丙丁', replacement: '第三四', evidenceIds: [] },
  ] }] }
}
const response = (value: unknown) => '```eadp-suggestions\n' + JSON.stringify(value) + '\n```'

test('precise body whitespace survives save and reopen; the file hash covers all metadata and body bytes', async t => {
  const { root } = await fixture(t)
  const body = '\n  甲乙  \n\n'
  const draft = await saveMaterial(root, metadata(), body)
  assert.equal(draft.body, body)
  assert.equal((await readMaterial(root, 'scenario', draft.entityId)).body, body)
  assert.equal(draft.sha256, digest(await readFile(path.join(root, draft.path))))
})

test('same operation survives service restart and returns the original result, while a reused ID rejects changed input', async t => {
  const { root, localRoot, draft, service } = await fixture(t)
  const input = { root, metadata: draft.metadata, body: '新正文', expectedHash: draft.sha256, operationId: 'save-one' }
  const [first, repeated] = await Promise.all([service.save(input), service.save(input)])
  assert.deepEqual(first, repeated)
  assert.deepEqual(await new ScenarioDocumentService(localRoot).save(input), first)
  await assert.rejects(service.save({ ...input, body: '另外正文' }), /同一操作 ID/)
  assert.equal((await readMaterial(root, 'scenario', draft.entityId)).body, '新正文')
  assert.deepEqual(await readdir(root), ['场景'])
})

test('concurrent writes serialize by file; losing writer keeps both external and local content outside the worktree', async t => {
  const { root, draft, service } = await fixture(t)
  const outcomes = await Promise.allSettled(['甲', '乙'].map((body, index) => service.save({ root, metadata: draft.metadata, body, expectedHash: draft.sha256, operationId: `save-${index}` })))
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1)
  const rejected = outcomes.find(result => result.status === 'rejected') as PromiseRejectedResult
  assert.ok(rejected.reason instanceof ScenarioDocumentConflictError)
  const conflict = rejected.reason as ScenarioDocumentConflictError
  // Which writer reaches the queue first is not observable; the loser must keep both versions.
  const external = conflict.conflict?.actual.body, local = conflict.conflict?.localBody
  assert.deepEqual(new Set([external, local]), new Set(['甲', '乙']))
  assert.equal(await readFile(conflict.savedPaths.external, 'utf8'), materialText(draft.metadata, external!))
  assert.equal(await readFile(conflict.savedPaths.local, 'utf8'), materialText(draft.metadata, local!))
  assert.equal(conflict.savedPaths.local.startsWith(`${root}/`), false)
  assert.equal((await readMaterial(root, 'scenario', draft.entityId)).body, external)
})

test('an invalid external file is retained with the local input and never overwritten', async t => {
  const { root, draft, service } = await fixture(t)
  await writeFile(path.join(root, draft.path), '损坏的外部文件')
  await assert.rejects(service.save({ root, metadata: draft.metadata, body: '未保存输入', expectedHash: draft.sha256, operationId: 'save-invalid' }), asyncError => {
    assert.ok(asyncError instanceof ScenarioDocumentConflictError)
    assert.equal(asyncError.conflict, undefined)
    assert.equal(asyncError.actualHash, digest('损坏的外部文件'))
    return true
  })
  assert.equal(await readFile(path.join(root, draft.path), 'utf8'), '损坏的外部文件')
})

test('suggestions accept one strict block, derive the original text from the draft, and reject malformed ranges', async t => {
  const { draft } = await fixture(t), wire = wireBatch(draft)
  const parsed = parseSuggestionBatch(response(wire), draft)
  assert.equal(parsed.status, 'current')
  assert.deepEqual(parsed.groups[0]!.items.map(item => item.original), ['甲', '丙丁'])
  assert.throws(() => parseSuggestionBatch(response({ ...wire, status: 'current' }), draft))
  assert.throws(() => parseSuggestionBatch(response(wire) + '\n' + response(wire), draft))
  const first = wire.groups[0]!.items[0]
  for (const changed of [
    { ...wire, groups: [...wire.groups, wire.groups[0]] },
    { ...wire, groups: [{ ...wire.groups[0], items: [first, first] }] },
    { ...wire, groups: [{ ...wire.groups[0], items: [{ ...first, anchor: '乙' }] }] },
    { ...wire, groups: [{ ...wire.groups[0], items: [{ ...first, end: 9 }] }] },
    { ...wire, groups: [{ ...wire.groups[0], items: [{ ...first, start: 0, end: 0 }] }] },
    { ...wire, groups: [{ ...wire.groups[0], items: [{ ...first, anchor: '甲'.repeat(41) }] }] },
    { ...wire, groups: [{ ...wire.groups[0], items: [{ ...first, replacement: '甲' }] }] },
    { ...wire, groups: [{ ...wire.groups[0], items: [{ ...first, evidenceIds: ['source-one', 'source-one'] }] }] },
  ]) assert.throws(() => parseSuggestionBatch(response(changed), draft))
  // A batch about another version still arrives as history, with empty originals.
  const older = parseSuggestionBatch(response({ ...wire, baseHash: 'f'.repeat(64) }), draft)
  assert.deepEqual(older.groups[0]!.items.map(item => item.original), ['', ''])
})

test('a selected batch applies once; stale, overlapping, mismatched and unread suggestions never write', async t => {
  const { root, draft, service } = await fixture(t), proposal = batch(draft)
  const input = { root, draft, batch: proposal, selectedItemIds: ['first', 'second'], expectedHash: draft.sha256, operationId: 'adopt-one', readEvidenceIds: ['source-one'] }
  const applied = await service.apply(input)
  assert.equal(applied.body, '第一乙第三四')
  assert.deepEqual(await service.apply({ ...input, batch: { ...proposal, status: 'applied' } }), applied)
  assert.deepEqual(await service.apply({ ...input, draft: applied, batch: { ...proposal, status: 'applied' }, readEvidenceIds: [] }), applied)
  assert.throws(() => suggestionBody(applied, proposal, ['first'], ['source-one']), /过期/)
  assert.throws(() => suggestionBody(draft, proposal, ['first'], []), /未实际读取/)
  assert.throws(() => suggestionBody(draft, { ...proposal, groups: [{ ...proposal.groups[0]!, items: [{ ...proposal.groups[0]!.items[0]!, end: 99 }] }] }, ['first'], ['source-one']), /超出当前正文/)
  const overlapping = { ...proposal, groups: [{ ...proposal.groups[0]!, items: [...proposal.groups[0]!.items, { id: 'overlap', start: 0, end: 2, original: '甲乙', replacement: '替代', evidenceIds: [] }] }] }
  assert.throws(() => suggestionBody(draft, overlapping, ['first', 'overlap'], ['source-one']), /重叠/)
  assert.equal((await readMaterial(root, 'scenario', draft.entityId)).sha256, applied.sha256)
})

test('formal evidence archives only explicit selected versions with original bytes and read scope', async t => {
  const { root, draft } = await fixture(t)
  const original = new TextEncoder().encode('原始依据'), text = '实际读取第一行\n实际读取第二行'
  const source: ScenarioSource = { id: 'source-one', name: '审批规则', format: 'txt', sha256: digest(original), status: 'partial', ranges: ['页 2—3'], text, selected: true, formal: true }
  const records = [{ source, original }, { source: { ...source, id: 'temporary', formal: false }, original }]
  const evidence = await archiveSelectedEvidence(root, records, ['source-one'])
  assert.equal(evidence.length, 1)
  assert.equal(evidence[0]!.files.length, 3)
  for (const file of evidence[0]!.files) assert.equal(digest(await readFile(path.join(root, file.path))), file.sha256)
  const scope = evidence[0]!.files.find(file => file.path.endsWith('.json'))!
  assert.deepEqual(JSON.parse(await readFile(path.join(root, scope.path), 'utf8')).ranges, source.ranges)
  const current = { ...draft, metadata: { ...draft.metadata, businessEvidence: evidence } }
  assert.deepEqual(await scenarioFileErrors(root, current), [])
  await assert.rejects(archiveSelectedEvidence(root, records, ['temporary']), /用户选定/)
  await assert.rejects(archiveSelectedEvidence(root, [{ source, original: new TextEncoder().encode('来源变化') }], ['source-one']), /来源已变化/)
  await writeFile(path.join(root, evidence[0]!.files[0]!.path), '来源遭改写')
  assert.match((await scenarioFileErrors(root, current)).join('\n'), /文件内容已变化/)
})

test('business checks do not infer completeness from titles or text length; optional template headings ignore fenced examples', async t => {
  const { draft } = await fixture(t, '## 自定义范围\n甲\n## 判断\n乙')
  const formal = { label: '确认依据', reference: 'source:approved', files: [{ path: '.eadp/evidence/hash/original.txt', sha256: 'd'.repeat(64) }], ranges: [{ path: '.eadp/evidence/hash/original.txt', startLine: 1, endLine: 1 }] }
  const ready = { ...draft, metadata: { ...draft.metadata, coreRulesPresent: true, acceptanceCriteriaPresent: true, businessEvidence: [formal] } }
  const input = { draft: ready, expectedHash: ready.sha256, hasPermission: true, hasOccupation: true }
  const result = checkScenarioDocument(input)
  assert.equal(result.passed, true)
  assert.equal(result.groups.find(group => group.id === 'template')!.status, 'disabled')
  assert.equal(checkScenarioDocument({ ...input, structureCheck: true, templateBody: '## 判断\n## 自定义范围\n```md\n## 示例章节\n```' }).passed, true)
  assert.equal(checkScenarioDocument({ ...input, structureCheck: true, templateBody: '## 缺少的章' }).passed, false)
  for (const changed of [{ expectedHash: 'e'.repeat(64) }, { hasPermission: false }, { hasOccupation: false }, { conflict: true }]) assert.equal(checkScenarioDocument({ ...input, ...changed }).passed, false)
  assert.equal(checkScenarioDocument({ ...input, draft: { ...ready, metadata: { ...ready.metadata, coreRulesPresent: false } } }).passed, false)
})

test('requirement evidence metadata uses the same serialized expected-hash writer and preserves the losing version', async t => {
  const f = await fixture(t), requirement: MaterialMetadata = { entityId: 'requirement-one', kind: 'requirement', title: '审批需求', categoryId: 'category', scenarioIds: ['scene'], sources: [{ projectId: 'project', entityId: 'scene', version: 1 }], prerequisites: [], businessEvidence: [], openQuestions: [], coreRulesPresent: false, acceptanceCriteriaPresent: false, referencedAssets: [] }
  const draft = await saveMaterial(f.root, requirement, '需求正文')
  const outcomes = await Promise.allSettled(['甲', '乙'].map((title, index) => f.service.save({ root: f.root, metadata: { ...requirement, title }, body: draft.body, expectedHash: draft.sha256, operationId: `requirement-${index}` })))
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1)
  const failed = outcomes.find(outcome => outcome.status === 'rejected') as PromiseRejectedResult
  assert.ok(failed.reason instanceof ScenarioDocumentConflictError)
  assert.deepEqual(new Set([failed.reason.conflict.actual.metadata.title, failed.reason.conflict.localMetadata.title]), new Set(['甲', '乙']))
  assert.equal((await readMaterial(f.root, 'requirement', requirement.entityId)).body, draft.body)
  assert.equal((await readdir(path.join(f.root, '需求'))).length, 1)
})
