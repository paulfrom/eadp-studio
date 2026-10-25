import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { EntityView, MaterialMetadata, OccupationToken, ProjectState, RepairEventRequest, RepairTaskView } from '../../packages/contracts/src/index.ts'
import type { TaskView } from '../../packages/studio-plugin/src/shared/studio.ts'
import { CollaborationError, type CollaborationClient } from '../../packages/studio-plugin/src/host/adapters/collaboration/client.ts'
import type { HostPorts, ScenarioSourceRead } from '../../packages/studio-plugin/src/host/application/ports.ts'
import type { ProjectWorkspaces } from '../../packages/studio-plugin/src/host/application/projects.ts'
import { digest, materialText, readMaterial, saveMaterial } from '../../packages/studio-plugin/src/host/adapters/assets/materials.ts'
import { StudioStore } from '../../packages/studio-plugin/src/host/application/state.ts'
import { ScenarioWorkspaces } from '../../packages/studio-plugin/src/host/application/scenario-workspaces.ts'
import { ScenarioRepairs } from '../../packages/studio-plugin/src/host/application/scenario-repairs.ts'
import { ScenarioTemplates } from '../../packages/studio-plugin/src/host/application/scenario-templates.ts'
import { BackgroundLane } from '../../packages/studio-plugin/src/host/application/background-lane.ts'
import { parseWriteProposal } from '../../packages/studio-plugin/src/host/application/scenario-write-proposals.ts'

const templateBody = '## 范围\n## 规则\n', templateRef = { commitSha: 'a'.repeat(40), path: '.template/default.md', sha256: digest(templateBody) }
function metadata(): MaterialMetadata { return { entityId: 'scene', kind: 'scenario', title: '审批', templateId: 'default', templateRef, scenarioIds: [], prerequisites: [], sources: [], businessEvidence: [], coreRulesPresent: false, acceptanceCriteriaPresent: false, openQuestions: [{ blocking: true, limitation: '异常审批规则待补充', excludedScope: '异常审批' }], referencedAssets: [] } }
async function fixture(t: { after(fn: () => Promise<unknown>): unknown }) {
  const parent = await mkdtemp(path.join(tmpdir(), 'eadp-scenario-orchestration-')), root = path.join(parent, 'project'), localRoot = path.join(parent, 'local')
  await mkdir(root)
  const background: Promise<unknown>[] = []
  t.after(async () => { workspaces.dispose(); await Promise.allSettled(background); await rm(parent, { recursive: true, force: true }) })
  const store = new StudioStore(localRoot); store.useUser(1)
  const local = await store.read(); local.selectedProjectId = 'project'
  local.projects.push({ id: 'project', name: '项目', directory: root, repositoryUrl: 'https://git.example/project.git' })
  const token: OccupationToken = { occupationId: 'occupation', generation: 1, taskId: path.basename(root), clientId: local.clientId, expectedRevision: 1 }
  const task: TaskView = { entityId: 'scene', projectId: 'project', sessionId: 'original-session', purpose: 'material', inputHash: '', worktree: root }
  local.tasks.push(task)
  const entity = { id: 'scene', kind: 'scenario', generation: 1, revision: 1, title: '审批', templateId: 'default', templateRef, materialVersion: 0, occupation: { ...token, ownerId: 1, purpose: 'design' } } as unknown as EntityView
  const remote = { project: { id: 'project', revision: 1, recognizedHead: 'c'.repeat(40), stableBranch: 'main' }, entities: [entity] } as unknown as ProjectState
  const prompts: string[] = [], events: RepairEventRequest[] = [], calls: string[] = [], contexts = new Map<string, Buffer>()
  let repairView: RepairTaskView | undefined
  let repairNumber = 0
  let loseResponse: 'start' | RepairEventRequest['type'] | undefined
  let failBeforeStart = false
  const receipts = new Map<string, RepairTaskView>()
  const fail = (kind: typeof loseResponse) => { if (loseResponse === kind) { loseResponse = undefined; throw new Error('response lost') } }
  const api = { async request(method: string, route: string, body?: object) {
    calls.push(`${method} ${route}`)
    if (route.endsWith('/templates')) { const catalog = { defaultTemplateId: 'default', templates: [{ id: 'default', name: '默认', fixed: templateRef }] }; return { acceptedHead: remote.project.recognizedHead, scenarios: catalog, requirements: { templates: [] } } }
    if (route.includes('/operations/') && method === 'GET') {
      const result = receipts.get(route.split('/').at(-1)!)
      if (!result) throw new CollaborationError('OPERATION_NOT_FOUND', 'operation missing', 404)
      return { result: { ...result } }
    }
    if (route.endsWith('/repairs') && method === 'POST') {
      const input = body as { startHash: string; userActionId: string; idempotencyKey: string }
      if (failBeforeStart) { failBeforeStart = false; throw new Error('request lost') }
      if (receipts.has(input.idempotencyKey)) return { ...receipts.get(input.idempotencyKey)! }
      repairView = { id: `repair-${++repairNumber}`, entityId: entity.id, occupationId: token.occupationId, userActionId: input.userActionId, startHash: input.startHash, currentHash: input.startHash, status: 'active', roundsUsed: 0, createdBy: 1, createdAt: '2026-10-20T00:00:00Z' }
      receipts.set(input.idempotencyKey, { ...repairView }); fail('start')
      return { ...repairView }
    }
    if (route.endsWith('/events') && method === 'POST') {
      const input = body as RepairEventRequest; events.push(input)
      if (receipts.has(input.idempotencyKey)) return { ...receipts.get(input.idempotencyKey)! }
      assert.ok(repairView); assert.equal(input.expectedHash, repairView.currentHash)
      if (input.type === 'round') { repairView.roundsUsed++; repairView.currentHash = input.hashAfter; if (!input.improved) { repairView.status = 'terminated'; repairView.terminationReason = 'no-improvement' } }
      if (input.type === 'pause') repairView.status = 'paused'
      if (input.type === 'resume') repairView.status = 'active'
      if (input.type === 'terminate') { repairView.status = 'terminated'; repairView.terminationReason = input.reason }
      receipts.set(input.idempotencyKey, { ...repairView }); fail(input.type)
      return { ...repairView }
    }
    if (route.endsWith(`/repairs/${repairView?.id}`) && method === 'GET') return { ...repairView }
    throw new Error(`Unexpected request: ${method} ${route}`)
  } } as unknown as CollaborationClient
  const ports = { async account() { return { id: 1 } }, async session(value: TaskView) { return value.sessionId }, async prompt(_sessionId: string, value: string) { prompts.push(value) }, git: { async state() { return { dirty: false, head: 'c'.repeat(40), branch: 'main' } }, async readOptionalBlob(_root: string, commit: string, relative: string) { return contexts.get(`${commit}:${relative}`) } } } as unknown as HostPorts
  const read = async (_projectId: string, _commit: string, relative: string) => { assert.equal(relative, templateRef.path); return Buffer.from(templateBody) }
  const projects = { localFixed: read, readFixed: read } as unknown as ProjectWorkspaces
  const workspaces = new ScenarioWorkspaces(store, api, ports, projects, { async entity() { return { remote, entity } }, async task() { return task }, async owned() { return token }, async deliver(work) { await work() } })
  const draft = await saveMaterial(root, metadata(), '## 范围\n审批流程允许退回重试。\n## 规则\n待补充')
  const record = await workspaces.record(entity.id)
  record.sources.push({ id: 'evidence', name: '审批规定', format: 'txt', sha256: digest('业务依据'), status: 'read', ranges: ['line:1'], text: '业务依据', selected: true, formal: false })
  await store.save()
  const confirmations: string[] = []
  const repairs = new ScenarioRepairs(workspaces, async (_entityId, hash) => { confirmations.push(hash); assert.ok(repairView); repairView.status = 'completed' })
  return { root, localRoot, store, local, loseNext(kind: typeof loseResponse) { loseResponse = kind }, loseStartRequest() { failBeforeStart = true }, task, entity, remote, token, workspaces, record, draft, repairs, events, calls, prompts, confirmations, api, ports, projects, contexts, getRepair: () => repairView }
}
const reply = (value: unknown) => ({ kind: 'assistant', content: '```eadp-repair\n' + JSON.stringify(value) + '\n```' })
/** Business declarations a repair candidate restates; identity stays with the current file. */
const quality = (draft: { metadata: MaterialMetadata }, changes: Partial<Pick<MaterialMetadata, 'coreRulesPresent' | 'acceptanceCriteriaPresent' | 'openQuestions'>> = {})
  : Pick<MaterialMetadata, 'coreRulesPresent' | 'acceptanceCriteriaPresent' | 'openQuestions'> => ({ coreRulesPresent: draft.metadata.coreRulesPresent, acceptanceCriteriaPresent: draft.metadata.acceptanceCriteriaPresent, openQuestions: draft.metadata.openQuestions, ...changes })

