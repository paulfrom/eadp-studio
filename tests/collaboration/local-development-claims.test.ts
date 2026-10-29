import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import type { ClaimPrototypeDevelopmentRequest, DevelopmentClaimToken, DevelopmentClaimView, EntityView, PrototypeTaskView, SynchronizePrototypeDevelopmentRequest } from '../../packages/contracts/src/index.ts'
import { generalScenarioDocument } from '../../packages/asset-domain/src/index.ts'
import { createApp } from '../../apps/collaboration-api/src/app.ts'
import { GitLab } from '../../apps/collaboration-api/src/auth/gitlab.ts'
import { PublicationAuthorization } from '../../apps/collaboration-api/src/auth/publication.ts'
import { SessionAuth } from '../../apps/collaboration-api/src/auth/session.ts'
import { loadConfig } from '../../apps/collaboration-api/src/config.ts'
import * as prototypes from '../../apps/collaboration-api/src/modules/prototypes.ts'
import { createDatabase, transaction } from '../../apps/collaboration-api/src/persistence/database.ts'
import type { Transaction } from '../../apps/collaboration-api/src/persistence/database.ts'
import { prototypePolicy } from '../../apps/collaboration-api/src/prototype-policy.ts'
import { CollaborationService } from '../../apps/collaboration-api/src/service.ts'
import { fixtureToken, gitlabFixture, requirementCatalog, requirementTemplate, templateCatalog } from './gitlab-fixture.ts'

const databaseUrl = process.env.STUDIO_TEST_DATABASE_URL
const initialSha = 'a'.repeat(40)
const key = () => randomUUID()
const errorCode = (error: unknown) => (error as { code?: string }).code
const token = (task: PrototypeTaskView) => ({ prototypeTaskId: task.id, generation: task.generation, clientId: task.clientId, expectedRevision: task.revision })
const identity = (claim: DevelopmentClaimView): DevelopmentClaimToken => ({ requirementId: claim.requirementId, claimId: claim.claimId, generation: claim.generation })

test('integration checks each requirement against the project-wide latest claim', async () => {
  const task = { developmentRequirementIds: ['requirement'], developmentClaims: [{ requirementId: 'requirement', claimId: 'old', generation: 1 }] } as PrototypeTaskView
  let latest = { id: 'old', requirement_id: 'requirement', generation: 1 }
  const db = { query: async () => ({ rows: [latest] }) } as unknown as Transaction
  await prototypes.assertLatestPrototypeClaims(db, 'project', task)
  latest = { id: 'other-task', requirement_id: 'requirement', generation: 2 }
  await assert.rejects(prototypes.assertLatestPrototypeClaims(db, 'project', task), error => errorCode(error) === 'STALE_DEVELOPMENT_CLAIM')
})

