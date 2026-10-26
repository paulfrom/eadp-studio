import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { digest, findMaterialFile, identityBlockCount, normalizeMaterialBody, parseMaterial, readMaterial, saveMaterial } from '../../packages/studio-plugin/src/host/adapters/assets/materials.ts'
import { initialMetadata } from '../../packages/studio-plugin/src/host/application/ports.ts'
import { ScenarioDocumentService } from '../../packages/studio-plugin/src/host/application/scenario-documents.ts'

const templateRef = { commitSha: 'a'.repeat(40), path: '.template/default.md', sha256: 'b'.repeat(64) }
const metadata = () => initialMetadata({ id: 'scenario-one', kind: 'scenario', title: '作者草稿', templateId: 'default', templateRef })
async function fixture(t: { after(fn: () => Promise<unknown>): unknown }) {
  const root = await mkdtemp(path.join(tmpdir(), 'eadp-material-identity-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, '场景'))
  return root
}

test('an existing draft with obsolete quality fields is identified then rejected by its actual path without changing bytes', async t => {
  const root = await fixture(t)
  const { flowComplete: _flow, ...identity } = metadata() as ReturnType<typeof metadata> & { flowComplete: boolean }
  const oldMetadata = { ...identity, coreRulesPresent: false, acceptanceCriteriaPresent: false }
  const relative = '场景/作者草稿.md', body = '作者唯一正文\n\n原始空白必须保留。\n'
  const bytes = '```eadp-metadata\n' + JSON.stringify(oldMetadata) + '\n```\n\n' + body
  await writeFile(path.join(root, relative), bytes)
  assert.equal(await findMaterialFile(root, 'scenario', identity.entityId), relative)
  await assert.rejects(readMaterial(root, 'scenario', identity.entityId), (error: NodeJS.ErrnoException) => {
    assert.equal(error.code, 'INVALID_MATERIAL')
    assert.match(error.message, /材料元数据无效：场景\/作者草稿\.md/)
    assert.doesNotMatch(error.message, /不存在/)
    return true
  })
  const localRoot = await mkdtemp(path.join(tmpdir(), 'eadp-material-identity-local-'))
  t.after(() => rm(localRoot, { recursive: true, force: true }))
  const service = new ScenarioDocumentService(localRoot)
  await assert.rejects(service.save({ root, metadata: metadata(), body: '不得自动替换作者草稿', expectedHash: digest(bytes), operationId: 'invalid-original' }), (error: NodeJS.ErrnoException) => error.code === 'INVALID_MATERIAL')
  assert.equal(await readFile(path.join(root, relative), 'utf8'), bytes)
  assert.deepEqual(await readdir(path.join(root, '场景')), ['作者草稿.md'])
})

test('a genuinely missing identity keeps ENOENT and a current contract still reads normally', async t => {
  const root = await fixture(t)
  await assert.rejects(readMaterial(root, 'scenario', 'absent'), (error: NodeJS.ErrnoException) => error.code === 'ENOENT')
  const draft = await saveMaterial(root, metadata(), '完整流程草稿')
  assert.deepEqual(await readMaterial(root, 'scenario', draft.entityId), draft)
})

test('invalid metadata JSON reports its file and preserves the parse cause', () => {
  assert.throws(() => parseMaterial(Buffer.from('```eadp-metadata\n{invalid json}\n```\n\n作者正文'), '场景/损坏文件.md'), (error: NodeJS.ErrnoException & { cause?: unknown }) => {
    assert.equal(error.code, 'INVALID_MATERIAL')
    assert.match(error.message, /JSON 无效：场景\/损坏文件\.md/)
    assert.ok(error.cause instanceof SyntaxError)
    return true
  })
})

test('an unidentified same-title file cannot be overwritten by a new current material', async t => {
  const root = await fixture(t), relative = '场景/作者草稿.md', original = '```eadp-metadata\n{invalid json}\n```\n\n唯一外部草稿'
  await writeFile(path.join(root, relative), original)
  const draft = await saveMaterial(root, metadata(), '新材料正文')
  assert.equal(draft.path, '场景/作者草稿-2.md')
  assert.equal(await readFile(path.join(root, relative), 'utf8'), original)
  assert.equal((await readMaterial(root, 'scenario', draft.entityId)).body, '新材料正文')
})

test('a model echo of the identity block is removed instead of producing a second block', async t => {
  const root = await fixture(t), echo = `\`\`\`eadp-metadata\n${JSON.stringify(metadata())}\n\`\`\`\n\n完整正文\n`
  const draft = await saveMaterial(root, metadata(), echo)
  assert.equal(draft.body, '完整正文\n')
  const text = await readFile(path.join(root, draft.path), 'utf8')
  assert.equal(identityBlockCount(text), 1)
  assert.equal(parseMaterial(Buffer.from(text), draft.path).body, '完整正文\n')
})

test('a second identity block inside the business body is refused before writing', () => {
  assert.throws(() => normalizeMaterialBody('正文\n\n```eadp-metadata\n{}\n```\n'), /正文不能包含材料身份块/)
  assert.equal(normalizeMaterialBody('正文\n'), '正文\n')
})
