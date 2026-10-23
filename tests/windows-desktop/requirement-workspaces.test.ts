import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { BindTemplateRequest, EntityView, MaterialMetadata, OccupationToken, ProjectState } from '../../packages/contracts/src/index.ts'
import type { TaskView } from '../../packages/studio-plugin/src/shared/studio.ts'
import { CollaborationError, type CollaborationClient } from '../../packages/studio-plugin/src/host/adapters/collaboration/client.ts'
import { digest, readMaterial, saveMaterial } from '../../packages/studio-plugin/src/host/adapters/assets/materials.ts'
import type { HostPorts } from '../../packages/studio-plugin/src/host/application/ports.ts'
import type { ProjectWorkspaces } from '../../packages/studio-plugin/src/host/application/projects.ts'
import { StudioStore } from '../../packages/studio-plugin/src/host/application/state.ts'
import { ScenarioWorkspaces } from '../../packages/studio-plugin/src/host/application/scenario-workspaces.ts'

const templateBody = '## 目标\n\n## 业务规则\n\n## 验收条件\n'
const templateRef = { commitSha: 'a'.repeat(40), path: '.template/default-requirement.md', sha256: digest(templateBody) }
const metadata = (): MaterialMetadata => ({ entityId: 'requirement', kind: 'requirement', title: '审批需求', templateId: 'default-requirement', templateRef, scenarioIds: ['scene'], sources: [{ projectId: 'project', entityId: 'scene', version: 1 }], prerequisites: [], businessEvidence: [], openQuestions: [], coreRulesPresent: false, acceptanceCriteriaPresent: false, referencedAssets: [] })

