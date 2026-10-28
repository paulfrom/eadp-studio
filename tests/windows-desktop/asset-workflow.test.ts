import assert from 'node:assert/strict'
import { cp, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createRequire, registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { OccupationTokenSchema } from '../../packages/contracts/src/index.ts'
import type { EntityView, FixedVersion, MaterialMetadata, PrepareIntegrationRequest, ProjectState } from '@eadp/contracts'
import { StudioApplication } from '../../packages/studio-plugin/src/host/application/studio.ts'
import { StudioStore } from '../../packages/studio-plugin/src/host/application/state.ts'
import { initialMetadata, type HostPorts, type MergeConflictInput } from '../../packages/studio-plugin/src/host/application/ports.ts'
import { CollaborationError, CollaborationClient } from '../../packages/studio-plugin/src/host/adapters/collaboration/client.ts'
import { registerRoutes } from '../../apps/collaboration-api/src/routes.ts'
import { loadConfig } from '../../apps/collaboration-api/src/config.ts'
import { digest, materialText, readMaterial, saveMaterial } from '../../packages/studio-plugin/src/host/adapters/assets/materials.ts'
import { archiveSelectedEvidence } from '../../packages/studio-plugin/src/host/application/scenario-evidence.ts'
import { validateIntegration } from '../../apps/collaboration-api/src/modules/integration.ts'

async function actualMerge(output: (input: MergeConflictInput) => string) {
  const nativeRequire = createRequire(path.resolve(import.meta.dirname, '../../.local/build/dsh/packages/preset/agent-preset-registry/package.json'))
  const llmUrl = pathToFileURL(nativeRequire.resolve('@deepseek-ai/dsh-llm')).href
  const hook = registerHooks({ resolve(specifier, context, next) { return specifier === '@deepseek-ai/dsh-llm' ? { url: llmUrl, shortCircuit: true } : next(specifier, context) } })
  const { mergeRemoteConflict } = await import('../../packages/studio-plugin/src/host/adapters/dsh/merge.ts').finally(() => hook.deregister())
  const inputs: MergeConflictInput[] = []
  const context = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
    llm: { prepareCall: async () => ({ config: {}, stream: () => (async function* () {
      const text = output(inputs.at(-1)!)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })() }) },
  }
  return { inputs, mergeConflict: async (input: MergeConflictInput, signal: AbortSignal) => {
    inputs.push(structuredClone(input))
    return mergeRemoteConflict(context as never, input, signal)
  } }
}

const head = 'a'.repeat(40), candidate = 'b'.repeat(40)
const { Value } = createRequire(new URL('../../packages/contracts/package.json', import.meta.url))('@sinclair/typebox/value')
/** A handled exception keeps the confirmation intent and offers recovery instead of reporting acceptance. */
function assertConfirmationRecovery(reply: Awaited<ReturnType<StudioApplication['command']>>): void {
  assert.equal(reply.ok, true, JSON.stringify(reply))
  if (reply.ok) assert.ok(reply.state.pending.some(value => value.phase === 'recovery'), JSON.stringify(reply.state.pending))
}
const body = '# 材料\n\n## 核心业务规则\n\n用户按固定业务范围检查记录且保留审计依据。\n\n## 验收条件\n\n符合业务规则的记录可以保存，不符合的显示明确错误。\n'
const templateBody = '## 目标与范围\n\n## 业务规则\n\n## 验收条件\n'
const templateRef = { commitSha: head, path: '.template/default.md', sha256: digest(templateBody) }
const evidencePath = '.eadp/evidence/fixture/approved.txt'
const evidenceBody = '合成业务访谈：用户按固定业务范围检查记录并保留审计依据。\n'
const evidence = { label: '合成测试业务依据', reference: 'synthetic:fixture', files: [{ path: evidencePath, sha256: digest(evidenceBody) }], ranges: [{ path: evidencePath, startLine: 1, endLine: 1 }] }
const entity = (id: string, kind: EntityView['kind'] = 'requirement'): EntityView => ({ id, kind, title: id,
  ...(kind === 'handoff' ? {} : { templateId: 'default', templateRef }),
  revision: 1, generation: 1, materialVersion: 0, confirmationStatus: 'draft', taskStatus: 'active',
  scenarioIds: kind === 'requirement' ? ['origin'] : [],
  ...(kind === 'requirement' ? { scenarioSources: [{ projectId: 'project', entityId: 'origin', version: 1 }] } : {}),
  prerequisites: [], authorId: 1 })
const metadata = (value: EntityView): MaterialMetadata => ({ ...initialMetadata(value, value.scenarioIds,
  value.scenarioIds.map(entityId => ({ projectId: 'project', entityId, version: 1 }))),
  businessEvidence: [evidence], ...(value.kind === 'scenario' ? { flowComplete: true } : { coreRulesPresent: true, acceptanceCriteriaPresent: true }) })