test('opening and snapshotting an accepted scenario reads its fixed version without acquiring an occupation', async t => {
  const f = await fixture(t), fixedText = materialText(metadata(), '已确认正文')
  delete f.entity.occupation
  f.entity.current = { fixed: { commitSha: 'd'.repeat(40), path: '场景/scene.md', sha256: digest(fixedText) }, confirmedBy: 1, confirmedAt: '2026-10-20T00:00:00Z' } as NonNullable<EntityView['current']>
  f.local.projects[0]!.sync = { status: 'pending', commit: 'd'.repeat(40) }
  f.task.cleanup = { status: 'pending', steps: { resources: true, archive: false, worktree: false, branch: false, history: false } }
  const read = async (_projectId: string, _commit: string, relative: string) => Buffer.from(relative === '场景/scene.md' ? fixedText : templateBody)
  const projects = { localFixed: read, readFixed: read } as unknown as ProjectWorkspaces
  let taskCalls = 0, ownershipCalls = 0
  const workspaces = new ScenarioWorkspaces(f.store, f.api, f.ports, projects, { async entity() { return { remote: f.remote, entity: f.entity } }, async task() { taskCalls++; throw new Error('must stay read-only') }, async owned() { ownershipCalls++; throw new Error('must not claim') }, async deliver(work) { await work() } })
  await workspaces.open(f.entity.id)
  const snapshot = await workspaces.snapshot(f.remote)
  assert.equal(snapshot?.readOnly, true)
  assert.equal(snapshot?.draft.body, '已确认正文')
  assert.equal(snapshot?.settlement.status, 'sync-pending')
  f.local.projects[0]!.sync = { status: 'synced', commit: 'd'.repeat(40) }
  assert.equal((await workspaces.snapshot(f.remote))?.settlement.status, 'cleanup-pending')
  f.task.cleanup = { status: 'done', steps: { resources: true, archive: true, worktree: true, branch: true, history: true } }
  assert.equal((await workspaces.snapshot(f.remote))?.settlement.status, 'settled')
  assert.equal(taskCalls, 0); assert.equal(ownershipCalls, 0)
  assert.equal(f.calls.some(call => call.includes('/claim')), false)
})

