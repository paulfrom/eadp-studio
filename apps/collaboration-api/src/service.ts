import { canonical, requireCondition } from '@eadp/asset-domain';
import type { BindTemplateRequest, UpdateEntityRequest, FixedReference, MaterialMetadata, MaterialIntegrationRequest, MaterialStatusReportFilter, MaterialStatusReportView, RepairStartRequest, RepairEventRequest, StudioUser, AdoptRequest, AdoptionSuccessRequest, ClaimRequest, CompleteIntegrationRequest, DeploymentRequest, EligibilityRequest, EntityView, HandoffReceiptRequest, PrepareIntegrationRequest, PublicationAuthorizationRequest, ProjectState, ProjectView, ReconcileRequest, CreateProjectRequest, InitializeProjectRequest, ReleaseRequest, ReserveEntityRequest, SubmitConsistencyComparisonRequest, SubmitMaterialStatusReportRequest, ConsistencyComparisonFilter, UpdateRelationsRequest } from '@eadp/contracts';
import { GitLab } from './auth/gitlab.js';
import { SessionAuth, type Actor } from './auth/session.js';
import { Projects } from './projects.js';
import { PublicationAuthorization } from './auth/publication.js';
import { GitLabContent } from './gitlab-content.js';
import { type Database, transaction, type Transaction } from './persistence/database.js';
import * as repository from './persistence/repository.js';
import * as occupations from './modules/occupations.js';
import * as integration from './modules/integration.js';
import * as reuse from './modules/reuse.js';
import * as repairs from './modules/repairs.js';
import * as templates from './modules/templates.js';
import * as prototypes from './modules/prototypes.js';
import * as prototypeIntegration from './modules/prototype-integration.js';
import * as prototypeReuse from './modules/prototype-reuse.js';
import type { AbortPrototypeIntegrationRequest, CancelPrototypeTaskRequest, CompletePrototypeIntegrationRequest, CreatePrototypeTaskRequest, PrototypeAdoptRequest, PrototypeAdoptionSuccessRequest, PrototypeIntegrationRequest, PrototypeSourceBaseResult, ReleasePrototypeTaskRequest, UpdatePrototypeClaimsRequest, UpdatePrototypeReferencesRequest, UpdatePrototypeScopeRequest, UpdatePrototypeSourceBaseRequest } from '@eadp/contracts';
import { visibleEntity } from './modules/visibility.js';
import { prototypePolicy, validatePrototypePolicy } from './prototype-policy.js';
import { verifyPrototypeConflict, verifyPrototypeMerge } from './prototype-merge-verifier.js';

