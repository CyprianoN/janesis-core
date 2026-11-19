import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import {
  DatabaseError,
  assertNoOpenTransaction,
  createDatabase,
  getTransactionDb,
} from '../../../src/infrastructure/adapters/database/client.js';
import { runInTransaction } from '../../../src/application/shared/transaction.js';
import type {
  TransactionContext,
  TransactionRunner,
} from '../../../src/infrastructure/ports/transaction.port.js';
import { resolveTestDatabaseUrl, withTestSchema } from '../../utils/test-database.js';

// Unit cases use a fake pool and client and need no database. INTEGRATION cases need
// TEST_DATABASE_URL and never skip. Limit (E5): the guard only prevents network I/O where a
// provider adapter explicitly calls it. It does not detect arbitrary sockets.
const SENTINEL = 'sentinel-secret-value-7f3a91';
const URL_PLACEHOLDER = 'postgres://user:placeholder@localhost:5432/janesis_test';
const SETTINGS = { max: 3, idleTimeoutMs: 12000, connectionTimeoutMs: 4000 };

class FakeClient {
  queries: string[] = [];
  released: unknown[] = [];
  constructor(private readonly failOn: string | undefined) {}
  async query(text: string): Promise<{ rows: unknown[] }> {
    this.queries.push(text);
    if (text === this.failOn) throw new Error('driver failure ' + SENTINEL);
    return { rows: [] };
  }
  release(error?: Error | boolean): void {
    this.released.push(error === undefined ? 'clean' : error);
  }
}

class FakePool extends EventEmitter {
  clients: FakeClient[] = [];
  connectError: Error | undefined;
  failOn: string | undefined;
  async connect(): Promise<FakeClient> {
    if (this.connectError) throw this.connectError;
    const client = new FakeClient(this.failOn);
    this.clients.push(client);
    return client;
  }
  async end(): Promise<void> {}
}

function fake() {
  const pool = new FakePool();
  const database = createDatabase(URL_PLACEHOLDER, SETTINGS, {
    createPool: () => pool as unknown as pg.Pool,
  });
  return { pool, database, runner: database.transactions };
}

async function rejectsWithKind(promise: Promise<unknown>, kind: string): Promise<DatabaseError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof DatabaseError, 'expected a DatabaseError');
    assert.equal(error.kind, kind);
    return error;
  }
  return assert.fail('expected a rejection');
}

test('commit path: the result is returned, BEGIN then COMMIT, the client released once', async () => {
  const { pool, runner } = fake();
  const result = await runner.run(async () => 42);
  assert.equal(result, 42);
  assert.equal(pool.clients.length, 1);
  assert.deepEqual(pool.clients[0]?.queries, ['BEGIN', 'COMMIT']);
  assert.deepEqual(pool.clients[0]?.released, ['clean']);
});

test('failure path: ROLLBACK, the client released once, the original error rethrown unchanged', async () => {
  const { pool, runner } = fake();
  const original = new Error('work failure');
  let caught: unknown;
  try {
    await runner.run(async () => {
      throw original;
    });
  } catch (error) {
    caught = error;
  }
  assert.strictEqual(caught, original);
  assert.deepEqual(pool.clients[0]?.queries, ['BEGIN', 'ROLLBACK']);
  assert.deepEqual(pool.clients[0]?.released, ['clean']);
});

test('a failed ROLLBACK discards the connection and still surfaces the original error', async () => {
  const { pool, runner } = fake();
  pool.failOn = 'ROLLBACK';
  const original = new Error('work failure');
  let caught: unknown;
  try {
    await runner.run(async () => {
      throw original;
    });
  } catch (error) {
    caught = error;
  }
  assert.strictEqual(caught, original);
  assert.equal(pool.clients[0]?.released.length, 1);
  assert.notEqual(pool.clients[0]?.released[0], 'clean');
});

