import { canonical, requireCondition } from '@eadp/asset-domain';
import type { AdoptRequest, AdoptionSuccessRequest, CategoryRequest, ClaimRequest, CompleteIntegrationRequest, DeploymentRequest, EligibilityRequest, EntityView, HandoffReceiptRequest, PrepareIntegrationRequest, PublicationAuthorizationRequest, ProjectState, ProjectView, ReconcileRequest, RegisterProjectRequest, ReleaseRequest, ReserveEntityRequest, UpdateRelationsRequest } from '@eadp/contracts';
import { GitLab, type Actor } from './auth/gitlab.js';
import { PublicationAuthorization } from './auth/publication.js';
import { GitLabContent } from './gitlab-content.js';
import { type Database, transaction, type Transaction } from './persistence/database.js';
import * as repository from './persistence/repository.js';
import * as occupations from './modules/occupations.js';
import * as integration from './modules/integration.js';
import * as reuse from './modules/reuse.js';

type Mutation<T> = (c: Transaction, project: ProjectView, all: EntityView[]) => Promise<T>;
export class CollaborationService {
  readonly content: GitLabContent;
  constructor(readonly database: Database, readonly gitlab: GitLab, readonly publication: PublicationAuthorization) { this.content = new GitLabContent(gitlab); }
  async authorize(actor: Actor, projectId: string, edit = false) {
    const project = await transaction(this.database, c => repository.project(c, projectId));
    await this.gitlab.authorize(actor, project.gitlabProjectId, edit); return project;
  }
  async mutate<T>(actor: Actor, projectId: string, action: string, input: { idempotencyKey: string }, change: Mutation<T>, extraProjectIds: string[] = []): Promise<T> {
    return transaction(this.database, async c => {
      for (const id of [...new Set([projectId, ...extraProjectIds])].sort()) await repository.project(c, id, true);
      const previous = await repository.previous(c, projectId, actor, action, input);
      if (previous.found) return previous.result as T;
      const project = await repository.project(c, projectId), all = await repository.entities(c, projectId);
      const result = await change(c, project, all);
      await repository.remember(c, projectId, actor, action, input, result); return result;
    });
  }
  async replay(actor: Actor, projectId: string, action: string, input: { idempotencyKey: string }) {
    return transaction(this.database, c => repository.previous(c, projectId, actor, action, input));
  }
  async listProjects(actor: Actor) {
    const rows = await this.database.query<{ data: ProjectView }>('SELECT data FROM studio_projects ORDER BY id');
    const visible: ProjectView[] = [];
    for (const row of rows.rows) {
      try { await this.gitlab.authorize(actor, row.data.gitlabProjectId); visible.push(row.data); }
      catch (error) { if ((error as { code?: string }).code !== 'GITLAB_READ_DENIED') throw error; }
    }
    return visible;
  }
  async registerProject(actor: Actor, input: RegisterProjectRequest): Promise<ProjectView> {
    const remote = await this.gitlab.authorize(actor, input.gitlabProjectId, true);
    requireCondition(input.repositoryUrl === remote.http_url_to_repo || input.repositoryUrl === remote.ssh_url_to_repo, 'REPOSITORY_MISMATCH', 'Repository URL must match the authorized GitLab project', 422);
    const head = await this.gitlab.branchHead(actor, input.gitlabProjectId, input.stableBranch);
    const id = `gitlab-${input.gitlabProjectId}`;
    return transaction(this.database, async c => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [id]);
      const existing = (await c.query<{ data: ProjectView }>('SELECT data FROM studio_projects WHERE id=$1', [id])).rows[0]?.data;
      if (existing) {
        const previous = await repository.previous(c, id, actor, 'project.register', input); if (previous.found) return previous.result as ProjectView;
        requireCondition(existing.repositoryUrl === input.repositoryUrl && existing.stableBranch === input.stableBranch, 'PROJECT_ALREADY_REGISTERED', 'Project is already bound to a repository and stable branch');
        await repository.remember(c, id, actor, 'project.register', input, existing); return existing;
      }
      const project: ProjectView = { id, gitlabProjectId: input.gitlabProjectId, repositoryUrl: input.repositoryUrl, stableBranch: input.stableBranch, name: input.name, recognizedHead: head, revision: 0, categories: [] };
      await c.query('INSERT INTO studio_projects(id,gitlab_project_id,data) VALUES($1,$2,$3)', [id, input.gitlabProjectId, project]);
      await repository.remember(c, id, actor, 'project.register', input, project); return project;
    });
  }
  async state(actor: Actor, projectId: string): Promise<ProjectState> {
    await this.authorize(actor, projectId);
    return transaction(this.database, async c => {
      await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const project = await repository.project(c, projectId), entities = await repository.entities(c, projectId);
      const integrations = (await c.query<{ data: integration.StoredIntegration }>('SELECT data FROM studio_integrations WHERE project_id=$1 ORDER BY id', [projectId])).rows.map(r => integration.publicIntegration(r.data));
      const baselines = (await c.query('SELECT data FROM studio_baselines WHERE project_id=$1 ORDER BY id', [projectId])).rows.map(r => r.data);
      return { project, entities, integrations, baselines };
    });
  }
  async category(actor: Actor, projectId: string, input: CategoryRequest) {
    await this.authorize(actor, projectId, true);
    return this.mutate(actor, projectId, 'category.write', input, async (c, project) => {
      requireCondition(project.revision === input.expectedRevision, 'REVISION_CONFLICT', 'Project revision changed');
      const category = project.categories.find(x => x.id === input.categoryId);
      if (category) category.name = input.name; else project.categories.push({ id: input.categoryId, name: input.name });
      project.revision++; await repository.saveProject(c, project);
      await repository.audit(c, projectId, actor, 'category.write', { categoryId: input.categoryId, name: input.name }); return project;
    });
  }
  async reserve(actor: Actor, projectId: string, input: ReserveEntityRequest) {
    await this.authorize(actor, projectId, true);
    return this.mutate(actor, projectId, 'entity.reserve', input, async (c, project, all) => {
      requireCondition(project.categories.some(x => x.id === input.categoryId), 'CATEGORY_NOT_FOUND', 'Choose an existing project category');
      const value: EntityView = { id: repository.newId(), kind: input.kind, title: input.title, categoryId: input.categoryId, revision: 0, generation: 0, materialVersion: 0, confirmationStatus: 'draft', taskStatus: 'idle', scenarioIds: [], prerequisites: [], frozenBy: [], associationRevision: 0 };
      if (input.batch) {
        requireCondition(input.kind === 'requirement', 'INVALID_BATCH_ENTITY', 'Only a new requirement may be reserved in a scenario batch');
        const scene = repository.entity(all, input.batch.scenarioId), occupation = occupations.assertOccupation(scene, input.batch.token, actor);
        requireCondition(occupation.purpose === 'scenario-batch', 'BATCH_REQUIRED', 'Scenario batch occupation is required');
        value.frozenBy = [occupation.occupationId]; value.scenarioIds = [scene.id]; scene.associationRevision++;
        await repository.saveEntity(c, projectId, scene);
      }
      await repository.saveEntity(c, projectId, value); return value;
    });
  }
  async claim(actor: Actor, projectId: string, id: string, input: ClaimRequest) {
    await this.authorize(actor, projectId, true);
    return this.mutate(actor, projectId, `occupation.claim:${id}`, input, (c, _p, all) => occupations.claim(c, projectId, all, id, actor, input));
  }
  async release(actor: Actor, projectId: string, id: string, input: ReleaseRequest, admin = false) {
    await this.authorize(actor, projectId, !admin);
    return this.mutate(actor, projectId, `occupation.${admin ? 'admin-release' : 'cancel'}:${id}`, input, (c, _p, all) => occupations.release(c, projectId, all, id, actor, input, admin));
  }
  async relations(actor: Actor, projectId: string, id: string, input: UpdateRelationsRequest) {
    await this.authorize(actor, projectId, true);
    return this.mutate(actor, projectId, `relations.write:${id}`, input, (c, _p, all) => occupations.updateRelations(c, projectId, all, id, actor, input));
  }
  async verifySources(actor: Actor, projectId: string, input: PrepareIntegrationRequest) {
    for (const confirmation of input.confirmations) for (const source of confirmation.metadata.sources) {
      // A requirement's fixed scenario input is provenance, not package adoption.
      if (source.projectId === projectId && confirmation.metadata.scenarioIds.includes(source.entityId)) {
        const pendingScene = input.confirmations.find(x => x.entityId === source.entityId && x.metadata.kind === 'scenario');
        if (pendingScene) {
          const matches = await transaction(this.database, async c => repository.entity(await repository.entities(c, projectId), source.entityId).materialVersion + 1 === source.version);
          requireCondition(matches, 'SCENARIO_VERSION_MISMATCH', 'Batch scenario source must bind the new fixed version');
          continue;
        }
        const version = await transaction(this.database, c => reuse.fixedVersion(c, projectId, source.entityId, source.version));
        requireCondition(version.metadata.kind === 'scenario', 'SCENARIO_VERSION_MISMATCH', 'Scenario input source must identify an accepted scenario');
        continue;
      }
      const sourceProject = await this.authorize(actor, source.projectId);
      const version = await transaction(this.database, c => reuse.fixedVersion(c, source.projectId, source.entityId, source.version));
      await this.content.verify(actor, sourceProject.gitlabProjectId, version.fixed, version.metadata);
      if (input.stage === 'prototype') continue;
      const inherited = await transaction(this.database, async c => {
        const all = await repository.entities(c, projectId), value = repository.entity(all, confirmation.entityId);
        if (value.current?.metadata.sources.some(s => canonical(s) === canonical(source))) return true;
        if (input.stage === 'scenario-batch' && source.projectId === projectId) {
          const original = repository.entity(all, source.entityId);
          if (original.completedVersion === source.version && original.frozenBy.includes(input.token.occupationId)) return true;
        }
        const adoptions = (await c.query<{ data: reuse.AdoptionRecord }>('SELECT data FROM studio_adoptions WHERE target_project_id=$1', [projectId])).rows;
        return adoptions.some(r => r.data.targetEntityId === value.id && r.data.targetTaskId === input.token.taskId && canonical(r.data.source) === canonical(source));
      });
      requireCondition(inherited, 'ADOPTION_REQUIRED', 'New reuse sources must have an accepted adoption for the target task');
    }
  }
  async prepare(actor: Actor, projectId: string, input: PrepareIntegrationRequest) {
    const project = await this.authorize(actor, projectId, true), action = 'integration.prepare';
    const replay = await this.replay(actor, projectId, action, input); if (replay.found) return replay.result;
    requireCondition(await this.gitlab.branchHead(actor, project.gitlabProjectId, project.stableBranch) === project.recognizedHead, 'UNRECOGNIZED_GIT_HEAD', 'Actual stable branch differs from the recognized head; reconcile before integration');
    await this.content.verifyCandidate(actor, project.gitlabProjectId, input);
    await this.verifySources(actor, projectId, input);
    return this.mutate(actor, projectId, action, input, (c, p, all) => integration.prepare(c, p, all, actor, input));
  }
  async complete(actor: Actor, projectId: string, id: string, input: CompleteIntegrationRequest) {
    const project = await this.authorize(actor, projectId, true), action = `integration.complete:${id}`;
    const replay = await this.replay(actor, projectId, action, input); if (replay.found) return replay.result;
    const operation = await transaction(this.database, c => integration.getIntegration(c, projectId, id));
    requireCondition(canonical(input.token) === canonical(operation.request.token), 'STALE_OCCUPATION', 'Completion must use the original integration occupation');
    requireCondition(await this.gitlab.branchHead(actor, project.gitlabProjectId, project.stableBranch) === operation.candidateSha, 'GIT_COMPLETION_UNVERIFIED', 'Stable branch has not reached the exact prepared candidate');
    await this.content.verifyCandidate(actor, project.gitlabProjectId, operation.request);
    return this.mutate(actor, projectId, action, input, async (c, p, all) => integration.complete(c, p, all, actor, await integration.getIntegration(c, projectId, id)));
  }
  async getIntegration(actor: Actor, projectId: string, id: string) { await this.authorize(actor, projectId); return transaction(this.database, async c => integration.publicIntegration(await integration.getIntegration(c, projectId, id))); }
  async operation(actor: Actor, projectId: string, key: string) {
    await this.authorize(actor, projectId);
    const row = (await this.database.query<{ actor_id: string; action: string; result: unknown }>('SELECT actor_id,action,result FROM studio_operations WHERE project_id=$1 AND key=$2', [projectId, key])).rows[0];
    requireCondition(row && Number(row.actor_id) === actor.id, 'OPERATION_NOT_FOUND', 'Operation result is not known for this actor', 404); return { action: row.action, result: row.result };
  }
  async versions(actor: Actor, projectId: string, id: string) { await this.authorize(actor, projectId); return transaction(this.database, c => reuse.versions(c, projectId, id)); }
  async eligibility(actor: Actor, projectId: string, id: string, input: EligibilityRequest) {
    await this.authorize(actor, projectId, true);
    return this.mutate(actor, projectId, `eligibility.write:${id}`, input, (c, _p, all) => reuse.eligibility(c, projectId, all, id, actor, input.version, input.enabled, input.reason));
  }
  async adopt(actor: Actor, projectId: string, input: AdoptRequest) {
    await this.authorize(actor, projectId, true); const sourceProject = await this.authorize(actor, input.source.projectId);
    const action = 'reuse.adopt', replay = await this.replay(actor, projectId, action, input); if (replay.found) return replay.result;
    const source = await transaction(this.database, c => reuse.fixedVersion(c, input.source.projectId, input.source.entityId, input.source.version));
    await this.content.verify(actor, sourceProject.gitlabProjectId, source.fixed, source.metadata);
    return this.mutate(actor, projectId, action, input, (c, _p, all) => reuse.adopt(c, projectId, all, actor, input), [input.source.projectId]);
  }
  async listAdoptions(actor: Actor, projectId: string) { await this.authorize(actor, projectId); return (await this.database.query('SELECT data FROM studio_adoptions WHERE target_project_id=$1 ORDER BY id', [projectId])).rows.map(r => r.data); }
  async adoptionSuccess(actor: Actor, projectId: string, id: string, input: AdoptionSuccessRequest) {
    await this.authorize(actor, projectId, true); return this.mutate(actor, projectId, `reuse.success:${id}`, input, c => reuse.adoptionSuccess(c, projectId, id, actor, input));
  }
  async reconcile(actor: Actor, projectId: string, input: ReconcileRequest) {
    const project = await this.authorize(actor, projectId, true);
    requireCondition(actor.admin, 'ADMIN_REQUIRED', 'Backend administrator permission is required to recognize a correction', 403);
    const action = 'integration.reconcile', replay = await this.replay(actor, projectId, action, input); if (replay.found) return replay.result;
    requireCondition(await this.gitlab.branchHead(actor, project.gitlabProjectId, project.stableBranch) === input.correctedHead, 'CORRECTION_HEAD_MISMATCH', 'Correction must be the actual stable branch head');
    await this.content.verifyCorrection(actor, project.gitlabProjectId, input.expectedHead, input.correctedHead);
    return this.mutate(actor, projectId, action, input, async (c, p) => {
      requireCondition(p.recognizedHead === input.expectedHead, 'INTEGRATION_HEAD_CHANGED', 'Recognized integration head changed');
      await c.query("UPDATE studio_integrations SET status='aborted',data=jsonb_set(data,'{status}','\"aborted\"') WHERE project_id=$1 AND status='prepared'", [projectId]);
      p.recognizedHead = input.correctedHead; p.revision++; await repository.saveProject(c, p);
      await repository.audit(c, projectId, actor, 'integration.reconciled', { expectedHead: input.expectedHead, correctedHead: input.correctedHead, reason: input.reason }); return p;
    });
  }
  async receipt(actor: Actor, projectId: string, id: string, input: HandoffReceiptRequest) {
    await this.authorize(actor, projectId);
    return this.mutate(actor, projectId, `handoff.receive:${id}`, input, async (c, _p, all) => {
      const value = repository.entity(all, id); requireCondition(value.kind === 'handoff' && value.current?.confirmationId === input.confirmationId, 'HANDOFF_CONFIRMATION_REQUIRED', 'Receipt requires the current accepted handoff');
      const receipt = { id: repository.newId(), entityId: id, confirmationId: input.confirmationId, actorId: actor.id, note: input.note, receivedAt: repository.now() };
      const result = await c.query('INSERT INTO studio_handoff_receipts(id,project_id,entity_id,confirmation_id,actor_id,note) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(project_id,entity_id,confirmation_id,actor_id) DO NOTHING RETURNING id', [receipt.id, projectId, id, input.confirmationId, actor.id, input.note]);
      if (!result.rowCount) return (await c.query('SELECT id,entity_id AS "entityId",confirmation_id AS "confirmationId",actor_id AS "actorId",note,created_at AS "receivedAt" FROM studio_handoff_receipts WHERE project_id=$1 AND entity_id=$2 AND confirmation_id=$3 AND actor_id=$4', [projectId, id, input.confirmationId, actor.id])).rows[0];
      return receipt;
    });
  }
  async publicationAuthorization(actor: Actor, projectId: string, input: PublicationAuthorizationRequest) {
    this.publication.assertPublisher(actor.id);
    const project = await this.authorize(actor, projectId, true);
    requireCondition(await this.gitlab.branchHead(actor, project.gitlabProjectId, project.stableBranch) === project.recognizedHead, 'UNRECOGNIZED_GIT_HEAD', 'Reconcile the stable branch before publishing');
    return transaction(this.database, async c => {
      const current = await repository.project(c, projectId, true);
      requireCondition(current.currentBaselineId === input.baselineId && current.recognizedHead === project.recognizedHead, 'CURRENT_BASELINE_REQUIRED', 'Publication requires the current accepted prototype baseline');
      requireCondition((await c.query("SELECT id FROM studio_integrations WHERE project_id=$1 AND status='prepared'", [projectId])).rowCount === 0, 'INTEGRATION_PENDING', 'Pending integration must be reconciled before publishing');
      const grant = this.publication.issue(projectId, input.baselineId, current.recognizedHead, actor.id);
      await repository.audit(c, projectId, actor, 'publication.authorized', { baselineId: input.baselineId, acceptedHead: current.recognizedHead, expiresAt: grant.expiresAt });
      return grant;
    });
  }
  async publicationCurrent(authorization: string | undefined, projectId: string) {
    const claims = this.publication.verify(authorization, projectId);
    return transaction(this.database, async c => {
      const project = await repository.project(c, projectId, true);
      requireCondition(project.currentBaselineId === claims.baselineId && project.recognizedHead === claims.acceptedHead, 'PUBLICATION_CONTEXT_CHANGED', 'The accepted baseline or integration head changed; request a new publication authorization');
      requireCondition((await c.query("SELECT id FROM studio_integrations WHERE project_id=$1 AND status='prepared'", [projectId])).rowCount === 0, 'INTEGRATION_PENDING', 'Pending integration must be reconciled before publishing');
      const baseline = (await c.query<{ data: { id: string; commitSha: string; confirmationId: string } }>('SELECT data FROM studio_baselines WHERE id=$1 AND project_id=$2', [claims.baselineId, projectId])).rows[0]?.data;
      requireCondition(baseline, 'BASELINE_NOT_FOUND', 'Accepted baseline was not found', 404);
      return { baselineId: baseline.id, commitSha: baseline.commitSha, acceptedHead: project.recognizedHead, completionEvidence: baseline.confirmationId };
    });
  }
  async deployment(actor: Actor, projectId: string, input: DeploymentRequest) {
    this.publication.assertPublisher(actor.id);
    const project = await this.authorize(actor, projectId, true);
    const url = new URL(input.url); requireCondition(['https:', 'http:'].includes(url.protocol) && !url.username && !url.password, 'INVALID_DEPLOYMENT_URL', 'Deployment URL must be an HTTP(S) URL without credentials', 422);
    requireCondition(await this.gitlab.branchHead(actor, project.gitlabProjectId, project.stableBranch) === project.recognizedHead, 'UNRECOGNIZED_GIT_HEAD', 'Reconcile the stable branch before publishing');
    return this.mutate(actor, projectId, 'deployment.record', input, async (c, p) => {
      requireCondition(p.currentBaselineId === input.baselineId && p.recognizedHead === project.recognizedHead, 'CURRENT_BASELINE_REQUIRED', 'Only the current accepted prototype baseline can be published');
      requireCondition((await c.query("SELECT id FROM studio_integrations WHERE project_id=$1 AND status='prepared'", [projectId])).rowCount === 0, 'INTEGRATION_PENDING', 'Pending integration must be reconciled before publishing');
      p.deployment = { baselineId: input.baselineId, url: input.url, artifactSha256: input.artifactSha256, deployedAt: repository.now() }; await repository.saveProject(c, p); return p.deployment;
    });
  }
}