async function fixedFiles(directory: string): Promise<void> {
  await mkdir(path.dirname(path.join(directory, evidencePath)), { recursive: true })
  await writeFile(path.join(directory, evidencePath), evidenceBody)
  await mkdir(path.join(directory, '.template'), { recursive: true })
  await writeFile(path.join(directory, templateRef.path), templateBody)
}
async function fixture(t: test.TestContext, kind: EntityView['kind'] = 'requirement') {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-asset-workflow-')), apps: StudioApplication[] = []
  // Confirmations finish on the background lane; teardown waits for it so no
  // local state write races removal of the temporary directory.
  t.after(async () => { for (const created of apps) await created.dispose(); await rm(root, { recursive: true, force: true }) })
  const store = new StudioStore(path.join(root, 'state')); store.useUser(1)
  const local = await store.read(), value = entity('target', kind), worktree = path.join(root, 'task')
  await mkdir(worktree)
  await fixedFiles(worktree)
  value.occupation = { occupationId: 'occupation', generation: 1, taskId: 'task', clientId: local.clientId, expectedRevision: 1, entityId: value.id, ownerId: 1, purpose: 'design', inputVersion: 0, prerequisiteBindings: [], createdAt: '' }
  const project = { id: 'project', name: '测试项目', gitlabProjectId: 1, repositoryUrl: 'https://example.test/project.git', stableBranch: 'main', namespaceId: 1, namespacePath: 'test', initializationStatus: 'ready' as const, recognizedHead: head, revision: 1 }
  const origin = entity('origin', 'scenario'); origin.materialVersion = 1; origin.confirmationStatus = 'confirmed'; origin.taskStatus = 'idle'
  const originDraft = await saveMaterial(worktree, metadata(origin), body)
  origin.current = { version: 1, fixed: { commitSha: head, path: originDraft.path, sha256: originDraft.sha256 }, metadata: originDraft.metadata, confirmationId: 'origin-confirmation', confirmedBy: 1, confirmedAt: '', reuse: { enabled: true, reason: '' } }
  const remote: ProjectState = { project, entities: [value, origin], integrations: [], baselines: [] }
  local.projects.push({ id: project.id, name: project.name, directory: root, repositoryUrl: project.repositoryUrl }); local.selectedProjectId = project.id
  local.tasks.push({ projectId: project.id, entityId: value.id, worktree, purpose: kind === 'handoff' ? 'handoff' : 'material', inputHash: '', sessionId: 'material-session' })
  await saveMaterial(worktree, metadata(value), body)
  await store.save()
  const sourceEntity = entity('source'), sourceMetadata = { ...metadata(sourceEntity), sources: [{ projectId: 'source-project', entityId: 'origin', version: 1 }] }
  const sourceDirectory = path.join(root, 'source'); await mkdir(sourceDirectory); await fixedFiles(sourceDirectory)
  const sourceDraft = await saveMaterial(sourceDirectory, sourceMetadata, body)
  local.projects.push({ id: 'source-project', name: '来源项目', directory: sourceDirectory, repositoryUrl: project.repositoryUrl }); await store.save()
  const source: FixedVersion = { version: 2, fixed: { commitSha: head, path: sourceDraft.path, sha256: sourceDraft.sha256 }, metadata: sourceMetadata, confirmationId: 'source-confirmation', confirmedBy: 1, confirmedAt: '', reuse: { enabled: true, reason: '' } }
  const records = new Map<string, unknown>(), integrationInputs = new Map<string, PrepareIntegrationRequest>(), calls = { prompts: [] as string[], sessions: [] as string[], adoptions: 0, successEffects: 0, successRequests: [] as object[], commits: [] as Array<readonly string[]>, prepared: [] as PrepareIntegrationRequest[], pushes: [] as string[], conditionalUpdates: 0 }
  const gitState = { head, remote: head, dirtyFiles: [(await readMaterial(worktree, kind, value.id)).path], changedFiles: [] as string[],
    conflicts: [] as string[], stages: new Map<string, { base: Buffer; ours: Buffer; theirs: Buffer }>() }
  const reviewTrees = new Map<string, string>()
  const failures = { adoptionResponse: false, successResponse: false, prompt: false, session: false, push: false, integrationResponse: false, pendingIntegration: false }
  const readMaterials = async (prepared: PrepareIntegrationRequest) => {
    const materials = new Map<string, MaterialMetadata>()
    for (const confirmation of prepared.confirmations) {
      const target = remote.entities.find(entity => entity.id === confirmation.entityId) as EntityView
      const fixedDraft = await readMaterial(worktree, target.kind, target.id)
      assert.equal(fixedDraft.sha256, confirmation.fixed.sha256, 'backend verification reads the exact fixed material bytes')
      assert.equal('metadata' in confirmation, false, 'confirmation controls cannot carry business content')
      materials.set(confirmation.entityId, fixedDraft.metadata)
    }
    return materials
  }
  const acceptMaterials = (prepared: PrepareIntegrationRequest, materials: Map<string, MaterialMetadata>) => {
    for (const item of prepared.confirmations) {
      const changed = remote.entities.find(e => e.id === item.entityId) as EntityView
      changed.current = { version: changed.materialVersion + 1, fixed: item.fixed, metadata: materials.get(item.entityId)!, confirmationId: 'confirmed-' + item.entityId, confirmedBy: 1, confirmedAt: '', reuse: { enabled: true, reason: '' } }; changed.materialVersion++; delete changed.occupation
    }
  }
  const api = { request: async (method: string, route: string, input?: Record<string, unknown>) => {
    if (method === 'GET' && (route.startsWith('/v1/projects/project/prototype/baselines?') || route === '/v1/projects/project/prototype/adoptions')) return []
    if (input && 'token' in input) assert.equal(Value.Check(OccupationTokenSchema, input.token), true, 'Host writes must send the exact occupation token contract')
    if (method === 'GET' && route === '/v1/projects') return [project]
    if (method === 'GET' && route.endsWith('/templates')) return { acceptedHead: project.recognizedHead, scenarios: { defaultTemplateId: 'default', templates: [{ id: 'default', name: '默认场景模板', fixed: templateRef }] }, requirements: { defaultTemplateId: 'default', templates: [{ id: 'default', name: '默认需求模板', fixed: templateRef }] } }
    if (method === 'GET' && route.endsWith('/versions')) return [source]
    if (method === 'GET' && route.includes('/operations/')) { const result = records.get(route.split('/').at(-1)!); if (!result) throw new CollaborationError('OPERATION_NOT_FOUND', 'missing', 404); return { action: 'integration.prepare', result } }
    if (method === 'GET' && route.includes('/integrations/')) return remote.integrations.find(integration => integration.id === route.split('/').at(-1))
    if (method === 'GET' && route === '/v1/projects/source-project') return { ...remote, project: { ...project, id: 'source-project' } }
    if (method === 'GET' && route === '/v1/projects/project') return remote
    if (method === 'POST' && route.endsWith('/adoptions')) {
      const operationKey = String(input!.idempotencyKey)
      let result = records.get(operationKey)
      if (!result) { calls.adoptions++; result = { id: 'adoption', ...input, status: 'accepted' }; records.set(operationKey, result) }
      if (failures.adoptionResponse) { failures.adoptionResponse = false; throw new Error('adoption response lost') }
      return result
    }
    if (method === 'POST' && route.endsWith('/adoptions/adoption/success')) {
      calls.successRequests.push(input!)
      const operationKey = String(input!.idempotencyKey)
      let result = records.get(operationKey)
      if (!result) { calls.successEffects++; result = { id: 'adoption', status: 'succeeded', targetConfirmationId: input!.targetConfirmationId }; records.set(operationKey, result) }
      if (failures.successResponse) { failures.successResponse = false; throw new Error('success response lost') }
      return result
    }
    if (method === 'POST' && route.endsWith('/integrations')) {
      const prepared = input as unknown as PrepareIntegrationRequest; calls.prepared.push(prepared)
      assert.notEqual(prepared.stage, 'template', 'material workflow must not publish project configuration')
      if (prepared.stage === 'template') throw new Error('Unexpected template integration')
      const materials = await readMaterials(prepared)
      validateIntegration(project, remote.entities as EntityView[], { id: 1 } as never, prepared, materials)
      const pending = remote.integrations.find(operation => operation.status === 'prepared')
      if (pending) {
        const previous = integrationInputs.get(pending.id)
        const sameOccupation = !!(previous && prepared.stage !== 'template' && previous.stage !== 'template' && previous.token.occupationId === prepared.token.occupationId)
        if (!sameOccupation) throw new CollaborationError('INTEGRATION_PENDING', 'An integration is pending', 409)
        pending.status = 'aborted'
      }
      const saved = { id: `integration-${prepared.idempotencyKey}`, entityId: value.id, ownerId: 1, status: failures.pendingIntegration ? 'prepared' as const : 'accepted' as const, sourceSha: prepared.sourceSha, expectedHead: prepared.expectedHead, candidateSha: prepared.candidateSha, stage: prepared.stage, confirmationIds: prepared.confirmations.map(item => 'confirmed-' + item.entityId), createdAt: '' }
      remote.integrations.push(saved); integrationInputs.set(saved.id, prepared); records.set(prepared.idempotencyKey, saved)
      if (saved.status === 'accepted') acceptMaterials(prepared, materials)
      if (failures.integrationResponse) { failures.integrationResponse = false; throw new Error('integration response lost') }
      return saved
    }
    if (method === 'POST' && /\/integrations\/[^/]+\/complete$/.test(route)) {
      const id = route.split('/').at(-2)!, saved = remote.integrations.find(operation => operation.id === id)
      assert.ok(saved); assert.equal(saved.status, 'prepared')
      const prepared = integrationInputs.get(id)!, materials = await readMaterials(prepared)
      saved.status = 'accepted'; saved.confirmationIds = prepared.confirmations.map(item => 'confirmed-' + item.entityId)
      acceptMaterials(prepared, materials)
      project.recognizedHead = prepared.candidateSha
      return saved
    }
    throw new Error('Unexpected request: ' + method + ' ' + route)
  } } as unknown as CollaborationClient
  const deliveredPrompts = new Set<string>()
  const ports = { account: async () => ({ id: 1, name: '作者', gitlabUsername: 'author', gitlabEmail: 'author@example.invalid' }), stopPreview: async () => {},
    session: async (task: { sessionId: string }) => { calls.sessions.push(task.sessionId); if (failures.session) { failures.session = false; throw new Error('session failed') }; return task.sessionId },
    prompt: async (session: string, text: string, operationId?: string) => { calls.prompts.push(session + ':' + text); if (failures.prompt) { failures.prompt = false; throw new Error('prompt failed') }; if (operationId) deliveredPrompts.add(operationId) },
    inspectPrompt: async (_session: string, operationId: string) => deliveredPrompts.has(operationId) ? 'delivered' as const : 'unknown' as const,
    checks: async (_task: unknown, sha: string) => ({ candidateSha: sha, passed: true, checks: [{ name: 'engineering', passed: true, evidenceHash: digest('checked') }] }),
    gitLocal: async (args: readonly string[]) => args[0] === 'rev-list' ? `${gitState.head} ${gitState.remote} ${candidate}` : gitState.dirtyFiles.map(file => ' M ' + file + '\0').join(''),
    git: { hasCommit: async () => true,
      isAncestor: async (_root: string, from: string, to: string) => from === head && to === gitState.remote,
      commits: async () => [{ sha: gitState.remote, title: '远端修改' }], commitAll: async () => 'f'.repeat(40),
      fastForward: async () => { gitState.head = gitState.remote }, applyCommit: async () => [...gitState.conflicts],
      conflictStages: async (_root: string, file: string) => gitState.stages.get(file)!,
      resolvePath: async () => {}, quitApply: async () => {}, unstage: async () => {}, abortApply: async () => {}, restore: async () => {}, moveHead: async () => { gitState.head = gitState.remote }, changedPathStatuses: async () => [],
      commitFiles: async (_directory: string, files: readonly string[]) => { calls.commits.push(files); gitState.head = candidate; gitState.changedFiles = [...new Set([...gitState.changedFiles, ...files])]; gitState.dirtyFiles = []; return candidate }, verifyFile: async () => {}, push: async (_root: string, commit: string, branch: string) => { calls.pushes.push(commit + ':' + branch); if (failures.push) { failures.push = false; throw new Error('push response lost') } }, remoteHead: async () => gitState.remote, conditionalUpdate: async (_directory: string, _branch: string, expected: string, next: string) => { assert.equal(expected, gitState.remote); gitState.remote = next; calls.conditionalUpdates++ }, fetch: async () => {}, checkoutBranch: async (_root: string, _branch: string, baseSha: string) => { gitState.head = baseSha }, switchBranch: async (_root: string, _branch: string, commit: string) => { gitState.head = commit }, deleteBranch: async () => {}, merge: async (_root: string, commit: string) => { assert.equal(commit, candidate); gitState.head = 'd'.repeat(40); project.recognizedHead = gitState.remote; return { status: 'merged' as const, commit: gitState.head } }, fetchCommit: async () => {}, readBlob: async (_directory: string, _sha: string, file: string) => { const { readFile } = await import('node:fs/promises'); return readFile(path.join(_directory === sourceDirectory ? sourceDirectory : worktree, file)) }, changedFiles: async () => gitState.changedFiles, state: async (directory: string) => { if (directory === worktree) return { head: gitState.head, branch: 'studio/target/original', dirty: gitState.dirtyFiles.length > 0 }; await stat(directory); return { head: reviewTrees.get(directory), dirty: false } }, createWorktree: async (_root: string, directory: string, _branch: string, sha: string) => { if (!directory.includes(path.sep + 'reviews' + path.sep)) throw new Error('prototype intentionally not started'); await cp(worktree, directory, { recursive: true }); reviewTrees.set(directory, sha) } },
  } as unknown as HostPorts
  const app = (nextStore = store) => { const created = new StudioApplication(nextStore, api, ports); apps.push(created); return created }
  const settle = async () => { for (const created of apps) await created.settle() }
  const adopt = { action: 'adopt' as const, sourceProjectId: 'source-project', sourceEntityId: 'source', version: 2, targetEntityId: value.id, reason: '依据目标业务调整验收条件' }
  return { root, store, local, value, worktree, remote, source, sourceDirectory, calls, failures, gitState, app, settle, adopt, api, ports }
}

