import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { GitLab } from '../../apps/collaboration-api/src/auth/gitlab.ts'
import { PublicationAuthorization } from '../../apps/collaboration-api/src/auth/publication.ts'
import { SessionAuth, type Actor } from '../../apps/collaboration-api/src/auth/session.ts'
import { loadConfig } from '../../apps/collaboration-api/src/config.ts'
import { createDatabase } from '../../apps/collaboration-api/src/persistence/database.ts'
import { CollaborationService } from '../../apps/collaboration-api/src/service.ts'
import type { EntityView } from '../../packages/contracts/src/index.ts'
import { fixtureToken, gitlabFixture, templateCatalog } from './gitlab-fixture.ts'

// Run only against a new, disposable database named eadp_auth_check_*.
// STUDIO_TEST_DATABASE_URL=... pnpm --dir apps/collaboration-api exec tsx --test ../../tests/collaboration/backend-consistency.test.ts
const databaseUrl = process.env.STUDIO_TEST_DATABASE_URL
const initialSha = 'a'.repeat(40)
const key = () => randomUUID()
const errorCode = (error: unknown) => (error as { code?: string }).code

test('A07 claim head gates and A08 shared draft directories hold on isolated PostgreSQL', { skip: !databaseUrl }, async t => {
  assert.match(new URL(databaseUrl!).pathname, /^\/eadp_auth_check_[a-z0-9]+$/, 'This suite only accepts its disposable database namespace')
  const gitlab = await gitlabFixture()
  t.after(() => gitlab.close())
  const config = loadConfig({ DATABASE_URL: databaseUrl, PG_SSL: 'disable', GITLAB_URL: gitlab.origin, GITLAB_ALLOW_HTTP: 'true', SEI_GITLAB_TOKEN: fixtureToken })
  const database = createDatabase(config)
  t.after(() => database.end())
  await database.query(await readFile(new URL('../../apps/collaboration-api/db/schema.sql', import.meta.url), 'utf8'))
  const gitlabAuth = new GitLab(config), auth = new SessionAuth(database, gitlabAuth, config)
  await auth.ensureTestUser()
  const login = await auth.login({ username: 'studioAdmin', password: 'admin@123' })
  const author = await auth.authenticate(`Bearer ${login.token}`)
  const service = new CollaborationService(database, gitlabAuth, new PublicationAuthorization(config), auth)
  // Other identities exercise read projections only; the deployment's single-user constraint stays intact.
  const other: Actor = { ...author, id: 2, username: 'reader', name: 'Reader', admin: false }
  const administrator: Actor = { ...other, id: 3, username: 'administrator', name: 'Administrator', admin: true }
  const created = await service.createProject(author, { idempotencyKey: key(), name: '一致性验证', namespaceId: 42, path: 'backend-consistency' })
  const projectId = created.id, remote = gitlab.projects.get(created.gitlabProjectId)!
  remote.head = initialSha; remote.empty_repo = false; remote.default_branch = 'main'
  remote.manifest = { schemaVersion: 1, projectId, gitlabProjectId: created.gitlabProjectId, repositoryUrl: created.repositoryUrl, stableBranch: 'main', directories: ['场景', '需求', '原型代码'], scenarioTemplates: templateCatalog }
  await service.initializeProject(author, projectId, { idempotencyKey: key(), commitSha: initialSha })

  let first: EntityView, second: EntityView
  await t.test('A07a a stable recognized head permits claiming a newly numbered scenario', async () => {
    const input = { idempotencyKey: key(), kind: 'scenario' as const, title: '一致性场景甲' }
    first = await service.reserve(author, projectId, input)
    const replay = await service.reserve(author, projectId, input)
    assert.equal(replay.id, first.id)
    assert.equal(replay.code, first.code)
    assert.equal(first.code, 'SC-0001')
    assert.equal(first.categoryId, undefined)
    assert.ok(first.templateRef)
    const claimed = await service.claim(author, projectId, first.id, { idempotencyKey: key(), expectedRevision: first.revision, taskId: 'task-a', clientId: 'client-a', purpose: 'design' })
    assert.equal(claimed.taskStatus, 'active')
    assert.equal(claimed.occupation?.ownerId, author.id)
  })

  await t.test('A07b claim reads and rejects a diverged remote stable head', async () => {
    second = await service.reserve(author, projectId, { idempotencyKey: key(), kind: 'scenario', title: '一致性场景乙' })
    remote.head = 'b'.repeat(40)
    const reads = gitlab.counts.headReads
    await assert.rejects(service.claim(author, projectId, second.id, { idempotencyKey: key(), expectedRevision: second.revision, taskId: 'task-b', clientId: 'client-b', purpose: 'design' }), error => errorCode(error) === 'UNRECOGNIZED_GIT_HEAD')
    assert.ok(gitlab.counts.headReads > reads)
    assert.equal((await service.state(author, projectId)).entities.find(value => value.id === second.id)?.occupation, undefined)
  })

  await t.test('A07c an administrator reconciles a traceable unchanged tree before claiming', async () => {
    gitlab.controls.commitParent = initialSha
    try {
      const corrected = await service.reconcile(author, projectId, { idempotencyKey: key(), expectedHead: initialSha, correctedHead: 'b'.repeat(40), reason: '管理员认可纠正提交' })
      assert.equal(corrected.recognizedHead, 'b'.repeat(40))
    } finally { gitlab.controls.commitParent = null }
    const claimed = await service.claim(author, projectId, second.id, { idempotencyKey: key(), expectedRevision: second.revision, taskId: 'task-c', clientId: 'client-c', purpose: 'design' })
    assert.equal(claimed.occupation?.ownerId, author.id)
  })

  await t.test('A07d releasing an occupation preserves the next claim head gate', async () => {
    const third = await service.reserve(author, projectId, { idempotencyKey: key(), kind: 'scenario', title: '一致性场景丙' })
    const claimed = await service.claim(author, projectId, third.id, { idempotencyKey: key(), expectedRevision: third.revision, taskId: 'task-d', clientId: 'client-d', purpose: 'design' })
    const released = await service.release(author, projectId, third.id, { idempotencyKey: key(), token: claimed.occupation!, reason: '管理员释放占用' }, true)
    assert.equal(released.occupation, undefined)
    assert.equal(released.taskStatus, 'aborted')
    remote.head = 'c'.repeat(40)
    await assert.rejects(service.claim(author, projectId, third.id, { idempotencyKey: key(), expectedRevision: released.revision, taskId: 'task-d2', clientId: 'client-d2', purpose: 'design' }), error => errorCode(error) === 'UNRECOGNIZED_GIT_HEAD')
  })

  await t.test('A08a the author sees the full draft directory and its selected fixed template', async () => {
    const view = (await service.state(author, projectId)).entities.find(value => value.id === first.id)
    assert.ok(view && 'prerequisites' in view)
    assert.equal(view.title, '一致性场景甲')
    assert.equal(view.code, 'SC-0001')
    assert.equal(view.confirmationStatus, 'draft')
    assert.equal(view.creator?.id, author.id)
    assert.equal(view.templateId, 'default')
    assert.equal(view.current, undefined)
  })

  await t.test('A08b another member sees shared names, numbers, authors and occupations without draft contents', async () => {
    const state = await service.state(other, projectId)
    const view = state.entities.find(value => value.id === first.id)
    assert.ok(view)
    assert.equal(view.title, '一致性场景甲')
    assert.equal(view.code, 'SC-0001')
    assert.equal(view.creator?.id, author.id)
    assert.equal(view.occupation?.ownerId, author.id)
    for (const privateField of ['current', 'metadata', 'prerequisites', 'scenarioIds', 'templateRef', 'body', 'conversation']) assert.equal(privateField in view, false, `${privateField} must not appear on another member's draft card`)
    assert.deepEqual(state.entities.map(value => value.id).sort(), (await service.state(author, projectId)).entities.map(value => value.id).sort())
  })

  await t.test('A08c administrator status does not expand another author’s draft projection', async () => {
    const members = (await service.state(other, projectId)).entities
    assert.deepEqual((await service.state(administrator, projectId)).entities, members)
  })

  await t.test('A08d reading draft revision impact neither creates an occupation nor invents a confirmation', async () => {
    const before = await database.query<{ count: string }>('SELECT count(*) FROM studio_occupations WHERE project_id=$1', [projectId])
    await assert.rejects(service.revisionImpact(other, projectId, first.id), error => errorCode(error) === 'CONFIRMED_SCENARIO_REQUIRED')
    const after = await database.query<{ count: string }>('SELECT count(*) FROM studio_occupations WHERE project_id=$1', [projectId])
    assert.equal(after.rows[0]!.count, before.rows[0]!.count)
    assert.equal((await database.query<{ count: string }>('SELECT count(*) FROM studio_confirmations WHERE project_id=$1', [projectId])).rows[0]!.count, '0')
  })
})