test('a failed COMMIT attempts ROLLBACK, discards the connection and throws kind commit safely', async () => {
  const { pool, runner } = fake();
  pool.failOn = 'COMMIT';
  const error = await rejectsWithKind(
    runner.run(async () => 1),
    'commit',
  );
  const visible = [error.message, String(error), JSON.stringify(error)].join(' ');
  assert.ok(!visible.includes(SENTINEL), 'driver detail appeared in the error');
  assert.equal((error as { cause?: unknown }).cause, undefined);
  assert.deepEqual(pool.clients[0]?.queries, ['BEGIN', 'COMMIT', 'ROLLBACK']);
  assert.equal(pool.clients[0]?.released.length, 1);
  assert.notEqual(pool.clients[0]?.released[0], 'clean');
  assert.doesNotThrow(() => assertNoOpenTransaction());
});

test('the guard throws a DatabaseError of kind transaction_open inside a transaction', async () => {
  const { runner } = fake();
  await runner.run(async () => {
    try {
      assertNoOpenTransaction();
      assert.fail('expected the guard to throw');
    } catch (error) {
      assert.ok(error instanceof DatabaseError);
      assert.equal(error.kind, 'transaction_open');
    }
  });
});

test('a nested run is rejected before a second client is acquired', async () => {
  const { pool, runner } = fake();
  await runner.run(async () => {
    await rejectsWithKind(
      runner.run(async () => 1),
      'nested',
    );
  });
  assert.equal(pool.clients.length, 1);
  assert.deepEqual(pool.clients[0]?.queries, ['BEGIN', 'COMMIT']);
});

test('the transaction context is opaque and unusable after its transaction ends', async () => {
  const { runner } = fake();
  const seen: { tx?: TransactionContext } = {};
  await runner.run(async (tx: TransactionContext) => {
    seen.tx = tx;
    assert.deepEqual(Object.getOwnPropertyNames(tx), []);
    assert.ok(getTransactionDb(tx));
  });
  const ended = seen.tx;
  assert.ok(ended);
  assert.throws(
    () => getTransactionDb(ended),
    (error: unknown) => error instanceof DatabaseError && error.kind === 'closed',
  );
});

test('the guard is silent outside a transaction, throws inside it, and does not leak afterwards', async () => {
  const { runner } = fake();
  assert.doesNotThrow(() => assertNoOpenTransaction());
  await runner.run(async () => {
    assert.throws(() => assertNoOpenTransaction(), DatabaseError);
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
    assert.throws(() => assertNoOpenTransaction(), DatabaseError);
  });
  assert.doesNotThrow(() => assertNoOpenTransaction());
  await assert.rejects(
    runner.run(async () => {
      throw new Error('work failure');
    }),
  );
  assert.doesNotThrow(() => assertNoOpenTransaction());
});

test('a connection failure is a DatabaseError of kind connection and exposes no driver detail', async () => {
  const { pool, runner } = fake();
  pool.connectError = new Error('connect failed ' + SENTINEL + ' postgres://u:p@h/db');
  const error = await rejectsWithKind(
    runner.run(async () => 1),
    'connection',
  );
  const visible = [error.message, String(error), JSON.stringify(error)].join(' ');
  assert.ok(!visible.includes(SENTINEL), 'driver detail appeared in the error');
  assert.ok(!visible.includes('postgres://'), 'a connection string appeared in the error');
  assert.equal((error as { cause?: unknown }).cause, undefined);
});

test('runInTransaction delegates to the runner and returns its result', async () => {
  const calls: unknown[] = [];
  const runner: TransactionRunner = {
    async run(work) {
      calls.push(work);
      return work({} as TransactionContext);
    },
  };
  const result = await runInTransaction(runner, async () => 'done');
  assert.equal(result, 'done');
  assert.equal(calls.length, 1);
});

async function rowCount(client: pg.Client, schema: string): Promise<number> {
  const result = await client.query('select count(*)::int as n from ' + schema + '.items');
  return (result.rows[0] as { n: number }).n;
}