test('repair pauses for an explicit answer, keeps its round budget and confirms only the third improved version', async t => {
  const f = await fixture(t), evidencePath = '.eadp/evidence/approved/original.txt'
  await mkdir(path.dirname(path.join(f.root, evidencePath)), { recursive: true }); await writeFile(path.join(f.root, evidencePath), '业务依据')
  const initial = { ...f.draft.metadata, businessEvidence: [{ label: '审批规定', reference: 'source:evidence', files: [{ path: evidencePath, sha256: digest('业务依据') }], ranges: [{ path: evidencePath, startLine: 1, endLine: 1 }] }] }
  let draft = await saveMaterial(f.root, initial, f.draft.body)
  await f.repairs.start({ action: 'startScenarioRepair', entityId: 'scene', expectedHash: draft.sha256, userActionId: 'authorize' })
  const sessionId = f.local.scenarioRepairs[0]!.task.sessionId
  await f.repairs.accept(sessionId, reply({ baseHash: draft.sha256, body: draft.body + '\n规则已补充', ...quality(draft, { coreRulesPresent: true }), evidenceIds: ['evidence'] }))
  assert.equal(f.prompts.length, 1, 'the next round waits until the current DSH turn ends')
  await f.repairs.accept(sessionId, { kind: 'turn-ended' })
  assert.equal(f.prompts.length, 2)
  draft = await readMaterial(f.root, 'scenario', 'scene')
  await f.repairs.accept(sessionId, reply({ baseHash: draft.sha256, body: draft.body + '\n验收已补充', ...quality(draft, { acceptanceCriteriaPresent: true }), evidenceIds: ['evidence'] }))
  await f.repairs.accept(sessionId, { kind: 'turn-ended' })
  draft = await readMaterial(f.root, 'scenario', 'scene')
  assert.equal(f.getRepair()!.roundsUsed, 2)
  await f.repairs.accept(sessionId, reply({ baseHash: draft.sha256, question: '异常审批是否允许重试？' }))
  await f.repairs.accept(sessionId, { kind: 'turn-ended' })
  assert.equal(f.getRepair()!.status, 'paused')
  const count = f.prompts.length
  await f.repairs.accept(sessionId, { kind: 'assistant', content: '普通聊天说可以重试' })
  assert.equal(f.prompts.length, count); assert.equal(f.getRepair()!.status, 'paused')
  await f.repairs.resume({ action: 'resumeScenarioRepair', entityId: 'scene', answer: '允许重试', expectedHash: draft.sha256, userActionId: 'answer-and-continue' })
  assert.equal(f.getRepair()!.roundsUsed, 2); assert.equal(f.prompts.length, count + 1)
  await f.repairs.accept(sessionId, reply({ baseHash: draft.sha256, body: draft.body + '\n异常审批可重试。', ...quality(draft, { openQuestions: [] }), evidenceIds: ['evidence'] }))
  await f.repairs.accept(sessionId, { kind: 'turn-ended' })
  assert.equal(f.getRepair()!.roundsUsed, 3); assert.equal(f.getRepair()!.status, 'completed')
  assert.equal(f.confirmations.length, 1)
  await f.repairs.accept(sessionId, reply({ baseHash: draft.sha256, question: '重新开始？' }))
  assert.equal(f.confirmations.length, 1)
})

test('external edits terminate repair and the old authorization cannot overwrite or resume', async t => {
  const f = await fixture(t)
  await f.repairs.start({ action: 'startScenarioRepair', entityId: 'scene', expectedHash: f.draft.sha256, userActionId: 'authorize' })
  const sessionId = f.local.scenarioRepairs[0]!.task.sessionId
  const external = await saveMaterial(f.root, f.draft.metadata, '用户并发修改')
  await f.repairs.accept(sessionId, reply({ baseHash: f.draft.sha256, body: 'AI不应写入', ...quality(f.draft), evidenceIds: ['evidence'] }))
  assert.equal(f.getRepair()!.status, 'terminated'); assert.equal(f.getRepair()!.terminationReason, 'concurrent-edit')
  assert.equal((await readMaterial(f.root, 'scenario', 'scene')).sha256, external.sha256)
  assert.equal(f.confirmations.length, 0)
  await assert.rejects(f.repairs.resume({ action: 'resumeScenarioRepair', entityId: 'scene', answer: '继续', expectedHash: external.sha256, userActionId: 'resume' }), /仅暂停/)
})

test('repair with no usable source terminates; an unchanged set of blockers stops after one round', async t => {
  const f = await fixture(t)
  f.record.sources[0]!.selected = false
  await f.repairs.start({ action: 'startScenarioRepair', entityId: 'scene', expectedHash: f.draft.sha256, userActionId: 'no-source' })
  assert.equal(f.getRepair()!.terminationReason, 'missing-evidence'); assert.equal(f.prompts.length, 0)
  f.record.sources[0]!.selected = true
  await f.repairs.start({ action: 'startScenarioRepair', entityId: 'scene', expectedHash: f.draft.sha256, userActionId: 'new-authorization' })
  const sessionId = f.local.scenarioRepairs.at(-1)!.task.sessionId
  await f.repairs.accept(sessionId, reply({ baseHash: f.draft.sha256, body: f.draft.body + '\n空泛描述', ...quality(f.draft), evidenceIds: ['evidence'] }))
  assert.equal(f.getRepair()!.roundsUsed, 1); assert.equal(f.getRepair()!.terminationReason, 'no-improvement')
  assert.equal(f.confirmations.length, 0)
})

test('scenario sessions use explicit whole-body write proposals after summarizing conclusions', async t => {
  const f = await fixture(t)
  const context = await f.workspaces.context(f.task)
  assert.match(context, /回答规则：先用可读中文归纳本轮明确结论/)
  assert.match(context, /eadp-write-proposal/)
  assert.match(context, /整篇新正文/)
  const example = /```eadp-write-proposal\n(\{[^\n]+\})\n```/.exec(context)?.[1]
  assert.ok(example, 'the runtime prompt supplies a complete proposal example')
  assert.match(context, /不要用 <eadp-write-proposal> 之类的标签代替围栏/)
  const response = `是否写入？\n\`\`\`eadp-write-proposal\n${example}\n\`\`\``
  const parsed = parseWriteProposal(response, f.draft, ['evidence'])
  assert.equal(parsed.conclusions[0]!.id, 'C1')
  assert.deepEqual(parsed.evidenceIds, [])
  assert.equal(await f.workspaces.accept(f.task.sessionId, '是否写入？'), false)
  assert.equal(await f.workspaces.accept(f.task.sessionId, '上一条回复末尾的 `eadp-write-proposal` 代码块即提议内容'), false, 'naming the block in prose is not an attempt')
  assert.equal(f.record.writeProposal, undefined, 'plain conversation never creates an actionable write')
  assert.equal(f.record.writeProposalError, undefined)
  assert.equal(await f.workspaces.accept(f.task.sessionId, response), true)
  assert.equal(f.record.writeProposal?.status, 'pending')
  assert.equal(f.record.writeProposal?.body, parsed.body)
  assert.equal((await readMaterial(f.root, 'scenario', 'scene')).sha256, f.draft.sha256, 'a proposal does not write the material')
})

