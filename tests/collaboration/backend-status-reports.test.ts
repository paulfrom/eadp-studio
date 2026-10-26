import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { createApp } from '../../apps/collaboration-api/src/app.ts'
import { loadConfig } from '../../apps/collaboration-api/src/config.ts'
import { createDatabase } from '../../apps/collaboration-api/src/persistence/database.ts'
import type { EntityView, IntegrationView, LoginResponse, MaterialIntegrationRequest, MaterialMetadata, MaterialStatusReportView, ProjectState, ProjectView } from '../../packages/contracts/src/index.ts'
import { generalScenarioDocument, materialPathOf, type MaterialKind } from '../../packages/asset-domain/src/index.ts'
import { defaultTemplate, fixtureToken, gitlabFixture, requirementCatalog, requirementTemplate, templateCatalog } from './gitlab-fixture.ts'

// 与 backend-lifecycle 相同的真实 PostgreSQL + 测试自有 GitLab HTTP 边界。
// STUDIO_TEST_DATABASE_URL=... pnpm --dir apps/collaboration-api exec tsx --test ../../tests/collaboration/backend-status-reports.test.ts
const databaseUrl = process.env.STUDIO_TEST_DATABASE_URL
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const key = () => randomUUID()
const initialSha = 'a'.repeat(40)
const evidencePath = '.eadp/evidence/interview.md'
const evidence = Buffer.from('业务访谈记录：订单提交后应进行审核。\n审核退回允许修改并重新提交。\n')

test('material status reports: sealed idempotent records without Git content reads', { skip: !databaseUrl }, async t => {
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

  const created = await post<ProjectView>('/v1/projects', { idempotencyKey: key(), name: '材料状态项目', path: 'status-report-project', namespaceId: 42 })
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

  let scene: EntityView
  await t.test('a confirmed scenario forms the status report fixture', async () => {
    scene = await post<EntityView>(`${base}/entities`, { idempotencyKey: key(), kind: 'scenario', title: '订单审核' })
    await acceptMaterial(scene = await claim(scene), material(scene))
    scene = await entity(scene.id)
    assert.equal(scene.confirmationStatus, 'confirmed'); assert.equal(scene.materialVersion, 1)
  })

  const reportsUrl = `${base}/entities/${scene.id}/status-reports`
  const head = (letter: string) => letter.repeat(40)
  const report = (overrides: Record<string, unknown> = {}) => ({ idempotencyKey: key(), id: key(), entityId: scene.id, trigger: 'save', baseHead: head('a'), worktreeHead: head('b'), changedPathCount: 2, summary: '未提交变更 2 个文件：场景/登录.md（修改）', ...overrides })

  await t.test('a status report is recorded without any Git content read and reads back identically', async () => {
    const payload = report(), gitBefore = gitlab.paths.length
    const created = await post<MaterialStatusReportView>(reportsUrl, payload)
    assert.equal(created.id, payload.id); assert.equal(created.entityId, scene.id)
    assert.equal(created.trigger, 'save'); assert.equal(created.baseHead, head('a'))
    assert.equal(created.changedPathCount, 2); assert.equal(created.creator.id, 1)
    const list = await get<MaterialStatusReportView[]>(reportsUrl)
    assert.deepEqual(list, [created])
    const detail = await get<MaterialStatusReportView>(`${reportsUrl}/${created.id}`)
    assert.deepEqual(detail, created)
    assert.ok(gitlab.paths.slice(gitBefore).every(path => !path.includes('/repository/files')), '纯记录不得读取 Git 内容')
  })

  await t.test('the operation key replays the original record and rejects a changed request', async () => {
    const payload = report()
    const original = await post<MaterialStatusReportView>(reportsUrl, payload)
    const replay = await post<MaterialStatusReportView>(reportsUrl, payload)
    assert.deepEqual(replay, original)
    const stored = await database.query<{ count: string }>('SELECT count(*) AS count FROM studio_material_status_reports WHERE project_id=$1 AND id=$2', [project.id, payload.id])
    assert.equal(stored.rows[0]!.count, '1')
    const changed = await send('POST', reportsUrl, { ...payload, summary: '同键不同内容' })
    assert.equal(changed.statusCode, 409, changed.body)
    assert.equal(changed.json<{ error: { code: string } }>().error.code, 'IDEMPOTENCY_CONFLICT')
  })

  await t.test('summary over 500 chars and mismatched route entity are rejected', async () => {
    const long = await send('POST', reportsUrl, report({ summary: '长'.repeat(501) }))
    assert.equal(long.statusCode, 400)
    const mismatch = await send('POST', reportsUrl, report({ entityId: 'other-entity' }))
    assert.equal(mismatch.statusCode, 422)
    assert.equal(mismatch.json<{ error: { code: string } }>().error.code, 'STATUS_REPORT_TARGET_MISMATCH')
  })
})
