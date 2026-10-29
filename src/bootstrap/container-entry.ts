import { buildApp } from '../transport/http/app.js';
import {
  closeAndDrain,
  createShutdownHandler,
  registerSignalHandlers,
} from './graceful-shutdown.js';

// Interim: PORT is read directly until validated configuration lands in config/env.ts (IADP Phase 5).
const DEFAULT_PORT = 8080;
// Kept below Cloud Run's termination window; confirm against the deployed service (IADP Phase 10).
const SHUTDOWN_TIMEOUT_MS = 8_000;

async function main(): Promise<void> {
  const port = Number(process.env['PORT'] ?? DEFAULT_PORT);
  const state = { ready: false };

  const app = buildApp({ logger: true, isReady: () => state.ready });

  const shutdown = createShutdownHandler({
    onStart: () => {
      state.ready = false;
    },
    server: { close: () => closeAndDrain(app) },
    // The database pool is registered here in IADP Phase 7.
    resources: [],
    log: {
      info: (message, meta) => app.log.info(meta ?? {}, message),
      error: (message, meta) => app.log.error(meta ?? {}, message),
    },
    exit: (code) => process.exit(code),
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
  });
  registerSignalHandlers(shutdown, process);

  await app.listen({ port, host: '0.0.0.0' });
  state.ready = true;
}

main().catch((error: unknown) => {
  console.error('fatal startup error', error);
  process.exit(1);
});
