import Fastify, { type FastifyInstance } from 'fastify';
import { registerErrorHandler } from './plugins/error-handler.plugin.js';
import { registerHealthRoutes } from './routes/health/health.routes.js';

export interface BuildAppOptions {
  logger?: boolean;
  isReady?: () => boolean;
}

/**
 * Fastify instance composition: plugins, hooks, routes and error handling are registered here.
 * Process concerns (port binding, signals) belong to bootstrap/container-entry.ts.
 * Trusted client IP handling (trustProxy) is intentionally unset until verified on Cloud Run (IADP Phase 12).
 */
export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });
  registerErrorHandler(app);
  registerHealthRoutes(app, { isReady: options.isReady ?? (() => true) });
  return app;
}
