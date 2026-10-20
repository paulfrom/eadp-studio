import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { createApp } from '../../apps/collaboration-api/src/app.ts'
import { loadConfig } from '../../apps/collaboration-api/src/config.ts'
import { createDatabase } from '../../apps/collaboration-api/src/persistence/database.ts'
import type { EntityView, IntegrationView, LoginResponse, MaterialIntegrationRequest, MaterialMetadata, ProjectState, ProjectView, RepairTaskView, TemplateIntegrationRequest } from '../../packages/contracts/src/index.ts'
import { defaultTemplate, fixtureToken, gitlabFixture, templateCatalog } from './gitlab-fixture.ts'

// Real SQL transactions and a test-owned GitLab HTTP boundary. This is not an
// enterprise GitLab, desktop, model-reading or Windows acceptance certificate.
const databaseUrl = process.env.STUDIO_TEST_DATABASE_URL
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const key = () => randomUUID()
const token = (value: EntityView) => { const { occupationId, generation, taskId, clientId, expectedRevision } = value.occupation!; return { occupationId, generation, taskId, clientId, expectedRevision } }
const initialSha = 'a'.repeat(40)
const evidencePath = '.eadp/evidence/interview.md'
const evidence = Buffer.from('业务访谈记录：订单提交后应进行审核。\n审核退回允许修改并重新提交。\n')
const attachmentPath = 'attachments/order-flow.txt'
const attachment = Buffer.from('订单提交 → 审核 → 通过或退回。\n')

