import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeAndDrain, createShutdownHandler } from '../../src/bootstrap/graceful-shutdown.js';
import { buildApp } from '../../src/transport/http/app.js';

function within<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function refusesNewConnections(base: string, deadlineMs = 3000): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) });
    } catch (error) {
      const code = (error as { cause?: { code?: string } }).cause?.code;
      if (code === 'ECONNREFUSED' || code === 'ECONNRESET') return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

test(
  'drains a real in-flight HTTP request, refuses new connections, then exits 0',
  { timeout: 20_000 },
  async () => {
    const state = { ready: true };
    const events: string[] = [];
    const exits: number[] = [];

    const app = buildApp({ isReady: () => state.ready });

    let entered: () => void = () => undefined;
    const hasEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Throwaway test-only route: it holds a request open until the test releases it.
    app.get('/__test/slow', async () => {
      entered();
      await gate;
      return { done: true };
    });

    const handler = createShutdownHandler({
      onStart: () => {
        state.ready = false;
        events.push('start');
      },
      server: { close: () => closeAndDrain(app) },
      resources: [
        {
          name: 'db',
          close: async () => {
            events.push('close:db');
          },
        },
      ],
      log: { info: () => undefined, error: () => undefined },
      exit: (code) => {
        exits.push(code);
      },
      timeoutMs: 10_000,
    });

    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected a TCP address');
    }
    const base = `http://127.0.0.1:${address.port}`;

    let done: Promise<void> | undefined;
    try {
      const inFlight = fetch(`${base}/__test/slow`);
      inFlight.catch(() => undefined);
      await within(hasEntered, 5000, 'the slow request never reached the server');

      done = handler('SIGTERM');

      assert.equal(
        await refusesNewConnections(base),
        true,
        'new connections must be refused while draining',
      );
      assert.equal(state.ready, false, 'readiness must be false once shutdown starts');
      assert.deepEqual(events, ['start'], 'resources must stay open while a request is in flight');
      assert.deepEqual(exits, [], 'the process must not exit while a request is in flight');

      release();
      const response = await within(inFlight, 5000, 'the in-flight request did not complete');
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { done: true });

      await within(done, 5000, 'shutdown did not complete after the in-flight request finished');
      assert.deepEqual(events, ['start', 'close:db']);
      assert.deepEqual(exits, [0]);
    } finally {
      release();
      app.server.closeAllConnections();
      if (done) {
        await done;
      } else {
        await app.close();
      }
    }
  },
);
