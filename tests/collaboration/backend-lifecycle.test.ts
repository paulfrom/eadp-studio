import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import test from 'node:test'
import { createApp } from '../../apps/collaboration-api/src/app.ts'
import { loadConfig } from '../../apps/collaboration-api/src/config.ts'
import { createDatabase } from '../../apps/collaboration-api/src/persistence/database.ts'
import type { LoginResponse, ProjectView } from '../../packages/contracts/src/index.ts'

// Run only against a new, disposable database named eadp_auth_check_*.
// STUDIO_TEST_DATABASE_URL=... pnpm --dir apps/collaboration-api exec tsx --test ../../tests/collaboration/backend-lifecycle.test.ts
// PostgreSQL is real. The GitLab HTTP boundary is a test-owned server and is not evidence of enterprise GitLab acceptance.
const databaseUrl = process.env.STUDIO_TEST_DATABASE_URL
const fixtureToken = 'synthetic-management-credential'
const login = { username: 'studioAdmin', password: 'admin@123' }
const initialSha = 'a'.repeat(40)
const boundUser = { id: 701, username: 'songlin.liu', email: 'songlin.liu@changhong.com', name: 'Songlin Liu', state: 'active' }

interface RemoteProject {
  id: number; name: string; path: string; path_with_namespace: string; description: string;
  namespace: { id: number; full_path: string }; http_url_to_repo: string; ssh_url_to_repo: string;
  default_branch: string | null; empty_repo: boolean; visibility: string;
  memberLevel: number; directMember: boolean; head: string | null; manifest?: object;
}

