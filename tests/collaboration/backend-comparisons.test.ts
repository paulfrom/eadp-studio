import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { createApp } from '../../apps/collaboration-api/src/app.ts'
import { loadConfig } from '../../apps/collaboration-api/src/config.ts'
import { createDatabase } from '../../apps/collaboration-api/src/persistence/database.ts'
import type { ConsistencyComparisonView, ConsistencyContextView, EntityView, IntegrationView, LoginResponse, MaterialIntegrationRequest, MaterialMetadata, ProjectState, ProjectView } from '../../packages/contracts/src/index.ts'
import { generalScenarioDocument, materialPathOf, type MaterialKind } from '../../packages/asset-domain/src/index.ts'
import { defaultTemplate, fixtureToken, gitlabFixture, requirementCatalog, requirementTemplate, templateCatalog } from './gitlab-fixture.ts'

// 与 backend-lifecycle 相同的真实 PostgreSQL + 测试自有 GitLab HTTP 边界。
// STUDIO_TEST_DATABASE_URL=... pnpm --dir apps/collaboration-api exec tsx --test ../../tests/collaboration/backend-comparisons.test.ts
const databaseUrl = process.env.STUDIO_TEST_DATABASE_URL
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const key = () => randomUUID()
const initialSha = 'a'.repeat(40)
const evidencePath = '.eadp/evidence/interview.md'
const evidence = Buffer.from('业务访谈记录：订单提交后应进行审核。\n审核退回允许修改并重新提交。\n')

