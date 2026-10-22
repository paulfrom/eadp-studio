import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { createApp } from '../../apps/collaboration-api/src/app.ts'
import { loadConfig } from '../../apps/collaboration-api/src/config.ts'
import { createDatabase } from '../../apps/collaboration-api/src/persistence/database.ts'
import type { EntityView, LoginResponse, ProjectState, ProjectView } from '../../packages/contracts/src/index.ts'
import { boundUser, fixtureToken, gitlabFixture, templateCatalog } from './gitlab-fixture.ts'

// Run only against a new, disposable database named eadp_auth_check_*.
// STUDIO_TEST_DATABASE_URL=... pnpm --dir apps/collaboration-api exec tsx --test ../../tests/collaboration/backend-lifecycle.test.ts
// PostgreSQL is real. The GitLab HTTP boundary is a test-owned server and is not evidence of enterprise GitLab acceptance.
const databaseUrl = process.env.STUDIO_TEST_DATABASE_URL
const login = { username: 'studioAdmin', password: 'admin@123' }
const initialSha = 'a'.repeat(40)

test('backend sessions, GitLab provisioning and initialization use a real isolated PostgreSQL database', { skip: !databaseUrl }, async t => {
  assert.match(new URL(databaseUrl!).pathname, /^\/eadp_auth_check_[a-z0-9]+$/, 'This suite only accepts its disposable database namespace')
  const gitlab = await gitlabFixture()
  t.after(() => gitlab.close())
  const config = loadConfig({ DATABASE_URL: databaseUrl, PG_SSL: 'disable', GITLAB_URL: gitlab.origin, GITLAB_ALLOW_HTTP: 'true', SEI_GITLAB_TOKEN: fixtureToken })
  const database = createDatabase(config)
  await database.query(await readFile(new URL('../../apps/collaboration-api/db/schema.sql', import.meta.url), 'utf8'))
  const app = createApp(config, database)
  t.after(() => app.close())
  await app.ready()
  let session: LoginResponse
  let created: ProjectView
  const auth = () => ({ authorization: `Bearer ${session.token}` })

  await t.test('the default test account validates credentials, binds the existing user and stores only a token digest', async () => {
    const wrong = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { ...login, password: 'incorrect' } })
    assert.equal(wrong.statusCode, 401)
    assert.equal(gitlab.counts.searches, 0)
    const result = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: login })
    assert.equal(result.statusCode, 200, result.body)
    session = result.json<LoginResponse>()
    assert.equal(session.user.id, 1)
    assert.equal(session.user.username, login.username)
    assert.equal(session.user.gitlabUserId, 701)
    assert.equal(session.gitlabOrigin, gitlab.origin)
    assert.ok(Date.parse(session.expiresAt) > Date.now())
    const stored = await database.query('SELECT * FROM studio_sessions')
    assert.equal(stored.rowCount, 1)
    assert.ok(!JSON.stringify(stored.rows).includes(session.token))
    assert.ok(JSON.stringify(stored.rows).includes(createHash('sha256').update(session.token).digest('hex')))
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: auth() })
    assert.equal(me.statusCode, 200, me.body)
    assert.equal(me.json().user.gitlabUserId, 701)
    assert.ok(!me.body.includes(fixtureToken))
  })

  await t.test('the service credential does not become a client session or expose management-only namespaces', async () => {
    const missing = await app.inject({ method: 'GET', url: '/v1/projects' })
    assert.equal(missing.statusCode, 401)
    const manager = await app.inject({ method: 'GET', url: '/v1/projects', headers: { authorization: `Bearer ${fixtureToken}` } })
    assert.equal(manager.statusCode, 401)
    const groups = await app.inject({ method: 'GET', url: '/v1/namespaces', headers: auth() })
    assert.equal(groups.statusCode, 200, groups.body)
    assert.deepEqual(groups.json().map((item: { id: number }) => item.id), [42])
    const denied = await app.inject({ method: 'POST', url: '/v1/projects', headers: auth(), payload: { idempotencyKey: randomUUID(), name: 'Must not create', namespaceId: 99, path: 'not-permitted' } })
    assert.ok([403, 404].includes(denied.statusCode), denied.body)
    assert.equal(gitlab.counts.creates, 0)
  })

  await t.test('repeated creation returns one persistent pending project and cannot change the request behind its key', async () => {
    const payload = { idempotencyKey: randomUUID(), name: '初始化验证项目', namespaceId: 42, path: 'lifecycle-project' }
    const first = await app.inject({ method: 'POST', url: '/v1/projects', headers: auth(), payload })
    assert.ok([200, 201].includes(first.statusCode), first.body)
    created = first.json<ProjectView>()
    assert.equal(created.initializationStatus, 'pending')
    assert.equal(created.recognizedHead, null)
    const second = await app.inject({ method: 'POST', url: '/v1/projects', headers: auth(), payload })
    assert.ok([200, 201].includes(second.statusCode), second.body)
    assert.equal(second.json<ProjectView>().id, created.id)
    assert.equal(gitlab.counts.creates, 1)
    const changed = await app.inject({ method: 'POST', url: '/v1/projects', headers: auth(), payload: { ...payload, name: 'Different request' } })
    assert.equal(changed.statusCode, 409)
    const categories = await app.inject({ method: 'POST', url: `/v1/projects/${created.id}/categories`, headers: auth(), payload: { idempotencyKey: randomUUID(), categoryId: randomUUID(), name: '业务分类', expectedRevision: 0 } })
    assert.equal(categories.statusCode, 409, categories.body)
    assert.equal((await database.query('SELECT state,recognized_head FROM studio_projects WHERE id=$1', [created.id])).rows[0].recognized_head, null)
  })

  await t.test('concurrent requests share one durable creation operation', async () => {
    const before = gitlab.counts.creates
    const payload = { idempotencyKey: randomUUID(), name: '并发创建', namespaceId: 42, path: 'concurrent-creation' }
    const send = () => app.inject({ method: 'POST', url: '/v1/projects', headers: auth(), payload })
    const replies = await Promise.all([send(), send()])
    assert.ok(replies.some(reply => [200, 201].includes(reply.statusCode)), 'One request must finish provisioning')
    assert.ok(replies.every(reply => [200, 201, 503].includes(reply.statusCode)))
    const replay = await send()
    assert.ok([200, 201].includes(replay.statusCode), replay.body)
    assert.equal(gitlab.counts.creates - before, 1)
  })

  await t.test('a lost GitLab create response is reconciled with the original operation rather than creating a second repository', async () => {
    gitlab.controls.loseNextCreateResponse = true
    const before = gitlab.counts.creates
    const payload = { idempotencyKey: randomUUID(), name: '网络响应丢失', namespaceId: 42, path: 'lost-create-response' }
    const first = await app.inject({ method: 'POST', url: '/v1/projects', headers: auth(), payload })
    assert.ok([200, 201, 502, 503].includes(first.statusCode), first.body)
    const recovered = await app.inject({ method: 'POST', url: '/v1/projects', headers: auth(), payload })
    assert.ok([200, 201].includes(recovered.statusCode), recovered.body)
    assert.equal(recovered.json<ProjectView>().initializationStatus, 'pending')
    assert.equal(gitlab.counts.creates - before, 1)
  })

  await t.test('membership failure recovery rechecks revoked group authority before granting a project role', async () => {
    gitlab.controls.failNextMember = true
    const before = gitlab.counts.creates
    const payload = { idempotencyKey: randomUUID(), name: '成员分配恢复', namespaceId: 42, path: 'member-recovery' }
    const first = await app.inject({ method: 'POST', url: '/v1/projects', headers: auth(), payload })
    assert.ok([502, 503].includes(first.statusCode), first.body)
    const grantsBeforeRevocation = gitlab.counts.members
    gitlab.controls.groupMemberLevel = 20
    const revoked = await app.inject({ method: 'POST', url: '/v1/projects', headers: auth(), payload })
    assert.equal(revoked.statusCode, 403, revoked.body)
    assert.equal(gitlab.counts.members, grantsBeforeRevocation)
    gitlab.controls.groupMemberLevel = 30
    const recovered = await app.inject({ method: 'POST', url: '/v1/projects', headers: auth(), payload })
    assert.ok([200, 201].includes(recovered.statusCode), recovered.body)
    assert.equal(gitlab.counts.creates - before, 1)
    assert.equal(gitlab.projects.get(recovered.json<ProjectView>().gitlabProjectId)?.memberLevel, 40)
  })

  await t.test('initialization requires the actual first pushed commit and matching project identity', async () => {
    const remote = gitlab.projects.get(created.gitlabProjectId)!
    const payload = { idempotencyKey: randomUUID(), commitSha: initialSha }
    const initialize = () => app.inject({ method: 'POST', url: `/v1/projects/${created.id}/initialize`, headers: auth(), payload })
    const notPushed = await initialize()
    assert.ok(notPushed.statusCode >= 400, notPushed.body)
    remote.head = initialSha; remote.default_branch = 'main'; remote.empty_repo = false
    remote.manifest = { schemaVersion: 1, projectId: 'wrong-project', gitlabProjectId: remote.id, repositoryUrl: remote.http_url_to_repo, stableBranch: 'main', directories: ['场景', '需求', '交接', '原型代码'], scenarioTemplates: templateCatalog }
    const wrongIdentity = await initialize()
    assert.ok(wrongIdentity.statusCode >= 400, wrongIdentity.body)
    assert.equal((await database.query('SELECT state,recognized_head FROM studio_projects WHERE id=$1', [created.id])).rows[0].state, 'assigned')
    remote.manifest = { ...remote.manifest, projectId: created.id }
    gitlab.controls.wrongRootParent = true
    const nonRoot = await initialize()
    assert.ok(nonRoot.statusCode >= 400, nonRoot.body)
    gitlab.controls.wrongRootParent = false
    const accepted = await initialize()
    assert.equal(accepted.statusCode, 200, accepted.body)
    assert.equal(accepted.json<ProjectView>().recognizedHead, initialSha)
    assert.equal(accepted.json<ProjectView>().initializationStatus, 'ready')
    const replay = await initialize()
    assert.equal(replay.statusCode, 200, replay.body)
    assert.deepEqual(replay.json(), accepted.json())
    const category = await app.inject({ method: 'POST', url: `/v1/projects/${created.id}/categories`, headers: auth(), payload: { idempotencyKey: randomUUID(), categoryId: randomUUID(), name: '业务分类', expectedRevision: accepted.json<ProjectView>().revision } })
    assert.equal(category.statusCode, 200, category.body)
  })

  await t.test('logout revokes the backend session while retaining project state and the stable binding', async () => {
    const out = await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: auth() })
    assert.ok([200, 204].includes(out.statusCode), out.body)
    const revoked = await app.inject({ method: 'GET', url: '/v1/me', headers: auth() })
    assert.equal(revoked.statusCode, 401)
    const again = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: login })
    assert.equal(again.statusCode, 200, again.body)
    const next = again.json<LoginResponse>()
    assert.equal(next.user.id, session.user.id)
    assert.equal(next.user.gitlabUserId, session.user.gitlabUserId)
    assert.notEqual(next.token, session.token)
    assert.equal(gitlab.counts.searches, 1, 'Later logins must use the persisted numeric binding')
    const list = await app.inject({ method: 'GET', url: '/v1/projects', headers: { authorization: `Bearer ${next.token}` } })
    assert.equal(list.statusCode, 200, list.body)
    assert.ok(list.json<ProjectView[]>().some(project => project.id === created.id && project.initializationStatus === 'ready'))
    const digest = createHash('sha256').update(next.token).digest('hex')
    await database.query("UPDATE studio_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1", [digest])
    const expired = await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${next.token}` } })
    assert.equal(expired.statusCode, 401)
  })

  await t.test('claim rejects a diverged stable head with the recognized-head error until the head is restored', async () => {
    const again = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: login })
    assert.equal(again.statusCode, 200, again.body)
    const headers = { authorization: `Bearer ${again.json<LoginResponse>().token}` }
    const current = await app.inject({ method: 'GET', url: `/v1/projects/${created.id}`, headers })
    assert.equal(current.statusCode, 200, current.body)
    const category = await app.inject({ method: 'POST', url: `/v1/projects/${created.id}/categories`, headers, payload: { idempotencyKey: randomUUID(), categoryId: randomUUID(), name: '头门禁分类', expectedRevision: current.json<ProjectState>().project.revision } })
    assert.equal(category.statusCode, 200, category.body)
    const reserved = await app.inject({ method: 'POST', url: `/v1/projects/${created.id}/entities`, headers, payload: { idempotencyKey: randomUUID(), kind: 'scenario', title: '头门禁场景' } })
    assert.equal(reserved.statusCode, 200, reserved.body)
    const entity = reserved.json<EntityView>()
    const claim = () => app.inject({ method: 'POST', url: `/v1/projects/${created.id}/entities/${entity.id}/claim`, headers, payload: { idempotencyKey: randomUUID(), expectedRevision: entity.revision, taskId: randomUUID(), clientId: randomUUID(), purpose: 'design' } })
    const remote = gitlab.projects.get(created.gitlabProjectId)!
    remote.head = 'e'.repeat(40)
    const rejected = await claim()
    assert.equal(rejected.statusCode, 409, rejected.body)
    assert.equal(rejected.json<{ error: { code: string } }>().error.code, 'UNRECOGNIZED_GIT_HEAD')
    remote.head = initialSha
    const accepted = await claim()
    assert.equal(accepted.statusCode, 200, accepted.body)
  })
})