async function fixture(t: { after(work: () => Promise<unknown>): unknown }) {
  const parent = await mkdtemp(path.join(tmpdir(), 'eadp-requirement-workspaces-')), root = path.join(parent, 'project')
  await mkdir(root)
  const store = new StudioStore(path.join(parent, 'local')); store.useUser(1)
  const local = await store.read(); local.selectedProjectId = 'project'
  local.projects.push({ id: 'project', name: '项目', directory: root, repositoryUrl: 'https://git.test/project.git' })
  const token: OccupationToken = { occupationId: 'occupation', generation: 1, clientId: local.clientId, taskId: path.basename(root), expectedRevision: 1 }
  const entity = { id: 'requirement', kind: 'requirement', generation: 1, revision: 1, title: '审批需求', scenarioIds: ['scene'], scenarioSources: [{ projectId: 'project', entityId: 'scene', version: 1 }], prerequisites: [], templateId: 'default-requirement', templateRef, materialVersion: 0, occupation: { ...token, ownerId: 1, purpose: 'design' } } as unknown as EntityView
  const task: TaskView = { entityId: entity.id, projectId: 'project', sessionId: 'original-session', purpose: 'material', inputHash: '', worktree: root }
  local.tasks.push(task)
  const remote = { project: { id: 'project', recognizedHead: 'c'.repeat(40), revision: 1 }, entities: [entity] } as unknown as ProjectState
  const nextTemplateBody = '## 专用规则\n', nextTemplateRef = { ...templateRef, path: '.template/special-requirement.md', sha256: digest(nextTemplateBody) }
  const sessionRules: string[] = [], templates = new Map([[templateRef.path, Buffer.from(templateBody)], [nextTemplateRef.path, Buffer.from(nextTemplateBody)]])
  const ports = { account: async () => ({ id: 1 }), session: async (value: TaskView, rules: string) => { sessionRules.push(rules); return value.sessionId }, git: { state: async () => ({ dirty: false, branch: 'main', head: 'c'.repeat(40) }) } } as unknown as HostPorts
  const projects = { readFixed: async (_project: string, _commit: string, relative: string) => templates.get(relative), localFixed: async (_project: string, _commit: string, relative: string) => templates.get(relative) } as unknown as ProjectWorkspaces
  const bindRequests: BindTemplateRequest[] = [], operations = new Map<string, { action: string; result: EntityView }>()
  let loseBindResponse = false, onBind: (() => Promise<void>) | undefined
  const api = { request: async (method: string, route: string, input?: BindTemplateRequest) => {
    if (method === 'GET' && route.endsWith('/templates')) return { acceptedHead: remote.project.recognizedHead, scenarios: { templates: [] }, requirements: { defaultTemplateId: 'default-requirement', templates: [{ id: 'default-requirement', name: '默认需求', fixed: templateRef }, { id: 'special-requirement', name: '专用需求', fixed: nextTemplateRef }] } }
    if (method === 'GET' && route.includes('/operations/')) { const operation = operations.get(route.split('/').at(-1)!); if (!operation) throw new CollaborationError('OPERATION_NOT_FOUND', 'missing', 404); return structuredClone(operation) }
    if (method === 'PUT' && route.endsWith('/template')) {
      assert.ok(input)
      assert.equal(input.token.expectedRevision, entity.revision)
      bindRequests.push(structuredClone(input))
      entity.templateId = input.templateId; entity.templateRef = { ...input.templateRef }; entity.revision++
      entity.occupation!.expectedRevision = entity.revision
      const operation = { action: `scenario.template:${entity.id}`, result: structuredClone(entity) }
      operations.set(input.idempotencyKey, operation)
      if (onBind) { const work = onBind; onBind = undefined; await work() }
      if (loseBindResponse) { loseBindResponse = false; throw new Error('template response lost') }
      return structuredClone(operation.result)
    }
    return entity
  } } as unknown as CollaborationClient
  const workspaces = new ScenarioWorkspaces(store, api, ports, projects, {
    entity: async () => ({ entity, remote }), task: async () => task,
    owned: async value => { if (!value.occupation) throw new Error('occupation missing'); return { ...value.occupation, expectedRevision: value.revision } },
    deliver: async work => { await work() },
  })
  t.after(async () => { workspaces.dispose(); await rm(parent, { recursive: true, force: true }) })
  const draft = await saveMaterial(root, metadata(), '')
  const record = await workspaces.record(entity.id)
  record.sources.push({ id: 'read-source', name: '审批规则', format: 'txt', sha256: digest('仅审批人可以同意'), status: 'read', ranges: ['line:1'], text: '仅审批人可以同意', selected: true, formal: false })
  await store.save()
  const response = (body = '审批人可以同意申请。', conclusion = '审批权限已明确') => '是否把本轮结论写入《审批需求》？\n```eadp-write-proposal\n' + JSON.stringify({ entityId: entity.id, conclusions: [{ id: 'C1', text: conclusion }], evidenceIds: ['read-source'], body }) + '\n```'
  const propose = async () => { await workspaces.context(task); await workspaces.accept(task.sessionId, response()); assert.ok(record.writeProposal); return record.writeProposal }
  return { root, store, local, task, entity, token, remote, draft, record, workspaces, sessionRules, templates, response, propose, bindRequests, api, ports, projects, nextTemplateRef, loseNextBindResponse() { loseBindResponse = true }, duringBind(work: () => Promise<void>) { onBind = work } }
}

test('requirement conversations read their fixed template, current body and actual evidence; new sessions get fresh identities', async t => {
  const f = await fixture(t)
  const context = await f.workspaces.context(f.task)
  assert.match(context, /当前需求 requirement/)
  assert.ok(context.includes(templateBody))
  assert.ok(context.includes('仅审批人可以同意'))
  assert.match(context, /eadp-write-proposal/)
  assert.equal(f.record.requestContexts?.[f.task.sessionId]?.draftHash, f.draft.sha256)
  const sessionId = await f.workspaces.newSession(f.entity.id)
  assert.notEqual(sessionId, f.task.sessionId)
  assert.match(f.sessionRules[0]!, /需求设计助手/)
  assert.equal(f.record.activeSessionId, sessionId)
  const changed = await saveMaterial(f.root, f.draft.metadata, '用户刚补充的当前正文')
  const nextTask = f.local.tasks.find(value => value.sessionId === sessionId)!
  assert.ok((await f.workspaces.context(nextTask)).includes(changed.body))
})