test('DSH material merge returns business body only and Host restores the trusted identity', async t => {
  const f = await fixture(t), draft = await readMaterial(f.worktree, 'requirement', f.value.id)
  const remoteBody = '# 材料\n\n## 核心业务规则\n\n远端补充规则。\n\n## 验收条件\n\n远端补充验收。\n'
  const mergedBody = '# 材料\n\n## 核心业务规则\n\n用户按固定业务范围检查记录且保留审计依据。\n远端补充规则。\n\n## 验收条件\n\n符合业务规则的记录可以保存，不符合的显示明确错误。\n远端补充验收。\n'
  const merge = await actualMerge(() => `\`\`\`eadp-merged\n${mergedBody}\n\`\`\``)
  f.ports.mergeConflict = merge.mergeConflict
  f.remote.project.recognizedHead = 'e'.repeat(40); f.gitState.remote = f.remote.project.recognizedHead
  f.gitState.conflicts = [draft.path]
  f.gitState.stages.set(draft.path, { base: Buffer.from(materialText(draft.metadata, body)), ours: Buffer.from(materialText(draft.metadata, remoteBody)), theirs: Buffer.from(materialText(draft.metadata, draft.body)) })
  const app = f.app()
  await app.command({ action: 'confirmMaterial', entityId: f.value.id, expectedHash: draft.sha256, method: 'direct' })
  await app.settle()
  const merged = await readMaterial(f.worktree, 'requirement', f.value.id)
  assert.equal(merged.body, mergedBody)
  assert.deepEqual(merged.metadata, draft.metadata)
  assert.equal(merge.inputs.length, 1)
  for (const input of merge.inputs) for (const value of [input.base, input.ours, input.theirs]) assert.equal(value?.includes('eadp-metadata'), false, 'AI 只能收到业务正文')
})

test('a merged material with unchanged declarations advances the verified hash and fixes both bodies', async t => {
  const f = await fixture(t, 'scenario'), draft = await readMaterial(f.worktree, 'scenario', f.value.id)
  const remoteBody = '# 材料\n\n## 核心业务规则\n\n远端补充规则。\n\n## 验收条件\n\n远端补充验收。\n'
  const mergedBody = '# 材料\n\n## 核心业务规则\n\n用户按固定业务范围检查记录且保留审计依据。\n远端补充规则。\n\n## 验收条件\n\n符合业务规则的记录可以保存，不符合的显示明确错误。\n远端补充验收。\n'
  const merge = await actualMerge(() => `\`\`\`eadp-merged\n${mergedBody}\n\`\`\``)
  f.ports.mergeConflict = merge.mergeConflict
  f.remote.project.recognizedHead = 'e'.repeat(40); f.gitState.remote = f.remote.project.recognizedHead
  f.gitState.conflicts = [draft.path]
  f.gitState.stages.set(draft.path, { base: Buffer.from(materialText(draft.metadata, body)), ours: Buffer.from(materialText(draft.metadata, remoteBody)), theirs: Buffer.from(materialText(draft.metadata, draft.body)) })
  const app = f.app()
  await app.command({ action: 'confirmMaterial', entityId: f.value.id, expectedHash: draft.sha256, method: 'direct' })
  await app.settle()
  assert.equal(f.calls.prepared.length, 1, JSON.stringify((await f.store.read()).scenarios.find(record => record.entityId === f.value.id)?.materialConfirmations))
  const merged = await readMaterial(f.worktree, 'scenario', f.value.id)
  assert.equal(merged.body, mergedBody)
  assert.equal(f.calls.prepared[0]!.confirmations[0]!.fixed.sha256, merged.sha256)
})

test('merged material, context and evidence keep the AI body and rebind every declaration to actual bytes', async t => {
  const f = await fixture(t), original = await readMaterial(f.worktree, 'requirement', f.value.id)
  const localContext = '本地上下文\n', remoteContext = '远端上下文\n', mergedContext = localContext + remoteContext
  await writeFile(path.join(f.worktree, 'CONTEXT.md'), localContext)
  const metadata = { ...original.metadata, files: [{ path: 'CONTEXT.md', sha256: digest(localContext) }] }
  const draft = await saveMaterial(f.worktree, metadata, original.body)
  const remoteBody = '# 材料\n\n## 核心业务规则\n\n远端补充规则。\n\n## 验收条件\n\n远端补充验收。\n'
  const mergedBody = '# 材料\n\n## 核心业务规则\n\n用户按固定业务范围检查记录且保留审计依据。\n远端补充规则。\n\n## 验收条件\n\n符合业务规则的记录可以保存，不符合的显示明确错误。\n远端补充验收。\n'
  const remoteEvidence = '远端正式依据\n', mergedEvidence = evidenceBody + remoteEvidence
  const merge = await actualMerge(input => {
    const content = input.path === draft.path ? mergedBody : input.path === 'CONTEXT.md' ? mergedContext : input.path === evidencePath ? mergedEvidence : undefined
    if (content === undefined) throw new Error(`unexpected conflict ${input.path}`)
    return `\`\`\`eadp-merged\n${content}\n\`\`\``
  })
  f.ports.mergeConflict = merge.mergeConflict
  f.remote.project.recognizedHead = 'e'.repeat(40); f.gitState.remote = f.remote.project.recognizedHead
  f.gitState.conflicts = [draft.path, 'CONTEXT.md', evidencePath]
  f.gitState.stages.set(draft.path, { base: Buffer.from(materialText(metadata, body)), ours: Buffer.from(materialText(metadata, remoteBody)), theirs: Buffer.from(materialText(metadata, draft.body)) })
  f.gitState.stages.set('CONTEXT.md', { base: Buffer.from('旧上下文\n'), ours: Buffer.from(remoteContext), theirs: Buffer.from(localContext) })
  f.gitState.stages.set(evidencePath, { base: Buffer.from('旧依据\n'), ours: Buffer.from(remoteEvidence), theirs: Buffer.from(evidenceBody) })
  const app = f.app()
  await app.command({ action: 'confirmMaterial', entityId: f.value.id, expectedHash: draft.sha256, method: 'direct' })
  await app.settle()
  assert.equal(f.calls.prepared.length, 1, JSON.stringify((await f.store.read()).scenarios.find(record => record.entityId === f.value.id)?.materialConfirmations))
  const merged = await readMaterial(f.worktree, 'requirement', f.value.id)
  assert.equal(merged.body, mergedBody, '声明刷新不得回写合并前正文')
  const contextBytes = await readFile(path.join(f.worktree, 'CONTEXT.md'))
  const evidenceBytes = await readFile(path.join(f.worktree, evidencePath))
  assert.equal(contextBytes.toString('utf8'), mergedContext)
  assert.equal(evidenceBytes.toString('utf8'), mergedEvidence)
  assert.equal(merged.metadata.files?.find(file => file.path === 'CONTEXT.md')?.sha256, digest(contextBytes))
  assert.equal(merged.metadata.businessEvidence[0]!.files[0]!.sha256, digest(evidenceBytes))
  assert.equal(f.calls.prepared[0]!.confirmations[0]!.fixed.sha256, merged.sha256)
})