test('a proposal closed with a matching tag still becomes an actionable card', async t => {
  const f = await fixture(t)
  await f.workspaces.context(f.task)
  const value = { entityId: f.entity.id, conclusions: [{ id: 'C1', text: '退货单只做申请' }], evidenceIds: ['evidence'], body: '## 范围\n退货单只做申请。\n## 规则\n待补充' }
  const response = `是否写入？\n<eadp-write-proposal>\n${JSON.stringify(value)}\n</eadp-write-proposal>`
  assert.equal(await f.workspaces.accept(f.task.sessionId, response), true)
  assert.equal(f.record.writeProposal?.status, 'pending')
  assert.deepEqual(f.record.writeProposal?.conclusions, [{ id: 'C1', text: '退货单只做申请' }])
})

test('the proposal, its write and its undo stay local when the collaboration service is unreachable', async t => {
  const f = await fixture(t)
  await f.workspaces.context(f.task)
  const value = { entityId: f.entity.id, conclusions: [{ id: 'C1', text: '退货单只做申请' }], evidenceIds: ['evidence'], body: '## 范围\n退货单只做申请。\n## 规则\n待补充' }
  const content = `是否写入？\n\`\`\`eadp-write-proposal\n${JSON.stringify(value)}\n\`\`\``
  f.workspaces.deps.entity = async () => { throw new Error('协同后端暂时无法访问 GitLab，请稍后重试。') }
  f.workspaces.deps.owned = async () => { throw new Error('协同后端暂时无法访问 GitLab，请稍后重试。') }
  assert.equal(await f.workspaces.accept(f.task.sessionId, content), true)
  const proposal = f.record.writeProposal!
  assert.equal(proposal.status, 'pending', 'an unreachable backend cannot discard the proposal')
  const before = await readMaterial(f.root, 'scenario', 'scene')
  await f.workspaces.resolveWriteProposal({ action: 'resolveScenarioWriteProposal', entityId: 'scene', proposalId: proposal.id, selectedChangeIds: proposal.changes.map(change => change.id), decision: 'write', expectedHash: before.sha256 })
  assert.equal((await readMaterial(f.root, 'scenario', 'scene')).body, value.body)
  await f.workspaces.undoWrite({ action: 'undoScenarioWrite', entityId: 'scene', operationId: proposal.id, expectedHash: f.record.writeReceipt!.afterHash })
  assert.equal((await readMaterial(f.root, 'scenario', 'scene')).body, before.body)
})

test('a scenario draft save writes the local file without touching the backend entity', async t => {
  const f = await fixture(t)
  const draft = await readMaterial(f.root, 'scenario', 'scene')
  f.workspaces.deps.entity = async () => { throw new Error('协同后端暂时无法访问 GitLab，请稍后重试。') }
  await f.workspaces.save({ action: 'saveScenario', entityId: 'scene', metadata: { ...draft.metadata, title: '改名后的场景' }, body: '## 范围\n改名后的正文\n## 规则\n待补充', expectedHash: draft.sha256, operationId: 'draft-save' })
  const saved = await readMaterial(f.root, 'scenario', 'scene')
  assert.equal(saved.body, '## 范围\n改名后的正文\n## 规则\n待补充')
  assert.equal(saved.metadata.title, '改名后的场景')
  assert.equal(saved.path, '场景/改名后的场景.md')
})

test('an unusable proposal reports why no button appeared, and the next request clears it', async t => {
  const f = await fixture(t)
  await f.workspaces.open(f.entity.id)
  await f.workspaces.context(f.task)
  const value = { entityId: f.entity.id, conclusions: [{ id: 'C1', text: '退货单只做申请' }], evidenceIds: ['evidence'], body: '## 范围\n退货单只做申请。\n## 规则\n待补充' }
  assert.equal(await f.workspaces.accept(f.task.sessionId, `是否写入？\n\`\`\`eadp-write-proposal\n${JSON.stringify(value)}`), true)
  assert.equal(f.record.writeProposal, undefined)
  assert.match(f.record.writeProposalError ?? '', /需要且仅允许一个/)
  assert.equal((await f.workspaces.snapshot(f.remote))?.writeProposalError, f.record.writeProposalError, 'the failure reaches the card')
  await f.workspaces.context(f.task)
  assert.equal(f.record.writeProposalError, undefined, 'a new answer replaces the previous explanation')
  assert.equal(await f.workspaces.accept(f.task.sessionId, `是否写入？\n\`\`\`eadp-write-proposal\n${JSON.stringify(value)}\n\`\`\``), true)
  assert.equal(f.record.writeProposal?.status, 'pending')
})

for (const failure of ['format', 'unread-evidence', 'expired-context'] as const) test(`a ${failure} proposal exposes its failure and replaces the old actionable card`, async t => {
  const f = await fixture(t)
  await f.workspaces.open(f.entity.id)
  await f.workspaces.context(f.task)
  const value = { entityId: f.entity.id, conclusions: [{ id: 'C1', text: '审批失败后允许重新提交' }], evidenceIds: ['evidence'], body: '审批失败后可重新提交。' }
  const response = (input: unknown) => `是否写入？\n\`\`\`eadp-write-proposal\n${JSON.stringify(input)}\n\`\`\``
  await f.workspaces.accept(f.task.sessionId, response(value))
  const previousId = f.record.writeProposal?.id
  assert.ok(previousId)
  assert.equal(f.record.writeProposal?.status, 'pending')

  const invalidValue = failure === 'format' ? { ...value, authorization: true }
    : failure === 'unread-evidence' ? { ...value, evidenceIds: ['unread-source'] } : value
  if (failure === 'expired-context') await saveMaterial(f.root, metadata(), '作者刚刚修改的正文')
  const before = await readMaterial(f.root, 'scenario', 'scene')
  assert.equal(await f.workspaces.accept(f.task.sessionId, response(invalidValue)), true)
  const snapshot = await f.workspaces.snapshot(f.remote)
  const reason = failure === 'format' ? /字段无效/ : failure === 'unread-evidence' ? /未实际读取的资料/ : /正文已变化/
  assert.match(snapshot?.writeProposalError ?? '', reason)
  assert.equal(snapshot?.writeProposal, undefined)
  assert.equal((await readMaterial(f.root, 'scenario', 'scene')).sha256, before.sha256)
  const saved = JSON.parse(await readFile(path.join(f.store.directory, 'studio-state.json'), 'utf8'))
  assert.equal(saved.scenarios[0].writeProposalError, snapshot?.writeProposalError, 'failure survives a restart')
  assert.equal(saved.scenarios[0].writeProposal, undefined)

  await f.workspaces.context(f.task)
  await f.workspaces.accept(f.task.sessionId, response(value))
  const recovered = await f.workspaces.snapshot(f.remote)
  assert.equal(recovered?.writeProposalError, undefined)
  assert.equal(recovered?.writeProposal?.status, 'pending')
  assert.notEqual(recovered?.writeProposal?.id, previousId)
})

