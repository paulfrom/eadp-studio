import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { EntityView, MaterialMetadata, ProjectState } from '../../packages/contracts/src/index.ts'
import type { TaskView } from '../../packages/studio-plugin/src/shared/studio.ts'
import { digest, saveMaterial } from '../../packages/studio-plugin/src/host/adapters/assets/materials.ts'
import { FixedCandidates, type FixedCandidateInput, type PreparedContent } from '../../packages/studio-plugin/src/host/application/fixed-candidates.ts'
import type { HostPorts } from '../../packages/studio-plugin/src/host/application/ports.ts'
import { StudioStore } from '../../packages/studio-plugin/src/host/application/state.ts'

const head = 'a'.repeat(40), candidateSha = 'b'.repeat(40)
const evidencePath = '.eadp/evidence/approved.md', evidence = '业务访谈：只有作者确认后，业务材料才成为固定版本。\n'

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'eadp-fixed-candidates-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new StudioStore(path.join(root, 'local')); store.useUser(1)
  const local = await store.read(), worktree = path.join(root, 'original-task')
  await mkdir(path.dirname(path.join(worktree, evidencePath)), { recursive: true })
  await writeFile(path.join(worktree, evidencePath), evidence)
  const templateRef = { commitSha: head, path: '.template/scenario.md', sha256: digest('template') }
  const entity: EntityView = { id: 'scenario', kind: 'scenario', title: '审批业务', templateId: 'default', templateRef,
    revision: 1, generation: 1, materialVersion: 0, confirmationStatus: 'draft', taskStatus: 'active', scenarioIds: [], prerequisites: [], authorId: 1,
    occupation: { occupationId: 'occupation', generation: 1, taskId: path.basename(worktree), clientId: local.clientId, expectedRevision: 1, entityId: 'scenario', ownerId: 1, purpose: 'design', inputVersion: 0, prerequisiteBindings: [], createdAt: '' } }
  const metadata: MaterialMetadata = { entityId: entity.id, kind: 'scenario', title: entity.title, templateId: 'default', templateRef,
    scenarioIds: [], prerequisites: [], sources: [], businessEvidence: [{ label: '业务访谈', reference: 'synthetic:approved', files: [{ path: evidencePath, sha256: digest(evidence) }], ranges: [{ path: evidencePath, startLine: 1, endLine: 1 }] }],
    openQuestions: [], coreRulesPresent: true, acceptanceCriteriaPresent: true, referencedAssets: [] }
  const draft = await saveMaterial(worktree, metadata, '## 核心业务规则\n\n只有作者可确认业务材料。\n\n## 验收条件\n\n作者确认后形成可追溯的固定版本。\n')
  const task: TaskView = { projectId: 'project', entityId: entity.id, purpose: 'material', worktree, sessionId: 'original-session', inputHash: '' }
  // A historical task precedes the original task, and the selected project has changed.
  local.tasks.push({ ...task, worktree: path.join(root, 'historical-task'), sessionId: 'historical-session' }, task)
  local.selectedProjectId = 'other-project'; await store.save()
  const remote = { project: { id: 'project', recognizedHead: head }, entities: [entity] } as unknown as ProjectState
  const calls = { taskFactories: 0, commits: [] as Array<{ root: string; files: readonly string[] }>, identities: [] as string[], reads: [] as string[], pruned: [] as TaskView[] }
  const git = { head, parents: '', status: ` M ${draft.path}\0`, changed: [draft.path], blobs: new Map<string, Buffer>(), committed: new Map<string, Buffer>(), loseCommitReply: false }
  const ports = {
    gitLocal: async (args: readonly string[], directory: string) => { assert.equal(directory, worktree); return args[0] === 'rev-list' ? git.parents : git.status },
    git: {
      state: async (directory: string) => { assert.equal(directory, worktree); return { head: git.head, dirty: !!git.status } },
      changedFiles: async () => git.changed,
      commitFiles: async (directory: string, files: readonly string[]) => {
        calls.commits.push({ root: directory, files })
        for (const relative of files) {
          const bytes = await readFile(path.join(directory, relative)).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error })
          if (bytes) git.committed.set(relative, bytes); else git.committed.delete(relative)
        }
        git.parents = `${candidateSha} ${git.head}`; git.head = candidateSha; git.status = ''
        if (git.loseCommitReply) { git.loseCommitReply = false; throw new Error('commit finished before process interruption') }
        return candidateSha
      },
      verifyFile: async () => {},
      readBlob: async (_directory: string, _sha: string, relative: string) => { const bytes = git.blobs.get(relative); if (!bytes) throw new Error('blob missing'); return bytes },
      readOptionalBlob: async (_directory: string, _sha: string, relative: string) => git.committed.get(relative),
    },
  } as unknown as HostPorts
  const create = () => new FixedCandidates(store, ports, {
    entity: async (entityId, projectId) => { assert.equal(entityId, entity.id); assert.equal(projectId, task.projectId); calls.reads.push(projectId!); return { remote, entity } },
    designTask: async () => { calls.taskFactories++; throw new Error('must not acquire another task') },
    prototypeTask: async () => { calls.taskFactories++; throw new Error('must not acquire another task') },
    owned: async value => { const { occupationId, generation, taskId, clientId, expectedRevision } = value.occupation!; return { occupationId, generation, taskId, clientId, expectedRevision } },
    identity: async projectId => { calls.identities.push(projectId); return { name: '作者', email: 'author@example.test' } },
    pruneEvidence: async value => { calls.pruned.push(value) },
  })
  const candidates = create()
  const request = { entityId: entity.id, purpose: 'material' as const, task: structuredClone(task), expectedHash: draft.sha256, operationId: 'original-confirmation' }
  return { store, local, worktree, entity, metadata, task, draft, git, calls, candidates, request, create }
}

