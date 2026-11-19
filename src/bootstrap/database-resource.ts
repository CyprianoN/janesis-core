import type { AppConfig } from '../config/env.js';
import { createDatabase, type DatabaseDeps } from '../infrastructure/adapters/database/client.js';
import type { Closable } from './graceful-shutdown.js';

// Composes the database pool as a shutdown resource (IADP Phase 7, WP7-7). The pool is created once,
// connects lazily and is closed by the shutdown handler. Only { name, close } leaves this module.
// createDatabase already attaches the single pool error listener; this seam only passes onError on.
export function composeDatabaseResource(
  config: AppConfig,
  deps: Pick<DatabaseDeps, 'onError' | 'createPool'> = {},
): Closable | undefined {
  const provider = config.providers.database;
  if (provider === undefined) return undefined;
  const handle = createDatabase(provider.url, config.databasePool, deps);
  return { name: 'database-pool', close: () => handle.close() };
}

/**
 * Log metadata for a pool error. Only the error name: the message, stack and cause can carry a
 * connection string or credentials, so they are never returned.
 */
export function databaseErrorLog(error: Error): { errorName: string } {
  return { errorName: error.name };
}