async function gitlabFixture() {
  const projects = new Map<number, RemoteProject>()
  const counts = { creates: 0, members: 0, searches: 0 }
  const controls = { loseNextCreateResponse: false, failNextMember: false, wrongRootParent: false, groupMemberLevel: 30 }
  const namespaces = [
    { id: 42, name: 'Delivery', path: 'delivery', full_path: 'delivery', project_creation_level: 'developer', visibility: 'private' },
    { id: 99, name: 'Management only', path: 'management', full_path: 'management', project_creation_level: 'maintainer', visibility: 'private' },
  ]
  let origin = ''
  const send = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json', 'x-next-page': '' }).end(JSON.stringify(body))
  }
  async function handle(request: IncomingMessage, response: ServerResponse) {
    assert.equal(request.headers['private-token'] ?? request.headers.authorization?.replace(/^Bearer /, ''), fixtureToken)
    const url = new URL(request.url ?? '/', origin)
    const route = decodeURIComponent(url.pathname.replace(/^\/api\/v4/, ''))
    if (route === '/user') return send(response, 200, { id: 900, username: 'manager', is_admin: true, state: 'active' })
    if (route === '/users' && request.method === 'GET') {
      counts.searches++
      assert.ok(url.searchParams.get('search') === boundUser.email || url.searchParams.get('username') === boundUser.email)
      return send(response, 200, [boundUser])
    }
    if (route === `/users/${boundUser.id}`) return send(response, 200, boundUser)
    if (route === '/groups') return send(response, 200, namespaces)
    const groupMember = /^\/groups\/(\d+)\/members(?:\/all)?\/701$/.exec(route)
    if (groupMember) return send(response, Number(groupMember[1]) === 42 ? 200 : 404,
      Number(groupMember[1]) === 42 ? { id: 701, access_level: controls.groupMemberLevel, state: 'active', expires_at: null } : { message: 'Not found' })
    const group = /^\/groups\/(\d+)$/.exec(route)
    if (group) {
      const namespace = namespaces.find(item => item.id === Number(group[1]))
      return send(response, namespace ? 200 : 404, namespace ?? { message: 'Not found' })
    }
    if (route === '/projects' && request.method === 'POST') {
      let data = ''
      for await (const chunk of request) data += chunk
      const body = request.headers['content-type']?.includes('application/json') ? JSON.parse(data) : Object.fromEntries(new URLSearchParams(data))
      assert.equal(Number(body.namespace_id), 42)
      assert.equal(body.visibility, 'private')
      assert.notEqual(body.initialize_with_readme, true)
      if ([...projects.values()].some(item => item.path === body.path)) return send(response, 400, { message: 'path has already been taken' })
      counts.creates++
      const id = 1000 + counts.creates
      const project: RemoteProject = {
        id, name: body.name, path: body.path, path_with_namespace: `delivery/${body.path}`, description: body.description ?? '',
        namespace: { id: 42, full_path: 'delivery' }, http_url_to_repo: `${origin}/delivery/${body.path}.git`,
        ssh_url_to_repo: `git@fixture.invalid:delivery/${body.path}.git`, default_branch: null, empty_repo: true,
        visibility: 'private', memberLevel: 30, directMember: false, head: null,
      }
      projects.set(id, project)
      if (controls.loseNextCreateResponse) { controls.loseNextCreateResponse = false; response.destroy(); return }
      return send(response, 201, publicProject(project))
    }
    const projectRoute = /^\/projects\/(.+?)(?:\/(members.*|repository.*))?$/.exec(route)
    if (projectRoute) {
      const selector = projectRoute[1]!
      const project = /^\d+$/.test(selector) ? projects.get(Number(selector)) : [...projects.values()].find(item => item.path_with_namespace === selector)
      if (!project) return send(response, 404, { message: 'Not found' })
      const action = projectRoute[2]
      if (!action) return send(response, 200, publicProject(project))
      if (/^members(?:\/all)?\/701$/.test(action) && request.method === 'GET') {
        if (action === 'members/701' && !project.directMember) return send(response, 404, { message: 'Not found' })
        return send(response, 200, { id: 701, username: boundUser.username, access_level: project.memberLevel, state: 'active', expires_at: null })
      }
      if (/^members(?:\/701)?$/.test(action) && ['POST', 'PUT'].includes(request.method ?? '')) {
        counts.members++
        if (controls.failNextMember) { controls.failNextMember = false; return send(response, 503, { message: 'fixture member failure' }) }
        project.memberLevel = 40; project.directMember = true
        return send(response, 201, { id: 701, username: boundUser.username, access_level: 40, state: 'active', expires_at: null })
      }
      if (action === 'repository/branches/main') return send(response, project.head ? 200 : 404,
        project.head ? { name: 'main', commit: { id: project.head }, protected: true } : { message: 'Not found' })
      if (action === 'repository/branches') return send(response, 200, project.head ? [{ name: 'main', commit: { id: project.head } }] : [])
      if (action.startsWith('repository/commits/')) return send(response, 200, { id: project.head, parent_ids: controls.wrongRootParent ? ['b'.repeat(40)] : [] })
      if (action === 'repository/tree') {
        const entries = ['场景', '需求', '原型代码'].map(name => ({ id: 'c'.repeat(40), name, path: name, type: 'tree', mode: '040000' }))
        const manifestBytes = Buffer.from(JSON.stringify(project.manifest ?? {}) + '\n')
        const manifestId = createHash('sha1').update(`blob ${manifestBytes.length}\0`).update(manifestBytes).digest('hex')
        return send(response, 200, [...entries, { id: manifestId, name: 'project.assets.json', path: 'project.assets.json', type: 'blob', mode: '100644' }])
      }
      if (/^repository\/blobs\/[a-f0-9]{40}\/raw$/.test(action)) {
        response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(JSON.stringify(project.manifest ?? {}) + '\n')
        return
      }
    }
    return send(response, 404, { message: 'Unknown test fixture route' })
  }
  function publicProject(project: RemoteProject) {
    const { memberLevel: _level, directMember: _direct, head: _head, manifest: _manifest, ...value } = project
    return { ...value, permissions: { project_access: { access_level: 50 } } }
  }
  const server = createServer((request, response) => { void handle(request, response).catch(() => send(response, 500, { message: 'GitLab fixture rejected a request' })) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  origin = `http://127.0.0.1:${address.port}`
  return { origin, projects, counts, controls, close: () => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections() }) }
}

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
    assert.equal((await database.query('SELECT data FROM studio_projects WHERE id=$1', [created.id])).rows[0].data.recognizedHead, null)
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
    remote.manifest = { schemaVersion: 1, projectId: 'wrong-project', gitlabProjectId: remote.id, repositoryUrl: remote.http_url_to_repo, stableBranch: 'main', directories: ['场景', '需求', '原型代码'] }
    const wrongIdentity = await initialize()
    assert.ok(wrongIdentity.statusCode >= 400, wrongIdentity.body)
    assert.equal((await database.query('SELECT data FROM studio_projects WHERE id=$1', [created.id])).rows[0].data.initializationStatus, 'pending')
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
})
