import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireCondition } from '@eadp/asset-domain';
import type { TSchema, Static } from '@eadp/contracts';
import * as contract from '@eadp/contracts';
import type { Actor } from './auth/session.js';
import type { Config } from './config.js';
import { decideDesktopUpdate } from './desktop-update.js';
import type { CollaborationService } from './service.js';

declare module 'fastify' { interface FastifyRequest { actor: Actor } }
export function registerRoutes(app: FastifyInstance, service: CollaborationService, config: Config) {
  app.decorateRequest('actor');
  app.addHook('preHandler', async request => {
    if (request.routeOptions.url === '/health' || request.routeOptions.url === '/v1/auth/login' || request.routeOptions.url === '/v1/projects/:projectId/publication-current' || request.routeOptions.url === '/api/v0/check_client_update') return;
    request.actor = await service.auth.authenticate(request.headers.authorization);
  });
  app.get('/health', async () => { await service.database.query('SELECT 1'); return { status: 'ok' }; });
  app.get('/api/v0/check_client_update', request => decideDesktopUpdate(config, request.headers));
  app.post<{ Body: contract.LoginRequest }>('/v1/auth/login', { schema: { body: contract.LoginSchema } }, request => service.auth.login(request.body));
  app.post('/v1/auth/logout', request => service.auth.logout(request.actor));
  app.get('/v1/me', request => service.auth.identity(request.actor));
  app.get('/v1/namespaces', request => service.gitlab.namespaces(request.actor));
  app.get('/v1/projects', request => service.listProjects(request.actor));
  function write<S extends TSchema>(method: 'POST' | 'PUT', url: string, schema: S, handle: (actor: Actor, params: Record<string, string>, body: Static<S>) => Promise<unknown>) {
    app.route<{ Params: Record<string, string>; Body: Static<S> }>({ method, url, schema: { body: schema }, handler: request => handle(request.actor, request.params, request.body) });
  }
  function read(url: string, handle: (actor: Actor, params: Record<string, string>) => Promise<unknown>) {
    app.get<{ Params: Record<string, string> }>(url, request => handle(request.actor, request.params));
  }
  write('POST', '/v1/projects', contract.CreateProjectSchema, (a, _p, b) => service.createProject(a, b));
  const base = '/v1/projects/:projectId';
  read(base, (a, p) => service.state(a, p.projectId!));
  write('POST', `${base}/initialize`, contract.InitializeProjectSchema, (a, p, b) => service.initializeProject(a, p.projectId!, b));
  read(`${base}/prototype`, (a, p) => service.prototype(a, p.projectId!));
  read(`${base}/prototype/tasks/:taskId`, (a, p) => service.prototypeTask(a, p.projectId!, p.taskId!));
  write('POST', `${base}/prototype/tasks`, contract.CreatePrototypeTaskSchema, (a, p, b) => service.createPrototypeTask(a, p.projectId!, b));
  write('POST', `${base}/prototype/tasks/:taskId/development-claims`, contract.UpdatePrototypeClaimsSchema, (a, p, b) => service.extendPrototypeClaims(a, p.projectId!, p.taskId!, b));
  write('PUT', `${base}/prototype/tasks/:taskId/reference-requirements`, contract.UpdatePrototypeReferencesSchema, (a, p, b) => service.updatePrototypeReferences(a, p.projectId!, p.taskId!, b));
  write('PUT', `${base}/prototype/tasks/:taskId/write-scope`, contract.UpdatePrototypeScopeSchema, (a, p, b) => service.updatePrototypeScope(a, p.projectId!, p.taskId!, b));
  write('PUT', `${base}/prototype/tasks/:taskId/source-base`, contract.UpdatePrototypeSourceBaseSchema, (a, p, b) => service.updatePrototypeSourceBase(a, p.projectId!, p.taskId!, b));
  write('POST', `${base}/prototype/tasks/:taskId/cancel`, contract.CancelPrototypeTaskSchema, (a, p, b) => service.cancelPrototypeTask(a, p.projectId!, p.taskId!, b));
  write('POST', `${base}/prototype/tasks/:taskId/admin-release`, contract.ReleasePrototypeTaskSchema, (a, p, b) => service.releasePrototypeTask(a, p.projectId!, p.taskId!, b));
  app.get<{ Params: { projectId: string }; Querystring: { limit?: string; offset?: string } }>(`${base}/prototype/baselines`, request => {
    const limit = Number(request.query.limit ?? '20'), offset = Number(request.query.offset ?? '0');
    requireCondition(Number.isInteger(limit) && limit >= 1 && limit <= 100 && Number.isInteger(offset) && offset >= 0, 'INVALID_PAGINATION', 'Baseline queries require limit 1..100 and a non-negative offset', 422);
    return service.prototypeBaselines(request.actor, request.params.projectId, limit, offset);
  });
  write('POST', `${base}/prototype/integrations`, contract.PrototypeIntegrationSchema, (a, p, b) => service.preparePrototypeIntegration(a, p.projectId!, b));
  read(`${base}/prototype/integrations/:integrationId`, (a, p) => service.prototypeIntegration(a, p.projectId!, p.integrationId!));
  write('POST', `${base}/prototype/integrations/:integrationId/complete`, contract.CompletePrototypeIntegrationSchema, (a, p, b) => service.completePrototypeIntegration(a, p.projectId!, p.integrationId!, b));
  write('POST', `${base}/prototype/integrations/:integrationId/abort`, contract.AbortPrototypeIntegrationSchema, (a, p, b) => service.abortPrototypeIntegration(a, p.projectId!, p.integrationId!, b));
  read(`${base}/prototype/adoptions`, (a, p) => service.prototypeAdoptions(a, p.projectId!));
  write('POST', `${base}/prototype/adoptions`, contract.PrototypeAdoptSchema, (a, p, b) => service.adoptPrototype(a, p.projectId!, b));
  write('POST', `${base}/prototype/adoptions/:adoptionId/success`, contract.PrototypeAdoptionSuccessSchema, (a, p, b) => service.prototypeAdoptionSuccess(a, p.projectId!, p.adoptionId!, b));
  write('POST', `${base}/entities`, contract.ReserveEntitySchema, (a, p, b) => service.reserve(a, p.projectId!, b));
  write('PUT', `${base}/entities/:entityId`, contract.UpdateEntitySchema, (a, p, b) => service.updateEntity(a, p.projectId!, p.entityId!, b));
  read(`${base}/entities/:entityId/revision-impact`, (a, p) => service.revisionImpact(a, p.projectId!, p.entityId!));
  read(`${base}/templates`, (a, p) => service.projectTemplates(a, p.projectId!));
  write('PUT', `${base}/entities/:entityId/template`, contract.BindTemplateSchema, (a, p, b) => service.bindTemplate(a, p.projectId!, p.entityId!, b));
  write('POST', `${base}/entities/:entityId/repairs`, contract.RepairStartSchema, (a, p, b) => service.startRepair(a, p.projectId!, p.entityId!, b));
  read(`${base}/repairs/:repairId`, (a, p) => service.getRepair(a, p.projectId!, p.repairId!));
  write('POST', `${base}/repairs/:repairId/events`, contract.RepairEventSchema, (a, p, b) => service.repairEvent(a, p.projectId!, p.repairId!, b));
  write('POST', `${base}/entities/:entityId/claim`, contract.ClaimSchema, (a, p, b) => service.claim(a, p.projectId!, p.entityId!, b));
  write('POST', `${base}/entities/:entityId/cancel`, contract.ReleaseSchema, (a, p, b) => service.release(a, p.projectId!, p.entityId!, b));
  write('POST', `${base}/entities/:entityId/admin-release`, contract.ReleaseSchema, (a, p, b) => service.release(a, p.projectId!, p.entityId!, b, true));
  write('PUT', `${base}/entities/:entityId/relations`, contract.UpdateRelationsSchema, (a, p, b) => service.relations(a, p.projectId!, p.entityId!, b));
  read(`${base}/entities/:entityId/versions`, (a, p) => service.versions(a, p.projectId!, p.entityId!));
  write('POST', `${base}/entities/:entityId/eligibility`, contract.EligibilitySchema, (a, p, b) => service.eligibility(a, p.projectId!, p.entityId!, b));
  write('POST', `${base}/integrations`, contract.PrepareIntegrationSchema, (a, p, b) => service.prepare(a, p.projectId!, b));
  read(`${base}/integrations/:integrationId`, (a, p) => service.getIntegration(a, p.projectId!, p.integrationId!));
  write('POST', `${base}/integrations/:integrationId/complete`, contract.CompleteIntegrationSchema, (a, p, b) => service.complete(a, p.projectId!, p.integrationId!, b));
  write('POST', `${base}/integrations/reconcile`, contract.ReconcileSchema, (a, p, b) => service.reconcile(a, p.projectId!, b));
  read(`${base}/operations/:key`, (a, p) => service.operation(a, p.projectId!, p.key!));
  read(`${base}/adoptions`, (a, p) => service.listAdoptions(a, p.projectId!));
  write('POST', `${base}/adoptions`, contract.AdoptSchema, (a, p, b) => service.adopt(a, p.projectId!, b));
  write('POST', `${base}/adoptions/:adoptionId/success`, contract.AdoptionSuccessSchema, (a, p, b) => service.adoptionSuccess(a, p.projectId!, p.adoptionId!, b));
  write('POST', `${base}/entities/:entityId/receipts`, contract.HandoffReceiptSchema, (a, p, b) => service.receipt(a, p.projectId!, p.entityId!, b));
  read(`${base}/entities/:entityId/receipts`, async (_a, p) =>
    (await service.database.query('SELECT id,confirmation_id AS "confirmationId",creator_id::integer AS "actorId",note,created_date AS "receivedAt" FROM studio_handoff_receipts WHERE project_id=$1 AND entity_id=$2 ORDER BY created_date', [p.projectId!, p.entityId!])).rows);
  read(`${base}/deployment`, async (a, p) => (await service.project(a, p.projectId!)).deployment ?? null);
  write('POST', `${base}/publication-authorizations`, contract.PublicationAuthorizationSchema, (a, p, b) => service.publicationAuthorization(a, p.projectId!, b));
  app.get<{ Params: { projectId: string } }>(`${base}/publication-current`, request => service.publicationCurrent(request.headers.authorization, request.params.projectId));
  write('POST', `${base}/deployment`, contract.DeploymentSchema, (a, p, b) => service.deployment(a, p.projectId!, b));
  write('POST', `${base}/consistency-comparisons`, contract.SubmitConsistencyComparisonSchema, (a, p, b) => service.submitComparison(a, p.projectId!, b));
  write('POST', `${base}/entities/:entityId/status-reports`, contract.SubmitMaterialStatusReportSchema, (a, p, b) => service.submitStatusReport(a, p.projectId!, p.entityId!, b));
  app.get<{ Params: { projectId: string; entityId: string }; Querystring: Record<string, string> }>(`${base}/entities/:entityId/status-reports`, request => {
    const query = request.query, limit = Number(query.limit ?? '20'), offset = Number(query.offset ?? '0');
    requireCondition(Number.isInteger(limit) && limit >= 1 && limit <= 100 && Number.isInteger(offset) && offset >= 0, 'INVALID_PAGINATION', 'Status report queries require limit 1..100 and a non-negative offset', 422);
    return service.listStatusReports(request.actor, request.params.projectId, { entityId: request.params.entityId, limit, offset });
  });
  read(`${base}/entities/:entityId/status-reports/:reportId`, (a, p) => service.getStatusReport(a, p.projectId!, p.reportId!));
  app.get<{ Params: { projectId: string }; Querystring: Record<string, string> }>(`${base}/consistency-comparisons`, request => {
    const query = request.query, limit = Number(query.limit ?? '20'), offset = Number(query.offset ?? '0');
    requireCondition(Number.isInteger(limit) && limit >= 1 && limit <= 100 && Number.isInteger(offset) && offset >= 0, 'INVALID_PAGINATION', 'Comparison queries require limit 1..100 and a non-negative offset', 422);
    if (query.entityId !== undefined) requireCondition(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(query.entityId) && query.entityId.length <= 100, 'INVALID_PAGINATION', 'Invalid entity filter', 422);
    requireCondition(query.latestPerEntity === undefined || query.latestPerEntity === 'true' || query.latestPerEntity === 'false', 'INVALID_PAGINATION', 'Invalid latest-per-entity filter', 422);
    requireCondition(query.result === undefined || ['completed', 'failed', 'cancelled'].includes(query.result), 'INVALID_PAGINATION', 'Invalid comparison result filter', 422);
    return service.listComparisons(request.actor, request.params.projectId, { ...(query.entityId ? { entityId: query.entityId } : {}), ...(query.result ? { result: query.result as contract.ConsistencyComparisonView['result'] } : {}), latestPerEntity: query.latestPerEntity === 'true', limit, offset });
  });
  read(`${base}/consistency-comparisons/:comparisonId`, (a, p) => service.getComparison(a, p.projectId!, p.comparisonId!));
  read(`${base}/entities/:entityId/consistency-context`, (a, p) => service.consistencyContext(a, p.projectId!, p.entityId!));
}