test('author handoff acknowledgement uses the actual API receipt route and current confirmation', async t => {
  const f = await fixture(t, 'handoff'), app = f.app()
  const Fastify = createRequire(new URL('../../apps/collaboration-api/package.json', import.meta.url))('fastify')
  const server = Fastify({ ajv: { customOptions: { removeAdditional: false } } })
  t.after(() => server.close())
  const receipts: Array<{ projectId: string; entityId: string; input: unknown }> = []
  registerRoutes(server, { auth: { authenticate: async () => ({ id: 1 }) }, receipt: async (_actor: unknown, projectId: string, entityId: string, input: unknown) => { receipts.push({ projectId, entityId, input }); return { id: 'receipt' } } } as never,
    loadConfig({ DATABASE_URL: 'postgresql://synthetic', PG_SSL: 'disable', GITLAB_URL: 'http://gitlab.test', GITLAB_ALLOW_HTTP: 'true', SEI_GITLAB_TOKEN: 'synthetic' }))
  const routed = new CollaborationClient('http://route.test', async () => 'synthetic', undefined, async (url, options) => {
    const response = await server.inject({ method: options!.method, url: new URL(String(url)).pathname, headers: options!.headers, payload: options!.body })
    return new Response(response.payload, { status: response.statusCode, headers: { 'content-type': 'application/json' } })
  })
  const original = f.api.request.bind(f.api)
  f.api.request = (method, route, input) => method === 'POST' ? routed.request(method, route, input) : original(method, route, input)
  assert.equal((await app.command({ action: 'acknowledgeHandoff', entityId: f.value.id, note: '已核对固定资料' })).ok, false)
  f.value.current = { ...f.source, confirmationId: 'confirmed-handoff' }
  const reply = await app.command({ action: 'acknowledgeHandoff', entityId: f.value.id, note: '已核对固定资料' })
  assert.equal(reply.ok, true, JSON.stringify(reply))
  assert.equal(receipts.length, 1); assert.equal(receipts[0]!.entityId, f.value.id)
  assert.equal((receipts[0]!.input as { confirmationId: string }).confirmationId, 'confirmed-handoff')
})

test('adoption success binds the accepted target confirmation and survives a lost response without duplicate acceptance', async t => {
  const f = await fixture(t)
  f.failures.adoptionResponse = true
  assert.equal((await f.app().command(f.adopt)).ok, false)
  const rebooted = new StudioStore(path.join(f.root, 'state')); rebooted.useUser(1)
  const app = f.app(rebooted)
  assert.equal((await app.command(f.adopt)).ok, true)
  assert.equal(f.calls.adoptions, 1, 'restart must resolve the original adoption instead of accepting a new record')
  const draft = await readMaterial(f.worktree, 'requirement', f.value.id)
  const checked = await saveMaterial(f.worktree, { ...draft.metadata, coreRulesPresent: true, acceptanceCriteriaPresent: true }, draft.body)
  f.failures.successResponse = true
  const confirmed = await app.command({ action: 'confirmMaterial', entityId: f.value.id, expectedHash: checked.sha256, method: 'direct' })
  assert.equal(confirmed.ok, true, JSON.stringify(confirmed))
  assert.equal((await rebooted.read()).scenarios.find(record => record.entityId === f.value.id)?.requirementConfirmation?.message, undefined)
  // The confirmation is recorded before its Git publication finishes; the lost
  // acknowledgement surfaces on the operation the surfaces render.
  await app.settle()
  const pending = (await rebooted.read()).operations[0]!
  assert.equal(pending.phase, 'accepted', 'the target confirmation remains accepted if success acknowledgement is lost')
  const second = new StudioStore(path.join(f.root, 'state')); second.useUser(1)
  const retry = f.app(second)
  assert.equal((await retry.command({ action: 'retryOperation', operationId: pending.id })).ok, true)
  await retry.settle()
  assert.equal(f.calls.successEffects, 1)
  assert.equal(f.calls.successRequests.length, 2)
  assert.deepEqual(f.calls.successRequests[0], f.calls.successRequests[1], 'retries retain the exact confirmation and idempotency key')
})

test('a lost push acknowledgement is repeated by the persisted operation retry', async t => {
  const f = await fixture(t), app = f.app()
  f.failures.push = true
  const draft = await readMaterial(f.worktree, 'requirement', f.value.id)
  assert.equal((await app.command({ action: 'confirmMaterial', entityId: f.value.id, expectedHash: draft.sha256, method: 'direct' })).ok, true)
  await app.settle()
  const operation = (await f.store.read()).operations[0]!
  assert.equal(operation.phase, 'unknown')
  assert.equal(f.calls.prepared.length, 0)
  assert.equal((await app.command({ action: 'retryOperation', operationId: operation.id })).ok, true)
  await app.settle()
  assert.equal(f.calls.pushes.length, 2, 'recovery repeats the idempotent candidate push before preparing')
  assert.equal(f.calls.prepared.length, 1)
  assert.equal((await f.store.read()).operations[0]!.phase, 'accepted')
})

test('a lost integration response resolves the original operation on retry without a second prepare', async t => {
  const f = await fixture(t), app = f.app()
  f.failures.integrationResponse = true
  const draft = await readMaterial(f.worktree, 'requirement', f.value.id)
  assert.equal((await app.command({ action: 'confirmMaterial', entityId: f.value.id, expectedHash: draft.sha256, method: 'direct' })).ok, true)
  await app.settle()
  const operation = (await f.store.read()).operations[0]!
  assert.equal(operation.phase, 'unknown')
  assert.equal(f.calls.prepared.length, 1)
  assert.equal((await app.command({ action: 'retryOperation', operationId: operation.id })).ok, true)
  await app.settle()
  assert.equal(f.calls.prepared.length, 1, 'retry queries the original operation instead of preparing again')
  assert.equal((await f.store.read()).operations[0]!.phase, 'accepted')
})

test('confirming a requirement never starts or prompts a prototype session', async t => {
  const f = await fixture(t), app = f.app(), draft = await readMaterial(f.worktree, 'requirement', f.value.id)
  assert.equal((await app.command({ action: 'confirmMaterial', entityId: f.value.id, expectedHash: draft.sha256, method: 'direct' })).ok, true)
  await app.settle()
  assert.equal(f.local.operations[0]!.phase, 'accepted')
  assert.equal(f.local.tasks.filter(task => task.purpose === 'prototype').length, 0)
  assert.equal(f.calls.sessions.length, 0)
  assert.equal(f.calls.prompts.length, 0)
})

test('a moved remote head rebuilds and accepts a merged candidate without rewriting the diverged branch', async t => {
  const f = await fixture(t), app = f.app()
  f.failures.pendingIntegration = true
  f.gitState.remote = 'c'.repeat(40)
  const draft = await readMaterial(f.worktree, 'requirement', f.value.id)
  assert.equal((await app.command({ action: 'confirmMaterial', entityId: f.value.id, expectedHash: draft.sha256, method: 'direct' })).ok, true)
  await app.settle()
  const operations = (await f.store.read()).operations
  assert.equal(operations.length, 2)
  assert.equal(operations[0]!.phase, 'superseded')
  assert.equal(operations[1]!.phase, 'accepted', operations[1]!.message)
  assert.equal(operations[1]!.id, `m-${'d'.repeat(40)}`)
  assert.equal(f.calls.prepared[1]!.confirmations[0]!.readHash, draft.sha256)
  assert.equal(f.remote.integrations[0]!.status, 'aborted')
  assert.equal(f.remote.integrations[1]!.status, 'accepted')
  assert.equal(f.calls.conditionalUpdates, 1, 'only the rebuilt candidate updates the remote head')
  assert.equal(f.calls.prepared.length, 2)
})

test('accepted handoff generation is durable per fixed baseline and never overwrites author edits on retry', async t => {
  const f = await fixture(t, 'handoff')
  f.value.title = '原型交接 v2'
  const requirement = entity('requirement'); requirement.materialVersion = 2
  f.remote.entities.push(requirement)
  f.remote.baselines.push({ id: 'baseline', prototypeId: 'prototype', sequence: 2, acceptanceId: 'acceptance', integrationId: 'integration', prototypeTaskId: 'task', commitSha: candidate, relatedRequirementIds: [requirement.id], confirmedBy: 1, acceptedAt: '' })
  const initial = await readMaterial(f.worktree, 'handoff', f.value.id)
  if (initial.metadata.kind !== 'handoff') throw new Error('handoff fixture identity')
  await saveMaterial(f.worktree, { ...initial.metadata, prototypeBaseline: { baselineId: 'baseline', commitSha: candidate } }, initial.body)
  assert.equal((await f.app().command({ action: 'generateHandoff', baselineId: 'baseline' })).ok, true)
  const generated = await readMaterial(f.worktree, 'handoff', f.value.id)
  await saveMaterial(f.worktree, generated.metadata, '作者修改必须保留\n' + body)
  const rebooted = new StudioStore(path.join(f.root, 'state')); rebooted.useUser(1)
  assert.equal((await f.app(rebooted).command({ action: 'generateHandoff', baselineId: 'baseline' })).ok, true)
  assert.match((await readMaterial(f.worktree, 'handoff', f.value.id)).body, /作者修改必须保留/)
  assert.equal(f.calls.prompts.length, 1)
})