test('an accepted context proposal writes only the project root snapshot and binds the new hash to the scenario package', async t => {
  const f = await fixture(t), head = 'c'.repeat(40), body = '新上下文：统一审批术语与边界'
  await writeFile(path.join(f.root, 'CONTEXT.md'), '旧上下文')
  f.contexts.set(`${head}:CONTEXT.md`, Buffer.from('旧上下文'))
  const content = '已整理。\n```eadp-write-proposal\n' + JSON.stringify({ entityId: 'scene', target: 'context', conclusions: [{ id: 'C1', text: '统一审批术语' }], evidenceIds: ['evidence'], body }) + '\n```'
  await f.workspaces.context(f.task)
  assert.equal(await f.workspaces.accept(f.task.sessionId, content), true)
  const proposal = f.record.writeProposal!
  assert.equal(proposal.target, 'context')
  assert.equal(proposal.baseHash, digest('旧上下文'))
  await f.workspaces.resolveWriteProposal({ action: 'resolveScenarioWriteProposal', entityId: 'scene', proposalId: proposal.id, selectedChangeIds: proposal.changes.map(change => change.id), decision: 'write', expectedHash: 'ignored-for-context' })
  assert.equal(await readFile(path.join(f.root, 'CONTEXT.md'), 'utf8'), body)
  assert.equal(f.record.writeProposal!.status, 'consumed')
  const draft = await readMaterial(f.root, 'scenario', 'scene')
  assert.equal(draft.metadata.files?.find(file => file.path === 'CONTEXT.md')?.sha256, digest(body), 'the confirmation package carries the new context hash')
})

test('a context write touches only the worktree; the accepted-version comparison belongs to confirmation', async t => {
  const f = await fixture(t), head = 'c'.repeat(40), acceptedHead = 'd'.repeat(40)
  await writeFile(path.join(f.root, 'CONTEXT.md'), '旧上下文')
  f.contexts.set(`${head}:CONTEXT.md`, Buffer.from('旧上下文'))
  f.remote.project.recognizedHead = acceptedHead
  f.contexts.set(`${acceptedHead}:CONTEXT.md`, Buffer.from('外部已接受的新上下文'))
  const content = '```eadp-write-proposal\n' + JSON.stringify({ entityId: 'scene', target: 'context', conclusions: [{ id: 'C1', text: '统一审批术语' }], evidenceIds: ['evidence'], body: '本地新上下文' }) + '\n```'
  await f.workspaces.context(f.task)
  assert.equal(await f.workspaces.accept(f.task.sessionId, content), true)
  const proposal = f.record.writeProposal!
  await f.workspaces.resolveWriteProposal({ action: 'resolveScenarioWriteProposal', entityId: 'scene', proposalId: proposal.id, selectedChangeIds: proposal.changes.map(change => change.id), decision: 'write', expectedHash: '' })
  assert.equal(await readFile(path.join(f.root, 'CONTEXT.md'), 'utf8'), '本地新上下文')
  assert.equal(f.record.writeProposal!.status, 'consumed')
})

test('a context proposal expires when the worktree file changes after the question', async t => {
  const f = await fixture(t), head = 'c'.repeat(40)
  await writeFile(path.join(f.root, 'CONTEXT.md'), '旧上下文')
  f.contexts.set(`${head}:CONTEXT.md`, Buffer.from('旧上下文'))
  const content = '```eadp-write-proposal\n' + JSON.stringify({ entityId: 'scene', target: 'context', conclusions: [{ id: 'C1', text: '统一审批术语' }], evidenceIds: ['evidence'], body: '提议正文' }) + '\n```'
  await f.workspaces.context(f.task)
  assert.equal(await f.workspaces.accept(f.task.sessionId, content), true)
  const proposal = f.record.writeProposal!
  await writeFile(path.join(f.root, 'CONTEXT.md'), '作者刚刚修改的上下文')
  await assert.rejects(f.workspaces.resolveWriteProposal({ action: 'resolveScenarioWriteProposal', entityId: 'scene', proposalId: proposal.id, selectedChangeIds: proposal.changes.map(change => change.id), decision: 'write', expectedHash: '' }), /CONTEXT\.md 已变化/)
  assert.equal(f.record.writeProposal!.status, 'pending')
  assert.match(f.record.writeProposal!.error ?? '', /CONTEXT\.md 已变化/)
})