test('INTEGRATION: a transaction that throws leaves no partial state; one that succeeds persists', async () => {
  const url = resolveTestDatabaseUrl(process.env);
  await withTestSchema(process.env, async (client, schema) => {
    await client.query('create table ' + schema + '.items (id int)');
    const database = createDatabase(url, SETTINGS);
    try {
      await assert.rejects(
        database.transactions.run(async (tx: TransactionContext) => {
          const db = getTransactionDb(tx);
          await db.execute(sql.raw('insert into ' + schema + '.items values (1)'));
          await db.execute(sql.raw('insert into ' + schema + '.items values (2)'));
          throw new Error('forced mid-transaction failure');
        }),
        /forced mid-transaction failure/,
      );
      assert.equal(await rowCount(client, schema), 0);
      await database.transactions.run(async (tx: TransactionContext) => {
        await getTransactionDb(tx).execute(sql.raw('insert into ' + schema + '.items values (3)'));
      });
      assert.equal(await rowCount(client, schema), 1);
    } finally {
      await database.close();
    }
  });
});

test('INTEGRATION: every query in a transaction uses the one acquired connection', async () => {
  const url = resolveTestDatabaseUrl(process.env);
  const database = createDatabase(url, SETTINGS);
  try {
    const pidOf = async (run: () => Promise<{ rows: unknown[] }>): Promise<number> =>
      ((await run()).rows[0] as { pid: number }).pid;
    const pidSql = sql.raw('select pg_backend_pid() as pid');
    await database.transactions.run(async (tx: TransactionContext) => {
      const db = getTransactionDb(tx);
      const first = await pidOf(() => db.execute(pidSql));
      const outside = await pidOf(() => database.db.execute(pidSql));
      const second = await pidOf(() => db.execute(pidSql));
      assert.equal(first, second);
      assert.notEqual(outside, first);
    });
  } finally {
    await database.close();
  }
});

test('INTEGRATION: uncommitted rows are invisible to other connections until commit', async () => {
  const url = resolveTestDatabaseUrl(process.env);
  await withTestSchema(process.env, async (client, schema) => {
    await client.query('create table ' + schema + '.items (id int)');
    const database = createDatabase(url, SETTINGS);
    try {
      let inserted!: () => void;
      const insertedSignal = new Promise<void>((resolve) => {
        inserted = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const writer = database.transactions.run(async (tx: TransactionContext) => {
        await getTransactionDb(tx).execute(sql.raw('insert into ' + schema + '.items values (1)'));
        inserted();
        await gate;
      });
      await insertedSignal;
      assert.equal(await rowCount(client, schema), 0);
      const seenByOtherTransaction = await database.transactions.run(
        async (tx: TransactionContext) => {
          const result = await getTransactionDb(tx).execute(
            sql.raw('select count(*)::int as n from ' + schema + '.items'),
          );
          return (result.rows[0] as { n: number }).n;
        },
      );
      assert.equal(seenByOtherTransaction, 0);
      release();
      await writer;
      assert.equal(await rowCount(client, schema), 1);
    } finally {
      await database.close();
    }
  });
});

test('INTEGRATION: connections return to the pool after both success and failure', async () => {
  const url = resolveTestDatabaseUrl(process.env);
  const real: pg.Pool[] = [];
  const database = createDatabase(url, SETTINGS, {
    createPool: (config: pg.PoolConfig): pg.Pool => {
      const pool = new pg.Pool(config);
      real.push(pool);
      return pool;
    },
  });
  try {
    await database.transactions.run(async () => 1);
    await assert.rejects(
      database.transactions.run(async () => {
        throw new Error('work failure');
      }),
    );
    const pool = real[0] as pg.Pool;
    assert.ok(pool.totalCount >= 1);
    assert.equal(pool.waitingCount, 0);
    assert.equal(pool.idleCount, pool.totalCount);
  } finally {
    await database.close();
  }
});