const fixedInput = ({ snapshot, paths, allowedPaths, input, inputHash }: PreparedContent): FixedCandidateInput =>
  JSON.parse(JSON.stringify({ snapshot, paths, allowedPaths, input, inputHash })) as FixedCandidateInput

test('a recorded confirmation uses its original task, project and operation identity after project selection changes', async t => {
  const f = await fixture(t), prepared = await f.candidates.prepare(f.request)
  assert.equal(prepared.prepare.idempotencyKey, f.request.operationId)
  assert.deepEqual(prepared.task, f.task)
  assert.equal(prepared.prepare.candidateSha, candidateSha)
  assert.equal(prepared.confirmations[0]!.fixed.commitSha, candidateSha)
  assert.equal(prepared.confirmations[0]!.fixed.sha256, f.draft.sha256)
  assert.deepEqual(prepared.review.files, [{ path: evidencePath, sha256: digest(evidence) }, { path: f.draft.path, sha256: f.draft.sha256 }].sort((a, b) => a.path.localeCompare(b.path)))
  assert.equal(f.calls.taskFactories, 0)
  assert.deepEqual(f.calls.identities, ['project'])
  assert.equal(f.calls.commits[0]!.root, f.worktree)
  assert.deepEqual(new Set(f.calls.commits[0]!.files), new Set([f.draft.path, evidencePath]))
})

test('a changed occupation or removed original session never selects or acquires a replacement task', async t => {
  for (const change of ['occupation', 'session', 'purpose'] as const) await t.test(change, async child => {
    const f = await fixture(child)
    if (change === 'occupation') f.entity.occupation!.taskId = 'new-task'
    if (change === 'session') f.local.tasks = f.local.tasks.filter(value => value.sessionId !== f.task.sessionId)
    if (change === 'purpose') f.entity.occupation!.purpose = 'prototype'
    await assert.rejects(f.candidates.prepare(f.request), /原任务现场与当前材料占用不一致/)
    assert.equal(f.calls.taskFactories, 0)
    assert.equal(f.calls.commits.length, 0)
  })
})

test('only a renamed material belonging to the fixed input can extend the commit whitelist', async t => {
  const f = await fixture(t), oldBytes = await readFile(path.join(f.worktree, f.draft.path))
  const renamed = await saveMaterial(f.worktree, { ...f.metadata, title: '新的审批业务' }, f.draft.body)
  f.git.blobs.set(f.draft.path, oldBytes)
  f.git.status = ` D ${f.draft.path}\0?? ${renamed.path}\0`
  const content = await f.candidates.content({ ...f.request, expectedHash: renamed.sha256 })
  assert.ok(content.allowedPaths.includes(f.draft.path))
  assert.deepEqual(content.snapshot.files.find(file => file.path === f.draft.path), { path: f.draft.path, sha256: null })
  f.git.status += ' D 场景/其他业务.md\0'
  f.git.blobs.set('场景/其他业务.md', Buffer.from(oldBytes.toString().replace('"entityId": "scenario"', '"entityId": "another-scenario"')))
  await assert.rejects(f.candidates.prepare({ ...f.request, expectedHash: renamed.sha256 }), /允许范围外的变更/)
  assert.equal(f.calls.commits.length, 0)
})

test('context and evidence must still match their declared bytes before fixing the candidate', async t => {
  const f = await fixture(t)
  await writeFile(path.join(f.worktree, 'CONTEXT.md'), '尚未保存到材料包的上下文')
  await assert.rejects(f.candidates.content(f.request), /项目上下文尚未纳入场景文件包/)
  await rm(path.join(f.worktree, 'CONTEXT.md'))
  await writeFile(path.join(f.worktree, evidencePath), '已被外部修改的业务依据')
  await assert.rejects(f.candidates.prepare(f.request), /正式依据或关联文件已变化/)
  assert.equal(f.calls.commits.length, 0)
})