test('consistency comparisons: sealed submission, table idempotency and a pure-SQL relation catalog', { skip: !databaseUrl }, async t => {
  assert.match(new URL(databaseUrl!).pathname, /^\/eadp_auth_check_[a-z0-9]+$/)
  const gitlab = await gitlabFixture(); t.after(() => gitlab.close())
  const config = loadConfig({ DATABASE_URL: databaseUrl, PG_SSL: 'disable', GITLAB_URL: gitlab.origin, GITLAB_ALLOW_HTTP: 'true', SEI_GITLAB_TOKEN: fixtureToken })
  const database = createDatabase(config)
  await database.query(await readFile(new URL('../../apps/collaboration-api/db/schema.sql', import.meta.url), 'utf8'))
  const app = createApp(config, database); t.after(() => app.close()); await app.ready()
  const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: 'studioAdmin', password: 'admin@123' } })
  assert.equal(login.statusCode, 200, login.body)
  const headers = { authorization: `Bearer ${login.json<LoginResponse>().token}` }
  const send = (method: 'POST' | 'PUT' | 'GET' | 'PATCH' | 'DELETE', url: string, payload?: object) => app.inject({ method, url, headers, ...(payload ? { payload } : {}) })
  async function post<T>(url: string, payload: object): Promise<T> { const reply = await send('POST', url, payload); assert.equal(reply.statusCode, 200, reply.body); return reply.json<T>() }
  async function get<T>(url: string): Promise<T> { const reply = await send('GET', url); assert.equal(reply.statusCode, 200, reply.body); return reply.json<T>() }

  const created = await post<ProjectView>('/v1/projects', { idempotencyKey: key(), name: '一致性对比项目', path: 'comparison-project', namespaceId: 42 })
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
    [evidencePath, evidence],
  ])]])
  remote.commits = new Map([[initialSha, []]]); remote.comparisons = new Map()
  const base = `/v1/projects/${project.id}`
  const state = () => get<ProjectState>(base)
  async function entity(id: string) { const value = (await state()).entities.find(e => e.id === id); assert.ok(value && 'title' in value); return value as EntityView }
  const claim = (value: EntityView) => post<EntityView>(`${base}/entities/${value.id}/claim`, { idempotencyKey: key(), expectedRevision: value.revision, taskId: key(), clientId: key(), purpose: 'design' })
  const token = (value: EntityView) => { const { occupationId, generation, taskId, clientId, expectedRevision } = value.occupation!; return { occupationId, generation, taskId, clientId, expectedRevision } }
  function material(value: EntityView): MaterialMetadata {
    return { entityId: value.id, kind: value.kind, title: value.title, templateId: value.templateId!, templateRef: value.templateRef!,
      scenarioIds: value.scenarioIds, prerequisites: value.prerequisites, sources: value.scenarioSources ?? [],
      businessEvidence: [{ label: '订单访谈', reference: '已选择的业务访谈', files: [{ path: evidencePath, sha256: hash(evidence) }], ranges: [{ path: evidencePath, startLine: 1, endLine: 2 }] }],
      coreRulesPresent: true, acceptanceCriteriaPresent: true, openQuestions: [], referencedAssets: [] } as MaterialMetadata
  }
  let candidateNumber = 0
  async function acceptMaterial(value: EntityView, metadata: MaterialMetadata) {
    const current = (await state()).project, sha = (++candidateNumber).toString(16).padStart(40, '0')
    const files = new Map(remote.snapshots!.get(current.recognizedHead!)!)
    const path = materialPathOf(value.kind as MaterialKind, value.title)
    const bytes = Buffer.from('```eadp-metadata\n' + JSON.stringify(metadata) + '\n```\n\n## 自定义业务约束\n\n订单审核退回后允许重新提交，验收时可验证循环。\n')
    files.set(path, bytes)
    remote.snapshots!.set(sha, files); remote.commits!.set(sha, [current.recognizedHead!])
    remote.comparisons!.set(`${current.recognizedHead}:${sha}`, [{ old_path: path, new_path: path, deleted_file: false, renamed_file: false, diff: `+${sha}` }])
    const input: MaterialIntegrationRequest = { idempotencyKey: key(), entityId: value.id, token: token(value), stage: 'material',
      sourceSha: sha, expectedHead: current.recognizedHead!, candidateSha: sha, allowedPaths: [path],
      checks: { candidateSha: sha, passed: true, checks: ['materials', 'relations'].map(name => ({ name, passed: true, evidenceHash: '1'.repeat(64) })) },
      confirmations: [{ entityId: value.id, expectedRevision: value.revision, fixed: { commitSha: sha, path, sha256: hash(bytes) }, readHash: hash(bytes), authorConfirmed: true, confirmationMethod: 'direct' }] }
    const prepared = await post<IntegrationView>(`${base}/integrations`, input)
    remote.head = sha
    const accepted = await post<IntegrationView>(`${base}/integrations/${prepared.id}/complete`, { idempotencyKey: key(), token: input.token })
    assert.equal(accepted.status, 'accepted')
  }

  let scene: EntityView, reqA: EntityView, reqB: EntityView
  await t.test('a confirmed scenario and requirement plus a drafted prerequisite form the relation fixture', async () => {
    scene = await post<EntityView>(`${base}/entities`, { idempotencyKey: key(), kind: 'scenario', title: '订单审核' })
    await acceptMaterial(scene = await claim(scene), material(scene))
    scene = await entity(scene.id)
    assert.equal(scene.confirmationStatus, 'confirmed'); assert.equal(scene.materialVersion, 1)
    const requirementRef = async () => ({ commitSha: (await state()).project.recognizedHead!, path: '.template/requirement.md', sha256: hash(requirementTemplate) })
    const sources = () => [{ projectId: project.id, entityId: scene.id, version: 1 }]
    reqA = await post<EntityView>(`${base}/entities`, { idempotencyKey: key(), kind: 'requirement', title: '订单审核要求', templateId: 'requirement', templateRef: await requirementRef(), sources: sources() })
    await acceptMaterial(reqA = await claim(reqA), material(reqA))
    reqA = await entity(reqA.id)
    assert.equal(reqA.materialVersion, 1)
    reqB = await post<EntityView>(`${base}/entities`, { idempotencyKey: key(), kind: 'requirement', title: '审核补充要求', templateId: 'requirement', templateRef: await requirementRef(), sources: sources() })
    reqB = await claim(reqB)
    const relations = await send('PUT', `${base}/entities/${reqB.id}/relations`, { idempotencyKey: key(), token: token(reqB), sources: sources(), scenarioIds: [scene.id], prerequisites: [{ requirementId: reqA.id, version: 1 }] })
    assert.equal(relations.statusCode, 200, relations.body)
    reqB = await entity(reqB.id)
    assert.ok(reqB.occupation, '需求 B 保持占用以观察目录中的占用标记')
  })

  const comparisonsUrl = `${base}/consistency-comparisons`
  const comparison = (overrides: Record<string, unknown> = {}) => ({ idempotencyKey: key(), id: key(), entityId: scene.id, trigger: 'manual', result: 'completed', coverage: 'complete', summary: '订单审核场景与需求结论一致', conflicts: [], ...overrides })
  const conflict = (ordinal: number, entities: string[], overrides: Record<string, unknown> = {}) => ({ id: key(), ordinal, summary: `冲突摘要 ${ordinal}`, relation: 'formal', entities, ...overrides })
  /** 对比相关请求不得触发任何 Git 内容读取 */
  const assertNoContentRead = (since: number) => assert.ok(gitlab.paths.slice(since).every(path => !path.includes('/repository/files')), gitlab.paths.slice(since).join('\n'))

  let first: ConsistencyComparisonView
  await t.test('a manual completed submission seals its conflicts and reads back identically', async () => {
    const conflicts = [conflict(1, [scene.id, reqA.id]), conflict(2, [reqA.id], { relation: 'potential', summary: '潜在不一致：审核退回规则表述不同' })]
    const payload = comparison({ conflicts })
    const gitBefore = gitlab.paths.length
    first = await post<ConsistencyComparisonView>(comparisonsUrl, payload)
    assert.equal(first.id, payload.id); assert.equal(first.entityId, scene.id); assert.equal(first.trigger, 'manual')
    assert.equal(first.confirmationId, undefined); assert.equal(first.result, 'completed'); assert.equal(first.failureCode, undefined)
    assert.equal(first.conflictCount, 2); assert.equal(first.conflicts.length, 2)
    assert.deepEqual(first.conflicts[0], { id: conflicts[0]!.id, ordinal: 1, summary: '冲突摘要 1', relation: 'formal', entities: [scene.id, reqA.id] })
    assert.equal(first.conflicts[1]!.relation, 'potential'); assert.equal(first.creator.id, 1)
    const list = await get<ConsistencyComparisonView[]>(`${comparisonsUrl}?entityId=${scene.id}`)
    assert.deepEqual(list, [first])
    const detail = await get<ConsistencyComparisonView>(`${comparisonsUrl}/${first.id}`)
    assert.deepEqual(detail, first)
    const unfiltered = await get<ConsistencyComparisonView[]>(comparisonsUrl)
    assert.ok(unfiltered.some(item => item.id === first.id))
    assertNoContentRead(gitBefore)
  })

  await t.test('the operation key replays the stored record and rejects a changed request behind it', async () => {
    const payload = comparison()
    const original = await post<ConsistencyComparisonView>(comparisonsUrl, payload)
    const replay = await post<ConsistencyComparisonView>(comparisonsUrl, payload)
    assert.deepEqual(replay, original)
    const stored = await database.query<{ count: string }>('SELECT count(*) AS count FROM studio_consistency_comparisons WHERE project_id=$1 AND operation_key=$2', [project.id, payload.idempotencyKey])
    assert.equal(stored.rows[0]!.count, '1')
    const audits = await database.query<{ count: string }>("SELECT count(*) AS count FROM studio_audit WHERE project_id=$1 AND action='consistency.submit' AND data->>'comparisonId'=$2", [project.id, payload.id])
    assert.equal(audits.rows[0]!.count, '1', 'Network retries must not duplicate the submission audit')
    const changed = await send('POST', comparisonsUrl, { ...payload, summary: '同一操作键下的不同结论' })
    assert.equal(changed.statusCode, 409, changed.body)
    assert.equal(changed.json<{ error: { code: string } }>().error.code, 'IDEMPOTENCY_CONFLICT')
  })

  await t.test('concurrent submission retries return one sealed result and create one audit', async () => {
    const payload = comparison({ conflicts: [conflict(1, [scene.id, reqA.id])] })
    const replies = await Promise.all(Array.from({ length: 8 }, () => send('POST', comparisonsUrl, payload)))
    for (const reply of replies) assert.equal(reply.statusCode, 200, reply.body)
    const original = replies[0]!.json<ConsistencyComparisonView>()
    for (const reply of replies) assert.deepEqual(reply.json(), original)
    assert.equal((await database.query('SELECT id FROM studio_consistency_comparisons WHERE project_id=$1 AND operation_key=$2', [project.id, payload.idempotencyKey])).rowCount, 1)
    assert.equal((await database.query("SELECT id FROM studio_audit WHERE project_id=$1 AND action='consistency.submit' AND data->>'comparisonId'=$2", [project.id, payload.id])).rowCount, 1)
    assert.equal((await database.query('SELECT id FROM studio_consistency_conflicts WHERE project_id=$1 AND comparison_id=$2', [project.id, payload.id])).rowCount, 1)
  })

  await t.test('latest-per-target queries retain each material and do not substitute old failures for its latest conclusion', async () => {
    const older = await post<ConsistencyComparisonView>(comparisonsUrl, comparison({ entityId: reqB.id, result: 'failed', coverage: 'partial', failureCode: 'read-failed', summary: '此前读取失败' }))
    const current = await post<ConsistencyComparisonView>(comparisonsUrl, comparison({ entityId: reqB.id }))
    const other = await post<ConsistencyComparisonView>(comparisonsUrl, comparison({ entityId: reqA.id }))
    const recent = await Promise.all(Array.from({ length: 4 }, () => post<ConsistencyComparisonView>(comparisonsUrl, comparison())))
    assert.equal(new Set(recent.map(value => value.id)).size, 4, 'Separate operations keep separate immutable results')
    const gitBefore = gitlab.paths.length
    const latest = await get<ConsistencyComparisonView[]>(`${comparisonsUrl}?latestPerEntity=true&limit=100`)
    assert.equal(latest.length, 3); assert.equal(new Set(latest.map(value => value.entityId)).size, 3)
    assert.equal(latest.find(value => value.entityId === reqB.id)!.id, current.id)
    assert.equal(latest.find(value => value.entityId === reqA.id)!.id, other.id)
    const pages = await Promise.all([0, 1, 2].map(offset => get<ConsistencyComparisonView[]>(`${comparisonsUrl}?latestPerEntity=true&limit=1&offset=${offset}`)))
    assert.deepEqual(pages.flat(), latest)
    const failedHistory = await get<ConsistencyComparisonView[]>(`${comparisonsUrl}?entityId=${reqB.id}&result=failed`)
    assert.deepEqual(failedHistory, [older])
    assert.deepEqual(await get(`${comparisonsUrl}?latestPerEntity=true&entityId=${reqB.id}&result=failed`), [])
    assertNoContentRead(gitBefore)
  })

  await t.test('a confirmation-triggered comparison binds one material confirmation of its target exactly once', async () => {
    const confirmationId = scene.current!.confirmationId
    const payload = comparison({ trigger: 'confirmation', confirmationId, coverage: 'partial' })
    const accepted = await post<ConsistencyComparisonView>(comparisonsUrl, payload)
    assert.equal(accepted.trigger, 'confirmation'); assert.equal(accepted.confirmationId, confirmationId)
    assert.deepEqual(await post<ConsistencyComparisonView>(comparisonsUrl, payload), accepted)
    const duplicate = await send('POST', comparisonsUrl, comparison({ trigger: 'confirmation', confirmationId }))
    assert.equal(duplicate.statusCode, 409, duplicate.body)
    assert.equal(duplicate.json<{ error: { code: string } }>().error.code, 'AUTO_COMPARISON_RECORDED')
    const mismatched = await send('POST', comparisonsUrl, comparison({ trigger: 'confirmation', confirmationId: reqA.current!.confirmationId }))
    assert.equal(mismatched.statusCode, 422, mismatched.body)
    assert.equal(mismatched.json<{ error: { code: string } }>().error.code, 'COMPARISON_CONFIRMATION_MISMATCH')
    const manual = await send('POST', comparisonsUrl, comparison({ confirmationId }))
    assert.equal(manual.statusCode, 400, manual.body)
  })

  await t.test('the whitelist contract rejects extra fields and every overflow without truncation', async () => {
    const valid = comparison()
    for (const body of [
      { ...valid, unexpected: 'field' },
      { ...valid, summary: '长'.repeat(501) },
      { ...valid, conflicts: Array.from({ length: 101 }, (_, index) => conflict(index + 1, [scene.id])) },
      { ...valid, conflicts: [conflict(1, Array.from({ length: 101 }, (_, index) => `entity-${index}`))] },
      { ...valid, conflicts: [conflict(0, [scene.id])] },
      { ...valid, id: 'illegal id!' },
      { ...valid, idempotencyKey: 'k'.repeat(101) },
      ...['body', 'diff', 'rawModelResponse', 'session', 'absolutePath', 'prompt', 'toolLog'].map(field => ({ ...valid, [field]: 'forbidden material or process payload' })),
      ...['status', 'processed', 'ignored', 'reminder', 'revision'].map(field => ({ ...valid, conflicts: [conflict(1, [scene.id], { [field]: 'forbidden conflict processing state' })] })),
    ]) assert.equal((await send('POST', comparisonsUrl, body)).statusCode, 400, JSON.stringify(body).slice(0, 120))
  })

  await t.test('result and failure code combinations follow the sealed record rules', async () => {
    for (const body of [
      comparison({ result: 'failed', summary: '', failureCode: 'read-failed' }),
      comparison({ result: 'failed', summary: '模型读取失败', failureCode: 'cancelled' }),
      comparison({ result: 'failed', summary: '模型读取失败' }),
      comparison({ result: 'cancelled', summary: '', failureCode: 'timeout' }),
      comparison({ result: 'cancelled', summary: '' }),
      comparison({ failureCode: 'timeout' }),
    ]) assert.equal((await send('POST', comparisonsUrl, body)).statusCode, 400, JSON.stringify(body).slice(0, 120))
    const failed = await post<ConsistencyComparisonView>(comparisonsUrl, comparison({ result: 'failed', summary: '模型超时未产出结论', failureCode: 'timeout', coverage: 'partial' }))
    assert.equal(failed.failureCode, 'timeout'); assert.equal(failed.conflictCount, 0)
    const cancelled = await post<ConsistencyComparisonView>(comparisonsUrl, comparison({ result: 'cancelled', summary: '', failureCode: 'cancelled' }))
    assert.equal(cancelled.result, 'cancelled'); assert.equal(cancelled.failureCode, 'cancelled')
  })

  await t.test('conflicts and targets must reference existing entities of the project', async () => {
    const missing = await send('POST', comparisonsUrl, comparison({ conflicts: [conflict(1, ['missing-entity'])] }))
    assert.equal(missing.statusCode, 404, missing.body)
    assert.equal(missing.json<{ error: { code: string } }>().error.code, 'ENTITY_NOT_FOUND')
    const target = await send('POST', comparisonsUrl, comparison({ entityId: 'missing-entity' }))
    assert.equal(target.statusCode, 404, target.body)
    assert.equal(target.json<{ error: { code: string } }>().error.code, 'ENTITY_NOT_FOUND')
    const skipped = await send('POST', comparisonsUrl, comparison({ conflicts: [conflict(1, [scene.id]), conflict(3, [reqA.id])] }))
    assert.equal(skipped.statusCode, 422, skipped.body)
    assert.equal(skipped.json<{ error: { code: string } }>().error.code, 'CONFLICT_ORDINAL_SEQUENCE')
  })

  await t.test('comparison writes require edit membership and reads require read membership', async () => {
    remote.memberLevel = 20
    const reporter = await send('POST', comparisonsUrl, comparison())
    assert.equal(reporter.statusCode, 403, reporter.body)
    remote.memberLevel = 0
    const list = await send('GET', comparisonsUrl)
    assert.equal(list.statusCode, 403, list.body)
    remote.memberLevel = 40
    const restored = await send('GET', comparisonsUrl)
    assert.equal(restored.statusCode, 200, restored.body)
  })

  await t.test('the consistency context projects the formal relation catalog without any Git read', async () => {
    const gitBefore = gitlab.paths.length
    const sceneContext = await get<ConsistencyContextView>(`${base}/entities/${scene.id}/consistency-context`)
    assert.equal(sceneContext.entity.id, scene.id); assert.equal(sceneContext.entity.kind, 'scenario'); assert.equal(sceneContext.entity.occupied, false)
    assert.equal(sceneContext.entity.path, scene.current!.fixed.path)
    assert.deepEqual(sceneContext.builtinScenario, { entityId: created.generalScenario!.entityId, path: '场景/通用场景.md' })
    assert.deepEqual(sceneContext.sources, []); assert.deepEqual(sceneContext.prerequisites, [])
    assert.deepEqual(sceneContext.requirements.map(item => item.id), [reqA.id, reqB.id])
    const [cardA, cardB] = sceneContext.requirements
    assert.equal(cardA!.code, reqA.code); assert.equal(cardA!.confirmationStatus, 'confirmed'); assert.equal(cardA!.occupied, false)
    assert.equal(cardB!.confirmationStatus, 'draft'); assert.equal(cardB!.occupied, true)
    assert.equal(cardA!.path, reqA.current!.fixed.path); assert.equal(cardB!.path, undefined)
    for (const card of sceneContext.requirements) assert.deepEqual(card.sources, [{ projectId: project.id, entityId: scene.id, version: 1 }])
    const reqContext = await get<ConsistencyContextView>(`${base}/entities/${reqB.id}/consistency-context`)
    assert.equal(reqContext.entity.id, reqB.id); assert.equal(reqContext.entity.occupied, true)
    assert.deepEqual(reqContext.sources, [{ entityId: scene.id, code: scene.code, title: scene.title, version: 1, confirmationId: scene.current!.confirmationId, fixed: scene.current!.fixed }])
    assert.deepEqual(reqContext.prerequisites, [{ requirementId: reqA.id, code: reqA.code, title: reqA.title, version: 1, confirmationId: reqA.current!.confirmationId, path: reqA.current!.fixed.path }])
    assert.deepEqual(reqContext.requirements, [])
    const missing = await send('GET', `${base}/entities/missing-entity/consistency-context`)
    assert.equal(missing.statusCode, 404, missing.body)
    assertNoContentRead(gitBefore)
  })

  await t.test('comparisons and conflicts are immutable records without processing states or mutation routes', async () => {
    for (const [method, url] of [['PATCH', `${comparisonsUrl}/${first.id}`], ['PUT', `${comparisonsUrl}/${first.id}`], ['DELETE', `${comparisonsUrl}/${first.id}`], ['PATCH', `${comparisonsUrl}/${first.id}/conflicts/${first.conflicts[0]!.id}`]] as const) {
      const reply = await send(method, url, method === 'DELETE' ? undefined : {})
      assert.equal(reply.statusCode, 404, `${method} ${url}`)
    }
    const unknown = await send('GET', `${comparisonsUrl}/missing-comparison`)
    assert.equal(unknown.statusCode, 404, unknown.body)
    assert.equal(unknown.json<{ error: { code: string } }>().error.code, 'COMPARISON_NOT_FOUND')
    for (const query of ['limit=0', 'limit=101', 'offset=-1', 'limit=abc', 'entityId=-illegal', 'latestPerEntity=1', 'result=unknown']) {
      const reply = await send('GET', `${comparisonsUrl}?${query}`)
      assert.equal(reply.statusCode, 422, query)
      assert.equal(reply.json<{ error: { code: string } }>().error.code, 'INVALID_PAGINATION')
    }
  })
})