test('local development claims use atomic generations and Git-verified per-requirement synchronization', { skip: !databaseUrl, timeout: 120_000 }, async t => {
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
  const created = await service.createProject(author, { idempotencyKey: key(), name: '本地开发占用', namespaceId: 42, path: 'local-development-claims' })
  const projectId = created.id, remote = gitlab.projects.get(created.gitlabProjectId)!
  remote.head = initialSha; remote.empty_repo = false; remote.default_branch = 'main'; remote.refs = new Map()
  remote.manifest = { schemaVersion: 1, projectId, gitlabProjectId: created.gitlabProjectId, repositoryUrl: created.repositoryUrl, stableBranch: 'main', directories: ['场景', '需求', '交接', '原型代码'], scenarioTemplates: templateCatalog, requirementTemplates: requirementCatalog }
  remote.generalDocument = generalScenarioDocument(created.generalScenario!.entityId)
  await service.initializeProject(author, projectId, { idempotencyKey: key(), commitSha: initialSha })
  const policy = await prototypePolicy()
  const requirement = await service.reserve(author, projectId, {
    idempotencyKey: key(), kind: 'requirement', title: '本地队列需求', templateId: 'requirement',
    templateRef: { commitSha: initialSha, path: '.template/requirement.md', sha256: createHash('sha256').update(requirementTemplate).digest('hex') },
    sources: [{ projectId, entityId: created.generalScenario!.entityId, version: 1 }],
  })
  async function createTask(title: string): Promise<PrototypeTaskView> {
    const idempotencyKey = key()
    return service.createPrototypeTask(author, projectId, {
      idempotencyKey, title, clientId: key(), developmentRequirementIds: [requirement.id], referenceRequirementIds: [], commitId: initialSha, remoteRef: `refs/heads/studio/prototype/${idempotencyKey}`,
      writeScope: ['src/pages/'], policyHash: policy.hash, instruction: { userActionId: key(), summary: '验证逐需求本地开发占用' },
    })
  }
  const tasks: PrototypeTaskView[] = []
  for (const title of ['首个本地事项', '并发本地事项']) {
    const task = await createTask(title); tasks.push(task)
    assert.equal(task.id, task.branch.split('/').at(-1)); assert.equal(task.developmentClaims.length, 1)
    const initial = await service.prototypeDevelopmentClaim(author, projectId, requirement.id)
    assert.equal(initial?.commitId, initialSha); assert.equal(initial?.remoteRef, `refs/heads/${task.branch}`)
    await database.query('UPDATE studio_prototype_development_claims SET active=false,ended_reason=$3 WHERE project_id=$1 AND task_id=$2 AND active', [projectId, task.id, 'test-setup'])
  }
  const [firstTask, secondTask] = tasks as [PrototypeTaskView, PrototypeTaskView]
  const claimInput = (task: PrototypeTaskView, commitId: string, operationKey = key()): ClaimPrototypeDevelopmentRequest => ({
    key: operationKey, token: token(task), requirementId: requirement.id, commitId, remoteRef: `refs/heads/${task.branch}`,
  })
  const syncInput = (task: PrototypeTaskView, claim: DevelopmentClaimView, commitId: string, release: boolean, operationKey = key()): SynchronizePrototypeDevelopmentRequest => ({
    key: operationKey, token: token(task), claim: identity(claim), commitId, remoteRef: `refs/heads/${task.branch}`, release,
  })
  const offlineConfig = loadConfig({ DATABASE_URL: databaseUrl, PG_SSL: 'disable', GITLAB_URL: 'http://127.0.0.1:1', GITLAB_ALLOW_HTTP: 'true', SEI_GITLAB_TOKEN: fixtureToken })
  const offline = new CollaborationService(database, new GitLab(offlineConfig), new PublicationAuthorization(offlineConfig), auth)
  const firstInput = claimInput(firstTask, 'b'.repeat(40)), secondInput = claimInput(secondTask, 'b'.repeat(40))
  let winningTask: PrototypeTaskView, winningInput: ClaimPrototypeDevelopmentRequest, losingTask: PrototypeTaskView, firstClaim: DevelopmentClaimView

  await t.test('concurrent free claims succeed once without Git, even with an unreachable remote and unmatched commit', async () => {
    const before = gitlab.paths.length
    const results = await Promise.allSettled([
      offline.claimPrototypeDevelopment(author, projectId, firstTask.id, firstInput),
      offline.claimPrototypeDevelopment(author, projectId, secondTask.id, secondInput),
    ])
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    const rejected = results.find(result => result.status === 'rejected')
    assert.ok(rejected?.status === 'rejected'); assert.equal(errorCode(rejected.reason), 'REQUIREMENT_ALREADY_CLAIMED')
    assert.equal(gitlab.paths.length, before, 'Claim must not make any GitLab request')
    const firstWon = results[0]!.status === 'fulfilled'
    winningTask = firstWon ? firstTask : secondTask; winningInput = firstWon ? firstInput : secondInput; losingTask = firstWon ? secondTask : firstTask
    firstClaim = (results[firstWon ? 0 : 1] as PromiseFulfilledResult<DevelopmentClaimView>).value
    assert.equal(firstClaim.active, true); assert.equal(firstClaim.generation, 3); assert.equal(firstClaim.commitId, 'b'.repeat(40))
    await assert.rejects(offline.claimPrototypeDevelopment(author, projectId, losingTask.id, claimInput(losingTask, 'b'.repeat(40))), error => errorCode(error) === 'REQUIREMENT_ALREADY_CLAIMED')
    assert.equal(gitlab.paths.length, before, 'An occupied check also does not compare commits through Git')
  })

  await t.test('claim replay returns the original generation and rejects changed input under the same key', async () => {
    assert.deepEqual(await offline.claimPrototypeDevelopment(author, projectId, winningTask.id, winningInput), firstClaim)
    await assert.rejects(offline.claimPrototypeDevelopment(author, projectId, winningTask.id, { ...winningInput, commitId: 'c'.repeat(40) }), error => errorCode(error) === 'IDEMPOTENCY_CONFLICT')
    assert.deepEqual(await service.prototypeDevelopmentClaim(author, projectId, requirement.id), firstClaim)
  })

  await t.test('wrong, mismatched and unavailable refs never release the active claim', async () => {
    await assert.rejects(service.synchronizePrototypeDevelopment(author, projectId, winningTask.id, requirement.id, { ...syncInput(winningTask, firstClaim, 'c'.repeat(40), true), remoteRef: 'refs/heads/main' }), error => errorCode(error) === 'INVALID_DEVELOPMENT_REF')
    assert.equal((await service.prototypeDevelopmentClaim(author, projectId, requirement.id))?.active, true)
    remote.refs!.set(winningInput.remoteRef, 'c'.repeat(40))
    await assert.rejects(service.synchronizePrototypeDevelopment(author, projectId, winningTask.id, requirement.id, syncInput(winningTask, firstClaim, 'd'.repeat(40), true)), error => errorCode(error) === 'DEVELOPMENT_COMMIT_MISMATCH')
    assert.equal((await service.prototypeDevelopmentClaim(author, projectId, requirement.id))?.active, true)
    remote.refs!.set(winningInput.remoteRef, 'c'.repeat(40)); gitlab.controls.failCommitReads = 2
    await assert.rejects(service.synchronizePrototypeDevelopment(author, projectId, winningTask.id, requirement.id, syncInput(winningTask, firstClaim, 'c'.repeat(40), true)), error => errorCode(error) === 'GITLAB_UNAVAILABLE')
    assert.equal((await service.prototypeDevelopmentClaim(author, projectId, requirement.id))?.active, true)
  })

  let correctionSync: SynchronizePrototypeDevelopmentRequest, finalSync: SynchronizePrototypeDevelopmentRequest
  await t.test('correction synchronization stays active and final release is idempotent without creating a baseline', async () => {
    remote.refs!.set(winningInput.remoteRef, 'c'.repeat(40))
    correctionSync = syncInput(winningTask, firstClaim, 'c'.repeat(40), false)
    const correction = await service.synchronizePrototypeDevelopment(author, projectId, winningTask.id, requirement.id, correctionSync)
    assert.equal(correction.active, true); assert.equal(correction.commitId, 'c'.repeat(40))
    assert.deepEqual(await service.synchronizePrototypeDevelopment(author, projectId, winningTask.id, requirement.id, correctionSync), correction)
    await assert.rejects(service.synchronizePrototypeDevelopment(author, projectId, winningTask.id, requirement.id, { ...correctionSync, commitId: 'd'.repeat(40) }), error => errorCode(error) === 'IDEMPOTENCY_CONFLICT')
    remote.refs!.set(winningInput.remoteRef, 'd'.repeat(40))
    finalSync = syncInput(winningTask, firstClaim, 'd'.repeat(40), true)
    const released = await service.synchronizePrototypeDevelopment(author, projectId, winningTask.id, requirement.id, finalSync)
    assert.equal(released.active, false); assert.equal(await service.prototypeDevelopmentClaim(author, projectId, requirement.id), null)
    assert.equal((await database.query('SELECT count(*) FROM studio_prototype_baselines WHERE project_id=$1', [projectId])).rows[0]!.count, '0')
    const task = await service.prototypeTask(author, projectId, winningTask.id)
    assert.deepEqual(task.developmentRequirementIds, [requirement.id]); assert.deepEqual(task.developmentClaims, [identity(firstClaim)])
    assert.doesNotThrow(() => prototypes.assertPrototypeClaims(task, author, { token: token(task), developmentClaims: task.developmentClaims, claimsDigest: task.claimsDigest }))
  })

  let secondClaim: DevelopmentClaimView
  await t.test('the same task can reclaim a new generation while late hooks cannot release it', async () => {
    secondClaim = await offline.claimPrototypeDevelopment(author, projectId, winningTask.id, claimInput(winningTask, 'e'.repeat(40)))
    assert.equal(secondClaim.generation, 4); assert.equal(secondClaim.active, true)
    assert.deepEqual(await service.synchronizePrototypeDevelopment(author, projectId, winningTask.id, requirement.id, finalSync), { ...firstClaim, commitId: 'd'.repeat(40), active: false })
    assert.equal((await service.prototypeDevelopmentClaim(author, projectId, requirement.id))?.claimId, secondClaim.claimId)
    remote.refs!.set(winningInput.remoteRef, 'd'.repeat(40))
    await assert.rejects(service.synchronizePrototypeDevelopment(author, projectId, winningTask.id, requirement.id, syncInput(winningTask, firstClaim, 'd'.repeat(40), true)), error => errorCode(error) === 'STALE_DEVELOPMENT_CLAIM')
    assert.deepEqual(await service.prototypeDevelopmentClaim(author, projectId, requirement.id), secondClaim)
  })

  let adminInput: { key: string; occupied: false; commitId: string; remoteRef: string; reason: string }
  await t.test('administrator forcing idle invalidates the generation and is audited without Git consistency checks', async () => {
    adminInput = { key: key(), occupied: false, commitId: 'f'.repeat(40), remoteRef: winningInput.remoteRef, reason: '管理员终止失效开发代次' }
    const staleTask = await service.prototypeTask(author, projectId, winningTask.id)
    await assert.rejects(service.administerPrototypeDevelopmentClaim({ ...author, admin: false }, projectId, requirement.id, adminInput), error => errorCode(error) === 'ADMIN_REQUIRED')
    const before = gitlab.paths.length
    assert.equal(await service.administerPrototypeDevelopmentClaim(author, projectId, requirement.id, adminInput), null)
    assert.ok(!gitlab.paths.slice(before).some(path => path.includes('/repository/commits/')), 'Administration checks permission but never compares Git commits')
    assert.equal(await service.prototypeDevelopmentClaim(author, projectId, requirement.id), null)
    const currentTask = await service.prototypeTask(author, projectId, winningTask.id)
    assert.equal(currentTask.developmentClaims[0]!.generation, 5)
    remote.refs!.set(winningInput.remoteRef, 'e'.repeat(40))
    await assert.rejects(service.synchronizePrototypeDevelopment(author, projectId, winningTask.id, requirement.id, syncInput(winningTask, secondClaim, 'e'.repeat(40), true)), error => errorCode(error) === 'STALE_DEVELOPMENT_CLAIM')
    assert.throws(() => prototypes.assertPrototypeClaims(currentTask, author, { token: token(currentTask), developmentClaims: staleTask.developmentClaims, claimsDigest: staleTask.claimsDigest }), error => errorCode(error) === 'STALE_DEVELOPMENT_CLAIM')
    const audit = await database.query<{ data: { reason: string; invalidatedClaimId: string; invalidatedGeneration: number; replacementGeneration: number } }>("SELECT data FROM studio_audit WHERE project_id=$1 AND action='prototype.development.claim.admin' ORDER BY id DESC LIMIT 1", [projectId])
    assert.equal(audit.rows[0]!.data.reason, adminInput.reason); assert.equal(audit.rows[0]!.data.invalidatedClaimId, secondClaim.claimId); assert.equal(audit.rows[0]!.data.invalidatedGeneration, 4); assert.equal(audit.rows[0]!.data.replacementGeneration, 5)
    const thirdClaim = await offline.claimPrototypeDevelopment(author, projectId, winningTask.id, claimInput(winningTask, 'f'.repeat(40)))
    assert.equal(thirdClaim.generation, 6)
    assert.equal(await service.administerPrototypeDevelopmentClaim(author, projectId, requirement.id, adminInput), null)
    assert.deepEqual(await service.prototypeDevelopmentClaim(author, projectId, requirement.id), thirdClaim)

    const occupied = await service.administerPrototypeDevelopmentClaim(author, projectId, requirement.id, { ...adminInput, key: key(), occupied: true, commitId: '0'.repeat(40), reason: '管理员保留新的排他占用代次' })
    assert.equal(occupied?.active, true); assert.equal(occupied?.generation, 7)
    assert.deepEqual(await service.prototypeDevelopmentClaim(author, projectId, requirement.id), occupied)
    remote.refs!.set(winningInput.remoteRef, 'f'.repeat(40))
    await assert.rejects(service.synchronizePrototypeDevelopment(author, projectId, winningTask.id, requirement.id, syncInput(winningTask, thirdClaim, 'f'.repeat(40), true)), error => errorCode(error) === 'STALE_DEVELOPMENT_CLAIM')
    const administeredTask = await service.prototypeTask(author, projectId, winningTask.id)
    assert.doesNotThrow(() => prototypes.assertPrototypeClaims(administeredTask, author, { token: token(administeredTask), developmentClaims: administeredTask.developmentClaims, claimsDigest: administeredTask.claimsDigest }))
  })

  await t.test('administrator can occupy an idle requirement without inventing a task', async () => {
    await service.administerPrototypeDevelopmentClaim(author, projectId, requirement.id, { ...adminInput, key: key(), occupied: false })
    const staleTask = await service.prototypeTask(author, projectId, winningTask.id)
    await service.administerPrototypeDevelopmentClaim(author, projectId, requirement.id, { ...adminInput, key: key(), occupied: false, reason: '管理员复核空闲标识' })
    await assert.rejects(transaction(database, c => prototypes.assertLatestPrototypeClaims(c, projectId, staleTask)), error => errorCode(error) === 'STALE_DEVELOPMENT_CLAIM')
    const administrative = await service.administerPrototypeDevelopmentClaim(author, projectId, requirement.id, { ...adminInput, key: key(), occupied: true, reason: '管理员设置占用' })
    assert.equal(administrative?.taskId, null)
    assert.equal(administrative?.active, true)
    assert.deepEqual(await service.prototypeDevelopmentClaim(author, projectId, requirement.id), administrative)
    await assert.rejects(offline.claimPrototypeDevelopment(author, projectId, losingTask.id, claimInput(losingTask, initialSha)), error => errorCode(error) === 'REQUIREMENT_ALREADY_CLAIMED')
    await assert.rejects(transaction(database, c => prototypes.assertLatestPrototypeClaims(c, projectId, staleTask)), error => errorCode(error) === 'STALE_DEVELOPMENT_CLAIM')
    await service.administerPrototypeDevelopmentClaim(author, projectId, requirement.id, { ...adminInput, key: key(), occupied: false })
    assert.equal(await service.prototypeDevelopmentClaim(author, projectId, requirement.id), null)
    const claimed = await offline.claimPrototypeDevelopment(author, projectId, losingTask.id, claimInput(losingTask, initialSha))
    assert.equal(claimed.generation, administrative!.generation + 2)
    await assert.rejects(transaction(database, c => prototypes.assertLatestPrototypeClaims(c, projectId, staleTask)), error => errorCode(error) === 'STALE_DEVELOPMENT_CLAIM')
  })

  await t.test('HTTP schemas require a full commit for initial and subsequent claims', async () => {
    const app = createApp(config, createDatabase(config)); await app.ready()
    try {
      const session = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: 'studioAdmin', password: 'admin@123' } })
      const headers = { authorization: `Bearer ${session.json<{ token: string }>().token}` }
      const missing = await app.inject({ method: 'POST', url: `/v1/projects/${projectId}/prototype/tasks/${winningTask.id}/development-claims`, headers, payload: { key: key(), token: token(winningTask), requirementId: requirement.id, remoteRef: winningInput.remoteRef } })
      assert.equal(missing.statusCode, 400, missing.body); assert.equal(missing.json<{ error: { code: string } }>().error.code, 'INVALID_REQUEST')
      const missingInitial = await app.inject({ method: 'POST', url: `/v1/projects/${projectId}/prototype/tasks`, headers, payload: { idempotencyKey: key(), title: '缺少初始提交', clientId: key(), developmentRequirementIds: [requirement.id], referenceRequirementIds: [], remoteRef: 'refs/heads/studio/prototype/missing-commit', writeScope: ['src/pages/'], policyHash: policy.hash, instruction: { userActionId: key(), summary: '缺少 commit 必须拒绝' } } })
      assert.equal(missingInitial.statusCode, 400, missingInitial.body)
    } finally { await app.close() }
  })
})
