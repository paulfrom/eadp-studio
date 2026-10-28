import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import type { PrototypeTaskView, UpdatePrototypeSourceBaseRequest } from '../../packages/contracts/src/index.ts'
import { generalScenarioDocument } from '../../packages/asset-domain/src/index.ts'
import { GitLab } from '../../apps/collaboration-api/src/auth/gitlab.ts'
import { PublicationAuthorization } from '../../apps/collaboration-api/src/auth/publication.ts'
import { SessionAuth } from '../../apps/collaboration-api/src/auth/session.ts'
import { loadConfig } from '../../apps/collaboration-api/src/config.ts'
import { createDatabase, transaction } from '../../apps/collaboration-api/src/persistence/database.ts'
import * as prototypes from '../../apps/collaboration-api/src/modules/prototypes.ts'
import { prototypePolicy } from '../../apps/collaboration-api/src/prototype-policy.ts'
import { CollaborationService } from '../../apps/collaboration-api/src/service.ts'
import { fixtureToken, gitlabFixture, requirementCatalog, requirementTemplate, templateCatalog } from './gitlab-fixture.ts'

// Run only against a new, disposable database named eadp_auth_check_*.
// STUDIO_TEST_DATABASE_URL=... pnpm --dir apps/collaboration-api exec tsx --test ../../tests/collaboration/backend-prototype-recovery.test.ts
const databaseUrl = process.env.STUDIO_TEST_DATABASE_URL
const initialSha = 'a'.repeat(40)
const correctedSha = 'd'.repeat(40)
const key = () => randomUUID()
const errorCode = (error: unknown) => (error as { code?: string }).code
const token = (task: PrototypeTaskView) => ({ prototypeTaskId: task.id, generation: task.generation, clientId: task.clientId, expectedRevision: task.revision })