type Mutation<T> = (c: Transaction, project: ProjectView, all: EntityView[]) => Promise<T>;
export class CollaborationService {
  readonly content: GitLabContent;
  readonly projects: Projects;
  constructor(readonly database: Database, readonly gitlab: GitLab, readonly publication: PublicationAuthorization, readonly auth: SessionAuth) { this.content = new GitLabContent(gitlab); this.projects = new Projects(database, gitlab); }
  /**
   * Give every persistence operation the authenticated audit identity and the
   * display reader for accepted materials: one read per transaction, remembered
   * across requests, while acceptance itself verifies live through `content.verify`.
   */
  private async transact<T>(actor: StudioUser, action: (c: Transaction) => Promise<T>): Promise<T> {
    return transaction(this.database, c => {
      const materials = new Map<string, Promise<MaterialMetadata>>();
      return repository.withContext({ actor, loadMaterial: (projectId, fixed) => {
        const key = `${projectId}:${canonical(fixed)}`;
        let material = materials.get(key);
        if (!material) {
          material = repository.project(c, projectId).then(project => this.content.loadMaterial(actor, project.gitlabProjectId, fixed));
          materials.set(key, material);
        }
        return material;
      }, loadBuiltin: async (projectId, fixed, entityId) => {
        const project = await repository.project(c, projectId);
        return this.content.readBuiltinScenario(actor, project.gitlabProjectId, fixed, entityId);
      } }, () => action(c));
    });
  }
  async authorize(actor: Actor, projectId: string, edit = false) {
    const project = await this.transact(actor, c => repository.project(c, projectId));
    const remote = await this.gitlab.authorize(actor, project.gitlabProjectId, edit);
    this.boundRepository(project, remote); repository.assertProjectReady(project); return project;
  }
  private boundRepository(project: ProjectView, remote: { http_url_to_repo: string; namespace: { id: number; full_path: string } }): void {
    requireCondition(remote.http_url_to_repo === project.repositoryUrl && remote.namespace.id === project.namespaceId && remote.namespace.full_path === project.namespacePath, 'PROJECT_REPOSITORY_CHANGED', 'The registered GitLab repository path changed', 409);
  }
  async mutate<T>(actor: Actor, projectId: string, action: string, input: { idempotencyKey: string }, change: Mutation<T>, extraProjectIds: string[] = []): Promise<T> {
    return this.transact(actor, async c => {
      for (const id of [...new Set([projectId, ...extraProjectIds])].sort()) await repository.project(c, id, true);
      const project = await repository.project(c, projectId); repository.assertProjectReady(project);
      const previous = await repository.previous(c, projectId, actor, action, input);
      if (previous.found) return previous.result as T;
      const all = await repository.entities(c, projectId);
      const result = await change(c, project, all);
      await repository.remember(c, projectId, actor, action, input, result); return result;
    });
  }
  async replay(actor: Actor, projectId: string, action: string, input: { idempotencyKey: string }) {
    return this.transact(actor, c => repository.previous(c, projectId, actor, action, input));
  }
  /**
   * The workbench list is a database projection: a Studio session already proves
   * the account, and GitLab is consulted only when an operation acts on it.
   */
  async listProjects(actor: Actor) {
    return this.transact(actor, c => repository.listProjects(c));
  }
  /** A read projection of one bound project; GitLab is not consulted for it. */
  async project(actor: Actor, projectId: string): Promise<ProjectView> {
    return this.transact(actor, c => repository.project(c, projectId));
  }
  async createProject(actor: Actor, input: CreateProjectRequest) { return this.projects.create(actor, input); }
  async initializeProject(actor: Actor, projectId: string, input: InitializeProjectRequest) { return this.projects.initialize(actor, projectId, input); }
  async prototype(actor: Actor, projectId: string) {
    await this.authorize(actor, projectId);
    return this.transact(actor, async c => prototypes.projectPrototype(c, await repository.project(c, projectId), actor));
  }
  async prototypeTask(actor: Actor, projectId: string, taskId: string) {
    await this.authorize(actor, projectId);
    return this.transact(actor, c => prototypes.getTask(c, projectId, taskId, actor));
  }
  async createPrototypeTask(actor: Actor, projectId: string, input: CreatePrototypeTaskRequest) {
    await this.authorize(actor, projectId, true);
    validatePrototypePolicy(await prototypePolicy(), input.writeScope, input.policyHash);
    return this.mutate(actor, projectId, 'prototype.task.create', input, (c, project, all) => prototypes.createTask(c, project, all, actor, input));
  }
  async extendPrototypeClaims(actor: Actor, projectId: string, taskId: string, input: UpdatePrototypeClaimsRequest) {
    await this.authorize(actor, projectId, true);
    return this.mutate(actor, projectId, `prototype.task.claims:${taskId}`, input, (c, _project, all) => prototypes.extendClaims(c, projectId, all, actor, taskId, input));
  }
  async updatePrototypeReferences(actor: Actor, projectId: string, taskId: string, input: UpdatePrototypeReferencesRequest) {
    await this.authorize(actor, projectId, true);
    return this.mutate(actor, projectId, `prototype.task.references:${taskId}`, input, (c, _project, all) => prototypes.updateReferences(c, projectId, all, actor, taskId, input));
  }
  async updatePrototypeScope(actor: Actor, projectId: string, taskId: string, input: UpdatePrototypeScopeRequest) {
    await this.authorize(actor, projectId, true);
    validatePrototypePolicy(await prototypePolicy(), input.writeScope, input.policyHash);
    return this.mutate(actor, projectId, `prototype.task.scope:${taskId}`, input, c => prototypes.updateScope(c, projectId, actor, taskId, input));
  }
  /** The registered base may advance only after the original uploaded source really conflicts. */
  async updatePrototypeSourceBase(actor: Actor, projectId: string, taskId: string, input: UpdatePrototypeSourceBaseRequest): Promise<PrototypeSourceBaseResult> {
    const project = await this.authorize(actor, projectId, true);
    const action = `prototype.task.source-base:${taskId}`;
    const previous = await this.replay(actor, projectId, action, input);
    if (previous.found) return previous.result as PrototypeSourceBaseResult;
    const task = await this.transact(actor, c => prototypes.getTask(c, projectId, taskId, actor));
    prototypes.assertPrototypeClaims(task, actor, input);
    requireCondition(project.recognizedHead === input.newBaseHead && input.newBaseHead !== task.sourceBaseHead, 'INTEGRATION_HEAD_CHANGED', 'The requested source base is not the current recognized head', 409);
    validatePrototypePolicy(await prototypePolicy(), task.writeScope, task.policyHash);
    requireCondition(!input.sourceOperationId.includes('..') && !input.sourceOperationId.endsWith('.lock') && input.sourceRef === `refs/heads/studio-private/${taskId}/${input.sourceOperationId}/source`, 'INVALID_SOURCE_REF', 'The source ref must identify the original task operation', 422);
    const prefix = `/projects/${project.gitlabProjectId}/repository`;
    const observe = async () => Promise.all([
      this.gitlab.branchHead(project.gitlabProjectId, project.stableBranch),
      this.gitlab.json<{ id: string }>(`${prefix}/commits/${encodeURIComponent(input.sourceRef)}`),
      this.gitlab.json<{ id: string; parent_ids: string[] }>(`${prefix}/commits/${input.sourceSha}`),
    ]);
    const checkObserved = ([head, ref, source]: Awaited<ReturnType<typeof observe>>): void => {
      requireCondition(head === input.newBaseHead, 'UNRECOGNIZED_GIT_HEAD', 'Stable branch does not match the recognized project head', 409);
      requireCondition(ref.id === input.sourceSha && source.id === input.sourceSha && Array.isArray(source.parent_ids) && source.parent_ids.length === 1 && source.parent_ids[0] === task.sourceBaseHead, 'SOURCE_CANDIDATE_MISMATCH', 'The original source ref or its parent does not match the registered task base', 409);
    };
    checkObserved(await observe());
    const mergeBaseSha = await verifyPrototypeConflict(this.gitlab, project.gitlabProjectId, { sourceBaseHead: task.sourceBaseHead, sourceSha: input.sourceSha, newBaseHead: input.newBaseHead, writeScope: task.writeScope });
    checkObserved(await observe());
    return this.mutate(actor, projectId, action, input, async (c, current) => {
      const updated = await prototypes.updateSourceBase(c, current, actor, taskId, input, task.sourceBaseHead);
      return { task: updated, source: { operationId: input.sourceOperationId, ref: input.sourceRef, sha: input.sourceSha, previousBaseHead: task.sourceBaseHead, newBaseHead: input.newBaseHead, mergeBaseSha } };
    });
  }
  /** Revoke the task independently of Git availability and retain the observed recovery state. */
  private async endPrototypeTask(actor: Actor, projectId: string, taskId: string, status: 'cancelled' | 'released', input: CancelPrototypeTaskRequest | ReleasePrototypeTaskRequest) {
    const project = await this.authorize(actor, projectId, true);
    const action = `prototype.task.${status === 'cancelled' ? 'cancel' : 'release'}:${taskId}`;
    const previous = await this.replay(actor, projectId, action, input);
    if (previous.found) return previous.result;
    let observedHead: string | undefined;
    try {
      observedHead = await this.gitlab.branchHead(project.gitlabProjectId, project.stableBranch);
    } catch {
      // An unavailable observation must not keep the task's authorization alive.
    }
    return this.mutate(actor, projectId, action, input, async (c, current) => ({
      ...(await prototypes.endTask(c, projectId, actor, taskId, status, input)),
      gitRecovery: observedHead === undefined ? 'unknown' : observedHead === current.recognizedHead ? 'clear' : 'reconcile-required',
    }));
  }
  async cancelPrototypeTask(actor: Actor, projectId: string, taskId: string, input: CancelPrototypeTaskRequest) {
    return this.endPrototypeTask(actor, projectId, taskId, 'cancelled', input);
  }
  async releasePrototypeTask(actor: Actor, projectId: string, taskId: string, input: ReleasePrototypeTaskRequest) {
    return this.endPrototypeTask(actor, projectId, taskId, 'released', input);
  }
  async prototypeBaselines(actor: Actor, projectId: string, limit: number, offset: number) {
    await this.authorize(actor, projectId);
    return this.transact(actor, c => prototypeIntegration.baselines(c, projectId, limit, offset));
  }
  async prototypeAdoptions(actor: Actor, projectId: string) {
    await this.authorize(actor, projectId);
    return this.transact(actor, c => prototypeReuse.list(c, projectId));
  }
  async adoptPrototype(actor: Actor, projectId: string, input: PrototypeAdoptRequest) {
    await this.authorize(actor, projectId, true); await this.authorize(actor, input.source.projectId);
    return this.mutate(actor, projectId, 'prototype.reuse.adopt', input, c => prototypeReuse.adopt(c, projectId, actor, input), [input.source.projectId]);
  }
  async prototypeAdoptionSuccess(actor: Actor, projectId: string, id: string, input: PrototypeAdoptionSuccessRequest) {
    await this.authorize(actor, projectId, true);
    return this.mutate(actor, projectId, `prototype.reuse.success:${id}`, input, c => prototypeReuse.success(c, projectId, id, actor, input));
  }
  async prototypeIntegration(actor: Actor, projectId: string, id: string) {
    await this.authorize(actor, projectId);
    return this.transact(actor, c => prototypeIntegration.getIntegration(c, projectId, id, actor));
  }
  private async inspectPrototypeCandidate(project: ProjectView, input: PrototypeIntegrationRequest) {
    const prefix = `/projects/${project.gitlabProjectId}/repository`;
    const expectedPrefix = `refs/heads/studio-private/${input.token.prototypeTaskId}/`;
    requireCondition(input.sourceRef.startsWith(expectedPrefix) && input.sourceRef.endsWith('/source') && input.candidateRef === `${input.sourceRef.slice(0, -'/source'.length)}/candidate`, 'INVALID_SOURCE_REF', 'Source and candidate refs must belong to this task and operation', 422);
    const [sourceRef, candidateRef, source, candidate] = await Promise.all([
      this.gitlab.json<{ id: string }>(`${prefix}/commits/${encodeURIComponent(input.sourceRef)}`),
      this.gitlab.json<{ id: string }>(`${prefix}/commits/${encodeURIComponent(input.candidateRef)}`),
      this.gitlab.json<{ id: string; parent_ids: string[] }>(`${prefix}/commits/${input.sourceSha}`),
      this.gitlab.json<{ id: string; parent_ids: string[] }>(`${prefix}/commits/${input.candidateSha}`),
    ]);
    requireCondition(sourceRef.id === input.sourceSha && candidateRef.id === input.candidateSha && source.id === input.sourceSha && candidate.id === input.candidateSha && source.parent_ids.length === 1 && source.parent_ids[0] === input.sourceBaseHead, 'SOURCE_CANDIDATE_MISMATCH', 'Uploaded refs and source parent must match the confirmed source', 409);
    if (input.derivation.kind === 'author-confirmed') requireCondition(input.sourceBaseHead === input.expectedHead && input.candidateSha === input.sourceSha, 'SOURCE_CANDIDATE_MISMATCH', 'Direct candidates must be the confirmed source', 409);
    else requireCondition(candidate.parent_ids.length === 2 && candidate.parent_ids[0] === input.expectedHead && candidate.parent_ids[1] === input.sourceSha, 'SOURCE_CANDIDATE_MISMATCH', 'Merged candidate must retain the expected head and source as parents', 409);
    await verifyPrototypeMerge(this.gitlab, project.gitlabProjectId, input);
  }
  async preparePrototypeIntegration(actor: Actor, projectId: string, input: PrototypeIntegrationRequest) {
    const project = await this.authorize(actor, projectId, true), action = 'prototype.integration.prepare';
    const previous = await this.replay(actor, projectId, action, input); if (previous.found) return previous.result;
    const task = await this.transact(actor, c => prototypes.getTask(c, projectId, input.token.prototypeTaskId, actor));
    validatePrototypePolicy(await prototypePolicy(), task.writeScope, task.policyHash);
    requireCondition(await this.gitlab.branchHead(project.gitlabProjectId, project.stableBranch) === project.recognizedHead, 'UNRECOGNIZED_GIT_HEAD', 'Stable branch differs from the recognized head', 409);
    await this.inspectPrototypeCandidate(project, input);
    return this.mutate(actor, projectId, action, input, (c, current) => prototypeIntegration.prepare(c, current, actor, input));
  }
  async completePrototypeIntegration(actor: Actor, projectId: string, id: string, input: CompletePrototypeIntegrationRequest) {
    const project = await this.authorize(actor, projectId, true), action = `prototype.integration.complete:${id}`;
    const previous = await this.replay(actor, projectId, action, input); if (previous.found) return previous.result;
    const operation = await this.transact(actor, c => prototypeIntegration.getIntegration(c, projectId, id, actor));
    if (operation.status === 'accepted') return this.mutate(actor, projectId, action, input, (c, current) => prototypeIntegration.complete(c, current, actor, id, input));
    requireCondition(await this.gitlab.branchHead(project.gitlabProjectId, project.stableBranch) === operation.candidateSha, 'GIT_COMPLETION_UNVERIFIED', 'Stable branch has not reached the prepared candidate', 409);
    const request = await this.transact(actor, c => prototypeIntegration.integrationRequest(c, projectId, id, actor));
    const task = await this.transact(actor, c => prototypes.getTask(c, projectId, request.token.prototypeTaskId, actor));
    validatePrototypePolicy(await prototypePolicy(), task.writeScope, task.policyHash);
    await this.inspectPrototypeCandidate(project, request);
    return this.mutate(actor, projectId, action, input, (c, current) => prototypeIntegration.complete(c, current, actor, id, input));
  }
  async abortPrototypeIntegration(actor: Actor, projectId: string, id: string, input: AbortPrototypeIntegrationRequest) {
    const project = await this.authorize(actor, projectId, true), action = `prototype.integration.abort:${id}`;
    const previous = await this.replay(actor, projectId, action, input); if (previous.found) return previous.result;
    const operation = await this.transact(actor, c => prototypeIntegration.getIntegration(c, projectId, id, actor));
    requireCondition(await this.gitlab.branchHead(project.gitlabProjectId, project.stableBranch) === operation.expectedHead, 'GIT_COMPLETION_UNVERIFIED', 'Stable branch changed; reconcile the integration before aborting', 409);
    return this.mutate(actor, projectId, action, input, (c, current) => prototypeIntegration.abort(c, current, actor, id, input));
  }
  async state(actor: Actor, projectId: string): Promise<ProjectState> {
    return this.transact(actor, async c => {
      await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      const project = await repository.project(c, projectId), entities = await repository.entities(c, projectId);
      const integrations = (await repository.listIntegrations(c, projectId)).map(integration.publicIntegration);
      const baselines = await prototypeIntegration.baselines(c, projectId);
      return { project, entities: entities.map(entity => visibleEntity(entity, actor)), integrations, baselines };
    });
  }
  async reserve(actor: Actor, projectId: string, input: ReserveEntityRequest) {
    const bound = await this.authorize(actor, projectId, true);
    const replay = await this.replay(actor, projectId, 'entity.reserve', input);
    if (replay.found) return replay.result as EntityView;
    let template: { templateId: string; templateRef: FixedReference } | undefined;
    if (input.kind === 'scenario' || input.kind === 'requirement') {
      const catalogs = await this.content.loadProjectTemplates(actor, bound.gitlabProjectId, bound.recognizedHead!);
      const catalog = input.kind === 'scenario' ? catalogs.scenarios : catalogs.requirements;
      const selected = catalog.templates.find(t => t.id === (input.templateId ?? catalog.defaultTemplateId));
      requireCondition(selected, 'TEMPLATE_NOT_FOUND', 'Select an accepted project template', 422);
      requireCondition(!input.templateRef || canonical(input.templateRef) === canonical(selected.fixed), 'TEMPLATE_VERSION_MISMATCH', 'New materials bind the selected accepted project template');
      template = { templateId: selected.id, templateRef: selected.fixed };
    }
    const number = input.kind === 'scenario' || input.kind === 'requirement' ? await repository.reserveEntityNumber(this.database, projectId, input.kind, actor, input) : undefined;
    return this.mutate(actor, projectId, 'entity.reserve', input, async (c, project, all) => {
      requireCondition(project.recognizedHead === bound.recognizedHead, 'INTEGRATION_HEAD_CHANGED', 'Refresh accepted project configuration before creating a material');
      const sources = input.kind === 'requirement' ? input.sources : [];
      if (input.kind === 'requirement') {
        requireCondition(sources.length > 0 && new Set(sources.map(s => s.entityId)).size === sources.length, 'SCENARIO_SOURCE_REQUIRED', 'A requirement must bind one or more distinct accepted scenario versions', 422);
        for (const source of sources) {
          requireCondition(source.projectId === projectId, 'SCENARIO_SOURCE_REQUIRED', 'Requirement scenario sources must belong to the same project', 422);
          const scene = repository.entity(all, source.entityId);
          requireCondition(scene.kind === 'scenario' && scene.materialVersion >= source.version && source.version > 0, 'SCENARIO_VERSION_MISMATCH', 'Requirement sources must identify accepted scenario versions');
          await reuse.fixedVersion(c, projectId, scene.id, source.version);
        }
      }
      const value: EntityView = { id: number?.id ?? repository.newId(), kind: input.kind, title: input.title,
        ...(number ? { sequence: number.sequence, code: number.code } : {}), ...template,
        revision: 0, generation: 0, materialVersion: 0, confirmationStatus: 'draft', taskStatus: 'idle',
        scenarioIds: sources.map(s => s.entityId), ...(sources.length ? { scenarioSources: sources } : {}),
        prerequisites: [], authorId: actor.id };
      await repository.saveEntity(c, projectId, value);
      return repository.entity(await repository.entities(c, projectId), value.id);
    });
  }
  async claim(actor: Actor, projectId: string, id: string, input: ClaimRequest) {
    const project = await this.authorize(actor, projectId, true);
    requireCondition(await this.gitlab.branchHead(project.gitlabProjectId, project.stableBranch) === project.recognizedHead, 'UNRECOGNIZED_GIT_HEAD', 'Actual stable branch differs from the recognized head; reconcile before claiming', 409);
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
  async updateEntity(actor: Actor, projectId: string, id: string, input: UpdateEntityRequest) {
    await this.authorize(actor, projectId, true);
    return this.mutate(actor, projectId, `entity.update:${id}`, input, async (c, _project, all) => {
      const value = repository.entity(all, id), occupation = occupations.assertOccupation(value, input.token, actor);
      requireCondition(!value.builtinKey, 'BUILTIN_SCENARIO_IMMUTABLE', 'The built-in general scenario cannot be edited', 409);
      requireCondition(!(await c.query("SELECT id FROM studio_integrations WHERE project_id=$1 AND status='prepared' AND occupation_id=$2", [projectId, occupation.occupationId])).rowCount,
        'INTEGRATION_PENDING', 'Reconcile the prepared confirmation before changing directory fields');
      await repairs.invalidateEntityRepairs(c, projectId, id, actor);
      value.title = input.title; if (input.summary !== undefined) value.summary = input.summary;
      value.revision++; occupation.expectedRevision = value.revision;
      await repository.saveEntity(c, projectId, value);
      return repository.entity(await repository.entities(c, projectId), value.id);
    });
  }
  async revisionImpact(actor: Actor, projectId: string, id: string) {
    return this.transact(actor, async c => {
      const all = await repository.entities(c, projectId), scenario = repository.entity(all, id);
      requireCondition(scenario.kind === 'scenario' && scenario.materialVersion > 0, 'CONFIRMED_SCENARIO_REQUIRED', 'Revision impact requires an accepted scenario');
      return { entityId: id, expectedRevision: scenario.revision,
        requirements: all.filter(value => value.kind === 'requirement' && value.scenarioIds.includes(id)).map(value => ({ id: value.id, title: value.title,
          materialVersion: value.materialVersion, taskStatus: value.taskStatus,
          ...(value.occupation ? { occupation: value.occupation } : {}) })) };
    });
  }
  async projectTemplates(actor: Actor, projectId: string) {
    const project = await this.project(actor, projectId);
    return { acceptedHead: project.recognizedHead, ...await this.content.loadProjectTemplates(actor, project.gitlabProjectId, project.recognizedHead!) };
  }
  async bindTemplate(actor: Actor, projectId: string, id: string, input: BindTemplateRequest) {
    const project = await this.authorize(actor, projectId, true);
    const kind = await this.transact(actor, c => repository.entityRow(c, projectId, id)).then(row => row.kind);
    requireCondition(kind !== 'requirement', 'REQUIREMENT_TEMPLATE_FIXED', 'A requirement keeps the template selected at creation', 409);
    requireCondition(kind === 'scenario', 'TEMPLATE_BINDING_REQUIRES_DESIGN', 'Template binding requires a scenario design task', 409);
    const action = `scenario.template:${id}`, replay = await this.replay(actor, projectId, action, input);
    if (replay.found) return replay.result;
    await templates.verifyBinding(this.gitlab, this.content, actor, project, input);
    return this.mutate(actor, projectId, action, input, async (c, current, all) => {
      requireCondition(current.recognizedHead === project.recognizedHead, 'INTEGRATION_HEAD_CHANGED', 'Refresh accepted project history before switching templates');
      await templates.bind(c, projectId, repository.entity(all, id), actor, input);
      return repository.entity(await repository.entities(c, projectId), id);
    });
  }
  async startRepair(actor: Actor, projectId: string, id: string, input: RepairStartRequest) {
    await this.authorize(actor, projectId, true);
    return this.mutate(actor, projectId, `repair.start:${id}`, input, (c, _p, all) => repairs.start(c, projectId, repository.entity(all, id), actor, input));
  }
  async repairEvent(actor: Actor, projectId: string, id: string, input: RepairEventRequest) {
    await this.authorize(actor, projectId, true);
    return this.mutate(actor, projectId, `repair.event:${id}`, input, async (c, _p, all) => {
      const repair = await repairs.task(c, projectId, id);
      return repairs.event(c, projectId, repository.entity(all, repair.entityId), id, actor, input);
    });
  }
  async getRepair(actor: Actor, projectId: string, id: string) {
    return this.transact(actor, async c => {
      const value = await repairs.task(c, projectId, id);
      requireCondition(value.createdBy === actor.id, 'REPAIR_NOT_FOUND', 'Repair authorization was not found', 404);
      return value;
    });
  }
  async verifySources(actor: Actor, projectId: string, input: MaterialIntegrationRequest, materials: Map<string, MaterialMetadata>) {
    for (const confirmation of input.confirmations) for (const source of materials.get(confirmation.entityId)!.sources) {
      // A requirement's fixed scenario input is provenance, not package adoption.
      if (source.projectId === projectId && materials.get(confirmation.entityId)!.scenarioIds.includes(source.entityId)) {
        const version = await this.transact(actor, c => reuse.fixedVersion(c, projectId, source.entityId, source.version));
        requireCondition(version.metadata.kind === 'scenario', 'SCENARIO_VERSION_MISMATCH', 'Scenario input source must identify an accepted scenario');
        continue;
      }
      const sourceProject = await this.authorize(actor, source.projectId);
      const version = await this.transact(actor, c => reuse.fixedVersion(c, source.projectId, source.entityId, source.version));
      await this.content.verify(actor, sourceProject.gitlabProjectId, version.fixed, { entityId: source.entityId, kind: version.metadata.kind });
      const inherited = await this.transact(actor, async c => {
        const all = await repository.entities(c, projectId), value = repository.entity(all, confirmation.entityId);
        if (value.current?.metadata.sources.some(s => canonical(s) === canonical(source))) return true;
        const adoptions = await repository.listAdoptions(c, projectId);
        return adoptions.some(r => r.targetEntityId === value.id && r.targetTaskId === input.token.taskId && canonical(r.source) === canonical(source));
      });
      requireCondition(inherited, 'ADOPTION_REQUIRED', 'New reuse sources must have an accepted adoption for the target task');
    }
  }
  async prepare(actor: Actor, projectId: string, input: PrepareIntegrationRequest) {
    const project = await this.authorize(actor, projectId, true), action = 'integration.prepare';
    const replay = await this.replay(actor, projectId, action, input); if (replay.found) return replay.result;
    requireCondition(await this.gitlab.branchHead(project.gitlabProjectId, project.stableBranch) === project.recognizedHead, 'UNRECOGNIZED_GIT_HEAD', 'Actual stable branch differs from the recognized head; reconcile before integration');
    const materials = await this.content.verifyCandidate(actor, project.gitlabProjectId, input);
    if (input.stage !== 'template') await this.verifySources(actor, projectId, input, materials);
    return this.mutate(actor, projectId, action, input, (c, p, all) => integration.prepare(c, p, all, actor, input, materials));
  }
  async complete(actor: Actor, projectId: string, id: string, input: CompleteIntegrationRequest) {
    const project = await this.authorize(actor, projectId, true), action = `integration.complete:${id}`;
    const replay = await this.replay(actor, projectId, action, input); if (replay.found) return replay.result;
    const operation = await this.transact(actor, c => integration.getIntegration(c, projectId, id));
    requireCondition(operation.ownerId === actor.id, 'INTEGRATION_OWNER_REQUIRED', 'Complete the integration using its original authenticated user', 403);
    requireCondition(operation.request.stage === 'template' ? !input.token : canonical(input.token) === canonical(operation.request.token), 'STALE_OCCUPATION', 'Completion must use the original integration occupation');
    requireCondition(await this.gitlab.branchHead(project.gitlabProjectId, project.stableBranch) === operation.candidateSha, 'GIT_COMPLETION_UNVERIFIED', 'Stable branch has not reached the exact prepared candidate');
    const materials = await this.content.verifyCandidate(actor, project.gitlabProjectId, operation.request);
    if (operation.request.stage !== 'template') await this.verifySources(actor, projectId, operation.request, materials);
    return this.mutate(actor, projectId, action, input, async (c, p, all) => integration.complete(c, p, all, actor, await integration.getIntegration(c, projectId, id), materials));
  }
  async getIntegration(actor: Actor, projectId: string, id: string) { return this.transact(actor, async c => integration.publicIntegration(await integration.getIntegration(c, projectId, id))); }
  async operation(actor: Actor, projectId: string, key: string) {
    return this.transact(actor, c => repository.operation(c, projectId, key, actor));
  }
  async versions(actor: Actor, projectId: string, id: string) { return this.transact(actor, c => reuse.versions(c, projectId, id)); }
  async eligibility(actor: Actor, projectId: string, id: string, input: EligibilityRequest) {
    await this.authorize(actor, projectId, true);
    return this.mutate(actor, projectId, `eligibility.write:${id}`, input, (c, _p, all) => reuse.eligibility(c, projectId, all, id, actor, input.version, input.enabled, input.reason));
  }
  async adopt(actor: Actor, projectId: string, input: AdoptRequest) {
    await this.authorize(actor, projectId, true); const sourceProject = await this.authorize(actor, input.source.projectId);
    const action = 'reuse.adopt', replay = await this.replay(actor, projectId, action, input); if (replay.found) return replay.result;
    const source = await this.transact(actor, c => reuse.fixedVersion(c, input.source.projectId, input.source.entityId, input.source.version));
    await this.content.verify(actor, sourceProject.gitlabProjectId, source.fixed, { entityId: input.source.entityId, kind: source.metadata.kind });
    return this.mutate(actor, projectId, action, input, (c, _p, all) => reuse.adopt(c, projectId, all, actor, input), [input.source.projectId]);
  }
  async listAdoptions(actor: Actor, projectId: string) { return this.transact(actor, c => repository.listAdoptions(c, projectId)); }
  async adoptionSuccess(actor: Actor, projectId: string, id: string, input: AdoptionSuccessRequest) {
    await this.authorize(actor, projectId, true); return this.mutate(actor, projectId, `reuse.success:${id}`, input, c => reuse.adoptionSuccess(c, projectId, id, actor, input));
  }
  async reconcile(actor: Actor, projectId: string, input: ReconcileRequest) {
    const project = await this.authorize(actor, projectId, true);
    requireCondition(actor.admin, 'ADMIN_REQUIRED', 'Backend administrator permission is required to recognize a correction', 403);
    const action = 'integration.reconcile', replay = await this.replay(actor, projectId, action, input); if (replay.found) return replay.result;
    requireCondition(await this.gitlab.branchHead(project.gitlabProjectId, project.stableBranch) === input.correctedHead, 'CORRECTION_HEAD_MISMATCH', 'Correction must be the actual stable branch head');
    await this.content.verifyCorrection(actor, project.gitlabProjectId, input.expectedHead, input.correctedHead);
    return this.mutate(actor, projectId, action, input, async (c, p) => {
      requireCondition(p.recognizedHead === input.expectedHead, 'INTEGRATION_HEAD_CHANGED', 'Recognized integration head changed');
      await c.query("UPDATE studio_integrations SET status='aborted',last_editor_id=$2,last_editor_account=$3,last_editor_name=$4,last_edited_date=now() WHERE project_id=$1 AND status='prepared'", [projectId, actor.id, actor.username, actor.name]);
      await c.query("UPDATE studio_prototype_integrations SET status='aborted',git_recovery='reconciled' WHERE project_id=$1 AND (status='prepared' OR (status='aborted' AND git_recovery='pending'))", [projectId]);
      p.recognizedHead = input.correctedHead; p.revision++; await repository.saveProject(c, p);
      await repository.audit(c, projectId, actor, 'integration.reconciled', { expectedHead: input.expectedHead, correctedHead: input.correctedHead, reason: input.reason }); return p;
    });
  }
  async receipt(actor: Actor, projectId: string, id: string, input: HandoffReceiptRequest) {
    await this.authorize(actor, projectId);
    return this.mutate(actor, projectId, `handoff.receive:${id}`, input, async (c, _p, all) => {
      const value = repository.entity(all, id); requireCondition(value.kind === 'handoff' && value.current?.confirmationId === input.confirmationId, 'HANDOFF_CONFIRMATION_REQUIRED', 'Receipt requires the current accepted handoff');
      const receipt = { id: repository.newId(), entityId: id, confirmationId: input.confirmationId, actorId: actor.id, note: input.note, receivedAt: repository.now() };
      const result = await c.query(`INSERT INTO studio_handoff_receipts(id,project_id,entity_id,confirmation_id,note,creator_id,creator_account,creator_name)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(project_id,entity_id,confirmation_id,creator_id) DO NOTHING RETURNING id`,
      [receipt.id, projectId, id, input.confirmationId, input.note, actor.id, actor.username, actor.name]);
      if (!result.rowCount) return (await c.query('SELECT id,entity_id AS "entityId",confirmation_id AS "confirmationId",creator_id::integer AS "actorId",note,created_date AS "receivedAt" FROM studio_handoff_receipts WHERE project_id=$1 AND entity_id=$2 AND confirmation_id=$3 AND creator_id=$4', [projectId, id, input.confirmationId, actor.id])).rows[0];
      return receipt;
    });
  }
  async publicationAuthorization(actor: Actor, projectId: string, input: PublicationAuthorizationRequest) {
    this.publication.assertPublisher(actor.id);
    const project = await this.authorize(actor, projectId, true);
    requireCondition(await this.gitlab.branchHead(project.gitlabProjectId, project.stableBranch) === project.recognizedHead, 'UNRECOGNIZED_GIT_HEAD', 'Reconcile the stable branch before publishing');
    return this.transact(actor, async c => {
      const current = await repository.project(c, projectId, true);
      repository.assertProjectReady(current);
      const prototype = await prototypes.projectPrototype(c, current, actor);
      requireCondition(prototype.currentBaselineId === input.baselineId && current.recognizedHead === project.recognizedHead, 'CURRENT_BASELINE_REQUIRED', 'Publication requires the current accepted prototype baseline');
      requireCondition((await c.query("SELECT id FROM studio_integrations WHERE project_id=$1 AND status='prepared' UNION ALL SELECT id FROM studio_prototype_integrations WHERE project_id=$1 AND status='prepared'", [projectId])).rowCount === 0, 'INTEGRATION_PENDING', 'Pending integration must be reconciled before publishing');
      const grant = this.publication.issue(projectId, input.baselineId, current.recognizedHead, actor.id);
      await repository.audit(c, projectId, actor, 'publication.authorized', { baselineId: input.baselineId, acceptedHead: current.recognizedHead, expiresAt: grant.expiresAt });
      return grant;
    });
  }
  async publicationCurrent(authorization: string | undefined, projectId: string) {
    const claims = this.publication.verify(authorization, projectId);
    const actor = await this.auth.boundUser(claims.actorId), bound = await this.transact(actor, c => repository.project(c, projectId));
    const remote = await this.gitlab.authorize(actor, bound.gitlabProjectId); this.boundRepository(bound, remote);
    return this.transact(actor, async c => {
      const project = await repository.project(c, projectId, true);
      repository.assertProjectReady(project);
      const prototype = await prototypes.projectPrototype(c, project, actor);
      requireCondition(prototype.currentBaselineId === claims.baselineId && project.recognizedHead === claims.acceptedHead, 'PUBLICATION_CONTEXT_CHANGED', 'The accepted baseline or integration head changed; request a new publication authorization');
      requireCondition((await c.query("SELECT id FROM studio_integrations WHERE project_id=$1 AND status='prepared' UNION ALL SELECT id FROM studio_prototype_integrations WHERE project_id=$1 AND status='prepared'", [projectId])).rowCount === 0, 'INTEGRATION_PENDING', 'Pending integration must be reconciled before publishing');
      const baseline = (await prototypeIntegration.baselines(c, projectId)).find(item => item.id === claims.baselineId);
      requireCondition(baseline, 'BASELINE_NOT_FOUND', 'Accepted baseline was not found', 404);
      return { baselineId: baseline.id, commitSha: baseline.commitSha, acceptedHead: project.recognizedHead, completionEvidence: baseline.acceptanceId };
    });
  }
  async submitComparison(actor: Actor, projectId: string, input: SubmitConsistencyComparisonRequest) {
    await this.authorize(actor, projectId, true);
    return this.transact(actor, async c => {
      await repository.entityRow(c, projectId, input.entityId);
      if (input.trigger === 'confirmation') {
        const confirmation = await repository.confirmation(c, projectId, input.confirmationId);
        requireCondition(confirmation.event.entityId === input.entityId && confirmation.stage === 'material', 'COMPARISON_CONFIRMATION_MISMATCH', 'Automatic comparison must bind a material confirmation of its target', 422);
      }
      for (const conflict of input.conflicts) for (const involved of conflict.entities) await repository.entityRow(c, projectId, involved);
      return repository.saveComparison(c, projectId, actor, input);
    });
  }
  async listComparisons(actor: Actor, projectId: string, query: ConsistencyComparisonFilter) {
    return this.transact(actor, c => repository.listComparisons(c, projectId, query));
  }
  async getComparison(actor: Actor, projectId: string, id: string) {
    return this.transact(actor, c => repository.getComparison(c, projectId, id));
  }
  async submitStatusReport(actor: Actor, projectId: string, entityId: string, input: SubmitMaterialStatusReportRequest): Promise<MaterialStatusReportView> {
    await this.authorize(actor, projectId, true);
    requireCondition(input.entityId === entityId, 'STATUS_REPORT_TARGET_MISMATCH', 'Status report must name the entity in its route', 422);
    return this.transact(actor, async c => {
      await repository.project(c, projectId, true);
      const project = await repository.project(c, projectId); repository.assertProjectReady(project);
      const previous = await repository.previous(c, projectId, actor, 'material.status-report', input);
      if (previous.found) return repository.getStatusReport(c, projectId, input.id);
      await repository.entityRow(c, projectId, entityId);
      const result = await repository.saveStatusReport(c, projectId, actor, input);
      await repository.remember(c, projectId, actor, 'material.status-report', input, { id: result.id });
      return result;
    });
  }
  async listStatusReports(actor: Actor, projectId: string, filter: MaterialStatusReportFilter): Promise<MaterialStatusReportView[]> {
    await this.authorize(actor, projectId);
    return this.transact(actor, async c => {
      if (filter.entityId) await repository.entityRow(c, projectId, filter.entityId);
      return repository.listStatusReports(c, projectId, filter);
    });
  }
  async getStatusReport(actor: Actor, projectId: string, id: string): Promise<MaterialStatusReportView> {
    await this.authorize(actor, projectId);
    return this.transact(actor, c => repository.getStatusReport(c, projectId, id));
  }
  async consistencyContext(actor: Actor, projectId: string, entityId: string) {
    return this.transact(actor, c => repository.consistencyContext(c, projectId, entityId));
  }
  async deployment(actor: Actor, projectId: string, input: DeploymentRequest) {
    this.publication.assertPublisher(actor.id);
    const project = await this.authorize(actor, projectId, true);
    const url = new URL(input.url); requireCondition(['https:', 'http:'].includes(url.protocol) && !url.username && !url.password, 'INVALID_DEPLOYMENT_URL', 'Deployment URL must be an HTTP(S) URL without credentials', 422);
    requireCondition(await this.gitlab.branchHead(project.gitlabProjectId, project.stableBranch) === project.recognizedHead, 'UNRECOGNIZED_GIT_HEAD', 'Reconcile the stable branch before publishing');
    return this.mutate(actor, projectId, 'deployment.record', input, async (c, p) => {
      const prototype = await prototypes.projectPrototype(c, p, actor);
      requireCondition(prototype.currentBaselineId === input.baselineId && p.recognizedHead === project.recognizedHead, 'CURRENT_BASELINE_REQUIRED', 'Only the current accepted prototype baseline can be published');
      requireCondition((await c.query("SELECT id FROM studio_integrations WHERE project_id=$1 AND status='prepared' UNION ALL SELECT id FROM studio_prototype_integrations WHERE project_id=$1 AND status='prepared'", [projectId])).rowCount === 0, 'INTEGRATION_PENDING', 'Pending integration must be reconciled before publishing');
      p.deployment = { baselineId: input.baselineId, url: input.url, artifactSha256: input.artifactSha256, deployedAt: repository.now() }; await repository.saveProject(c, p); return p.deployment;
    });
  }
}