test('template preview rejects deleting historical identities and publication stops before touching materials when the accepted head changes', async t => {
  const f = await fixture(t), lane = new BackgroundLane(), templates = new ScenarioTemplates(f.store, f.api, f.ports, f.projects, lane)
  await assert.rejects(templates.preview(f.remote, 'scenario', [{ id: 'different', name: '替代', body: '## 范围' }], 'different'), /不支持删除/)
  await templates.preview(f.remote, 'scenario', [{ id: 'default', name: '默认', body: '## 更新范围' }], 'default')
  const operation = f.local.templateOperations[0]!
  f.remote.project.recognizedHead = 'e'.repeat(40)
  // Publication queues its Git work: the reply returns at once and the stopped
  // operation is what the surfaces show and retry.
  await templates.publish(operation.preview.operationId, f.remote)
  await lane.settle()
  const recorded = (await f.store.read()).templateOperations[0]!
  assert.match(recorded.message ?? '', /项目版本已变化/)
  assert.equal(recorded.phase, 'unknown')
  assert.equal(recorded.directory, undefined)
  assert.equal(await readFile(path.join(f.root, f.draft.path), 'utf8'), materialText(f.draft.metadata, f.draft.body))
  assert.equal(f.calls.some(call => /integrations/.test(call)), false)
})

test('template publication builds outside the material worktree and rejects a candidate containing a scene', async t => {
  const f = await fixture(t)
  const manifest = { schemaVersion: 1, projectId: 'project', gitlabProjectId: 1, repositoryUrl: 'https://git.example/project.git', stableBranch: 'main', directories: ['场景', '需求', '交接', '原型代码'], scenarioTemplates: { defaultTemplateId: 'default', templates: [{ id: 'default', name: '默认', path: '.template/default.md' }] } }
  const read = async (_project: string, _sha: string, relative: string) => Buffer.from(relative === 'project.assets.json' ? JSON.stringify(manifest) : templateBody)
  const projects = { localFixed: read, readFixed: read } as unknown as ProjectWorkspaces
  const lane = new BackgroundLane(), directories: string[] = [], staged: string[][] = []
  const ports = { ...f.ports, git: {
    async fetch() {},
    async createWorktree(_projectDirectory: string, directory: string) { directories.push(directory); await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, 'project.assets.json'), JSON.stringify(manifest)) },
    async identity() { return { name: '开发者', email: 'developer@example.test' } },
    async commitFiles(_directory: string, files: string[]) { staged.push(files); return 'f'.repeat(40) },
    async changedFiles() { return ['project.assets.json', '.template/default.md', '场景/scene.md'] },
  } } as unknown as HostPorts
  const templates = new ScenarioTemplates(f.store, f.api, ports, projects, lane)
  await templates.preview(f.remote, 'scenario', [{ id: 'default', name: '默认', body: '## 更新范围' }], 'default')
  await templates.publish(f.local.templateOperations[0]!.preview.operationId, f.remote)
  await lane.settle()
  const recorded = (await f.store.read()).templateOperations[0]!
  assert.match(recorded.message ?? '', /不允许的变更/)
  assert.equal(recorded.phase, 'unknown')
  assert.equal(directories.length, 1)
  assert.equal(directories[0]!.startsWith(`${f.root}/`), false)
  assert.deepEqual(staged, [['project.assets.json', '.template/default.md']])
  assert.equal(f.calls.some(call => /integrations/.test(call)), false)
  assert.equal(await readFile(path.join(f.root, f.draft.path), 'utf8'), materialText(f.draft.metadata, f.draft.body))
})

test('source extraction returns before the reader finishes and delivers into its original project after a project switch', async t => {
  const f = await fixture(t), deliveries: Array<() => Promise<void>> = []
  let resolveReader!: (value: ScenarioSourceRead) => void, queueReady!: () => void
  const queued = new Promise<void>(resolve => { queueReady = resolve })
  f.ports.readScenarioSource = () => new Promise(resolve => { resolveReader = resolve })
  f.workspaces.deps.deliver = work => { deliveries.push(work); queueReady() }
  await f.workspaces.sources.importSource({ action: 'importScenarioSource', entityId: 'scene', operationId: 'asynchronous-source', name: '审批.txt', base64: Buffer.from('实际依据').toString('base64') })
  const source = f.record.sources.find(item => item.id === 'asynchronous-source')!
  assert.equal(source.status, 'reading'); assert.equal(deliveries.length, 0)
  f.local.selectedProjectId = 'other-project'
  resolveReader({ status: 'read', text: '实际依据', ranges: ['line:1'] })
  await queued
  assert.equal(source.status, 'reading', 'reader completion waits for the serialized delivery queue')
  await deliveries[0]!()
  assert.equal(source.status, 'read'); assert.equal(source.text, '实际依据')
  assert.equal(f.local.scenarios.some(record => record.projectId === 'other-project'), false)
})

test('deselecting formal evidence removes only its untracked archives and preserves tracked, shared and unrelated files', async t => {
  const f = await fixture(t), originalPath = path.join(f.store.directory, 'evidence-source.txt')
  await writeFile(originalPath, '业务依据'); f.record.sourcePaths.evidence = originalPath
  let trackedPath: string | undefined
  f.ports.gitLocal = async (args, cwd) => { assert.deepEqual(args.slice(0, 3), ['ls-files', '-z', '--']); assert.equal(cwd, f.root); return trackedPath ? `${trackedPath}\0` : '' }
  await f.workspaces.sources.selectSource({ action: 'selectScenarioSource', entityId: 'scene', sourceId: 'evidence', selected: true, formal: true })
  const archived = (await readMaterial(f.root, 'scenario', 'scene')).metadata.businessEvidence[0]!.files
  assert.equal(archived.length, 3)
  const sharedFile = archived.find(file => file.path.endsWith('.txt') && file.path.includes('extracted-'))!
  trackedPath = archived.find(file => file.path.endsWith('/original.txt'))!.path
  const otherEntity = { ...f.entity, id: 'other-scene' }
  f.remote.entities.push(otherEntity)
  f.local.tasks.push({ ...f.task, entityId: otherEntity.id, sessionId: 'other-session' })
  await saveMaterial(f.root, { ...metadata(), entityId: otherEntity.id, files: [sharedFile] }, '另一场景仍引用此依据文件')
  f.workspaces.deps.entity = async id => ({ remote: f.remote, entity: f.remote.entities.find(entity => entity.id === id) as EntityView })
  const unrelated = path.join(path.dirname(path.join(f.root, trackedPath)), 'user-owned.txt')
  await writeFile(unrelated, '不是Host创建的文件')
  await f.workspaces.sources.selectSource({ action: 'selectScenarioSource', entityId: 'scene', sourceId: 'evidence', selected: false, formal: false })
  assert.deepEqual((await readMaterial(f.root, 'scenario', 'scene')).metadata.businessEvidence, [])
  assert.equal(await readFile(path.join(f.root, trackedPath), 'utf8'), '业务依据')
  assert.equal(await readFile(path.join(f.root, sharedFile.path), 'utf8'), '业务依据')
  assert.equal(await readFile(unrelated, 'utf8'), '不是Host创建的文件')
  const removed = archived.find(file => file.path.endsWith('.json'))!
  await assert.rejects(readFile(path.join(f.root, removed.path)), { code: 'ENOENT' })
  assert.deepEqual(new Set(f.record.localEvidencePaths), new Set([trackedPath, sharedFile.path]))
  await saveMaterial(f.root, { ...metadata(), entityId: otherEntity.id }, '另一场景已不再引用')
  await f.workspaces.sources.pruneEvidence(f.task)
  await assert.rejects(readFile(path.join(f.root, sharedFile.path)), { code: 'ENOENT' })
  assert.deepEqual(f.record.localEvidencePaths, [trackedPath])
})