test('a commit interrupted before returning its candidate reuses the original review head and fixed input', async t => {
  const f = await fixture(t), original = fixedInput(await f.candidates.content(f.request))
  f.git.loseCommitReply = true
  await assert.rejects(f.candidates.prepare({ ...f.request, fixedInput: original }), /commit finished/)
  assert.equal(f.git.head, candidateSha)
  assert.equal(f.calls.commits.length, 1)
  const restored = await f.create().prepare({ ...f.request, fixedInput: original })
  assert.equal(restored.prepare.candidateSha, candidateSha)
  assert.equal(restored.review.head, head, 'the already reviewed head is never replaced by the committed head')
  assert.equal(restored.review.inputHash, original.inputHash)
  assert.deepEqual(restored.review.files, original.snapshot.files)
  assert.deepEqual(restored.review.paths, original.paths)
  assert.deepEqual(restored.prepare.allowedPaths, original.allowedPaths)
  assert.equal(f.calls.commits.length, 1, 'recovery never manufactures a second candidate commit')
  assert.equal(original.input.confirmations[0]!.fixed.commitSha, '', 'precommit input remains immutable')
})

test('rename recovery retains and commits the deleted original path after its porcelain entry disappears', async t => {
  const f = await fixture(t), oldBytes = await readFile(path.join(f.worktree, f.draft.path))
  const renamed = await saveMaterial(f.worktree, { ...f.metadata, title: '新的审批业务' }, f.draft.body)
  f.git.blobs.set(f.draft.path, oldBytes)
  f.git.status = ` D ${f.draft.path}\0?? ${renamed.path}\0`
  f.git.changed = [f.draft.path, renamed.path]
  const request = { ...f.request, expectedHash: renamed.sha256 }, original = fixedInput(await f.candidates.content(request))
  f.git.loseCommitReply = true
  await assert.rejects(f.candidates.prepare({ ...request, fixedInput: original }), /commit finished/)
  assert.ok(f.calls.commits[0]!.files.includes(f.draft.path), 'the removed old filename enters the same commit')
  assert.equal(f.git.status, '')
  const restored = await f.create().prepare({ ...request, fixedInput: original })
  assert.ok(restored.prepare.allowedPaths.includes(f.draft.path))
  assert.deepEqual(restored.review.files.find(file => file.path === f.draft.path), { path: f.draft.path, sha256: null })
  assert.equal(restored.review.head, head)
  assert.equal(f.calls.commits.length, 1)
})

test('persisted input identity, hashes and scope cannot be changed while retaining the original confirmation', async t => {
  for (const change of ['token', 'hash', 'scope'] as const) await t.test(change, async child => {
    const f = await fixture(child), original = fixedInput(await f.candidates.content(f.request))
    if (change === 'token') original.input.token.expectedRevision++
    if (change === 'hash') original.inputHash = 'f'.repeat(64)
    if (change === 'scope') { original.allowedPaths.push('场景/另一材料.md'); original.snapshot.files.push({ path: '场景/另一材料.md', sha256: null }) }
    await assert.rejects(f.candidates.prepare({ ...f.request, fixedInput: original }), /原固定输入/)
    assert.equal(f.calls.commits.length, 0)
  })
})

test('an unexpected commit outside the original scope cannot be recovered as the interrupted candidate', async t => {
  const f = await fixture(t), original = fixedInput(await f.candidates.content(f.request))
  f.git.loseCommitReply = true
  await assert.rejects(f.candidates.prepare({ ...f.request, fixedInput: original }), /commit finished/)
  f.git.changed.push('场景/其他材料.md')
  await assert.rejects(f.create().prepare({ ...f.request, fixedInput: original }), /其他提交或范围外变更/)
  assert.equal(f.calls.commits.length, 1)
})

test('a completed commit with different recorded bytes is never repaired into a replacement candidate', async t => {
  const f = await fixture(t), original = fixedInput(await f.candidates.content(f.request))
  f.git.loseCommitReply = true
  await assert.rejects(f.candidates.prepare({ ...f.request, fixedInput: original }), /commit finished/)
  f.git.committed.set(f.draft.path, Buffer.from('不同的提交内容'))
  await assert.rejects(f.create().prepare({ ...f.request, fixedInput: original }), /已提交候选与原固定输入不一致/)
  assert.equal(f.calls.commits.length, 1)
})

test('file edits after the input was persisted stop fixing before any candidate commit', async t => {
  const f = await fixture(t), original = fixedInput(await f.candidates.content(f.request))
  await saveMaterial(f.worktree, f.metadata, '外部更新的材料正文')
  await assert.rejects(f.candidates.prepare({ ...f.request, fixedInput: original }), /材料已变化/)
  assert.equal(f.calls.commits.length, 0)
})