test('scenario confirmation fixes only the scenario material and leaves related requirements untouched', async t => {
  const f = await fixture(t, 'scenario')
  f.value.materialVersion = 1; f.value.occupation!.inputVersion = 1
  const unstarted = entity('unstarted'), completed = entity('completed'), unrelated = entity('unrelated')
  for (const requirement of [unstarted, completed, unrelated]) requirement.scenarioIds = [f.value.id]
  completed.materialVersion = 2
  f.remote.entities.push(unstarted, completed, unrelated)
  const draft = await readMaterial(f.worktree, 'scenario', f.value.id)
  const reply = await f.app().command({ action: 'confirmMaterial', entityId: f.value.id, expectedHash: draft.sha256, method: 'direct' })
  assert.equal(reply.ok, true, JSON.stringify(reply))
  const request = f.calls.prepared[0]!
  assert.equal(request.stage, 'material')
  assert.deepEqual(request.confirmations.map(item => item.entityId), ['target'])
  assert.deepEqual([...f.calls.commits[0]!].sort(), [evidencePath, '场景/target.md'].sort())
  assert.ok(request.confirmations.every(item => item.fixed.commitSha === candidate))
})

test('a blocked scenario confirmation continues on the corrected file after a retry', async t => {
  const f = await fixture(t, 'scenario'), app = f.app()
  const draft = await readMaterial(f.worktree, 'scenario', f.value.id)
  const blocked = await saveMaterial(f.worktree, { ...draft.metadata, flowComplete: false }, '作者原始正文\n' + body)
  assert.equal((await app.command({ action: 'confirmMaterial', entityId: f.value.id, expectedHash: blocked.sha256, method: 'direct' })).ok, false)
  const original = f.local.scenarios.find(record => record.entityId === f.value.id)!.materialConfirmations![0]!
  assert.equal(original.phase, 'recovery'); assert.equal(original.request.body, blocked.body)
  const corrected = await saveMaterial(f.worktree, { ...blocked.metadata, flowComplete: true }, blocked.body)
  await app.command({ action: 'retryOperation', operationId: original.operationId }); await app.settle()
  assert.equal(original.request.body, blocked.body, 'the submitted input stays the recorded request')
  assert.equal(original.phase, 'accepted')
  assert.equal(f.calls.prepared.length, 1)
  assert.equal(f.calls.prepared[0]!.confirmations[0]!.readHash, corrected.sha256, 'the file the author corrected is what gets confirmed')
})


test('a requirement material session receives the shared read-only design context', async t => {
  const f = await fixture(t), app = f.app()
  const context = await app.scenarioSessionContext(f.local.tasks[0]!)
  assert.match(context.text, /当前需求 target/)
  assert.match(context.text, /回答规则：先用可读中文归纳本轮明确结论/)
  assert.match(context.text, /eadp-material-questions/)
  assert.match(context.text, /核心业务规则/)
  assert.deepEqual(context.readPaths, [], 'requirement context never grants paths outside its worktree')
})

test('material decision questions are a separate, context-bound assistant turn beside an optional write proposal', async t => {
  const f = await fixture(t), app = f.app(), task = f.local.tasks[0]!
  await app.scenarioSessionContext(task)
  await app.command({ action: 'openRequirement', entityId: f.value.id })
  const before = await readMaterial(f.worktree, 'requirement', f.value.id)
  const questions = { entityId: f.value.id, questions: [{ key: 'Q1', title: '退款由谁审批？', reason: '当前资料没有说明审批角色。', evidenceIds: [], options: [
    { key: 'A', label: '客服主管', description: '由客服主管审批。' }, { key: 'B', label: '财务主管', description: '由财务主管审批。' },
  ] }] }
  const proposal = { entityId: f.value.id, conclusions: [{ id: 'C1', text: '退款保留审批记录' }], evidenceIds: [], body: `${before.body}\n新增审批记录。` }
  const response = `本轮保留一项未决选择。\n\`\`\`eadp-material-questions\n${JSON.stringify(questions)}\n\`\`\`\n\`\`\`eadp-write-proposal\n${JSON.stringify(proposal)}\n\`\`\``
  await app.acceptSessionOutput(task.sessionId, { kind: 'assistant', content: response })

  const accepted = await f.store.read(), record = accepted.scenarios.find(value => value.entityId === f.value.id)!
  const turn = record.decisionQuestions?.[task.sessionId]
  assert.ok(turn)
  assert.equal(turn.questions[0]!.title, '退款由谁审批？')
  assert.equal(turn.entityId, f.value.id)
  assert.equal(turn.taskId, path.basename(f.worktree))
  assert.equal(record.writeProposal?.status, 'pending', 'the question block and write proposal remain independent')
  assert.equal((await readMaterial(f.worktree, 'requirement', f.value.id)).body, before.body, 'receiving an option never writes Markdown')

  const projected = await app.state()
  assert.equal(projected.requirement?.decisionQuestions?.stale, false)
  assert.equal(projected.requirement?.decisionQuestions?.questions[0]!.options[1]!.label, '财务主管')

  await saveMaterial(f.worktree, before.metadata, `${before.body}\n外部正文变化。`)
  const stale = await app.state()
  assert.equal(stale.requirement?.decisionQuestions?.stale, true, 'questions from an old body stay readable and stop accepting answers')

  await app.acceptSessionOutput(task.sessionId, { kind: 'assistant', content: '收到你的回答，我继续整理。' })
  const afterReply = await f.store.read()
  assert.equal(afterReply.scenarios.find(value => value.entityId === f.value.id)!.decisionQuestions?.[task.sessionId], undefined, 'a later assistant turn retires old choices')
})

test('an adoption acknowledgement cannot overwrite a target edited while its response was lost', async t => {
  const f = await fixture(t)
  f.failures.adoptionResponse = true
  assert.equal((await f.app().command(f.adopt)).ok, false)
  const original = await readMaterial(f.worktree, 'requirement', f.value.id)
  await saveMaterial(f.worktree, original.metadata, '作者保留的新内容\n' + body)
  const rebooted = new StudioStore(path.join(f.root, 'state')); rebooted.useUser(1)
  assert.equal((await f.app(rebooted).command(f.adopt)).ok, false)
  assert.equal(f.calls.adoptions, 1)
  assert.match((await readMaterial(f.worktree, 'requirement', f.value.id)).body, /作者保留的新内容/)
  assert.equal(f.calls.successEffects, 0)
})

test('a confirmed target without the exact adopted source cannot report reuse success', async t => {
  const f = await fixture(t)
  assert.equal((await f.app().command(f.adopt)).ok, true)
  const draft = await readMaterial(f.worktree, 'requirement', f.value.id)
  const checked = await saveMaterial(f.worktree, { ...draft.metadata, sources: draft.metadata.sources.filter(source => source.projectId === 'project' && draft.metadata.scenarioIds.includes(source.entityId)), coreRulesPresent: true, acceptanceCriteriaPresent: true }, draft.body)
  assert.equal((await f.app().command({ action: 'confirmMaterial', entityId: f.value.id, expectedHash: checked.sha256, method: 'direct' })).ok, true)
  assert.equal(f.calls.successEffects, 0)
})

for (const failure of ['session', 'prompt'] as const) test('failed handoff ' + failure + ' retries its fixed task without replacing author content', async t => {
  const f = await fixture(t, 'handoff')
  f.value.title = '原型交接 v2'
  const requirement = entity('requirement'); requirement.materialVersion = 2
  f.remote.entities.push(requirement)
  f.remote.baselines.push({ id: 'baseline', prototypeId: 'prototype', sequence: 2, acceptanceId: 'acceptance', integrationId: 'integration', prototypeTaskId: 'task', commitSha: candidate, relatedRequirementIds: [requirement.id], confirmedBy: 1, acceptedAt: '' })
  const initial = await readMaterial(f.worktree, 'handoff', f.value.id)
  if (initial.metadata.kind !== 'handoff') throw new Error('handoff fixture identity')
  await saveMaterial(f.worktree, { ...initial.metadata, prototypeBaseline: { baselineId: 'baseline', commitSha: candidate } }, initial.body)
  f.failures[failure] = true
  assert.equal((await f.app().command({ action: 'generateHandoff', baselineId: 'baseline' })).ok, false)
  const draft = await readMaterial(f.worktree, 'handoff', f.value.id)
  await saveMaterial(f.worktree, draft.metadata, '失败后作者补充\n' + body)
  const rebooted = new StudioStore(path.join(f.root, 'state')); rebooted.useUser(1)
  assert.equal((await f.app(rebooted).command({ action: 'generateHandoff', baselineId: 'baseline' })).ok, failure === 'session')
  assert.match((await readMaterial(f.worktree, 'handoff', f.value.id)).body, /失败后作者补充/)
  assert.ok(f.calls.sessions.every(id => id === 'material-session'))
})

