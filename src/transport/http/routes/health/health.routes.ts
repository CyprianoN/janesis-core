import type { FastifyInstance } from 'fastify';

export interface HealthDeps {
  /** Readiness is false while the process is starting or draining during shutdown. */
  isReady: () => boolean;
}

/**
 * Runtime-foundation health surface (IADP Phase 3).
 * /health is liveness: the process is up and serving.
 * /ready is readiness: the process should receive traffic.
 * Response bodies move to the canonical error envelope in Phase 6.
 */
export function registerHealthRoutes(app: FastifyInstance, deps: HealthDeps): void {
  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/ready', async (_request, reply) => {
    if (deps.isReady()) {
      return { status: 'ready' };
    }
    return reply.code(503).send({ status: 'not_ready' });
  });
}
