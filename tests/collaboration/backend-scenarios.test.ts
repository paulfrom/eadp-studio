import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { createApp } from '../../apps/collaboration-api/src/app.ts'
import { loadConfig } from '../../apps/collaboration-api/src/config.ts'
import { createDatabase } from '../../apps/collaboration-api/src/persistence/database.ts'
import type { EntityView, IntegrationView, LoginResponse, MaterialIntegrationRequest, MaterialMetadata, ProjectState, ProjectView, RepairTaskView, TemplateIntegrationRequest } from '../../packages/contracts/src/index.ts'
import { generalScenarioDocument, materialPathOf, type MaterialKind } from '../../packages/asset-domain/src/index.ts'
import { defaultTemplate, fixtureToken, gitlabFixture, requirementCatalog, requirementTemplate, templateCatalog } from './gitlab-fixture.ts'

// Real SQL transactions and a test-owned GitLab HTTP boundary. This is not an
// enterprise GitLab, desktop, model-reading or Windows acceptance certificate.
const databaseUrl = process.env.STUDIO_TEST_DATABASE_URL
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const key = () => randomUUID()
const token = (value: EntityView) => { const { occupationId, generation, taskId, clientId, expectedRevision } = value.occupation!; return { occupationId, generation, taskId, clientId, expectedRevision } }
const errorCode = (reply: { json: <T>() => T }) => reply.json<{ error: { code: string } }>().error.code
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
    const created = await post<ProjectView>('/v1/projects', { idempotencyKey: key(), name, path: `scenario-${name}`, namespaceId: 42 })
    const remote = gitlab.projects.get(created.gitlabProjectId)!
    remote.head = initialSha; remote.empty_repo = false; remote.default_branch = 'main'
    remote.manifest = { schemaVersion: 1, projectId: created.id, gitlabProjectId: remote.id, repositoryUrl: created.repositoryUrl, stableBranch: 'main', directories: ['场景', '需求', '交接', '原型代码'], scenarioTemplates: templateCatalog, requirementTemplates: requirementCatalog }
    remote.generalDocument = generalScenarioDocument(created.generalScenario!.entityId)
    const project = await post<ProjectView>(`/v1/projects/${created.id}/initialize`, { idempotencyKey: key(), commitSha: initialSha })
    remote.snapshots = new Map([[initialSha, new Map<string, Uint8Array>([
      ['project.assets.json', Buffer.from(JSON.stringify(remote.manifest) + '\n')],
      ['.template/default.md', defaultTemplate],
      ['.template/requirement.md', requirementTemplate],
      ['场景/通用场景.md', Buffer.from(remote.generalDocument)],
      [evidencePath, evidence], [attachmentPath, attachment],
    ])]])
    remote.commits = new Map([[initialSha, []]]); remote.comparisons = new Map()
    return { project, remote }
  }
  const { project, remote } = await createProject('primary'), base = `/v1/projects/${project.id}`
  const scene = (title: string, idempotencyKey = key()) => post<EntityView>(`${base}/entities`, { idempotencyKey, kind: 'scenario', title })
  const state = () => get<ProjectState>(base)
  async function entity(id: string) { const value = (await state()).entities.find(e => e.id === id); assert.ok(value && 'title' in value); return value as EntityView }
  const claim = (value: EntityView, purpose: 'design' | 'prototype' = 'design') => post<EntityView>(`${base}/entities/${value.id}/claim`, { idempotencyKey: key(), expectedRevision: value.revision, taskId: key(), clientId: key(), purpose })
  const requirementRef = async () => ({ commitSha: (await state()).project.recognizedHead!, path: '.template/requirement.md', sha256: hash(requirementTemplate) })
  const requirement = async (title: string, sources: Array<{ projectId: string; entityId: string; version: number }>, idempotencyKey = key()) =>
    post<EntityView>(`${base}/entities`, { idempotencyKey, kind: 'requirement', title, templateId: 'requirement', templateRef: await requirementRef(), sources })
  let candidateNumber = 0
  function material(value: EntityView, overrides: Partial<MaterialMetadata> = {}): MaterialMetadata {
    return { entityId: value.id, kind: value.kind, title: value.title,
      ...(value.kind === 'scenario' || value.kind === 'requirement' ? { templateId: value.templateId!, templateRef: value.templateRef! } : {}),
      scenarioIds: value.scenarioIds, prerequisites: value.prerequisites, sources: value.scenarioSources ?? [],
      businessEvidence: [{ label: '订单访谈', reference: '已选择的业务访谈', files: [{ path: evidencePath, sha256: hash(evidence) }], ranges: [{ path: evidencePath, startLine: 1, endLine: 2 }] }],
      files: [{ path: attachmentPath, sha256: hash(attachment) }],
      ...(value.kind === 'scenario' ? { flowComplete: true } : { coreRulesPresent: true, acceptanceCriteriaPresent: true }), openQuestions: [], referencedAssets: [], ...overrides } as MaterialMetadata
  }
  async function candidate(values: Array<{ value: EntityView; metadata: MaterialMetadata }>, stage: MaterialIntegrationRequest['stage'] = 'material') {
    const current = (await state()).project, sha = (++candidateNumber).toString(16).padStart(40, '0')
    const files = new Map(remote.snapshots!.get(current.recognizedHead!)!)
    const removals: string[] = []
    const confirmations = values.map(({ value, metadata }) => {
      const path = materialPathOf(value.kind as MaterialKind, metadata.title)
      const bytes = Buffer.from('```eadp-metadata\n' + JSON.stringify(metadata) + '\n```\n\n## 自定义业务约束\n\n订单审核退回后允许重新提交，验收时可验证循环。\n')
      files.set(path, bytes)
      // A title edit renames the material: the candidate removes its own previous confirmed path.
      const previous = value.current ? materialPathOf(value.kind as MaterialKind, value.title) : path
      if (previous !== path) { files.delete(previous); removals.push(previous) }
      return { entityId: value.id, expectedRevision: value.revision, fixed: { commitSha: sha, path, sha256: hash(bytes) }, readHash: hash(bytes), authorConfirmed: true as const, confirmationMethod: 'direct' as const }
    })
    remote.snapshots!.set(sha, files); remote.commits!.set(sha, [current.recognizedHead!])
    remote.comparisons!.set(`${current.recognizedHead}:${sha}`, [
      ...confirmations.map(c => ({ old_path: c.fixed.path, new_path: c.fixed.path, deleted_file: false, renamed_file: false, diff: `+${sha}:${c.entityId}` })),
      ...removals.map(path => ({ old_path: path, new_path: path, deleted_file: true, renamed_file: false, diff: `-${sha}` })),
    ])
    const root = values.find(v => v.value.kind === 'scenario')?.value ?? values[0]!.value
    const input: MaterialIntegrationRequest = { idempotencyKey: key(), entityId: root.id, token: token(root), stage,
      sourceSha: sha, expectedHead: current.recognizedHead!, candidateSha: sha, allowedPaths: [...confirmations.map(c => c.fixed.path), ...removals],
      checks: { candidateSha: sha, passed: true, checks: ['materials', 'relations'].map(name => ({ name, passed: true, evidenceHash: '1'.repeat(64) })) }, confirmations }
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
    assert.equal(first.code, 'SC-0002', 'Project creation reserves SC-0001 for the built-in general scenario'); assert.equal(first.sequence, 2)
    assert.ok(first.templateRef); assert.equal(first.current, undefined)
    const current = (await state()).project
    assert.equal(current.generalScenario?.code, 'SC-0001')
    assert.equal('categories' in current, false, 'The project view no longer carries requirement categories')
    for (const extra of [{ categoryId: 'default' }, { code: 'SC-0100' }, { sequence: 100 }]) {
      assert.equal((await send('POST', `${base}/entities`, { idempotencyKey: key(), kind: 'scenario', title: '不能自报', ...extra })).statusCode, 400)
    }
    assert.equal((await send('POST', `${base}/entities`, { idempotencyKey: key(), kind: 'requirement', title: '无模板需求', sources: [{ projectId: project.id, entityId: first.id, version: 1 }] })).statusCode, 400)
  })
  await t.test('S37/S38 concurrent retries allocate one entity, distinct operations allocate unique project-scoped numbers', async () => {
    const operation = key(), same = await Promise.all(Array.from({ length: 8 }, () => scene('重复创建', operation)))
    assert.equal(new Set(same.map(v => v.id)).size, 1); assert.equal(new Set(same.map(v => v.code)).size, 1)
    assert.deepEqual(same[0], same[1])
    const distinct = await Promise.all(Array.from({ length: 8 }, (_, i) => scene(`并发场景${i}`)))
    assert.equal(new Set(distinct.map(v => v.sequence)).size, 8)
    const other = await createProject('secondary')
    const created = await post<EntityView>(`/v1/projects/${other.project.id}/entities`, { idempotencyKey: key(), kind: 'scenario', title: '另一个项目' })
    assert.equal(created.code, 'SC-0002')
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
    const crossAction = await send('POST', `${base}/entities/${first.id}/claim`, { idempotencyKey: operation, expectedRevision: first.revision, taskId: key(), clientId: key(), purpose: 'design' })
    assert.equal(crossAction.statusCode, 409)
    assert.equal(errorCode(crossAction), 'IDEMPOTENCY_CONFLICT')
    const retried = await post<EntityView>(`${base}/entities`, payload)
    assert.equal(retried.id, allocated.entity_id); assert.equal(retried.code, allocated.code)
    await database.query("UPDATE studio_project_counters SET next_sequence=10000 WHERE project_id=$1 AND kind='scenario'", [project.id])
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
    for (const metadata of [material(draft, { flowComplete: false }), material(draft, { openQuestions: [{ blocking: true, limitation: '尚未知晓', excludedScope: '待补答' }] }), material(draft, { files: [{ path: 'attachments/missing.txt', sha256: '1'.repeat(64) }] }), material(draft, { files: [{ path: evidencePath, sha256: '0'.repeat(64) }] })]) {
      const rejected = await send('POST', `${base}/integrations`, await candidate([{ value: draft, metadata }]))
      assert.ok([409, 422].includes(rejected.statusCode), rejected.body)
    }
    assert.equal((await entity(draft.id)).materialVersion, 0)
  })

  let reqA: EntityView, reqB: EntityView, reqC: EntityView
  await t.test('R01 requirement reserve returns a stable REQ number and identity, and failures never reclaim numbers', async () => {
    const operation = key()
    const input = { idempotencyKey: operation, kind: 'requirement', title: '订单审核要求', templateId: 'requirement', templateRef: await requirementRef(), sources: [{ projectId: project.id, entityId: first.id, version: 1 }] }
    reqA = await post<EntityView>(`${base}/entities`, input)
    assert.equal(reqA.code, 'REQ-0001'); assert.equal(reqA.sequence, 1)
    const replay = await post<EntityView>(`${base}/entities`, input)
    assert.equal(replay.id, reqA.id); assert.equal(replay.code, reqA.code); assert.deepEqual(replay, reqA)
    await database.query(`CREATE FUNCTION test_requirement_failure() RETURNS trigger AS $$ BEGIN IF NEW.title='需求故障注入' THEN RAISE EXCEPTION 'injected requirement write failure'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER test_requirement_failure BEFORE INSERT ON studio_entities FOR EACH ROW EXECUTE FUNCTION test_requirement_failure()`)
    const failedOperation = key()
    const failing = { idempotencyKey: failedOperation, kind: 'requirement', title: '需求故障注入', templateId: 'requirement', templateRef: await requirementRef(), sources: [{ projectId: project.id, entityId: first.id, version: 1 }] }
    assert.equal((await send('POST', `${base}/entities`, failing)).statusCode, 503)
    const allocated = (await database.query('SELECT entity_id,sequence,code FROM studio_entity_numbers WHERE project_id=$1 AND operation_key=$2', [project.id, failedOperation])).rows[0]
    assert.ok(allocated)
    assert.equal(allocated.code, 'REQ-0002')
    assert.equal((await database.query('SELECT id FROM studio_entities WHERE id=$1', [allocated.entity_id])).rowCount, 0)
    await database.query('DROP TRIGGER test_requirement_failure ON studio_entities; DROP FUNCTION test_requirement_failure()')
    const next = await requirement('失败后的新需求', [{ projectId: project.id, entityId: first.id, version: 1 }])
    assert.ok(next.sequence! > Number(allocated.sequence))
    const retried = await post<EntityView>(`${base}/entities`, failing)
    assert.equal(retried.id, allocated.entity_id); assert.equal(retried.code, 'REQ-0002')
  })
  await t.test('R02 renames keep the requirement code and same-title requirements receive递增 numbers', async () => {
    let draft = await claim(reqA)
    const renamed = await send('PUT', `${base}/entities/${reqA.id}`, { idempotencyKey: key(), token: token(draft), title: '订单审核与退回要求', summary: '改名验证编号稳定' })
    assert.equal(renamed.statusCode, 200, renamed.body)
    draft = renamed.json<EntityView>()
    assert.equal(draft.id, reqA.id); assert.equal(draft.code, 'REQ-0001'); assert.equal(draft.title, '订单审核与退回要求')
    await post(`${base}/entities/${reqA.id}/cancel`, { idempotencyKey: key(), token: token(draft), reason: '结束改名验证' })
    reqA = await entity(reqA.id)
    reqB = await requirement('同名需求', [{ projectId: project.id, entityId: first.id, version: 1 }])
    reqC = await requirement('同名需求', [{ projectId: project.id, entityId: first.id, version: 1 }])
    assert.notEqual(reqB.id, reqC.id)
    assert.equal(Number(reqC.sequence), Number(reqB.sequence) + 1)
    assert.notEqual(reqB.code, reqC.code)
  })
  await t.test('R04 requirement reserve enforces the template binding and accepted same-project scenario sources', async () => {
    const template = { templateId: 'requirement', templateRef: await requirementRef() }
    const source = { projectId: project.id, entityId: first.id, version: 1 }
    assert.equal((await send('POST', `${base}/entities`, { idempotencyKey: key(), kind: 'requirement', title: '缺模板引用', templateId: template.templateId, sources: [source] })).statusCode, 400)
    assert.equal((await send('POST', `${base}/entities`, { idempotencyKey: key(), kind: 'requirement', title: '缺来源需求', ...template })).statusCode, 400)
    assert.equal((await send('POST', `${base}/entities`, { idempotencyKey: key(), kind: 'requirement', title: '空来源需求', ...template, sources: [] })).statusCode, 400)
    const crossProject = await send('POST', `${base}/entities`, { idempotencyKey: key(), kind: 'requirement', title: '跨项目来源', ...template, sources: [{ projectId: 'some-other-project', entityId: first.id, version: 1 }] })
    assert.equal(crossProject.statusCode, 422, crossProject.body); assert.equal(errorCode(crossProject), 'SCENARIO_SOURCE_REQUIRED')
    const unknown = await send('POST', `${base}/entities`, { idempotencyKey: key(), kind: 'requirement', title: '不存在来源', ...template, sources: [{ projectId: project.id, entityId: 'missing-scenario', version: 1 }] })
    assert.equal(unknown.statusCode, 404, unknown.body); assert.equal(errorCode(unknown), 'ENTITY_NOT_FOUND')
    const future = await send('POST', `${base}/entities`, { idempotencyKey: key(), kind: 'requirement', title: '未接受版本', ...template, sources: [{ projectId: project.id, entityId: first.id, version: (await entity(first.id)).materialVersion + 1 }] })
    assert.equal(future.statusCode, 409, future.body); assert.equal(errorCode(future), 'SCENARIO_VERSION_MISMATCH')
    const duplicated = await send('POST', `${base}/entities`, { idempotencyKey: key(), kind: 'requirement', title: '重复来源', ...template, sources: [source, source] })
    assert.equal(duplicated.statusCode, 422, duplicated.body); assert.equal(errorCode(duplicated), 'SCENARIO_SOURCE_REQUIRED')
    const general = (await state()).entities.find(value => (value as EntityView).builtinKey === 'general') as EntityView | undefined
    assert.ok(general, 'The initialized project contains the system-provisioned general scenario')
    assert.equal(general.code, 'SC-0001'); assert.equal(general.materialVersion, 1)
    const viaGeneral = await requirement('通用来源需求', [{ projectId: project.id, entityId: general.id, version: 1 }])
    assert.deepEqual(viaGeneral.scenarioSources, [{ projectId: project.id, entityId: general.id, version: 1 }])
    const editGeneral = await send('POST', `${base}/entities/${general.id}/claim`, { idempotencyKey: key(), expectedRevision: general.revision, taskId: key(), clientId: key(), purpose: 'design' })
    assert.equal(editGeneral.statusCode, 409, editGeneral.body); assert.equal(errorCode(editGeneral), 'BUILTIN_SCENARIO_IMMUTABLE')
    assert.equal((await send('POST', `${base}/entities`, { idempotencyKey: key(), kind: 'scenario', title: '伪造预置', builtinKey: 'general' })).statusCode, 400)
  })
  await t.test('R11 requirements enforce business quality with general sources while accepting non-GWT wording', async () => {
    const general = (await state()).entities.find(value => value.builtinKey === 'general')!
    let value = await claim(await requirement('非GWT需求验收', [{ projectId: project.id, entityId: general.id, version: 1 }]))
    for (const override of [
      { coreRulesPresent: false }, { acceptanceCriteriaPresent: false }, { businessEvidence: [] },
      { openQuestions: [{ blocking: true, limitation: '核心授权未明确', excludedScope: '不确认授权范围' }] },
    ]) {
      const rejected = await send('POST', `${base}/integrations`, await candidate([{ value, metadata: material(value, override) }]))
      assert.equal(rejected.statusCode, 422, rejected.body)
    }
    await accept(await candidate([{ value, metadata: material(value) }]))
    value = await entity(value.id)
    assert.equal(value.confirmationStatus, 'confirmed'); assert.equal(value.materialVersion, 1)
  })
  await t.test('R13 a confirmed scenario revises under a plain design occupation; relations never freeze or auto-advance', async () => {
    const impact = await get<{ requirements: Array<{ id: string }> }>(`${base}/entities/${first.id}/revision-impact`)
    assert.ok(impact.requirements.some(r => r.id === reqA.id))
    await get(`${base}/entities/${first.id}/versions`)
    assert.equal((await entity(first.id)).occupation, undefined, 'Read-only inspection must not create an occupation')
    assert.deepEqual((await entity(reqA.id)).scenarioSources, [{ projectId: project.id, entityId: first.id, version: 1 }])
    const revising = await claim(await entity(first.id))
    await accept(await candidate([{ value: revising, metadata: material(revising, { title: '审核流程第二版' }) }]))
    first = await entity(first.id)
    assert.equal(first.materialVersion, 2); assert.equal(first.code, 'SC-0002'); assert.equal(first.occupation, undefined)
    const versions = await get<Array<{ metadata: MaterialMetadata }>>(`${base}/entities/${first.id}/versions`)
    assert.equal(versions.length, 2); assert.equal(versions[0]!.metadata.title, '审核流程第二版'); assert.equal(versions[1]!.metadata.title, '订单审核')
    const draft = await claim(await entity(reqA.id))
    await accept(await candidate([{ value: draft, metadata: material(draft) }]))
    reqA = await entity(reqA.id)
    assert.equal(reqA.materialVersion, 1)
    assert.deepEqual(reqA.scenarioSources, [{ projectId: project.id, entityId: first.id, version: 1 }], 'A scenario revision must not advance the requirement source binding')
  })
  await t.test('R12 prerequisite relations validate identity, duplication, cycles and accepted versions without blocking document confirmation', async () => {
    let dependent = await claim(await entity(reqB.id))
    const relations = (prerequisites: Array<{ requirementId: string; version: number }>) => send('PUT', `${base}/entities/${dependent.id}/relations`, { idempotencyKey: key(), token: token(dependent), sources: dependent.scenarioSources, scenarioIds: dependent.scenarioIds, prerequisites })
    const self = await relations([{ requirementId: dependent.id, version: 1 }])
    assert.equal(self.statusCode, 409, self.body); assert.equal(errorCode(self), 'INVALID_PREREQUISITE')
    const duplicate = await relations([{ requirementId: reqA.id, version: 1 }, { requirementId: reqA.id, version: 1 }])
    assert.equal(duplicate.statusCode, 409, duplicate.body); assert.equal(errorCode(duplicate), 'DUPLICATE_PREREQUISITE')
    const unconfirmed = await relations([{ requirementId: reqC.id, version: 1 }])
    assert.equal(unconfirmed.statusCode, 409, unconfirmed.body); assert.equal(errorCode(unconfirmed), 'PREREQUISITE_UNCONFIRMED')
    const future = await relations([{ requirementId: reqA.id, version: 2 }])
    assert.equal(future.statusCode, 409, future.body); assert.equal(errorCode(future), 'PREREQUISITE_UNCONFIRMED')
    const valid = await relations([{ requirementId: reqA.id, version: 1 }])
    assert.equal(valid.statusCode, 200, valid.body)
    dependent = valid.json<EntityView>()
    await accept(await candidate([{ value: dependent, metadata: material(dependent) }]))
    dependent = await entity(dependent.id)
    assert.equal(dependent.materialVersion, 1, 'Document confirmation is not blocked by a prerequisite without production evidence')
    assert.deepEqual(dependent.prerequisites, [{ requirementId: reqA.id, version: 1 }])
    const prematurePrototype = await send('POST', `${base}/entities/${dependent.id}/claim`, { idempotencyKey: key(), expectedRevision: dependent.revision, taskId: key(), clientId: key(), purpose: 'prototype' })
    assert.equal(prematurePrototype.statusCode, 409, prematurePrototype.body); assert.equal(errorCode(prematurePrototype), 'PREREQUISITE_INCOMPLETE')
    const upstream = await claim(await entity(reqA.id))
    const cycle = await send('PUT', `${base}/entities/${upstream.id}/relations`, { idempotencyKey: key(), token: token(upstream), sources: upstream.scenarioSources, scenarioIds: upstream.scenarioIds, prerequisites: [{ requirementId: dependent.id, version: 1 }] })
    assert.equal(cycle.statusCode, 409, cycle.body); assert.equal(errorCode(cycle), 'DEPENDENCY_CYCLE')
    await post(`${base}/entities/${upstream.id}/cancel`, { idempotencyKey: key(), token: token(upstream), reason: '结束关系验证' })
    reqB = dependent
  })
  await t.test('integrations confirm exactly their single occupied entity', async () => {
    const left = await claim(await scene('联合确认甲')), right = await claim(await scene('联合确认乙'))
    const joint = await candidate([{ value: left, metadata: material(left) }, { value: right, metadata: material(right) }])
    const rejected = await send('POST', `${base}/integrations`, joint)
    assert.equal(rejected.statusCode, 422, rejected.body)
    assert.equal(errorCode(rejected), 'SINGLE_ENTITY_REQUIRED')
    await accept(await candidate([{ value: left, metadata: material(left) }]))
    assert.equal((await entity(left.id)).materialVersion, 1)
    await post(`${base}/entities/${right.id}/cancel`, { idempotencyKey: key(), token: token(right), reason: '结束联合确认验证' })
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
    const sourceCompletion = await prototype(reqA)
    assert.ok(sourceCompletion.accepted.baselineId)
    await post(`${base}/entities/${reqA.id}/eligibility`, { idempotencyKey: key(), version: 1, enabled: false, reason: '临时停止新采用' })
    await post(`${base}/entities/${reqA.id}/eligibility`, { idempotencyKey: key(), version: 1, enabled: true, reason: '恢复采用' })
    let target = await requirement('复用审核规则', [{ projectId: project.id, entityId: first.id, version: 2 }])
    target = await claim(target)
    const adopted = await post<{ id: string }>(`${base}/adoptions`, { idempotencyKey: key(), source: { projectId: project.id, entityId: reqA.id, version: 1 }, targetEntityId: target.id, targetTaskId: target.occupation!.taskId, scope: 'prototype-package', adjustmentSummary: '按新订单入口调整' })
    const fixed = await accept(await candidate([{ value: target, metadata: material(target, { sources: [...target.scenarioSources!, { projectId: project.id, entityId: reqA.id, version: 1 }] }) }]))
    const premature = await send('POST', `${base}/adoptions/${adopted.id}/success`, { idempotencyKey: key(), targetConfirmationId: fixed.accepted.confirmationIds![0] })
    assert.equal(premature.statusCode, 409)
    const targetCompletion = await prototype(target)
    const succeeded = await post<{ status: string }>(`${base}/adoptions/${adopted.id}/success`, { idempotencyKey: key(), targetConfirmationId: targetCompletion.accepted.confirmationIds![0] })
    assert.equal(succeeded.status, 'succeeded')
    let handoff = await post<EntityView>(`${base}/entities`, { idempotencyKey: key(), kind: 'handoff', title: '审核交接' })
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
    const catalogs = await get<{ scenarios: { templates: unknown[] } }>(`${base}/templates`)
    assert.equal(catalogs.scenarios.templates.length, 2)
    let revising = await claim(await entity(first.id))
    const switched = await send('PUT', `${base}/entities/${first.id}/template`, { idempotencyKey: key(), token: token(revising), templateId: fresh.templateId, templateRef: fresh.templateRef })
    assert.equal(switched.statusCode, 200, switched.body)
    revising = switched.json<EntityView>(); assert.equal(revising.templateId, 'review'); assert.deepEqual(revising.current!.metadata.templateRef, before)
    const renamed = await send('PUT', `${base}/entities/${first.id}`, { idempotencyKey: key(), token: token(revising), title: '用户修改展示名称', summary: '修订目录摘要' })
    assert.equal(renamed.statusCode, 200, renamed.body)
    revising = renamed.json<EntityView>(); assert.equal(revising.code, 'SC-0002'); assert.equal(revising.id, first.id)
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
    for (const row of records.rows) assert.doesNotMatch(JSON.stringify(row.payload), /"(?:metadata|businessEvidence|files|openQuestions|flowComplete|coreRulesPresent|acceptanceCriteriaPresent|body|messages)"/)
  })
})