test('a related requirement without local material does not block scenario confirmation', async t => {
  const f = await fixture(t, 'scenario')
  f.value.materialVersion = 1; f.value.occupation!.inputVersion = 1
  const missing = entity('missing'); missing.scenarioIds = [f.value.id]
  f.remote.entities.push(missing)
  const draft = await readMaterial(f.worktree, 'scenario', f.value.id)
  assert.equal((await f.app().command({ action: 'confirmMaterial', entityId: f.value.id, expectedHash: draft.sha256, method: 'direct' })).ok, true)
  assert.deepEqual(f.calls.prepared[0]!.confirmations.map(item => item.entityId), ['target'])
})

test("a requirement under another owner's design occupation is read-only and refuses edits", async t => {
  const f = await fixture(t, 'scenario')
  const related = entity('related'); related.scenarioIds = [f.value.id]
  related.occupation = { occupationId: 'foreign', generation: 1, taskId: 'foreign-task', clientId: f.local.clientId, expectedRevision: 1, entityId: related.id, ownerId: 2, purpose: 'design', inputVersion: 0, prerequisiteBindings: [], createdAt: '' }
  f.remote.entities.push(related)
  const app = f.app()
  const state = await app.state()
  assert.equal(state.materialSources!.find(value => value.entityId === related.id)!.readOnly, true)
  const draft = await readMaterial(f.worktree, 'scenario', f.value.id)
  assert.equal((await app.command({ action: 'saveMaterial', entityId: related.id, metadata: { ...metadata(related), entityId: related.id }, body })).ok, false)
  assert.equal(related.occupation!.ownerId, 2)
  assert.equal((await readMaterial(f.worktree, 'scenario', f.value.id)).sha256, draft.sha256)
})


const reviewReport = (summary = '固定候选符合业务依据，作者仍需检查并确认。') => String.fromCharCode(96).repeat(3) + 'eadp-review\n' + JSON.stringify({ summary, findings: [{ severity: 'warning', message: '请作者核对异常分支的使用限制。' }] }) + '\n' + String.fromCharCode(96).repeat(3)

test('an author-requested material review binds the local snapshot without committing and only explicit author confirmation submits its hashes', async t => {
  const f = await fixture(t), app = f.app()
  const requested = await app.command({ action: 'requestReview', entityId: f.value.id, purpose: 'material' })
  assert.equal(requested.ok, true, JSON.stringify(requested))
  const review = (await f.store.read()).reviews[0]!
  assert.notEqual(review.task.worktree, f.worktree)
  assert.equal(review.task.purpose, 'review')
  assert.equal(review.head, head, 'the review binds the local HEAD')
  assert.equal(f.gitState.head, head, 'requesting a review leaves Git history unchanged')
  assert.equal(f.calls.commits.length, 0, 'requesting a review creates no candidate commit')
  await app.acceptSessionOutput(review.task.sessionId, { kind: 'assistant', content: reviewReport() })
  await app.acceptSessionOutput(review.task.sessionId, { kind: 'turn-ended', reason: 'completed' })
  assert.equal(f.calls.prepared.length, 0, 'AI output cannot author-confirm or integrate')
  const draft = await readMaterial(f.worktree, 'requirement', f.value.id)
  const reply = await app.command({ action: 'confirmMaterial', entityId: f.value.id, expectedHash: draft.sha256, method: 'ai-assisted', reviewId: review.id, authorDisposition: '已核对异常分支并在交付限制中保留说明。' })
  assert.equal(reply.ok, true, JSON.stringify(reply))
  assert.equal((await f.store.read()).scenarios.find(record => record.entityId === f.value.id)?.materialConfirmations?.at(-1)?.message, undefined)
  const confirmation = f.calls.prepared[0]!.confirmations[0]!
  assert.equal(confirmation.confirmationMethod, 'ai-assisted')
  if (confirmation.confirmationMethod === 'ai-assisted') {
    assert.deepEqual(confirmation.reviewEvidence, { candidateSha: candidate, inputHash: review.inputHash, reportHash: digest(reviewReport()), dispositionHash: digest('已核对异常分支并在交付限制中保留说明。') })
  }
  assert.equal(JSON.stringify(f.calls.prepared).includes('请作者核对异常分支'), false)
  assert.equal(f.calls.commits.length, 1, 'confirmation creates the reviewed candidate once')
})

test('a review report is rejected when the fixed snapshot bytes change', async t => {
  const f = await fixture(t), app = f.app()
  assert.equal((await app.command({ action: 'requestReview', entityId: f.value.id, purpose: 'material' })).ok, true)
  const review = (await f.store.read()).reviews[0]!
  const draft = await readMaterial(review.task.worktree, 'requirement', f.value.id)
  await writeFile(path.join(review.task.worktree, draft.path), '被改动的评审快照\n')
  await assert.rejects(app.acceptSessionOutput(review.task.sessionId, { kind: 'assistant', content: reviewReport() }), /快照已变化/)
  assert.equal((await f.store.read()).reviews[0]!.status, 'failed')
  assert.equal(f.calls.prepared.length, 0)
})

test('direct confirmation remains available after a pending review freezes a clean candidate', async t => {
  const f = await fixture(t), app = f.app()
  assert.equal((await app.command({ action: 'requestReview', entityId: f.value.id, purpose: 'material' })).ok, true)
  const draft = await readMaterial(f.worktree, 'requirement', f.value.id)
  assert.equal((await app.command({ action: 'confirmMaterial', entityId: f.value.id, expectedHash: draft.sha256, method: 'direct' })).ok, true)
  assert.equal(f.calls.prepared[0]!.confirmations[0]!.confirmationMethod, 'direct')
  assert.equal(f.calls.commits.length, 1)
})

test('AI-assisted confirmation rejects pending output and blank author disposition without integration', async t => {
  const f = await fixture(t), app = f.app()
  await app.command({ action: 'requestReview', entityId: f.value.id, purpose: 'material' })
  const review = (await f.store.read()).reviews[0]!, draft = await readMaterial(f.worktree, 'requirement', f.value.id)
  assertConfirmationRecovery(await app.command({ action: 'confirmMaterial', entityId: f.value.id, expectedHash: draft.sha256, method: 'ai-assisted', reviewId: review.id, authorDisposition: '已自行检查' }))
  await app.acceptSessionOutput(review.task.sessionId, { kind: 'assistant', content: reviewReport() })
  await app.acceptSessionOutput(review.task.sessionId, { kind: 'turn-ended', reason: 'completed' })
  assertConfirmationRecovery(await app.command({ action: 'confirmMaterial', entityId: f.value.id, expectedHash: draft.sha256, method: 'ai-assisted', reviewId: review.id, authorDisposition: '   ' }))
  assert.equal(f.calls.prepared.length, 0)
})

test('changing author material after review invalidates the original report and preserves the fixed review snapshot', async t => {
  const f = await fixture(t), app = f.app()
  await app.command({ action: 'requestReview', entityId: f.value.id, purpose: 'material' })
  const review = (await f.store.read()).reviews[0]!
  await app.acceptSessionOutput(review.task.sessionId, { kind: 'assistant', content: reviewReport() })
  await app.acceptSessionOutput(review.task.sessionId, { kind: 'turn-ended', reason: 'completed' })
  const original = await readMaterial(f.worktree, 'requirement', f.value.id)
  const changed = await saveMaterial(f.worktree, original.metadata, original.body + '\n作者新增业务规则。')
  f.gitState.dirtyFiles = [changed.path]
  assertConfirmationRecovery(await app.command({ action: 'confirmMaterial', entityId: f.value.id, expectedHash: changed.sha256, method: 'ai-assisted', reviewId: review.id, authorDisposition: '确认旧评审' }))
  assert.equal((await readMaterial(review.task.worktree, 'requirement', f.value.id)).sha256, original.sha256)
  assert.equal(f.calls.prepared.length, 0)
})

