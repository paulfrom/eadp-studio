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
  read(`${base}/entities/:entityId/receipts`, async (a, p) => {
    await service.authorize(a, p.projectId!);
    return (await service.database.query('SELECT id,confirmation_id AS "confirmationId",creator_id::integer AS "actorId",note,created_date AS "receivedAt" FROM studio_handoff_receipts WHERE project_id=$1 AND entity_id=$2 ORDER BY created_date', [p.projectId!, p.entityId!])).rows;
  });
  read(`${base}/deployment`, async (a, p) => (await service.authorize(a, p.projectId!)).deployment ?? null);
  write('POST', `${base}/publication-authorizations`, contract.PublicationAuthorizationSchema, (a, p, b) => service.publicationAuthorization(a, p.projectId!, b));
  app.get<{ Params: { projectId: string } }>(`${base}/publication-current`, request => service.publicationCurrent(request.headers.authorization, request.params.projectId));
  write('POST', `${base}/deployment`, contract.DeploymentSchema, (a, p, b) => service.deployment(a, p.projectId!, b));
  write('POST', `${base}/consistency-comparisons`, contract.SubmitConsistencyComparisonSchema, (a, p, b) => service.submitComparison(a, p.projectId!, b));
  app.get<{ Params: { projectId: string }; Querystring: Record<string, string> }>(`${base}/consistency-comparisons`, request => {
    const query = request.query, limit = Number(query.limit ?? '20'), offset = Number(query.offset ?? '0');
    requireCondition(Number.isInteger(limit) && limit >= 1 && limit <= 100 && Number.isInteger(offset) && offset >= 0, 'INVALID_PAGINATION', 'Comparison queries require limit 1..100 and a non-negative offset', 422);
    if (query.entityId !== undefined) requireCondition(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(query.entityId) && query.entityId.length <= 100, 'INVALID_PAGINATION', 'Invalid entity filter', 422);
    return service.listComparisons(request.actor, request.params.projectId, { ...(query.entityId ? { entityId: query.entityId } : {}), limit, offset });
  });
  read(`${base}/consistency-comparisons/:comparisonId`, (a, p) => service.getComparison(a, p.projectId!, p.comparisonId!));
  read(`${base}/entities/:entityId/consistency-context`, (a, p) => service.consistencyContext(a, p.projectId!, p.entityId!));
}