test('only an explicit write decision consumes a requirement proposal, and a repeated answer writes once', async t => {
  const f = await fixture(t), proposal = await f.propose()
  assert.equal((await readMaterial(f.root, 'requirement', f.entity.id)).body, '')
  await f.workspaces.accept(f.task.sessionId, '好的')
  assert.equal((await readMaterial(f.root, 'requirement', f.entity.id)).body, '')
  const command = { action: 'resolveRequirementWriteProposal' as const, entityId: f.entity.id, proposalId: proposal.id, decision: 'write' as const, expectedHash: f.draft.sha256 }
  await f.workspaces.resolveWriteProposal(command)
  const written = await readMaterial(f.root, 'requirement', f.entity.id)
  assert.equal(written.body, '审批人可以同意申请。')
  assert.equal(proposal.status, 'consumed')
  await f.workspaces.resolveWriteProposal(command)
  assert.equal((await readMaterial(f.root, 'requirement', f.entity.id)).sha256, written.sha256)
})

test('rejecting a requirement proposal preserves the body and prevents the same conclusion returning under a new model ID', async t => {
  const f = await fixture(t), proposal = await f.propose()
  const command = { action: 'resolveRequirementWriteProposal' as const, entityId: f.entity.id, proposalId: proposal.id, decision: 'reject' as const, expectedHash: f.draft.sha256 }
  await f.workspaces.resolveWriteProposal(command)
  await f.workspaces.resolveWriteProposal(command)
  assert.equal(proposal.status, 'rejected')
  await f.workspaces.context(f.task)
  await f.workspaces.accept(f.task.sessionId, f.response().replace('"C1"', '"C9"'))
  assert.equal(f.record.writeProposal?.id, proposal.id)
  assert.equal((await readMaterial(f.root, 'requirement', f.entity.id)).body, '')
})

test('undoing a requirement whole-body write uses a distinct receipt and repeated undo does not write twice', async t => {
  const f = await fixture(t), proposal = await f.propose()
  await f.workspaces.resolveWriteProposal({ action: 'resolveRequirementWriteProposal', entityId: f.entity.id, proposalId: proposal.id, decision: 'write', expectedHash: f.draft.sha256 })
  const written = await readMaterial(f.root, 'requirement', f.entity.id)
  const command = { action: 'undoRequirementWrite' as const, entityId: f.entity.id, operationId: proposal.id, expectedHash: written.sha256 }
  await f.workspaces.undoWrite(command)
  await f.workspaces.undoWrite(command)
  assert.equal((await readMaterial(f.root, 'requirement', f.entity.id)).body, f.draft.body)
  assert.equal(f.record.writeReceipt?.undone, true)
})

test('a late requirement answer cannot become a proposal against a newer body or an unprepared session', async t => {
  const f = await fixture(t)
  await f.workspaces.accept(f.task.sessionId, f.response())
  assert.equal(f.record.writeProposal, undefined, 'no material request context was supplied to this session')
  await f.workspaces.context(f.task)
  await saveMaterial(f.root, f.draft.metadata, '用户在模型运行时修改正文')
  await f.workspaces.accept(f.task.sessionId, f.response())
  assert.equal(f.record.writeProposal, undefined, 'the answer was generated against older material bytes')
})

for (const change of ['body', 'evidence', 'context', 'occupation'] as const) test(`a requirement proposal expires after its ${change} input changes`, async t => {
  const f = await fixture(t), proposal = await f.propose()
  if (change === 'body') await saveMaterial(f.root, f.draft.metadata, '用户修改')
  if (change === 'evidence') f.record.sources[0]!.selected = false
  if (change === 'context') await writeFile(path.join(f.root, 'CONTEXT.md'), '新的项目上下文')
  if (change === 'occupation') f.entity.occupation = { ...f.entity.occupation!, occupationId: 'another-occupation', generation: 2 }
  const current = await readMaterial(f.root, 'requirement', f.entity.id)
  await assert.rejects(f.workspaces.resolveWriteProposal({ action: 'resolveRequirementWriteProposal', entityId: f.entity.id, proposalId: proposal.id, decision: 'write', expectedHash: current.sha256 }), /已变化|已作废/)
  assert.equal((await readMaterial(f.root, 'requirement', f.entity.id)).body, current.body)
})

