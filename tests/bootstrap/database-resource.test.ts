import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type pg from 'pg';
import {
  composeDatabaseResource,
  databaseErrorLog,
} from '../../src/bootstrap/database-resource.js';
import { createShutdownHandler } from '../../src/bootstrap/graceful-shutdown.js';
import type { AppConfig } from '../../src/config/env.js';

// Exercises the real composition, the real createDatabase and the real shutdown handler. Only the
// pool constructor is replaced, so no PostgreSQL is needed. No connection is ever opened.
const URL = 'postgres://user:placeholder@localhost:5432/janesis_test';
const POOL = { max: 3, idleTimeoutMs: 12000, connectionTimeoutMs: 4000 };

function config(withDatabase: boolean): AppConfig {
  return {
    appEnv: 'development',
    port: 8080,
    shutdownTimeoutMs: 8000,
    providers: withDatabase ? { database: { url: URL } } : {},
    databasePool: POOL,
  };
}

class FakePool extends EventEmitter {
  ended = 0;
  connected = 0;
  async end(): Promise<void> {
    this.ended += 1;
  }
  async connect(): Promise<never> {
    this.connected += 1;
    throw new Error('the fake pool must not be connected');
  }
}

function harness() {
  const pools: FakePool[] = [];
  const configs: pg.PoolConfig[] = [];
  const createPool = (poolConfig: pg.PoolConfig): pg.Pool => {
    const pool = new FakePool();
    pools.push(pool);
    configs.push(poolConfig);
    return pool as unknown as pg.Pool;
  };
  return { pools, configs, createPool };
}

test('with no database provider it returns nothing and creates no pool', () => {
  const h = harness();
  assert.equal(composeDatabaseResource(config(false), { createPool: h.createPool }), undefined);
  assert.equal(h.pools.length, 0);
});

test('with a database provider it returns a Closable named database-pool and maps the settings', () => {
  const h = harness();
  const resource = composeDatabaseResource(config(true), { createPool: h.createPool });
  assert.equal(resource?.name, 'database-pool');
  assert.equal(h.pools.length, 1);
  assert.equal(h.configs[0]?.connectionString, URL);
  assert.equal(h.configs[0]?.max, 3);
  assert.equal(h.configs[0]?.idleTimeoutMillis, 12000);
  assert.equal(h.configs[0]?.connectionTimeoutMillis, 4000);
});

test('composition opens no connection (the pool is lazy)', () => {
  const h = harness();
  composeDatabaseResource(config(true), { createPool: h.createPool });
  assert.equal(h.pools[0]?.connected, 0);
});

test('close ends the pool once and a repeated close does not end it again', async () => {
  const h = harness();
  const resource = composeDatabaseResource(config(true), { createPool: h.createPool });
  await resource?.close();
  await resource?.close();
  assert.equal(h.pools[0]?.ended, 1);
});

test('a failure while creating the pool propagates and is not swallowed', () => {
  assert.throws(
    () =>
      composeDatabaseResource(config(true), {
        createPool: () => {
          throw new Error('pool construction failure');
        },
      }),
    /pool construction failure/,
  );
});

test('a pool error event reaches the supplied callback, and an absent callback does not throw', () => {
  const h = harness();
  const seen: Error[] = [];
  composeDatabaseResource(config(true), {
    createPool: h.createPool,
    onError: (error: Error) => seen.push(error),
  });
  const failure = new Error('idle client failure');
  assert.doesNotThrow(() => h.pools[0]?.emit('error', failure));
  assert.deepEqual(seen, [failure]);

  const quiet = harness();
  composeDatabaseResource(config(true), { createPool: quiet.createPool });
  assert.doesNotThrow(() => quiet.pools[0]?.emit('error', new Error('idle client failure')));
});

test('the returned resource exposes only name and close, never the URL or the password', () => {
  const h = harness();
  const resource = composeDatabaseResource(config(true), { createPool: h.createPool });
  assert.ok(resource);
  assert.deepEqual(Object.keys(resource).sort(), ['close', 'name']);
  const visible = [resource.name, JSON.stringify(resource), String(resource.close)].join(' ');
  assert.ok(!visible.includes('placeholder'), 'the password appeared in the resource');
  assert.ok(!visible.includes('postgres://'), 'the connection string appeared in the resource');
});

test('the real shutdown handler closes the database resource after the server and exits 0', async () => {
  const h = harness();
  const resource = composeDatabaseResource(config(true), { createPool: h.createPool });
  assert.ok(resource);
  const events: string[] = [];
  let exitCode: number | undefined;
  const shutdown = createShutdownHandler({
    server: {
      close: async () => {
        events.push('server:close');
        assert.equal(h.pools[0]?.ended, 0);
      },
    },
    resources: [resource],
    log: { info: () => undefined, error: () => undefined },
    exit: (code) => {
      exitCode = code;
    },
    timeoutMs: 5000,
  });
  await shutdown('SIGTERM');
  assert.deepEqual(events, ['server:close']);
  assert.equal(h.pools[0]?.ended, 1);
  assert.equal(exitCode, 0);
});

test('a failing pool close makes the real shutdown handler exit 1', async () => {
  const h = harness();
  const resource = composeDatabaseResource(config(true), { createPool: h.createPool });
  assert.ok(resource);
  (h.pools[0] as FakePool).end = async () => {
    throw new Error('end failure');
  };
  let exitCode: number | undefined;
  const shutdown = createShutdownHandler({
    server: { close: async () => undefined },
    resources: [resource],
    log: { info: () => undefined, error: () => undefined },
    exit: (code) => {
      exitCode = code;
    },
    timeoutMs: 5000,
  });
  await shutdown('SIGTERM');
  assert.equal(exitCode, 1);
});

test('the error log helper returns only the error name, never the message or a credential', () => {
  const error = new Error('connect failed postgres://user:sentinel-secret-value-7f3a91@host/db');
  const meta = databaseErrorLog(error);
  assert.deepEqual(meta, { errorName: 'Error' });
  assert.ok(!JSON.stringify(meta).includes('sentinel-secret-value-7f3a91'));
  assert.ok(!JSON.stringify(meta).includes('postgres://'));
});
