import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createShutdownHandler,
  registerSignalHandlers,
  type Closable,
  type ShutdownDeps,
} from '../../src/bootstrap/graceful-shutdown.js';

const silentLog = { info: () => undefined, error: () => undefined };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function harness() {
  const events: string[] = [];
  const exits: number[] = [];
  const resource = (name: string, fail = false): Closable => ({
    name,
    close: async () => {
      events.push(`close:${name}`);
      if (fail) throw new Error(`${name} failed`);
    },
  });
  const deps: ShutdownDeps = {
    onStart: () => {
      events.push('start');
    },
    server: {
      close: async () => {
        events.push('server:close');
      },
    },
    resources: [],
    log: silentLog,
    exit: (code) => {
      exits.push(code);
    },
    timeoutMs: 1000,
  };
  return { deps, events, exits, resource };
}

test('marks not-ready, stops accepting, then closes resources in reverse order and exits 0', async () => {
  const h = harness();
  h.deps.resources = [h.resource('db'), h.resource('cache')];
  await createShutdownHandler(h.deps)('SIGTERM');
  assert.deepEqual(h.events, ['start', 'server:close', 'close:cache', 'close:db']);
  assert.deepEqual(h.exits, [0]);
});

test('waits for in-flight requests to drain before closing any resource', async () => {
  const h = harness();
  let release: () => void = () => undefined;
  h.deps.server = {
    close: () =>
      new Promise<void>((resolve) => {
        h.events.push('server:close');
        release = resolve;
      }),
  };
  h.deps.resources = [h.resource('db')];
  const done = createShutdownHandler(h.deps)('SIGTERM');
  await tick();
  assert.deepEqual(h.events, ['start', 'server:close']);
  assert.deepEqual(h.exits, []);
  release();
  await done;
  assert.deepEqual(h.events, ['start', 'server:close', 'close:db']);
  assert.deepEqual(h.exits, [0]);
});

test('is idempotent: repeated signals share one shutdown and close the server once', async () => {
  const h = harness();
  const handler = createShutdownHandler(h.deps);
  const first = handler('SIGTERM');
  const second = handler('SIGINT');
  await Promise.all([first, second]);
  assert.equal(h.events.filter((e) => e === 'server:close').length, 1);
  assert.deepEqual(h.exits, [0]);
});

test('keeps closing remaining resources when one fails, then exits 1', async () => {
  const h = harness();
  h.deps.resources = [h.resource('db'), h.resource('cache', true), h.resource('queue')];
  await createShutdownHandler(h.deps)('SIGTERM');
  assert.deepEqual(h.events, ['start', 'server:close', 'close:queue', 'close:cache', 'close:db']);
  assert.deepEqual(h.exits, [1]);
});

test('still closes resources when the server fails to close, then exits 1', async () => {
  const h = harness();
  h.deps.server = {
    close: async () => {
      throw new Error('close failed');
    },
  };
  h.deps.resources = [h.resource('db')];
  await createShutdownHandler(h.deps)('SIGTERM');
  assert.deepEqual(h.events, ['start', 'close:db']);
  assert.deepEqual(h.exits, [1]);
});

test('forces exit 1 once when draining exceeds the timeout', async () => {
  const h = harness();
  let signalExit: () => void = () => undefined;
  const exited = new Promise<void>((resolve) => {
    signalExit = resolve;
  });
  h.deps.server = { close: () => new Promise<void>(() => undefined) };
  h.deps.resources = [h.resource('db')];
  h.deps.timeoutMs = 20;
  h.deps.exit = (code) => {
    h.exits.push(code);
    signalExit();
  };
  void createShutdownHandler(h.deps)('SIGTERM');
  await exited;
  assert.deepEqual(h.exits, [1]);
  assert.ok(!h.events.includes('close:db'));
});

test('registerSignalHandlers binds SIGTERM and SIGINT to the shutdown handler', async () => {
  const bound = new Map<string, () => void>();
  const received: string[] = [];
  registerSignalHandlers(
    (signal) => {
      received.push(signal);
      return Promise.resolve();
    },
    { on: (signal, listener) => void bound.set(signal, listener) },
  );
  assert.deepEqual([...bound.keys()].sort(), ['SIGINT', 'SIGTERM']);
  bound.get('SIGTERM')?.();
  bound.get('SIGINT')?.();
  assert.deepEqual(received, ['SIGTERM', 'SIGINT']);
});
