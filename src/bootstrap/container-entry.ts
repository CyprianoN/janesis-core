import { ConfigError, describeConfig, loadConfig } from '../config/env.js';
import { buildApp } from '../transport/http/app.js';
import { composeDatabaseResource, databaseErrorLog } from './database-resource.js';
import {
  closeAndDrain,
  createShutdownHandler,
  registerSignalHandlers,
} from './graceful-shutdown.js';

async function main(): Promise<void> {
  // Fail fast: invalid configuration throws here, before anything listens.
  const config = loadConfig();
  const state = { ready: false };

  const app = buildApp({ logger: true, isReady: () => state.ready });
  // Redacted summary only: provider values are never logged.
  app.log.info({ config: describeConfig(config) }, 'configuration loaded');

  // The pool is created once here, connects lazily and is closed by the shutdown handler.
  const database = composeDatabaseResource(config, {
    onError: (error) => app.log.error(databaseErrorLog(error), 'database pool error'),
  });

  const shutdown = createShutdownHandler({
    onStart: () => {
      state.ready = false;
    },
    server: { close: () => closeAndDrain(app) },
    resources: database === undefined ? [] : [database],
    log: {
      info: (message, meta) => app.log.info(meta ?? {}, message),
      error: (message, meta) => app.log.error(meta ?? {}, message),
    },
    exit: (code) => process.exit(code),
    timeoutMs: config.shutdownTimeoutMs,
  });
  registerSignalHandlers(shutdown, process);

  await app.listen({ port: config.port, host: '0.0.0.0' });
  state.ready = true;
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    // Names variables and reasons only; never values.
    console.error(error.message);
  } else {
    console.error('fatal startup error', error);
  }
  process.exit(1);
});