test('switching a requirement template preserves the body and invalidates its earlier proposal', async t => {
  const f = await fixture(t), proposal = await f.propose(), nextBody = '## 专用规则\n', nextRef = { ...templateRef, path: '.template/special-requirement.md', sha256: digest(nextBody) }
  await assert.rejects(f.workspaces.documents.save({ root: f.root, metadata: { ...f.draft.metadata, templateId: 'special-requirement', templateRef: nextRef }, body: f.draft.body, expectedHash: f.draft.sha256, operationId: 'implicit-template' }), /不能隐式更换/)
  const bound = await f.workspaces.documents.bindTemplate({ root: f.root, kind: 'requirement', entityId: f.entity.id, templateId: 'special-requirement', templateRef: nextRef, expectedHash: f.draft.sha256, operationId: 'explicit-template' })
  assert.equal(bound.body, f.draft.body)
  f.entity.templateId = 'special-requirement'; f.entity.templateRef = nextRef; f.templates.set(nextRef.path, Buffer.from(nextBody))
  await assert.rejects(f.workspaces.resolveWriteProposal({ action: 'resolveRequirementWriteProposal', entityId: f.entity.id, proposalId: proposal.id, decision: 'write', expectedHash: bound.sha256 }), /正文已变化|模板已变化/)
  assert.ok((await f.workspaces.context(f.task)).includes(nextBody))
})

test('a local requirement template reference cannot override the binding accepted by the backend', async t => {
  const f = await fixture(t), proposal = await f.propose()
  f.entity.templateId = 'another-template'
  f.entity.templateRef = { ...templateRef, path: '.template/another-template.md' }
  await assert.rejects(f.workspaces.context(f.task), /模板绑定与后台不一致/)
  await assert.rejects(f.workspaces.resolveWriteProposal({ action: 'resolveRequirementWriteProposal', entityId: f.entity.id, proposalId: proposal.id, decision: 'write', expectedHash: f.draft.sha256 }), /模板绑定与后台不一致/)
  assert.equal((await readMaterial(f.root, 'requirement', f.entity.id)).body, f.draft.body)
})

test('an explicit requirement template switch preserves its body, clears old proposals and replays the same operation', async t => {
  const f = await fixture(t)
  await f.propose()
  await f.workspaces.bindTemplate(f.entity.id, 'special-requirement', f.draft.sha256, 'bind-once')
  const draft = await readMaterial(f.root, 'requirement', f.entity.id)
  assert.equal(draft.body, f.draft.body)
  assert.equal(draft.metadata.kind === 'requirement' && draft.metadata.templateId, 'special-requirement')
  assert.equal(f.record.templateBinding?.status, 'applied')
  assert.equal(f.record.templateBinding?.backendAccepted, true)
  assert.equal(f.record.writeProposal, undefined)
  assert.equal(f.record.requestContexts, undefined)
  await f.workspaces.bindTemplate(f.entity.id, 'special-requirement', f.draft.sha256, 'bind-once')
  assert.equal(f.bindRequests.length, 1)
  await assert.rejects(f.workspaces.bindTemplate(f.entity.id, 'special-requirement', draft.sha256, 'bind-once'), /同一模板绑定操作不能用于不同输入/)
})

test('a lost template binding response is reconciled from the original operation after the Host store restarts', async t => {
  const f = await fixture(t)
  f.loseNextBindResponse()
  await assert.rejects(f.workspaces.bindTemplate(f.entity.id, 'special-requirement', f.draft.sha256, 'bind-lost'), /response lost/)
  assert.equal(f.record.templateBinding?.status, 'pending')
  const nextStore = new StudioStore(path.dirname(path.dirname(f.store.directory))); nextStore.useUser(1)
  const next = new ScenarioWorkspaces(nextStore, f.api, f.ports, f.projects, f.workspaces.deps)
  try {
    await next.retryTemplateBinding(f.entity.id)
    assert.equal((await next.record(f.entity.id)).templateBinding?.status, 'applied')
    assert.equal(f.bindRequests.length, 1)
    assert.equal((await readMaterial(f.root, 'requirement', f.entity.id)).body, f.draft.body)
  } finally { next.dispose() }
})