test('a lost round response recovers the same event and starts the remaining round after native turn end', async t => {
  const f = await fixture(t)
  await f.repairs.start({ action: 'startScenarioRepair', entityId: 'scene', expectedHash: f.draft.sha256, userActionId: 'authorize' })
  const repair = f.local.scenarioRepairs[0]!, sessionId = repair.task.sessionId
  f.loseNext('round')
  await f.repairs.accept(sessionId, reply({ baseHash: f.draft.sha256, body: f.draft.body + '\n规则已补齐', ...quality(f.draft, { coreRulesPresent: true }), evidenceIds: ['evidence'] }))
  const written = await readMaterial(f.root, 'scenario', 'scene'), key = repair.pending!.idempotencyKey
  assert.equal(f.getRepair()!.roundsUsed, 1); assert.equal(f.prompts.length, 1)
  await assert.rejects(f.repairs.start({ action: 'startScenarioRepair', entityId: 'scene', expectedHash: written.sha256, userActionId: 'new-action' }), /待核对/)
  await f.repairs.accept(sessionId, { kind: 'turn-ended' })
  assert.equal(f.getRepair()!.roundsUsed, 1); assert.equal(f.prompts.length, 2)
  assert.equal(repair.waiting, true, 'the old turn end cannot clear the new request')
  assert.equal(repair.pending, undefined); assert.equal(repair.recoverPending, undefined)
  assert.equal(f.events[0]!.idempotencyKey, key); assert.equal(f.events[1]!.idempotencyKey, key)
  assert.equal((await readMaterial(f.root, 'scenario', 'scene')).sha256, written.sha256, 'recovery does not rewrite the candidate')
})

test('a lost passing round response recovers confirmation once using the final file and gates', async t => {
  const f = await fixture(t), evidencePath = '.eadp/evidence/approved/original.txt'
  await mkdir(path.dirname(path.join(f.root, evidencePath)), { recursive: true }); await writeFile(path.join(f.root, evidencePath), '业务依据')
  const draft = await saveMaterial(f.root, { ...f.draft.metadata, businessEvidence: [{ label: '审批规定', reference: 'source:evidence', files: [{ path: evidencePath, sha256: digest('业务依据') }], ranges: [{ path: evidencePath, startLine: 1, endLine: 1 }] }] }, f.draft.body)
  await f.repairs.start({ action: 'startScenarioRepair', entityId: 'scene', expectedHash: draft.sha256, userActionId: 'authorize' })
  const repair = f.local.scenarioRepairs[0]!
  f.loseNext('round')
  await f.repairs.accept(repair.task.sessionId, reply({ baseHash: draft.sha256, body: '## 范围\n审批流程允许退回重试。\n## 规则\n异常审批可重试。', ...quality(draft, { coreRulesPresent: true, acceptanceCriteriaPresent: true, openQuestions: [] }), evidenceIds: ['evidence'] }))
  assert.equal(f.confirmations.length, 0)
  await f.repairs.checkConcurrent('scene')
  assert.equal(f.getRepair()!.roundsUsed, 1); assert.equal(f.getRepair()!.status, 'completed')
  assert.equal(f.confirmations.length, 1); assert.equal(f.prompts.length, 1)
  await f.repairs.checkConcurrent('scene')
  assert.equal(f.confirmations.length, 1)
})

test('a lost resume response preserves the explicit business answer across persisted recovery', async t => {
  const f = await fixture(t)
  await f.repairs.start({ action: 'startScenarioRepair', entityId: 'scene', expectedHash: f.draft.sha256, userActionId: 'authorize' })
  const repair = f.local.scenarioRepairs[0]!, sessionId = repair.task.sessionId
  await f.repairs.accept(sessionId, reply({ baseHash: f.draft.sha256, question: '失败后是否允许重试？' }))
  f.loseNext('resume')
  await assert.rejects(f.repairs.resume({ action: 'resumeScenarioRepair', entityId: 'scene', expectedHash: f.draft.sha256, answer: '允许重试三次', userActionId: 'resume-action' }), /response lost/)
  const persisted = JSON.parse(await readFile(path.join(f.store.directory, 'studio-state.json'), 'utf8'))
  assert.equal(persisted.scenarioRepairs[0].pendingAnswer, '允许重试三次')
  const restartedStore = new StudioStore(f.localRoot); restartedStore.useUser(1)
  const restarted = new ScenarioWorkspaces(restartedStore, f.api, f.ports, f.projects, f.workspaces.deps)
  t.after(async () => { restarted.dispose() })
  const repairs = new ScenarioRepairs(restarted, async () => { throw new Error('must not confirm a question') })
  await repairs.checkConcurrent('scene')
  assert.equal(f.prompts.length, 1, 'resume waits for the original native turn to end')
  await repairs.accept(sessionId, { kind: 'turn-ended' })
  assert.equal(f.prompts.length, 2); assert.match(f.prompts[1]!, /本次业务补答：允许重试三次/)
  assert.equal(f.getRepair()!.roundsUsed, 0)
  assert.equal((await restartedStore.read()).scenarioRepairs[0]!.waiting, true)
})