test('prototype Git recovery persists pending and reconciles only through an unchanged-tree correction', { skip: !databaseUrl }, async t => {
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
  const created = await service.createProject(author, { idempotencyKey: key(), name: '原型恢复验证', namespaceId: 42, path: 'backend-prototype-recovery' })
  const projectId = created.id, remote = gitlab.projects.get(created.gitlabProjectId)!
  remote.head = initialSha; remote.empty_repo = false; remote.default_branch = 'main'
  remote.manifest = { schemaVersion: 1, projectId, gitlabProjectId: created.gitlabProjectId, repositoryUrl: created.repositoryUrl, stableBranch: 'main', directories: ['场景', '需求', '交接', '原型代码'], scenarioTemplates: templateCatalog, requirementTemplates: requirementCatalog }
  remote.generalDocument = generalScenarioDocument(created.generalScenario!.entityId)
  await service.initializeProject(author, projectId, { idempotencyKey: key(), commitSha: initialSha })
  const policy = await prototypePolicy()

  async function createTask(title: string): Promise<PrototypeTaskView> {
    const requirement = await service.reserve(author, projectId, {
      idempotencyKey: key(), kind: 'requirement', title: `${title}需求`, templateId: 'requirement',
      templateRef: { commitSha: initialSha, path: '.template/requirement.md', sha256: createHash('sha256').update(requirementTemplate).digest('hex') },
      sources: [{ projectId, entityId: created.generalScenario!.entityId, version: 1 }],
    })
    return service.createPrototypeTask(author, projectId, {
      idempotencyKey: key(), title, clientId: key(), developmentRequirementIds: [requirement.id], referenceRequirementIds: [],
      writeScope: ['src/pages/'], policyHash: policy.hash, instruction: { userActionId: key(), summary: '验证原型 Git 恢复状态' },
    })
  }
  function integrationRequest(task: PrototypeTaskView, candidateSha: string) {
    return {
      token: token(task), sourceSha: task.sourceBaseHead, expectedHead: initialSha, candidateSha,
      developmentClaims: task.developmentClaims, claimsDigest: task.claimsDigest,
    }
  }
  async function insertIntegration(task: PrototypeTaskView, id: string, candidateSha: string, status: 'prepared' | 'accepted' = 'prepared') {
    await database.query(`INSERT INTO studio_prototype_integrations(id,project_id,prototype_id,task_id,owner_id,status,source_sha,expected_head,candidate_sha,request)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, projectId, task.prototypeId, task.id, author.id, status, task.sourceBaseHead, initialSha, candidateSha, integrationRequest(task, candidateSha)])
  }
  function sourceBaseInput(task: PrototypeTaskView, newBaseHead: string): UpdatePrototypeSourceBaseRequest {
    const operationId = key()
    return {
      idempotencyKey: key(), token: token(task), sourceOperationId: operationId,
      sourceRef: `refs/heads/studio-private/${task.id}/${operationId}/source`, sourceSha: task.sourceBaseHead, newBaseHead,
      developmentClaims: task.developmentClaims, claimsDigest: task.claimsDigest,
    }
  }

  const abortTask = await createTask('主动中止')
  const abortId = key()
  await insertIntegration(abortTask, abortId, '1'.repeat(40))
  await assert.rejects(database.query(`INSERT INTO studio_prototype_integrations(id,project_id,prototype_id,task_id,owner_id,status,source_sha,expected_head,candidate_sha,request)
    VALUES($1,$2,$3,$4,$5,'aborted',$6,$7,$8,$9)`, [key(), projectId, abortTask.prototypeId, abortTask.id, author.id, initialSha, initialSha, '1'.repeat(40), integrationRequest(abortTask, '1'.repeat(40))]), 'Aborted rows must persist an accurate recovery state')
  assert.equal((await service.prototypeIntegration(author, projectId, abortId)).gitRecovery, undefined)
  const abortInput = { idempotencyKey: key(), token: token(abortTask) }
  const aborted = await service.abortPrototypeIntegration(author, projectId, abortId, abortInput)
  assert.equal(aborted.status, 'aborted')
  assert.equal(aborted.gitRecovery, 'pending')
  assert.deepEqual(await service.abortPrototypeIntegration(author, projectId, abortId, abortInput), aborted)

  const cancelTask = await createTask('取消事项')
  const cancelId = key()
  await insertIntegration(cancelTask, cancelId, '2'.repeat(40))
  const cancelled = await service.cancelPrototypeTask(author, projectId, cancelTask.id, { idempotencyKey: key(), token: token(cancelTask), reason: '验证取消后的晚到推送' })
  assert.equal(cancelled.gitRecovery, 'clear', 'The immediate observation remains independent from persistent recovery')
  assert.equal((await service.prototypeIntegration(author, projectId, cancelId)).gitRecovery, 'pending')

  const releaseTask = await createTask('管理员释放')
  const releaseId = key()
  await insertIntegration(releaseTask, releaseId, '3'.repeat(40))
  const released = await service.releasePrototypeTask(author, projectId, releaseTask.id, { idempotencyKey: key(), expectedGeneration: releaseTask.generation, expectedRevision: releaseTask.revision, reason: '验证释放后的晚到推送' })
  assert.equal(released.gitRecovery, 'clear')
  assert.equal((await service.prototypeIntegration(author, projectId, releaseId)).gitRecovery, 'pending')

  const acceptedTask = await createTask('既有接受')
  const acceptedId = key(), acceptanceId = key(), baselineId = key(), acceptedCandidate = '5'.repeat(40)
  await database.query("UPDATE studio_prototype_tasks SET status='accepted' WHERE project_id=$1 AND id=$2", [projectId, acceptedTask.id])
  await database.query('UPDATE studio_prototype_development_claims SET active=false,ended_reason=$3 WHERE project_id=$1 AND task_id=$2', [projectId, acceptedTask.id, 'accepted'])
  await insertIntegration(acceptedTask, acceptedId, acceptedCandidate, 'accepted')
  await database.query(`INSERT INTO studio_prototype_acceptances(id,project_id,prototype_id,task_id,integration_id,confirmation_id,source_sha,candidate_sha,confirmed_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [acceptanceId, projectId, acceptedTask.prototypeId, acceptedTask.id, acceptedId, key(), initialSha, acceptedCandidate, author.id])
  await database.query('INSERT INTO studio_prototype_baselines(id,project_id,prototype_id,sequence,acceptance_id,commit_sha) VALUES($1,$2,$3,1,$4,$5)', [baselineId, projectId, acceptedTask.prototypeId, acceptanceId, acceptedCandidate])
  await database.query('INSERT INTO studio_prototype_acceptance_requirements(project_id,acceptance_id,requirement_id) VALUES($1,$2,$3)', [projectId, acceptanceId, acceptedTask.developmentRequirementIds[0]!])
  await database.query('INSERT INTO studio_prototype_baseline_requirements(project_id,baseline_id,requirement_id) VALUES($1,$2,$3)', [projectId, baselineId, acceptedTask.developmentRequirementIds[0]!])
  await database.query('UPDATE studio_prototypes SET current_baseline_id=$2 WHERE project_id=$1', [projectId, baselineId])
  const acceptedView = await service.prototypeIntegration(author, projectId, acceptedId)
  assert.equal(acceptedView.status, 'accepted')
  assert.equal(acceptedView.baselineId, baselineId)
  assert.equal(acceptedView.gitRecovery, undefined)

  const previousBaseHead = '0'.repeat(40)
  await database.query('UPDATE studio_prototype_tasks SET source_base_head=$3 WHERE project_id=$1 AND id=$2', [projectId, abortTask.id, previousBaseHead])
  const initialProject = await service.project(author, projectId)
  await assert.rejects(
    transaction(database, c => prototypes.updateSourceBase(c, initialProject, author, abortTask.id, sourceBaseInput(abortTask, initialSha), previousBaseHead)),
    error => errorCode(error) === 'INTEGRATION_PENDING',
  )

  const preparedTask = await createTask('收敛时仍准备')
  const preparedId = key()
  await insertIntegration(preparedTask, preparedId, '4'.repeat(40))

  remote.head = correctedSha
  remote.comparisons = new Map([[`${initialSha}:${correctedSha}`, [{ old_path: '原型代码/src/pages/index.tsx', new_path: '原型代码/src/pages/index.tsx', deleted_file: false, renamed_file: false, diff: 'late candidate content' }]]])
  gitlab.controls.commitParent = initialSha
  const reconcileInput = { idempotencyKey: key(), expectedHead: initialSha, correctedHead: correctedSha, reason: '移除未接受原型内容并保留原认可树' }
  await assert.rejects(service.reconcile(author, projectId, reconcileInput), error => errorCode(error) === 'CORRECTION_TREE_MISMATCH')
  assert.equal((await service.prototypeIntegration(author, projectId, preparedId)).status, 'prepared')
  assert.equal((await service.prototypeIntegration(author, projectId, abortId)).gitRecovery, 'pending')

  const fixedBefore = (await database.query('SELECT id,source_sha,expected_head,candidate_sha,request FROM studio_prototype_integrations WHERE project_id=$1 ORDER BY id', [projectId])).rows
  remote.comparisons = new Map()
  const reconciled = await service.reconcile(author, projectId, reconcileInput)
  assert.equal(reconciled.recognizedHead, correctedSha)
  assert.deepEqual(await service.reconcile(author, projectId, reconcileInput), reconciled)
  gitlab.controls.commitParent = null

  for (const id of [abortId, cancelId, releaseId, preparedId]) {
    const view = await service.prototypeIntegration(author, projectId, id)
    assert.equal(view.status, 'aborted')
    assert.equal(view.gitRecovery, 'reconciled')
  }
  const unchangedAccepted = await service.prototypeIntegration(author, projectId, acceptedId)
  assert.equal(unchangedAccepted.status, 'accepted')
  assert.equal(unchangedAccepted.gitRecovery, undefined)
  assert.equal(unchangedAccepted.baselineId, baselineId)
  assert.equal((await database.query('SELECT count(*) FROM studio_prototype_baselines WHERE project_id=$1', [projectId])).rows[0]!.count, '1')
  const fixedAfter = (await database.query('SELECT id,source_sha,expected_head,candidate_sha,request FROM studio_prototype_integrations WHERE project_id=$1 ORDER BY id', [projectId])).rows
  assert.deepEqual(fixedAfter, fixedBefore, 'Reconcile preserves every original request and fixed SHA')

  const correctedProject = await service.project(author, projectId)
  const updated = await transaction(database, c => prototypes.updateSourceBase(c, correctedProject, author, abortTask.id, sourceBaseInput(abortTask, correctedSha), previousBaseHead))
  assert.equal(updated.sourceBaseHead, correctedSha)
})
