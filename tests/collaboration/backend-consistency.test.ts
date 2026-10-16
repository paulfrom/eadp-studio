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
import type { EntityView, FixedVersion, ProjectView } from '../../packages/contracts/src/index.ts'
import { boundUser, fixtureToken, gitlabFixture } from './gitlab-fixture.ts'

// Run only against a new, disposable database named eadp_auth_check_*.
// STUDIO_TEST_DATABASE_URL=... pnpm --dir apps/collaboration-api exec tsx --test ../../tests/collaboration/backend-consistency.test.ts
// Service-level consistency checks use synthetic actors; studio_users stays untouched.
const databaseUrl = process.env.STUDIO_TEST_DATABASE_URL
const initialSha = 'a'.repeat(40)
const key = () => randomUUID()
const keys = (value: object) => Object.keys(value).sort()
const errorCode = (error: unknown) => (error as { code?: string }).code

test('A07 claim head gate and A08 entity visibility projection hold on a real isolated PostgreSQL database', { skip: !databaseUrl }, async t => {
  assert.match(new URL(databaseUrl!).pathname, /^\/eadp_auth_check_[a-z0-9]+$/, 'This suite only accepts its disposable database namespace')
  const gitlab = await gitlabFixture()
  t.after(() => gitlab.close())
  const config = loadConfig({ DATABASE_URL: databaseUrl, PG_SSL: 'disable', GITLAB_URL: gitlab.origin, GITLAB_ALLOW_HTTP: 'true', SEI_GITLAB_TOKEN: fixtureToken })
  const database = createDatabase(config)
  t.after(() => database.end())
  await database.query(await readFile(new URL('../../apps/collaboration-api/db/schema.sql', import.meta.url), 'utf8'))
  const gitlabAuth = new GitLab(config)
  const service = new CollaborationService(database, gitlabAuth, new PublicationAuthorization(config), new SessionAuth(database, gitlabAuth, config))
  const actor = (id: number, admin: boolean): Actor => ({
    id, username: `synthetic-${id}`, name: `Synthetic ${id}`, email: `synthetic-${id}@fixture.invalid`,
    admin, gitlabUserId: boundUser.id, gitlabUsername: boundUser.username, sessionHash: `synthetic-session-${id}`,
  })
  const author = actor(1, true), other = actor(2, false), administrator = actor(3, true)
  const projectId = 'g0-consistency-project'
  const gitlabProjectId = 5001
  gitlab.projects.set(gitlabProjectId, {
    id: gitlabProjectId, name: 'consistency', path: 'consistency', path_with_namespace: 'delivery/consistency', description: '',
    namespace: { id: 42, full_path: 'delivery' }, http_url_to_repo: `${gitlab.origin}/delivery/consistency.git`,
    ssh_url_to_repo: 'git@fixture.invalid:delivery/consistency.git', default_branch: 'main', empty_repo: false,
    visibility: 'private', memberLevel: 30, directMember: true, head: initialSha,
  })
  const seeded: ProjectView = {
    id: projectId, gitlabProjectId, repositoryUrl: `${gitlab.origin}/delivery/consistency.git`, stableBranch: 'main',
    name: '一致性验证', namespaceId: 42, namespacePath: 'delivery', initializationStatus: 'ready',
    revision: 0, recognizedHead: initialSha, categories: [{ id: 'cat-1', name: '业务分类' }],
  }
  await database.query('INSERT INTO studio_projects(id,gitlab_project_id,data) VALUES($1,$2,$3)', [projectId, gitlabProjectId, seeded])
  const remote = () => gitlab.projects.get(gitlabProjectId)!

  let first: EntityView
  await t.test('A07a claim succeeds while the actual stable head matches the recognized head', async () => {
    first = await service.reserve(author, projectId, { idempotencyKey: key(), kind: 'requirement', title: '一致性需求甲', categoryId: 'cat-1' })
    const claimed = await service.claim(author, projectId, first.id, { idempotencyKey: key(), expectedRevision: first.revision, taskId: 'task-a', clientId: 'client-a', purpose: 'design' })
    assert.equal(claimed.taskStatus, 'active')
    assert.equal(claimed.occupation?.ownerId, author.id)
  })

  let second: EntityView
  await t.test('A07b a diverged stable head rejects claim with UNRECOGNIZED_GIT_HEAD after reading the branch head', async () => {
    second = await service.reserve(author, projectId, { idempotencyKey: key(), kind: 'requirement', title: '一致性需求乙', categoryId: 'cat-1' })
    remote().head = 'b'.repeat(40)
    const reads = gitlab.counts.headReads
    await assert.rejects(
      service.claim(author, projectId, second.id, { idempotencyKey: key(), expectedRevision: second.revision, taskId: 'task-b', clientId: 'client-b', purpose: 'design' }),
      error => errorCode(error) === 'UNRECOGNIZED_GIT_HEAD')
    assert.ok(gitlab.counts.headReads > reads, 'claim must actually read the stable branch head before rejecting')
  })

  await t.test('A07c reconcile recognizes the corrected head and claim succeeds again', async () => {
    gitlab.controls.commitParent = initialSha
    try {
      const corrected = await service.reconcile(author, projectId, { idempotencyKey: key(), expectedHead: initialSha, correctedHead: 'b'.repeat(40), reason: '管理员认可纠正提交' })
      assert.equal(corrected.recognizedHead, 'b'.repeat(40))
    } finally { gitlab.controls.commitParent = null }
    const claimed = await service.claim(author, projectId, second.id, { idempotencyKey: key(), expectedRevision: second.revision, taskId: 'task-c', clientId: 'client-c', purpose: 'design' })
    assert.equal(claimed.occupation?.ownerId, author.id)
  })

  await t.test('A07d releasing the occupation never clears the head gate for the next claim', async () => {
    const third = await service.reserve(author, projectId, { idempotencyKey: key(), kind: 'requirement', title: '一致性需求丙', categoryId: 'cat-1' })
    const claimed = await service.claim(author, projectId, third.id, { idempotencyKey: key(), expectedRevision: third.revision, taskId: 'task-d', clientId: 'client-d', purpose: 'design' })
    await service.release(author, projectId, third.id, { idempotencyKey: key(), token: claimed.occupation!, reason: '管理员释放占用' }, true)
    remote().head = 'c'.repeat(40)
    await assert.rejects(
      service.claim(author, projectId, third.id, { idempotencyKey: key(), expectedRevision: claimed.revision, taskId: 'task-d2', clientId: 'client-d2', purpose: 'design' }),
      error => errorCode(error) === 'UNRECOGNIZED_GIT_HEAD')
  })

  await t.test('A08a the author sees the full entity view including its title', async () => {
    const state = await service.state(author, projectId)
    const view = state.entities.find(entity => entity.id === first.id)
    assert.ok(view && 'title' in view)
    assert.equal(view.title, '一致性需求甲')
    assert.equal(view.categoryId, 'cat-1')
    assert.equal(view.confirmationStatus, 'draft')
  })

  await t.test('A08b another member sees only the occupancy card without the title', async () => {
    const state = await service.state(other, projectId)
    const occupied = state.entities.find(entity => 'occupation' in entity && entity.occupation)
    assert.ok(occupied)
    assert.deepEqual(keys(occupied), ['id', 'kind', 'occupation', 'revision', 'taskStatus'])
    assert.equal(occupied.occupation?.ownerId, author.id)
    assert.ok(!JSON.stringify(state.entities).includes('一致性需求甲'), 'the draft title must not reach another member')
    assert.ok(!JSON.stringify(state.entities).includes('一致性需求乙'))
    assert.ok(!JSON.stringify(state.entities).includes('一致性需求丙'))
    const ids = state.entities.map(entity => entity.id).sort()
    assert.deepEqual(ids, (await service.state(author, projectId)).entities.map(entity => entity.id).sort(), 'visibility projection must not hide entity identities')
  })

  await t.test('A08c a non-author administrator sees the same occupancy card and nothing more', async () => {
    const state = await service.state(administrator, projectId)
    const occupied = state.entities.find(entity => 'occupation' in entity && entity.occupation)
    assert.ok(occupied)
    assert.deepEqual(keys(occupied), ['id', 'kind', 'occupation', 'revision', 'taskStatus'])
    assert.ok(!JSON.stringify(state.entities).includes('一致性需求甲'), 'admin status must not widen visibility')
  })

  await t.test('A08d a confirmed entity opens its summary to every member', async () => {
    const stored = (await database.query<{ data: EntityView }>('SELECT data FROM studio_entities WHERE project_id=$1 AND id=$2', [projectId, first.id])).rows[0].data
    const current: FixedVersion = {
      version: 1, confirmationId: 'confirm-e1', confirmedBy: author.id, confirmedAt: new Date().toISOString(),
      fixed: { commitSha: 'd'.repeat(40), path: `需求/${stored.id}.md`, sha256: 'e'.repeat(64) },
      metadata: {
        entityId: stored.id, kind: 'requirement', title: '一致性需求甲', categoryId: 'cat-1', scenarioIds: [], prerequisites: [],
        sources: [], businessEvidence: [{ label: '作者确认', reference: 'backend-consistency' }], coreRulesPresent: true,
        acceptanceCriteriaPresent: true, openQuestions: [], referencedAssets: [],
      },
      reuse: { enabled: true, reason: '材料确认即取得资格' },
    }
    await database.query('UPDATE studio_entities SET data=$3 WHERE project_id=$1 AND id=$2', [projectId, stored.id, { ...stored, confirmationStatus: 'confirmed', materialVersion: 1, current }])
    const state = await service.state(other, projectId)
    const view = state.entities.find(entity => entity.id === stored.id)
    assert.ok(view && 'title' in view)
    assert.equal(view.title, '一致性需求甲')
    assert.equal(view.confirmationStatus, 'confirmed')
    assert.equal(view.current?.version, 1)
  })
})