test('duplicate review requests recover the same local report across Host restart and reject AI self-confirm fields', async t => {
  const f = await fixture(t), app = f.app()
  await app.command({ action: 'requestReview', entityId: f.value.id, purpose: 'material' })
  const review = (await f.store.read()).reviews[0]!
  const rebooted = new StudioStore(path.join(f.root, 'state')); rebooted.useUser(1)
  const next = f.app(rebooted)
  assert.equal((await next.command({ action: 'requestReview', entityId: f.value.id, purpose: 'material' })).ok, true)
  assert.equal(f.calls.prompts.length, 1)
  assert.equal((await rebooted.read()).reviews.length, 1)
  await assert.rejects(next.acceptSessionOutput(review.task.sessionId, { kind: 'assistant', content: String.fromCharCode(96).repeat(3) + 'eadp-review\n' + JSON.stringify({ summary: 'AI self approval', findings: [], authorConfirmed: true }) + '\n' + String.fromCharCode(96).repeat(3) }), /格式无效/)
  assert.equal((await rebooted.read()).reviews[0]!.status, 'failed')
  assert.equal(f.calls.prepared.length, 0)
})

test('adoption recovery recognizes already-applied exact provenance without replacing later author edits', async t => {
  const f = await fixture(t), app = f.app()
  await app.command(f.adopt)
  const draft = await readMaterial(f.worktree, 'requirement', f.value.id)
  await saveMaterial(f.worktree, draft.metadata, draft.body + '\n采用后作者调整。')
  const adoption = (await f.store.read()).adoptions[0]!; delete adoption.applied; await f.store.save()
  const rebooted = new StudioStore(path.join(f.root, 'state')); rebooted.useUser(1)
  assert.equal((await f.app(rebooted).command(f.adopt)).ok, true)
  assert.match((await readMaterial(f.worktree, 'requirement', f.value.id)).body, /采用后作者调整/)
  assert.equal(f.calls.adoptions, 1)
})


for (const reason of ['error', 'aborted', 'completed']) test('review terminal ' + reason + ' without a valid report leaves pending and permits an explicit new-session retry', async t => {
  const f = await fixture(t), app = f.app()
  assert.equal((await app.command({ action: 'requestReview', entityId: f.value.id, purpose: 'material' })).ok, true)
  const review = (await f.store.read()).reviews[0]!
  await app.acceptSessionOutput(review.task.sessionId, { kind: 'assistant', content: '正在核对固定业务依据，尚未生成报告。' })
  assert.equal(review.status, 'pending', 'intermediate assistant text must not fail a running review')
  await app.acceptSessionOutput(review.task.sessionId, { kind: 'turn-ended', reason })
  assert.equal(review.status, 'failed')
  assert.ok(review.error)
  assert.equal((await app.command({ action: 'requestReview', entityId: f.value.id, purpose: 'material' })).ok, true)
  const next = (await f.store.read()).reviews.at(-1)!
  assert.notEqual(next.id, review.id); assert.notEqual(next.task.sessionId, review.task.sessionId)
  assert.equal(next.status, 'pending'); assert.equal(f.calls.prompts.length, 2)
})


for (const reason of ['error', 'aborted']) test('a valid-looking report followed by ' + reason + ' cannot become author-confirmable or be revived by late text', async t => {
  const f = await fixture(t), app = f.app()
  await app.command({ action: 'requestReview', entityId: f.value.id, purpose: 'material' })
  const review = (await f.store.read()).reviews[0]!
  await app.acceptSessionOutput(review.task.sessionId, { kind: 'assistant', content: reviewReport() })
  assert.equal(review.status, 'pending', 'a report is incomplete until the actual turn succeeds')
  const draft = await readMaterial(f.worktree, 'requirement', f.value.id)
  assertConfirmationRecovery(await app.command({ action: 'confirmMaterial', entityId: f.value.id, expectedHash: draft.sha256, method: 'ai-assisted', reviewId: review.id, authorDisposition: '尝试提前确认' }))
  await app.acceptSessionOutput(review.task.sessionId, { kind: 'turn-ended', reason })
  assert.equal(review.status, 'failed')
  await app.acceptSessionOutput(review.task.sessionId, { kind: 'assistant', content: reviewReport() })
  assert.equal(review.status, 'failed')
  assert.equal(f.calls.prepared.length, 0)
})

test('explicit scenario revision claims a design occupation and leaves requirement materials untouched', async t => {
  const f = await fixture(t, 'scenario'), app = f.app()
  const current = await readMaterial(f.worktree, 'scenario', f.value.id)
  f.value.materialVersion = 1; f.value.confirmationStatus = 'confirmed'; f.value.taskStatus = 'idle'
  f.value.current = { version: 1, fixed: { commitSha: head, path: current.path, sha256: current.sha256 }, metadata: current.metadata, confirmationId: 'scene-confirmation', confirmedBy: 1, confirmedAt: '', reuse: { enabled: true, reason: '' } }
  delete f.value.occupation
  const related = entity('unfinished'), completed = entity('already-completed')
  for (const requirement of [related, completed]) {
    requirement.scenarioIds = [f.value.id, 'origin']
    requirement.scenarioSources = [{ projectId: 'project', entityId: f.value.id, version: 1 }, { projectId: 'project', entityId: 'origin', version: 1 }]
  }
  const previous = await saveMaterial(f.worktree, metadata(related), body + '\n作者保留的业务细节。')
  const finished = await saveMaterial(f.worktree, metadata(completed), body + '\n已完成需求保持固定。')
  completed.materialVersion = 2; completed.confirmationStatus = 'confirmed'
  completed.current = { version: 2, fixed: { commitSha: head, path: finished.path, sha256: finished.sha256 }, metadata: finished.metadata, confirmationId: 'completed-confirmation', confirmedBy: 1, confirmedAt: '', reuse: { enabled: true, reason: '' } }
  f.remote.entities.push(related, completed)
  const original = f.api.request.bind(f.api), claims: Array<Record<string, unknown>> = []
  f.api.request = async (method, route, input) => {
    if (method === 'GET' && route.endsWith('/revision-impact')) return { requirements: [related, completed] }
    if (method === 'POST' && route.endsWith(`/entities/${f.value.id}/claim`)) {
      claims.push(input!)
      assert.equal(input!.purpose, 'design')
      assert.equal(input!.expectedRevision, f.value.revision)
      f.value.revision++; f.value.generation++
      f.value.occupation = { occupationId: 'revision-occupation', generation: f.value.generation, taskId: String(input!.taskId), clientId: String(input!.clientId), expectedRevision: f.value.revision, entityId: f.value.id, ownerId: 1, purpose: 'design', inputVersion: 1, prerequisiteBindings: [], createdAt: '' }
      return f.value
    }
    return original(method, route, input)
  }
  const state = f.ports.git.state.bind(f.ports.git)
  f.ports.git.createWorktree = async (_root, directory) => { await cp(f.worktree, directory, { recursive: true }) }
  f.ports.git.state = async directory => directory.includes(`${path.sep}worktrees${path.sep}`) ? { head, dirty: true, branch: 'studio/revision' } : state(directory)
  const impact = await app.command({ action: 'scenarioRevisionImpact', entityId: f.value.id })
  assert.equal(impact.ok, true, JSON.stringify(impact))
  assert.equal(claims.length, 0, 'viewing the impact cannot claim anything')
  assert.equal(f.value.occupation, undefined)
  const reply = await app.command({ action: 'startScenarioRevision', entityId: f.value.id, expectedRevision: f.value.revision })
  assert.equal(reply.ok, true, JSON.stringify(reply))
  assert.equal(claims.length, 1)
  const task = (await f.store.read()).tasks.findLast(task => task.entityId === f.value.id && task.purpose === 'material')!
  assert.notEqual(task.worktree, f.worktree)
  assert.equal((await readMaterial(task.worktree, 'scenario', f.value.id)).sha256, current.sha256)
  assert.equal((await readMaterial(task.worktree, 'requirement', related.id)).sha256, previous.sha256, 'requirement materials are not rebound by a scenario revision')
  assert.equal(f.value.current!.fixed.sha256, current.sha256, 'the accepted scene stays fixed while its revision is edited')
})