test('scenario backend: relational persistence, fixed Git acceptance and repair authorization', { skip: !databaseUrl }, async t => {
  assert.match(new URL(databaseUrl!).pathname, /^\/eadp_auth_check_[a-z0-9]+$/)
  const gitlab = await gitlabFixture(); t.after(() => gitlab.close())
  const config = loadConfig({ DATABASE_URL: databaseUrl, PG_SSL: 'disable', GITLAB_URL: gitlab.origin, GITLAB_ALLOW_HTTP: 'true', SEI_GITLAB_TOKEN: fixtureToken })
  const database = createDatabase(config)
  await database.query(await readFile(new URL('../../apps/collaboration-api/db/schema.sql', import.meta.url), 'utf8'))
  const app = createApp(config, database); t.after(() => app.close()); await app.ready()
  const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: 'studioAdmin', password: 'admin@123' } })
  assert.equal(login.statusCode, 200, login.body)
  const headers = { authorization: `Bearer ${login.json<LoginResponse>().token}` }
  const send = (method: 'POST' | 'PUT' | 'GET', url: string, payload?: object) => app.inject({ method, url, headers, ...(payload ? { payload } : {}) })
  async function post<T>(url: string, payload: object): Promise<T> { const reply = await send('POST', url, payload); assert.equal(reply.statusCode, 200, reply.body); return reply.json<T>() }
  async function get<T>(url: string): Promise<T> { const reply = await send('GET', url); assert.equal(reply.statusCode, 200, reply.body); return reply.json<T>() }
  async function createProject(name: string) {
    const project = await post<ProjectView>('/v1/projects', { idempotencyKey: key(), name, path: `scenario-${name}`, namespaceId: 42 })
    const remote = gitlab.projects.get(project.gitlabProjectId)!
    remote.head = initialSha; remote.empty_repo = false; remote.default_branch = 'main'
    remote.manifest = { schemaVersion: 1, projectId: project.id, gitlabProjectId: remote.id, repositoryUrl: project.repositoryUrl, stableBranch: 'main', directories: ['场景', '需求', '原型代码'], scenarioTemplates: templateCatalog }
    const initialized = await post<ProjectView>(`/v1/projects/${project.id}/initialize`, { idempotencyKey: key(), commitSha: initialSha })
    remote.snapshots = new Map([[initialSha, new Map([
      ['project.assets.json', Buffer.from(JSON.stringify(remote.manifest) + '\n')], ['.template/default.md', defaultTemplate], [evidencePath, evidence], [attachmentPath, attachment],
    ])]])
    remote.commits = new Map([[initialSha, []]]); remote.comparisons = new Map()
    return { project: initialized, remote }
  }
  const { project, remote } = await createProject('primary'), base = `/v1/projects/${project.id}`
  const scene = (title: string, idempotencyKey = key()) => post<EntityView>(`${base}/entities`, { idempotencyKey, kind: 'scenario', title })
  const state = () => get<ProjectState>(base)
  async function entity(id: string) { const value = (await state()).entities.find(e => e.id === id); assert.ok(value && 'title' in value); return value as EntityView }
  const claim = (value: EntityView, purpose: 'design' | 'scenario-batch' | 'prototype' = 'design') => post<EntityView>(`${base}/entities/${value.id}/claim`, { idempotencyKey: key(), expectedRevision: value.revision, taskId: key(), clientId: key(), purpose })
  let candidateNumber = 0
  function material(value: EntityView, overrides: Partial<MaterialMetadata> = {}): MaterialMetadata {
    return { entityId: value.id, kind: value.kind, title: value.title,
      ...(value.kind === 'scenario' ? { templateId: value.templateId!, templateRef: value.templateRef! } : { categoryId: value.categoryId! }),
      scenarioIds: value.scenarioIds, prerequisites: value.prerequisites, sources: value.scenarioSources ?? [],
      businessEvidence: [{ label: '订单访谈', reference: '已选择的业务访谈', files: [{ path: evidencePath, sha256: hash(evidence) }], ranges: [{ path: evidencePath, startLine: 1, endLine: 2 }] }],
      files: [{ path: attachmentPath, sha256: hash(attachment) }],
      coreRulesPresent: true, acceptanceCriteriaPresent: true, openQuestions: [], referencedAssets: [], ...overrides } as MaterialMetadata
  }
  async function candidate(values: Array<{ value: EntityView; metadata: MaterialMetadata }>, stage: MaterialIntegrationRequest['stage'] = 'material') {
    const current = (await state()).project, sha = (++candidateNumber).toString(16).padStart(40, '0')
    const files = new Map(remote.snapshots!.get(current.recognizedHead!)!)
    const confirmations = values.map(({ value, metadata }) => {
      const path = value.kind === 'handoff' ? `handoff.${value.id}.md` : `${value.kind === 'scenario' ? '场景' : '需求'}/${value.id}.md`
      const bytes = Buffer.from('```eadp-metadata\n' + JSON.stringify(metadata) + '\n```\n\n## 自定义业务约束\n\n订单审核退回后允许重新提交，验收时可验证循环。\n')
      files.set(path, bytes)
      return { entityId: value.id, expectedRevision: value.revision, fixed: { commitSha: sha, path, sha256: hash(bytes) }, readHash: hash(bytes), authorConfirmed: true as const, confirmationMethod: 'direct' as const }
    })
    remote.snapshots!.set(sha, files); remote.commits!.set(sha, [current.recognizedHead!])
    remote.comparisons!.set(`${current.recognizedHead}:${sha}`, confirmations.map(c => ({ old_path: c.fixed.path, new_path: c.fixed.path, deleted_file: false, renamed_file: false, diff: `+${sha}:${c.entityId}` })))
    const root = values.find(v => v.value.kind === 'scenario')?.value ?? values[0]!.value
    const input: MaterialIntegrationRequest = { idempotencyKey: key(), entityId: root.id, token: token(root), stage,
      sourceSha: sha, expectedHead: current.recognizedHead!, candidateSha: sha, allowedPaths: confirmations.map(c => c.fixed.path),
      checks: { candidateSha: sha, passed: true, checks: ['materials', 'relations'].map(name => ({ name, passed: true, evidenceHash: '1'.repeat(64) })) }, confirmations,
      ...(stage === 'scenario-batch' ? { expectedAssociationRevision: root.associationRevision, batchRequirementIds: (await state()).entities.filter(e => 'frozenBy' in e && e.frozenBy.includes(root.occupation!.occupationId)).map(e => e.id) } : {}) }
    return input
  }
  async function accept(input: MaterialIntegrationRequest | TemplateIntegrationRequest) {
    const prepared = await post<IntegrationView>(`${base}/integrations`, input)
    remote.head = input.candidateSha
    const complete = { idempotencyKey: key(), ...(input.stage !== 'template' ? { token: input.token } : {}) }
    const accepted = await post<IntegrationView>(`${base}/integrations/${prepared.id}/complete`, complete)
    return { prepared, accepted, complete }
  }

  let first: EntityView
  await t.test('S01/S35 scenarios need only a name; client categories and business numbers are rejected', async () => {
    first = await scene('订单审核')
    assert.equal(first.code, 'SC-0001'); assert.equal(first.sequence, 1)
    assert.ok(first.templateRef); assert.equal(first.categoryId, undefined); assert.equal(first.current, undefined)
    assert.equal((await state()).project.categories.length, 0)
    for (const extra of [{ categoryId: 'default' }, { code: 'SC-0100' }, { sequence: 100 }]) {
      assert.equal((await send('POST', `${base}/entities`, { idempotencyKey: key(), kind: 'scenario', title: '不能自报', ...extra })).statusCode, 400)
    }
    assert.equal((await send('POST', `${base}/entities`, { idempotencyKey: key(), kind: 'requirement', title: '无来源需求', categoryId: 'any' })).statusCode, 400)
  })
  await t.test('S37/S38 concurrent retries allocate one entity, distinct operations allocate unique project-scoped numbers', async () => {
    const operation = key(), same = await Promise.all(Array.from({ length: 8 }, () => scene('重复创建', operation)))
    assert.equal(new Set(same.map(v => v.id)).size, 1); assert.equal(new Set(same.map(v => v.code)).size, 1)
    assert.deepEqual(same[0], same[1])
    const distinct = await Promise.all(Array.from({ length: 8 }, (_, i) => scene(`并发场景${i}`)))
    assert.equal(new Set(distinct.map(v => v.sequence)).size, 8)
    const other = await createProject('secondary')
    const created = await post<EntityView>(`/v1/projects/${other.project.id}/entities`, { idempotencyKey: key(), kind: 'scenario', title: '另一个项目' })
    assert.equal(created.code, 'SC-0001')
    const changed = await send('POST', `${base}/entities`, { idempotencyKey: operation, kind: 'scenario', title: '改变同一操作' })
    assert.equal(changed.statusCode, 409)
  })
  await t.test('S38 an entity-write rollback preserves the allocated number and its original operation identity', async () => {
    await database.query(`CREATE FUNCTION test_entity_failure() RETURNS trigger AS $$ BEGIN IF NEW.title='故障注入' THEN RAISE EXCEPTION 'injected entity write failure'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER test_entity_failure BEFORE INSERT ON studio_entities FOR EACH ROW EXECUTE FUNCTION test_entity_failure()`)
    const operation = key(), payload = { idempotencyKey: operation, kind: 'scenario', title: '故障注入' }
    assert.equal((await send('POST', `${base}/entities`, payload)).statusCode, 503)
    const allocated = (await database.query('SELECT entity_id,sequence,code FROM studio_entity_numbers WHERE project_id=$1 AND operation_key=$2', [project.id, operation])).rows[0]
    assert.ok(allocated)
    assert.equal((await database.query('SELECT id FROM studio_entities WHERE id=$1', [allocated.entity_id])).rowCount, 0)
    await database.query('DROP TRIGGER test_entity_failure ON studio_entities; DROP FUNCTION test_entity_failure()')
    const next = await scene('故障后的新场景')
    assert.ok(next.sequence! > Number(allocated.sequence))
    const crossAction = await send('POST', `${base}/categories`, { idempotencyKey: operation, categoryId: 'stolen-key', name: '不可占用编号操作键', expectedRevision: (await state()).project.revision })
    assert.equal(crossAction.statusCode, 409)
    const retried = await post<EntityView>(`${base}/entities`, payload)
    assert.equal(retried.id, allocated.entity_id); assert.equal(retried.code, allocated.code)
    await database.query('UPDATE studio_project_counters SET next_sequence=10000 WHERE project_id=$1', [project.id])
    assert.equal((await scene('超过四位编号')).code, 'SC-10000')
  })
  await t.test('S12/S14/S19 confirm exact fixed bytes without prescribed headings; unknown completion replays one acceptance', async () => {
    first = await claim(first)
    const input = await candidate([{ value: first, metadata: material(first) }])
    assert.equal((await send('POST', `${base}/integrations`, { ...input, confirmations: input.confirmations.map(c => ({ ...c, metadata: material(first) })) })).statusCode, 400)
    const oldHash = { ...input, idempotencyKey: key(), confirmations: input.confirmations.map(c => ({ ...c, readHash: 'f'.repeat(64) })) }
    assert.equal((await send('POST', `${base}/integrations`, oldHash)).statusCode, 422)
    const { prepared, accepted, complete } = await accept(input)
    assert.equal(accepted.status, 'accepted')
    assert.deepEqual(await post(`${base}/integrations/${prepared.id}/complete`, complete), accepted)
    assert.equal((await database.query('SELECT id FROM studio_confirmations WHERE project_id=$1 AND entity_id=$2', [project.id, first.id])).rowCount, 1)
    const operation = await get<{ action: string; result: IntegrationView }>(`${base}/operations/${complete.idempotencyKey}`)
    assert.equal(operation.result.status, 'accepted')
    first = await entity(first.id); assert.equal(first.confirmationStatus, 'confirmed'); assert.equal(first.occupation, undefined)
    assert.equal(first.current!.metadata.title, '订单审核')
    assert.deepEqual(first.files, [attachmentPath])
    const projection = (await database.query('SELECT path FROM studio_entity_files WHERE project_id=$1 AND entity_id=$2', [project.id, first.id])).rows
    assert.deepEqual(projection.map(row => row.path), [attachmentPath])
    assert.equal(first.current!.confirmedBy, 1); assert.ok(first.creator?.name); assert.ok(first.lastEditor?.name)
  })
  await t.test('S13/S33 invalid final business facts, missing fixed files and incorrect file hashes block acceptance', async () => {
    const draft = await claim(await scene('阻断验证'))
    for (const metadata of [material(draft, { coreRulesPresent: false }), material(draft, { openQuestions: [{ blocking: true, limitation: '尚未知晓', excludedScope: '待补答' }] }), material(draft, { files: [{ path: 'attachments/missing.txt', sha256: '1'.repeat(64) }] }), material(draft, { files: [{ path: evidencePath, sha256: '0'.repeat(64) }] })]) {
      const rejected = await send('POST', `${base}/integrations`, await candidate([{ value: draft, metadata }]))
      assert.ok([409, 422].includes(rejected.statusCode), rejected.body)
    }
    assert.equal((await entity(draft.id)).materialVersion, 0)
  })

  let requirement: EntityView
  await t.test('S21 requirements retain classification and at least one accepted fixed scenario source', async () => {
    const current = (await state()).project
    await post(`${base}/categories`, { idempotencyKey: key(), expectedRevision: current.revision, categoryId: 'orders', name: '订单' })
    const invalid = await send('POST', `${base}/entities`, { idempotencyKey: key(), kind: 'requirement', title: '不存在的来源', categoryId: 'orders', sources: [{ projectId: project.id, entityId: 'missing', version: 1 }] })
    assert.ok(invalid.statusCode >= 400)
    requirement = await post<EntityView>(`${base}/entities`, { idempotencyKey: key(), kind: 'requirement', title: '订单审核要求', categoryId: 'orders', sources: [{ projectId: project.id, entityId: first.id, version: 1 }] })
    assert.equal(requirement.categoryId, 'orders'); assert.equal(requirement.code, undefined)
    assert.deepEqual(requirement.scenarioSources, [{ projectId: project.id, entityId: first.id, version: 1 }])
  })
  await t.test('S23/S24 read-only history does not claim; explicit revision freezes requirements and accepts the whole batch', async () => {
    const impact = await get<{ requirements: Array<{ id: string }> }>(`${base}/entities/${first.id}/revision-impact`)
    assert.ok(impact.requirements.some(r => r.id === requirement.id))
    await get(`${base}/entities/${first.id}/versions`)
    assert.equal((await entity(first.id)).occupation, undefined)
    const rejected = await send('POST', `${base}/entities/${first.id}/claim`, { idempotencyKey: key(), expectedRevision: first.revision, taskId: key(), clientId: key(), purpose: 'design' })
    assert.equal(rejected.statusCode, 409)
    first = await claim(await entity(first.id), 'scenario-batch')
    requirement = await entity(requirement.id)
    assert.deepEqual(requirement.frozenBy, [first.occupation!.occupationId])
    const partial = await candidate([{ value: first, metadata: material(first, { title: '审核流程第二版' }) }], 'scenario-batch')
    assert.equal((await send('POST', `${base}/integrations`, partial)).statusCode, 409)
    const both = await candidate([
      { value: requirement, metadata: material(requirement, { sources: [{ projectId: project.id, entityId: first.id, version: 2 }] }) },
      { value: first, metadata: material(first, { title: '审核流程第二版' }) },
    ], 'scenario-batch')
    await accept(both)
    first = await entity(first.id); requirement = await entity(requirement.id)
    assert.equal(first.materialVersion, 2); assert.equal(first.code, 'SC-0001')
    assert.equal(requirement.materialVersion, 1); assert.deepEqual(requirement.frozenBy, [])
    assert.equal(requirement.scenarioSources![0]!.version, 2)
    const versions = await get<Array<{ metadata: MaterialMetadata }>>(`${base}/entities/${first.id}/versions`)
    assert.equal(versions.length, 2); assert.equal(versions[1]!.metadata.title, '订单审核')
  })
  await t.test('existing prototype completion, reuse and handoff still use relational fixed-version records', async () => {
    async function prototype(value: EntityView) {
      const owned = await claim(await entity(value.id), 'prototype'), current = (await state()).project
      const sha = (++candidateNumber).toString(16).padStart(40, '0'), path = `原型代码/src/${owned.id}.tsx`
      const files = new Map(remote.snapshots!.get(current.recognizedHead!)!); files.set(path, Buffer.from('export default function Page() { return <main>订单审核</main> }\n'))
      remote.snapshots!.set(sha, files); remote.commits!.set(sha, [current.recognizedHead!])
      remote.comparisons!.set(`${current.recognizedHead}:${sha}`, [{ old_path: path, new_path: path, deleted_file: false, renamed_file: false, diff: '+prototype' }])
      return accept({ idempotencyKey: key(), entityId: owned.id, token: token(owned), stage: 'prototype', sourceSha: sha, expectedHead: current.recognizedHead!, candidateSha: sha,
        allowedPaths: [path], checks: { candidateSha: sha, passed: true, checks: ['engineering', 'mock', 'browser', 'relations'].map(name => ({ name, passed: true as const, evidenceHash: '1'.repeat(64) })) },
        confirmations: [{ entityId: owned.id, expectedRevision: owned.revision, fixed: owned.current!.fixed, readHash: owned.current!.fixed.sha256, authorConfirmed: true, confirmationMethod: 'direct' }] })
    }
    const sourceCompletion = await prototype(requirement)
    assert.ok(sourceCompletion.accepted.baselineId)
    await post(`${base}/entities/${requirement.id}/eligibility`, { idempotencyKey: key(), version: 1, enabled: false, reason: '临时停止新采用' })
    await post(`${base}/entities/${requirement.id}/eligibility`, { idempotencyKey: key(), version: 1, enabled: true, reason: '恢复采用' })
    let target = await post<EntityView>(`${base}/entities`, { idempotencyKey: key(), kind: 'requirement', title: '复用审核规则', categoryId: 'orders', sources: [{ projectId: project.id, entityId: first.id, version: 2 }] })
    target = await claim(target)
    const adopted = await post<{ id: string }>(`${base}/adoptions`, { idempotencyKey: key(), source: { projectId: project.id, entityId: requirement.id, version: 1 }, targetEntityId: target.id, targetTaskId: target.occupation!.taskId, scope: 'prototype-package', adjustmentSummary: '按新订单入口调整' })
    const fixed = await accept(await candidate([{ value: target, metadata: material(target, { sources: [...target.scenarioSources!, { projectId: project.id, entityId: requirement.id, version: 1 }] }) }]))
    const premature = await send('POST', `${base}/adoptions/${adopted.id}/success`, { idempotencyKey: key(), targetConfirmationId: fixed.accepted.confirmationIds![0] })
    assert.equal(premature.statusCode, 409)
    const targetCompletion = await prototype(target)
    const succeeded = await post<{ status: string }>(`${base}/adoptions/${adopted.id}/success`, { idempotencyKey: key(), targetConfirmationId: targetCompletion.accepted.confirmationIds![0] })
    assert.equal(succeeded.status, 'succeeded')
    let handoff = await post<EntityView>(`${base}/entities`, { idempotencyKey: key(), kind: 'handoff', title: '审核交接', categoryId: 'orders' })
    handoff = await claim(handoff)
    const done = await accept(await candidate([{ value: handoff, metadata: material(handoff, { referencedAssets: [{ projectId: project.id, entityId: target.id, version: 1 }] }) }]))
    const payload = { idempotencyKey: key(), confirmationId: done.accepted.confirmationIds![0], note: '已收悉固定交接版本' }
    const receipt = await post<{ id: string }>(`${base}/entities/${handoff.id}/receipts`, payload)
    assert.deepEqual(await post(`${base}/entities/${handoff.id}/receipts`, payload), receipt)
    const receipts = await get<Array<{ id: string; actorId: number }>>(`${base}/entities/${handoff.id}/receipts`)
    assert.equal(receipts.length, 1); assert.equal(receipts[0]!.actorId, 1)
    assert.ok((await state()).baselines.length >= 2)
  })
  await t.test('S08/S29/S30 template publication has a separate scope, preserves old bindings and is idempotent', async () => {
    const current = (await state()).project, sha = (++candidateNumber).toString(16).padStart(40, '0')
    const files = new Map(remote.snapshots!.get(current.recognizedHead!)!), newPath = '.template/review.md'
    const manifest = JSON.parse(Buffer.from(files.get('project.assets.json')!).toString())
    manifest.scenarioTemplates = { defaultTemplateId: 'review', templates: [...templateCatalog.templates, { id: 'review', name: '审核模板', path: newPath }] }
    files.set('project.assets.json', Buffer.from(JSON.stringify(manifest) + '\n')); files.set(newPath, Buffer.from('## 审核范围\n\n## 验收\n'))
    remote.snapshots!.set(sha, files); remote.commits!.set(sha, [current.recognizedHead!]); remote.comparisons!.set(`${current.recognizedHead}:${sha}`, ['project.assets.json', newPath].map(path => ({ old_path: path, new_path: path, deleted_file: false, renamed_file: false, diff: '+template' })))
    const input: TemplateIntegrationRequest = { idempotencyKey: key(), stage: 'template', expectedProjectRevision: current.revision, sourceSha: sha, expectedHead: current.recognizedHead!, candidateSha: sha,
      allowedPaths: ['project.assets.json', newPath], checks: { candidateSha: sha, passed: true, checks: [{ name: 'templates', passed: true, evidenceHash: '1'.repeat(64) }] } }
    const before = (await entity(first.id)).templateRef
    const { accepted } = await accept(input)
    assert.equal(accepted.entityId, undefined)
    assert.deepEqual((await entity(first.id)).templateRef, before)
    const fresh = await scene('新默认模板场景')
    assert.equal(fresh.templateId, 'review'); assert.equal(fresh.templateRef!.commitSha, sha)
    assert.equal((await entity(first.id)).materialVersion, 2)
    assert.equal((await get<{ templates: unknown[] }>(`${base}/templates`)).templates.length, 2)
    let revising = await claim(await entity(first.id), 'scenario-batch')
    const switched = await send('PUT', `${base}/entities/${first.id}/template`, { idempotencyKey: key(), token: token(revising), templateId: fresh.templateId, templateRef: fresh.templateRef })
    assert.equal(switched.statusCode, 200, switched.body)
    revising = switched.json<EntityView>(); assert.equal(revising.templateId, 'review'); assert.deepEqual(revising.current!.metadata.templateRef, before)
    const renamed = await send('PUT', `${base}/entities/${first.id}`, { idempotencyKey: key(), token: token(revising), title: '用户修改展示名称', summary: '修订目录摘要' })
    assert.equal(renamed.statusCode, 200, renamed.body)
    revising = renamed.json<EntityView>(); assert.equal(revising.code, 'SC-0001'); assert.equal(revising.id, first.id)
    assert.equal(revising.current!.metadata.title, '审核流程第二版')
    await post(`${base}/entities/${first.id}/cancel`, { idempotencyKey: key(), token: token(revising), reason: '保留已确认版本，结束本次修订' })
  })
  await t.test('S15/S16/S17/S34 paused repair resumes explicitly with the same three-round budget and final hash', async () => {
    const draft = await claim(await scene('授权修复场景'))
    let repair = await post<RepairTaskView>(`${base}/entities/${draft.id}/repairs`, { idempotencyKey: key(), token: token(draft), userActionId: key(), startHash: '1'.repeat(64) })
    const event = async (payload: object) => { repair = await post<RepairTaskView>(`${base}/repairs/${repair.id}/events`, { idempotencyKey: key(), token: token(draft), expectedHash: repair.currentHash, ...payload }); return repair }
    await event({ type: 'round', hashAfter: '2'.repeat(64), improved: true }); await event({ type: 'round', hashAfter: '3'.repeat(64), improved: true })
    await event({ type: 'pause', reason: 'business-answer-required' }); assert.equal(repair.status, 'paused'); assert.equal(repair.roundsUsed, 2)
    const final = await candidate([{ value: draft, metadata: material(draft) }])
    final.confirmations[0] = { ...final.confirmations[0]!, confirmationMethod: 'ai-repair', repairTaskId: repair.id }
    assert.equal((await send('POST', `${base}/integrations`, final)).statusCode, 409)
    const resumeAction = key()
    assert.equal((await send('POST', `${base}/repairs/${repair.id}/events`, { idempotencyKey: key(), token: token(draft), expectedHash: repair.currentHash, type: 'chat' })).statusCode, 400)
    await event({ type: 'resume', userActionId: resumeAction }); assert.equal(repair.roundsUsed, 2)
    await event({ type: 'pause', reason: 'business-answer-required' })
    assert.equal((await send('POST', `${base}/repairs/${repair.id}/events`, { idempotencyKey: key(), token: token(draft), expectedHash: repair.currentHash, type: 'resume', userActionId: resumeAction })).statusCode, 409)
    await event({ type: 'resume', userActionId: key() })
    await event({ type: 'round', hashAfter: final.confirmations[0]!.fixed.sha256, improved: true }); assert.equal(repair.roundsUsed, 3)
    assert.equal((await send('POST', `${base}/repairs/${repair.id}/events`, { idempotencyKey: key(), token: token(draft), expectedHash: repair.currentHash, type: 'round', hashAfter: '4'.repeat(64), improved: true })).statusCode, 409)
    await accept({ ...final, idempotencyKey: key() })
    assert.equal((await get<RepairTaskView>(`${base}/repairs/${repair.id}`)).status, 'completed')
    const stored = (await database.query('SELECT method,repair_task_id FROM studio_confirmations WHERE entity_id=$1', [draft.id])).rows[0]
    assert.equal(stored.method, 'repair'); assert.equal(stored.repair_task_id, repair.id)
  })
  await t.test('S18 termination and occupation cancellation revoke repair authority without restoring it', async () => {
    const draft = await claim(await scene('冲突停止'))
    const repair = await post<RepairTaskView>(`${base}/entities/${draft.id}/repairs`, { idempotencyKey: key(), token: token(draft), userActionId: key(), startHash: '1'.repeat(64) })
    await post(`${base}/entities/${draft.id}/cancel`, { idempotencyKey: key(), token: token(draft), reason: '取消本次设计' })
    const ended = await get<RepairTaskView>(`${base}/repairs/${repair.id}`)
    assert.equal(ended.status, 'terminated'); assert.equal(ended.terminationReason, 'occupation-ended')
    const stale = await send('POST', `${base}/repairs/${repair.id}/events`, { idempotencyKey: key(), token: token(draft), type: 'resume', expectedHash: ended.currentHash, userActionId: key() })
    assert.equal(stale.statusCode, 409)
  })
  await t.test('repair without improvement stops early and a user edit revokes an active authorization', async () => {
    let draft = await claim(await scene('修复授权边界'))
    const initialAction = key(), start = { idempotencyKey: key(), token: token(draft), userActionId: initialAction, startHash: '5'.repeat(64) }
    let repair = await post<RepairTaskView>(`${base}/entities/${draft.id}/repairs`, start)
    repair = await post<RepairTaskView>(`${base}/repairs/${repair.id}/events`, { idempotencyKey: key(), token: token(draft), type: 'round', expectedHash: repair.currentHash, hashAfter: '6'.repeat(64), improved: false })
    assert.equal(repair.status, 'terminated'); assert.equal(repair.roundsUsed, 1); assert.equal(repair.terminationReason, 'no-improvement')
    assert.equal((await send('POST', `${base}/entities/${draft.id}/repairs`, { ...start, idempotencyKey: key() })).statusCode, 409)
    repair = await post<RepairTaskView>(`${base}/entities/${draft.id}/repairs`, { ...start, idempotencyKey: key(), userActionId: key() })
    const edit = await send('PUT', `${base}/entities/${draft.id}`, { idempotencyKey: key(), token: token(draft), title: '用户手动改名' })
    assert.equal(edit.statusCode, 200, edit.body); draft = edit.json<EntityView>()
    repair = await get<RepairTaskView>(`${base}/repairs/${repair.id}`)
    assert.equal(repair.status, 'terminated'); assert.equal(repair.terminationReason, 'concurrent-edit')
    await post(`${base}/entities/${draft.id}/cancel`, { idempotencyKey: key(), token: token(draft), reason: '结束测试' })
  })
  await t.test('a prepared integration rechecks edit permission before accepting the pushed candidate', async () => {
    const draft = await claim(await scene('权限变化'))
    const input = await candidate([{ value: draft, metadata: material(draft) }])
    const prepared = await post<IntegrationView>(`${base}/integrations`, input)
    remote.head = input.candidateSha; remote.memberLevel = 20
    const complete = { idempotencyKey: key(), token: input.token }
    const denied = await send('POST', `${base}/integrations/${prepared.id}/complete`, complete)
    assert.equal(denied.statusCode, 403, denied.body)
    assert.equal((await database.query('SELECT material_version FROM studio_entities WHERE project_id=$1 AND id=$2', [project.id, draft.id])).rows[0].material_version, 0)
    remote.memberLevel = 40
    assert.equal((await post<IntegrationView>(`${base}/integrations/${prepared.id}/complete`, complete)).status, 'accepted')
  })
  await t.test('fixed material, evidence and conversations never become backend JSON snapshots', async () => {
    const removed = await database.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND (column_name IN ('metadata','body','content','messages','prompt','conversation') OR table_name IN ('studio_project_creations','studio_confirmation_files','studio_confirmation_evidence'))")
    assert.equal(removed.rowCount, 0)
    const records = await database.query('SELECT request AS payload FROM studio_integrations UNION ALL SELECT result AS payload FROM studio_operations UNION ALL SELECT data AS payload FROM studio_audit UNION ALL SELECT detail AS payload FROM studio_repair_task_events')
    for (const row of records.rows) assert.doesNotMatch(JSON.stringify(row.payload), /"(?:metadata|businessEvidence|files|openQuestions|coreRulesPresent|acceptanceCriteriaPresent|body|messages)"/)
  })
})
