export interface Closable {
  name: string;
  close(): Promise<void>;
}

export interface ShutdownLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface ShutdownDeps {
  /** Called first, so readiness can fail while in-flight requests drain. */
  onStart?: () => void;
  /** Stops accepting new requests and resolves once in-flight requests have drained. */
  server: { close(): Promise<void> };
  /** Infrastructure resources (for example the database pool), closed in reverse order after the drain. */
  resources: Closable[];
  log: ShutdownLogger;
  exit: (code: number) => void;
  /** Upper bound for the whole shutdown; keep it below the platform's termination window. */
  timeoutMs: number;
}

export type ShutdownHandler = (signal: string) => Promise<void>;

/**
 * Process termination boundary. Contains no business logic: it only sequences
 * stop-accepting, drain, resource close and exit.
 */
export function createShutdownHandler(deps: ShutdownDeps): ShutdownHandler {
  let inProgress: Promise<void> | undefined;
  let exited = false;

  const exitOnce = (code: number): void => {
    if (exited) return;
    exited = true;
    deps.exit(code);
  };

  async function run(signal: string): Promise<void> {
    deps.log.info('shutdown started', { signal });
    let failed = false;
    const timer = setTimeout(() => {
      deps.log.error('shutdown timed out', { timeoutMs: deps.timeoutMs });
      exitOnce(1);
    }, deps.timeoutMs);

    deps.onStart?.();

    try {
      await deps.server.close();
    } catch (error) {
      failed = true;
      deps.log.error('server close failed', { error: String(error) });
    }

    for (const resource of [...deps.resources].reverse()) {
      try {
        await resource.close();
      } catch (error) {
        failed = true;
        deps.log.error('resource close failed', { resource: resource.name, error: String(error) });
      }
    }

    clearTimeout(timer);
    exitOnce(failed ? 1 : 0);
  }

  return (signal) => {
    if (inProgress) {
      deps.log.info('shutdown already in progress', { signal });
      return inProgress;
    }
    inProgress = run(signal);
    return inProgress;
  };
}

export interface SignalSource {
  on(signal: string, listener: () => void): unknown;
}

export function registerSignalHandlers(handler: ShutdownHandler, source: SignalSource): void {
  for (const signal of ['SIGTERM', 'SIGINT']) {
    source.on(signal, () => {
      void handler(signal);
    });
  }
}

export interface DrainableApp {
  close(): Promise<unknown>;
  server: { closeIdleConnections(): void };
}

/**
 * Stops accepting connections and waits for in-flight requests to finish.
 * Keep-alive connections that become idle after their request completes are closed
 * as they go idle, otherwise they would hold the shutdown open until their timeout.
 */
export async function closeAndDrain(app: DrainableApp, pollMs = 50): Promise<void> {
  const timer = setInterval(() => app.server.closeIdleConnections(), pollMs);
  try {
    await app.close();
  } finally {
    clearInterval(timer);
  }
}