test('requirement attachments share source extraction, retry, context, formal archives and pruning', async t => {
  const f = await fixture(t), app = f.app()
  let reads = 0
  f.ports.readScenarioSource = async () => ++reads === 1
    ? { status: 'failed', text: '', ranges: [], error: '转换服务暂不可用' }
    : { status: 'partial', text: '实际读取的需求规则', ranges: ['page:1'], error: '第 2 页未读取' }
  const imported = await app.command({ action: 'importScenarioSource', entityId: f.value.id, operationId: 'requirement-source', name: '规则.pdf', base64: Buffer.from('原始资料').toString('base64') })
  assert.equal(imported.ok, true, JSON.stringify(imported)); await app.settle()
  const record = f.local.scenarios.find(value => value.entityId === f.value.id)!, source = record.sources[0]!
  assert.equal(source.status, 'failed'); assert.match(source.error!, /转换服务/)
  assert.ok(record.sourcePaths[source.id]!.includes(`${path.sep}scenario-sources${path.sep}project${path.sep}target${path.sep}`))
  let reply = await app.command({ action: 'selectScenarioSource', entityId: f.value.id, sourceId: source.id, selected: true, formal: true })
  assert.equal(reply.ok, false, 'unread requirement sources cannot become formal evidence')
  reply = await app.command({ action: 'retryScenarioSource', entityId: f.value.id, sourceId: source.id })
  assert.equal(reply.ok, true, JSON.stringify(reply)); await app.settle()
  assert.equal(source.status, 'partial'); assert.deepEqual(source.ranges, ['page:1'])
  const projection = await app.state(), projected = projection.materialSources!.find(value => value.entityId === f.value.id)!
  assert.equal(projected.readOnly, false); assert.equal(projected.sources[0]!.text, '')
  const context = await app.scenarioSessionContext(f.local.tasks[0]!)
  assert.deepEqual(context.readPaths, [record.sourcePaths[source.id]])
  assert.match(context.text, /实际读取的需求规则/); assert.match(context.text, /page:1/)
  assert.match(context.text, /eadp-write-proposal/)
  const original = await readMaterial(f.worktree, 'requirement', f.value.id)
  reply = await app.command({ action: 'selectScenarioSource', entityId: f.value.id, sourceId: source.id, selected: true, formal: true })
  assert.equal(reply.ok, true, JSON.stringify(reply))
  const archived = await readMaterial(f.worktree, 'requirement', f.value.id), evidence = archived.metadata.businessEvidence[0]!
  assert.equal(archived.body, original.body); assert.notEqual(archived.sha256, original.sha256)
  assert.equal(evidence.label, '规则.pdf'); assert.equal(evidence.files.length, 3)
  assert.equal(await readFile(path.join(f.worktree, evidence.files.find(file => file.path.includes('extracted-'))!.path), 'utf8'), source.text)
  reply = await app.command({ action: 'selectScenarioSource', entityId: f.value.id, sourceId: source.id, selected: false, formal: false })
  assert.equal(reply.ok, true, JSON.stringify(reply))
  assert.deepEqual((await readMaterial(f.worktree, 'requirement', f.value.id)).metadata.businessEvidence, [])
  for (const file of evidence.files) await assert.rejects(readFile(path.join(f.worktree, file.path)), { code: 'ENOENT' })
  assert.deepEqual((await app.scenarioSessionContext(f.local.tasks[0]!)).readPaths, [])
  assert.doesNotMatch((await app.scenarioSessionContext(f.local.tasks[0]!)).text, /实际读取的需求规则/)
  assert.equal(await readFile(record.sourcePaths[source.id]!, 'utf8'), '原始资料')
})

test('native image reads for requirement attachments require the current design owner and original source hash', async t => {
  const f = await fixture(t), app = f.app()
  f.ports.readScenarioSource = async () => ({ status: 'failed', text: '', ranges: [], error: '请使用 read_image' })
  assert.equal((await app.command({ action: 'importScenarioSource', entityId: f.value.id, operationId: 'image-source', name: '流程.png', base64: Buffer.from('image-bytes').toString('base64') })).ok, true)
  await app.settle()
  const record = f.local.scenarios.find(value => value.entityId === f.value.id)!, source = record.sources[0]!, filename = record.sourcePaths[source.id]!
  const output = { kind: 'source-read' as const, path: filename, attachmentId: 'native-image', ranges: ['image:1 (20×10)'] }
  await writeFile(filename, 'changed-bytes')
  await app.acceptSessionOutput('material-session', output)
  assert.equal(source.status, 'failed', 'changed original bytes cannot become actual-read evidence')
  await writeFile(filename, 'image-bytes')
  const ownerId = f.value.occupation!.ownerId; f.value.occupation!.ownerId = 2
  await app.acceptSessionOutput('material-session', output)
  assert.equal(source.status, 'failed', 'a former session cannot mark evidence after ownership changes')
  f.value.occupation!.ownerId = ownerId
  await app.acceptSessionOutput('material-session', { ...output, path: path.join(f.root, 'outside.png') })
  assert.equal(source.status, 'failed')
  await app.acceptSessionOutput('material-session', output)
  assert.equal(source.status, 'read'); assert.match(source.text, /attachmentId=native-image/)
  assert.deepEqual(source.ranges, output.ranges)
  assert.match((await app.scenarioSessionContext(f.local.tasks[0]!)).text, /attachmentId=native-image/)
})

test('confirmed requirement attachment projections use fixed evidence and reject mutation by another owner', async t => {
  const f = await fixture(t), app = f.app(), draft = await readMaterial(f.worktree, 'requirement', f.value.id)
  const archived = await archiveSelectedEvidence(f.worktree, [{ source: { id: 'fixed-pdf', name: '已确认部分读取.pdf', format: 'pdf', sha256: digest('原始PDF'), status: 'partial', ranges: ['page:1'], text: '仅读取第一页', error: '第 2 页提取失败', selected: true, formal: true }, original: Buffer.from('原始PDF') }], ['fixed-pdf'])
  f.value.current = { version: 1, fixed: { commitSha: head, path: draft.path, sha256: draft.sha256 }, metadata: { ...draft.metadata, businessEvidence: archived }, confirmationId: 'accepted', confirmedBy: 1, confirmedAt: '', reuse: { enabled: true, reason: '' } }
  const record = { projectId: 'project', entityId: f.value.id, sources: [{ id: 'local', name: '未确认本地资料', format: 'txt', sha256: digest('local'), status: 'read' as const, ranges: ['line:1'], text: '本地未确认文本', selected: true, formal: false }], sourcePaths: {} }
  f.local.scenarios.push(record); await f.store.save()
  delete f.value.occupation
  let projection = (await app.state()).materialSources!.find(value => value.entityId === f.value.id)!
  assert.equal(projection.readOnly, true); assert.equal(projection.sources[0]!.name, '已确认部分读取.pdf')
  assert.equal(projection.sources[0]!.formal, true); assert.equal(projection.sources[0]!.text, '')
  assert.equal(projection.sources[0]!.status, 'partial'); assert.equal(projection.sources[0]!.format, 'pdf')
  assert.deepEqual(projection.sources[0]!.ranges, ['page:1']); assert.match(projection.sources[0]!.error!, /第 2 页提取失败/)
  const command = { action: 'importScenarioSource' as const, entityId: f.value.id, operationId: 'blocked-source', name: '禁止.txt', base64: Buffer.from('blocked').toString('base64') }
  assert.equal((await app.command(command)).ok, false)
  f.value.occupation = { occupationId: 'other-owner', generation: 1, taskId: 'task', clientId: f.local.clientId, expectedRevision: 1, entityId: f.value.id, ownerId: 2, purpose: 'design', inputVersion: 1, prerequisiteBindings: [], createdAt: '' }
  projection = (await app.state()).materialSources!.find(value => value.entityId === f.value.id)!
  assert.equal(projection.readOnly, true); assert.equal((await app.command(command)).ok, false)
  assert.equal(record.sources.length, 1)
  f.value.current!.metadata.businessEvidence = [evidence]
  projection = (await app.state()).materialSources!.find(value => value.entityId === f.value.id)!
  assert.equal(projection.sources[0]!.status, 'failed'); assert.match(projection.sources[0]!.error!, /读取记录/)
  f.value.current!.metadata.businessEvidence = archived
  const manifest = archived[0]!.files.find(file => file.path.endsWith('.json'))!
  await writeFile(path.join(f.worktree, manifest.path), '{}')
  projection = (await f.app().state()).materialSources!.find(value => value.entityId === f.value.id)!
  assert.equal(projection.sources[0]!.status, 'failed'); assert.match(projection.sources[0]!.error!, /hash|哈希/)
})


test('a flow-only scenario with no formal evidence confirms through the fixed candidate and backend acceptance pipeline', async t => {
  const f = await fixture(t, 'scenario'), app = f.app()
  const draft = await readMaterial(f.worktree, 'scenario', f.value.id)
  const ready = await saveMaterial(f.worktree, { ...draft.metadata, businessEvidence: [], flowComplete: true, openQuestions: [{ blocking: false, limitation: '审批金额阈值在需求确认', excludedScope: '具体金额与计算口径' }] }, '提交申请 → 按金额审批 → 通过后执行，拒绝退回。')
  const reply = await app.command({ action: 'confirmMaterial', entityId: f.value.id, expectedHash: ready.sha256, method: 'direct' })
  assert.equal(reply.ok, true, JSON.stringify(reply)); await app.settle()
  assert.equal(f.local.operations[0]!.phase, 'accepted')
  assert.deepEqual(f.calls.commits[0], [ready.path])
  assert.deepEqual(f.value.current!.metadata.businessEvidence, [])
  assert.equal(f.value.current!.metadata.kind === 'scenario' && f.value.current!.metadata.flowComplete, true)
})