test('a binding accepted before local edits stays pending until a fresh user operation explicitly preserves those edits', async t => {
  const f = await fixture(t)
  f.loseNextBindResponse()
  f.duringBind(async () => { await saveMaterial(f.root, f.draft.metadata, '请求期间的用户修改') })
  await assert.rejects(f.workspaces.bindTemplate(f.entity.id, 'special-requirement', f.draft.sha256, 'bind-concurrent'), /response lost/)
  await assert.rejects(f.workspaces.retryTemplateBinding(f.entity.id), /外部修改/)
  assert.equal(f.record.templateBinding?.backendAccepted, true)
  assert.equal(f.record.templateBinding?.status, 'pending')
  const changed = await readMaterial(f.root, 'requirement', f.entity.id)
  assert.equal(changed.body, '请求期间的用户修改')
  await assert.rejects(f.workspaces.bindTemplate(f.entity.id, 'special-requirement', changed.sha256, 'bind-concurrent'), /同一模板绑定操作不能用于不同输入/)
  await f.workspaces.bindTemplate(f.entity.id, 'special-requirement', changed.sha256, 'bind-read-current')
  const applied = await readMaterial(f.root, 'requirement', f.entity.id)
  assert.equal(applied.body, changed.body)
  assert.equal(applied.metadata.kind === 'requirement' && applied.metadata.templateId, 'special-requirement')
  assert.equal(f.record.templateBinding?.expectedHash, f.draft.sha256, 'the original input remains immutable')
  assert.equal(f.record.templateBinding?.application?.expectedHash, changed.sha256)
  assert.equal(f.bindRequests.length, 1, 'recovery never rebinds the backend')
})

test('requirement saves preserve conflicting external and unsaved input and accept an explicit resolution at the current hash', async t => {
  const f = await fixture(t), external = await saveMaterial(f.root, f.draft.metadata, '外部修改')
  await f.workspaces.save({ action: 'saveRequirement', entityId: f.entity.id, metadata: f.draft.metadata, body: '未保存的用户输入', expectedHash: f.draft.sha256, operationId: 'losing-save' })
  assert.equal((await readMaterial(f.root, 'requirement', f.entity.id)).body, '外部修改')
  assert.equal(f.record.conflict?.localBody, '未保存的用户输入')
  assert.equal(f.record.conflict?.actual.sha256, external.sha256)
  await f.workspaces.save({ action: 'resolveRequirementConflict', entityId: f.entity.id, metadata: external.metadata, body: '用户合并两份内容', expectedHash: external.sha256, operationId: 'resolve-conflict' })
  assert.equal((await readMaterial(f.root, 'requirement', f.entity.id)).body, '用户合并两份内容')
  assert.equal(f.record.conflict, undefined)
})

test('an accepted requirement context write records the same project file hash on its material package', async t => {
  const f = await fixture(t), body = '新的业务术语'
  const contextHead = 'c'.repeat(40)
  f.workspaces.ports.git.readOptionalBlob = async (_root, commit, relative) => { assert.equal(commit, contextHead); assert.equal(relative, 'CONTEXT.md'); return undefined }
  await f.workspaces.context(f.task)
  const content = '```eadp-write-proposal\n' + JSON.stringify({ entityId: f.entity.id, target: 'context', conclusions: [{ id: 'C2', text: '术语已明确' }], evidenceIds: ['read-source'], body }) + '\n```'
  await f.workspaces.accept(f.task.sessionId, content)
  const proposal = f.record.writeProposal!
  await f.workspaces.resolveWriteProposal({ action: 'resolveRequirementWriteProposal', entityId: f.entity.id, proposalId: proposal.id, decision: 'write', expectedHash: f.draft.sha256 })
  assert.equal(await readFile(path.join(f.root, 'CONTEXT.md'), 'utf8'), body)
  const draft = await readMaterial(f.root, 'requirement', f.entity.id)
  assert.equal(draft.body, '')
  assert.equal(draft.metadata.files?.find(value => value.path === 'CONTEXT.md')?.sha256, digest(body))
})