test('lost start responses resolve the original operation without duplicate authorization or prompts', async t => {
  const f = await fixture(t)
  f.loseNext('start')
  await assert.rejects(f.repairs.start({ action: 'startScenarioRepair', entityId: 'scene', expectedHash: f.draft.sha256, userActionId: 'authorize' }), /response lost/)
  assert.equal(f.record.repairAuthorization!.status, 'pending'); assert.equal(f.prompts.length, 0)
  const original = structuredClone(f.record.repairAuthorization!.request)
  await assert.rejects(f.repairs.start({ action: 'startScenarioRepair', entityId: 'scene', expectedHash: f.draft.sha256, userActionId: 'different-action' }), /授权结果待核对/)
  await f.repairs.retryStart('scene')
  assert.equal(f.record.repairAuthorization!.status, 'accepted'); assert.equal(f.prompts.length, 1)
  assert.equal(f.calls.filter(call => call.endsWith('/entities/scene/repairs')).length, 1)
  assert.ok(f.calls.includes('GET /v1/projects/project/operations/authorize'))
  await f.repairs.retryStart('scene')
  assert.equal(f.prompts.length, 1); assert.equal(f.local.scenarioRepairs.length, 1)
  assert.deepEqual(f.record.repairAuthorization!.request, original)
})

test('start retries only a missing operation with the original body and terminates if material changed', async t => {
  const f = await fixture(t)
  f.loseStartRequest()
  await assert.rejects(f.repairs.start({ action: 'startScenarioRepair', entityId: 'scene', expectedHash: f.draft.sha256, userActionId: 'authorize' }), /request lost/)
  const request = structuredClone(f.record.repairAuthorization!.request)
  const external = await saveMaterial(f.root, f.draft.metadata, '授权结果未知期间的人工修改')
  await f.repairs.retryStart('scene')
  assert.deepEqual(f.record.repairAuthorization!.request, request)
  assert.equal(f.calls.filter(call => call.endsWith('/entities/scene/repairs')).length, 2)
  assert.equal(f.getRepair()!.terminationReason, 'concurrent-edit'); assert.equal(f.prompts.length, 0)
  assert.equal((await readMaterial(f.root, 'scenario', 'scene')).sha256, external.sha256)
})

test('native abort cancels a repair with an unresolved round without confirming or requesting another round', async t => {
  const f = await fixture(t)
  await f.repairs.start({ action: 'startScenarioRepair', entityId: 'scene', expectedHash: f.draft.sha256, userActionId: 'authorize' })
  const repair = f.local.scenarioRepairs[0]!
  f.loseNext('round')
  await f.repairs.accept(repair.task.sessionId, reply({ baseHash: f.draft.sha256, body: f.draft.body + '\n规则已补齐', ...quality(f.draft, { coreRulesPresent: true }), evidenceIds: ['evidence'] }))
  await f.repairs.accept(repair.task.sessionId, { kind: 'turn-ended', reason: 'aborted' })
  assert.equal(f.getRepair()!.terminationReason, 'cancelled'); assert.equal(f.getRepair()!.roundsUsed, 1)
  assert.equal(f.prompts.length, 1); assert.equal(f.confirmations.length, 0)
})

test('replayed DSH assistant and turn-end sequences cannot alter the current repair round', async t => {
  const f = await fixture(t)
  await f.repairs.start({ action: 'startScenarioRepair', entityId: 'scene', expectedHash: f.draft.sha256, userActionId: 'authorize' })
  const repair = f.local.scenarioRepairs[0]!, firstReply = { ...reply({ baseHash: f.draft.sha256, body: f.draft.body + '\n规则已补齐', ...quality(f.draft, { coreRulesPresent: true }), evidenceIds: ['evidence'] }), seq: 10 }
  await f.repairs.accept(repair.task.sessionId, firstReply)
  await f.repairs.accept(repair.task.sessionId, { kind: 'turn-ended', seq: 11 })
  const draft = await readMaterial(f.root, 'scenario', 'scene')
  assert.equal(repair.waiting, true); assert.equal(f.prompts.length, 2)
  await f.repairs.accept(repair.task.sessionId, firstReply)
  await f.repairs.accept(repair.task.sessionId, { kind: 'turn-ended', seq: 11 })
  assert.equal(repair.waiting, true); assert.equal(f.getRepair()!.status, 'active')
  assert.equal(f.getRepair()!.roundsUsed, 1); assert.equal(f.prompts.length, 2)
  assert.equal((await readMaterial(f.root, 'scenario', 'scene')).sha256, draft.sha256)
  const persisted = JSON.parse(await readFile(path.join(f.store.directory, 'studio-state.json'), 'utf8'))
  assert.equal(persisted.scenarioRepairs[0].lastHandledSeq, 11)
})

test('an earlier revision conversation receives current occupied material rather than its historical worktree body', async t => {
  const f = await fixture(t), historicalRoot = path.join(path.dirname(f.root), 'historical')
  await mkdir(historicalRoot)
  await saveMaterial(historicalRoot, f.draft.metadata, '旧修订独有正文，不得作为当前上下文')
  const historicalTask = { ...f.task, sessionId: 'historical-session', worktree: historicalRoot }
  f.local.tasks.push(historicalTask); await f.store.save()
  assert.equal(await f.workspaces.selectSession('scene', historicalTask.sessionId), historicalTask.sessionId)
  const context = await f.workspaces.context(historicalTask)
  assert.ok(context.includes(f.draft.body)); assert.ok(context.includes(path.join(f.root, f.draft.path)))
  assert.equal(context.includes('旧修订独有正文'), false)
  assert.equal(historicalTask.worktree, historicalRoot, 'native session cwd remains bound to its original session')
  f.workspaces.deps.owned = async () => { throw new Error('occupation revoked') }
  await assert.rejects(f.workspaces.context(historicalTask), /occupation revoked/)
})
