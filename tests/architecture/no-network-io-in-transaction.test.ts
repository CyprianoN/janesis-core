import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type pg from 'pg';
import {
  DatabaseError,
  assertNoOpenTransaction,
  createDatabase,
} from '../../src/infrastructure/adapters/database/client.js';
import { runInTransaction } from '../../src/application/shared/transaction.js';

// IADP section 9 and TSDS 47.3: no external network I/O while a database transaction is open.
// LIMIT (E5): the guard protects only provider paths that call it. It does not detect arbitrary
// sockets or every possible network call, and no test here claims universal prevention.
const PLACEHOLDER = 'postgres://user:placeholder@localhost:5432/janesis_test';
const SETTINGS = { max: 3, idleTimeoutMs: 12000, connectionTimeoutMs: 4000 };

class FakeClient {
  async query(): Promise<{ rows: unknown[] }> {
    return { rows: [] };
  }
  release(): void {}
}

class FakePool extends EventEmitter {
  async connect(): Promise<FakeClient> {
    return new FakeClient();
  }
  async end(): Promise<void> {}
}

function runner() {
  return createDatabase(PLACEHOLDER, SETTINGS, {
    createPool: () => new FakePool() as unknown as pg.Pool,
  }).transactions;
}

/** A provider adapter that follows the rule: it calls the guard before its network call. */
class GuardedProvider {
  calls = 0;
  async send(): Promise<string> {
    assertNoOpenTransaction();
    this.calls += 1;
    return 'sent';
  }
}

/** A provider adapter that does not call the guard. It documents the limit. */
class UnguardedProvider {
  calls = 0;
  async send(): Promise<string> {
    this.calls += 1;
    return 'sent';
  }
}

function isTransactionOpen(error: unknown): boolean {
  return error instanceof DatabaseError && error.kind === 'transaction_open';
}

test('a guarded provider call outside a transaction proceeds', async () => {
  const provider = new GuardedProvider();
  assert.equal(await provider.send(), 'sent');
  assert.equal(provider.calls, 1);
});

test('a guarded provider call inside a transaction is rejected before any I/O', async () => {
  const provider = new GuardedProvider();
  await runner().run(async () => {
    await assert.rejects(provider.send(), isTransactionOpen);
  });
  assert.equal(provider.calls, 0);
});

test('the same holds through the application entry point', async () => {
  const provider = new GuardedProvider();
  await runInTransaction(runner(), async () => {
    await assert.rejects(provider.send(), isTransactionOpen);
  });
  assert.equal(provider.calls, 0);
});

test('the guard does not leak: calls proceed again after a commit and after a failure', async () => {
  const provider = new GuardedProvider();
  const transactions = runner();
  await transactions.run(async () => 1);
  assert.equal(await provider.send(), 'sent');
  await assert.rejects(
    transactions.run(async () => {
      throw new Error('work failure');
    }),
  );
  assert.equal(await provider.send(), 'sent');
  assert.equal(provider.calls, 2);
});

test('a call from a different asynchronous context is not blocked by another context transaction', async () => {
  const provider = new GuardedProvider();
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const writer = runner().run(async () => {
    open();
    await gate;
  });
  await opened;
  assert.equal(await provider.send(), 'sent');
  release();
  await writer;
});

test('LIMIT (E5): a provider that does not call the guard is not stopped inside a transaction', async () => {
  const provider = new UnguardedProvider();
  await runner().run(async () => {
    assert.equal(await provider.send(), 'sent');
  });
  assert.equal(provider.calls, 1);
});
