import Fastify from 'fastify';
import { DomainError } from '@eadp/asset-domain';
import { PublicationAuthorization } from './auth/publication.js';
import { GitLab } from './auth/gitlab.js';
import { SessionAuth } from './auth/session.js';
import type { Config } from './config.js';
import { createDatabase, type Database } from './persistence/database.js';
import { createRedisCache, ReadThrough } from './persistence/cache.js';
import { registerRoutes } from './routes.js';
import { CollaborationService } from './service.js';

export function createApp(config: Config, database: Database = createDatabase(config)) {
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024, ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false } } });
  app.setErrorHandler((error, _request, response) => {
    if (error instanceof DomainError) return response.status(error.status).send({ error: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) } });
    const failure = error as { validation?: unknown; statusCode?: number; code?: string };
    if (failure.validation) return response.status(400).send({ error: { code: 'INVALID_REQUEST', message: 'Request fields do not match the API contract; content bodies and unknown fields are rejected' } });
    if (failure.statusCode === 413) return response.status(413).send({ error: { code: 'REQUEST_TOO_LARGE', message: 'Request exceeds the metadata size limit' } });
    if (failure.statusCode && failure.statusCode < 500) return response.status(failure.statusCode).send({ error: { code: 'INVALID_REQUEST', message: 'Request could not be parsed' } });
    if (failure.code === '23505') return response.status(409).send({ error: { code: 'CONCURRENT_CONFLICT', message: 'Another accepted action conflicts with this request; query the latest state' } });
    return response.status(503).send({ error: { code: 'SERVICE_UNAVAILABLE', message: 'The operation could not be completed; query its idempotency key before retrying' } });
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: { code: 'ROUTE_NOT_FOUND', message: 'API route was not found' } }));
  const redis = config.redisUrl ? createRedisCache(config.redisUrl) : undefined;
  const gitlab = new GitLab(config, new ReadThrough(redis?.cache)), auth = new SessionAuth(database, gitlab, config);
  app.addHook('onReady', async () => { await auth.ensureTestUser(); void redis?.connect(); });
  registerRoutes(app, new CollaborationService(database, gitlab, new PublicationAuthorization(config), auth), config);
  app.addHook('onClose', async () => { await database.end(); await redis?.close(); });
  return app;
}
