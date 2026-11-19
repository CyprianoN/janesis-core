import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import Fastify from 'fastify';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { createDatabase } from '../../../src/infrastructure/adapters/database/client.js';
import { resolveTestDatabaseUrl } from '../../utils/test-database.js';

// IADP Phase 7 exit criterion: the pool is created once per process and reused across concurrent
// requests, and request concurrency is not the connection count. Meta-tests need no database.
// The INTEGRATION test needs TEST_DATABASE_URL and never skips.
const PLACEHOLDER = 'postgres://user:placeholder@localhost:5432/janesis_test';

interface Observation {
  constructed: number;
  peak: number;
  max: number;
  requests: number;
  totalAfterClose: number;
}

export function poolReuseViolations(o: Observation): string[] {
  const found: string[] = [];
  if (o.constructed !== 1) found.push('pool constructed ' + o.constructed + ' times, expected 1');
  if (o.requests <= o.max) found.push('requests do not exceed the pool maximum');
  if (o.peak > o.max) found.push('peak connections ' + o.peak + ' exceed max ' + o.max);
  if (o.totalAfterClose !== 0) found.push('connections remain after close');
  return found;
}

class FakePool extends EventEmitter {
  async end(): Promise<void> {}
}

async function perRequestPoolHarness(requests: number): Promise<number> {
  let constructed = 0;
  const app = Fastify({ logger: false });
  app.get('/q', async () => {
    const handle = createDatabase(
      PLACEHOLDER,
      { max: 2, idleTimeoutMs: 10000, connectionTimeoutMs: 5000 },
      {
        createPool: () => {
          constructed += 1;
          return new FakePool() as unknown as pg.Pool;
        },
      },
    );
    await handle.close();
    return { ok: true };
  });
  await Promise.all(
    Array.from({ length: requests }, () => app.inject({ method: 'GET', url: '/q' })),
  );
  await app.close();
  return constructed;
}

test('META: the assertion helper detects a pool created per request', async () => {
  const constructed = await perRequestPoolHarness(8);
  assert.equal(constructed, 8);
  const found = poolReuseViolations({
    constructed,
    peak: 0,
    max: 2,
    requests: 8,
    totalAfterClose: 0,
  });
  assert.ok(found.some((message) => message.includes('constructed 8 times')));
});

test('META: the helper detects a peak above max, too few requests and leftover connections', () => {
  const base = { constructed: 1, peak: 2, max: 2, requests: 8, totalAfterClose: 0 };
  assert.deepEqual(poolReuseViolations(base), []);
  assert.equal(poolReuseViolations({ ...base, peak: 3 }).length, 1);
  assert.equal(poolReuseViolations({ ...base, requests: 2 }).length, 1);
  assert.equal(poolReuseViolations({ ...base, totalAfterClose: 1 }).length, 1);
});

test('INTEGRATION: one shared pool serves concurrent requests above the pool maximum', async () => {
  const url = resolveTestDatabaseUrl(process.env);
  const real: pg.Pool[] = [];
  let constructed = 0;
  const settings = { max: 2, idleTimeoutMs: 10000, connectionTimeoutMs: 5000 };
  const database = createDatabase(url, settings, {
    createPool: (config: pg.PoolConfig): pg.Pool => {
      constructed += 1;
      const pool = new pg.Pool(config);
      real.push(pool);
      return pool;
    },
  });
  const app = Fastify({ logger: false });
  app.get('/q', async () => {
    await database.db.execute(sql.raw('select pg_sleep(0.05)'));
    return { ok: true };
  });
  const requests = 8;
  // Live physical clients, tracked synchronously from the pool events: connect fires when a new
  // client is created and remove when one is destroyed. This is the quantity bounded by max.
  let live = 0;
  let peak = 0;
  const pool = real[0] as pg.Pool;
  pool.on('connect', () => {
    live += 1;
    peak = Math.max(peak, live);
  });
  pool.on('remove', () => {
    live -= 1;
  });
  try {
    const responses = await Promise.all(
      Array.from({ length: requests }, () => app.inject({ method: 'GET', url: '/q' })),
    );
    assert.ok(responses.every((response) => response.statusCode === 200));
    assert.equal(pool.waitingCount, 0);
    assert.equal(pool.idleCount, pool.totalCount);
  } finally {
    await app.close();
    await database.close();
  }
  const found = poolReuseViolations({
    constructed,
    peak,
    max: settings.max,
    requests,
    totalAfterClose: pool.totalCount,
  });
  assert.deepEqual(found, []);
  assert.equal(
    peak,
    settings.max,
    'the pool never reached its maximum, so there was no contention',
  );
  assert.equal(pool.totalCount, 0);
});
