import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { TransactionContext, TransactionRunner } from '../../ports/transaction.port.js';
import { toPoolConfig, type PoolSettings } from './pool-config.js';

// The only module that knows the pool and the driver (IADP Phase 7, WP7-4 and WP7-5). One pool,
// created once at process start by the composition root. The pool connects lazily: nothing opens
// a connection until the first query. No schema is registered yet (Technical Lead, Q15).

export type DatabaseErrorKind =
  'connection' | 'rollback' | 'nested' | 'closed' | 'transaction_open' | 'commit';

const MESSAGES: Readonly<Record<DatabaseErrorKind, string>> = {
  connection: 'The database connection failed.',
  rollback: 'The database rollback failed.',
  nested: 'A transaction is already open in this context.',
  closed: 'The transaction has already ended.',
  transaction_open: 'This operation is not allowed while a transaction is open.',
  commit: 'The database commit failed and its outcome may be uncertain.',
};

/**
 * Adapter-owned error. The message is fixed and the kind is enumerated. It never carries the
 * driver error, SQL, a connection string or credentials, and it has no cause.
 */
export class DatabaseError extends Error {
  readonly kind: DatabaseErrorKind;

  constructor(kind: DatabaseErrorKind) {
    super(MESSAGES[kind]);
    this.name = 'DatabaseError';
    this.kind = kind;
  }
}

export interface DatabaseDeps {
  /** Injectable pool constructor, so tests can count construction. */
  createPool?: (config: pg.PoolConfig) => pg.Pool;
  /** Called with idle-client errors. The adapter does no logging. */
  onError?: (error: Error) => void;
}

export interface DatabaseHandle {
  db: NodePgDatabase;
  transactions: TransactionRunner;
  /** Ends the pool. Idempotent: concurrent and repeated calls share one pool.end(). */
  close(): Promise<void>;
}

interface TransactionState {
  readonly client: pg.PoolClient;
  active: boolean;
  db?: NodePgDatabase;
}

// One shared store for the whole process. The runner sets it; the guard reads it.
const openTransaction = new AsyncLocalStorage<TransactionContext>();
const states = new WeakMap<TransactionContext, TransactionState>();

function isOpen(): boolean {
  const tx = openTransaction.getStore();
  return tx !== undefined && states.get(tx)?.active === true;
}

/**
 * Throws while a transaction is open in the current asynchronous context. Provider adapters call
 * it before any network I/O. Limit: it prevents I/O only where it is explicitly called. It does
 * not detect arbitrary sockets or every possible network call.
 */
export function assertNoOpenTransaction(): void {
  if (isOpen()) throw new DatabaseError('transaction_open');
}

/** Adapter-internal. Returns the Drizzle executor bound to the transaction's one connection. */
export function getTransactionDb(tx: TransactionContext): NodePgDatabase {
  const state = states.get(tx);
  if (state === undefined || !state.active) throw new DatabaseError('closed');
  state.db ??= drizzle(state.client);
  return state.db;
}

function createRunner(pool: pg.Pool): TransactionRunner {
  return {
    async run<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T> {
      if (isOpen()) throw new DatabaseError('nested');

      let client: pg.PoolClient;
      try {
        client = await pool.connect();
      } catch {
        throw new DatabaseError('connection');
      }

      const tx = Object.freeze({}) as unknown as TransactionContext;
      const state: TransactionState = { client, active: true };
      states.set(tx, state);
      let discard = false;
      try {
        try {
          await client.query('BEGIN');
        } catch {
          discard = true;
          throw new DatabaseError('connection');
        }

        let result: T;
        try {
          result = await openTransaction.run(tx, () => work(tx));
        } catch (error) {
          try {
            await client.query('ROLLBACK');
          } catch {
            discard = true;
          }
          throw error;
        }

        try {
          await client.query('COMMIT');
        } catch {
          // The outcome may be uncertain: always discard the connection.
          discard = true;
          try {
            await client.query('ROLLBACK');
          } catch {
            // Cleanup only; the connection is discarded either way.
          }
          throw new DatabaseError('commit');
        }
        return result;
      } finally {
        state.active = false;
        if (discard) client.release(true);
        else client.release();
      }
    },
  };
}

export function createDatabase(
  url: string,
  settings: PoolSettings,
  deps: DatabaseDeps = {},
): DatabaseHandle {
  const createPool = deps.createPool ?? ((config: pg.PoolConfig) => new pg.Pool(config));
  const pool = createPool(toPoolConfig(url, settings));

  // Without a listener, an error on an idle client would crash the process.
  pool.on('error', (error: Error) => {
    try {
      deps.onError?.(error);
    } catch {
      // A failing callback must never escape the listener.
    }
  });

  const db = drizzle(pool);
  const transactions = createRunner(pool);
  let closing: Promise<void> | undefined;
  return {
    db,
    transactions,
    close(): Promise<void> {
      closing ??= pool.end();
      return closing;
    },
  };
}
