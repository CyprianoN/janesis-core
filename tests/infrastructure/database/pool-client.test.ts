import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { createDatabase } from '../../../src/infrastructure/adapters/database/client.js';
import { resolveTestDatabaseUrl } from '../../utils/test-database.js';

// Unit cases use a fake pool and need no database. INTEGRATION cases need TEST_DATABASE_URL and
// never skip. The URL below is a placeholder: no connection is attempted with it.
const URL_PLACEHOLDER = 'postgres://user:placeholder@localhost:5432/janesis_test';
const SETTINGS = { max: 3, idleTimeoutMs: 12000, connectionTimeoutMs: 4000 };

class FakePool extends EventEmitter {
  ended = 0;
  connected = 0;
  async end(): Promise<void> {
    this.ended += 1;
  }
  async connect(): Promise<never> {
    this.connected += 1;
    throw new Error('the fake pool must not be connected in these tests');
  }
}

function harness() {
  const pools: FakePool[] = [];
  const configs: pg.PoolConfig[] = [];
  const createPool = (config: pg.PoolConfig): pg.Pool => {
    const pool = new FakePool();
    pools.push(pool);
    configs.push(config);
    return pool as unknown as pg.Pool;
  };
  return { pools, configs, createPool };
}

test('creates exactly one pool, once, and opens no connection (lazy)', () => {
  const h = harness();
  const database = createDatabase(URL_PLACEHOLDER, SETTINGS, { createPool: h.createPool });
  assert.equal(h.pools.length, 1);
  assert.equal(h.pools[0]?.connected, 0);
  assert.ok(database.db);
});

test('maps the validated settings to the pool options', () => {
  const h = harness();
  createDatabase(URL_PLACEHOLDER, SETTINGS, { createPool: h.createPool });
  const config = h.configs[0];
  assert.equal(config?.max, 3);
  assert.equal(config?.idleTimeoutMillis, 12000);
  assert.equal(config?.connectionTimeoutMillis, 4000);
  assert.equal(config?.connectionString, URL_PLACEHOLDER);
});

test('close ends the pool once and is idempotent, including concurrent calls', async () => {
  const h = harness();
  const database = createDatabase(URL_PLACEHOLDER, SETTINGS, { createPool: h.createPool });
  await Promise.all([database.close(), database.close()]);
  await database.close();
  assert.equal(h.pools[0]?.ended, 1);
});

test('a pool error event is handled once-registered and passed to onError', () => {
  const h = harness();
  const seen: Error[] = [];
  createDatabase(URL_PLACEHOLDER, SETTINGS, {
    createPool: h.createPool,
    onError: (error: Error) => seen.push(error),
  });
  const pool = h.pools[0] as FakePool;
  assert.equal(pool.listenerCount('error'), 1);
  const failure = new Error('idle client failure');
  assert.doesNotThrow(() => pool.emit('error', failure));
  assert.deepEqual(seen, [failure]);
});

test('a pool error without onError does not throw', () => {
  const h = harness();
  createDatabase(URL_PLACEHOLDER, SETTINGS, { createPool: h.createPool });
  const pool = h.pools[0] as FakePool;
  assert.doesNotThrow(() => pool.emit('error', new Error('idle client failure')));
});

test('an onError callback that throws never escapes the pool error listener', () => {
  const h = harness();
  createDatabase(URL_PLACEHOLDER, SETTINGS, {
    createPool: h.createPool,
    onError: () => {
      throw new Error('callback failure');
    },
  });
  const pool = h.pools[0] as FakePool;
  assert.doesNotThrow(() => pool.emit('error', new Error('idle client failure')));
});

test('INTEGRATION: select 1 runs through Drizzle on the real pool', async () => {
  const url = resolveTestDatabaseUrl(process.env);
  const database = createDatabase(url, SETTINGS);
  try {
    const result = await database.db.execute(sql.raw('select 1 as one'));
    assert.equal((result.rows[0] as { one: number }).one, 1);
  } finally {
    await database.close();
  }
});

test('INTEGRATION: one pool serves concurrent requests above the pool maximum', async () => {
  const url = resolveTestDatabaseUrl(process.env);
  const real: pg.Pool[] = [];
  let constructed = 0;
  const createPool = (config: pg.PoolConfig): pg.Pool => {
    constructed += 1;
    const pool = new pg.Pool(config);
    real.push(pool);
    return pool;
  };
  const settings = { max: 2, idleTimeoutMs: 10000, connectionTimeoutMs: 5000 };
  const database = createDatabase(url, settings, { createPool });
  try {
    let peak = 0;
    const requests = Array.from({ length: 8 }, async () => {
      await database.db.execute(sql.raw('select pg_sleep(0.05)'));
      peak = Math.max(peak, real[0]?.totalCount ?? 0);
    });
    const sampler = setInterval(() => {
      peak = Math.max(peak, real[0]?.totalCount ?? 0);
    }, 5);
    await Promise.all(requests);
    clearInterval(sampler);
    assert.equal(constructed, 1);
    assert.ok(requests.length > settings.max);
    assert.ok(peak >= 1 && peak <= settings.max, 'peak connections ' + peak);
  } finally {
    await database.close();
  }
  assert.equal(real[0]?.totalCount, 0);
});
