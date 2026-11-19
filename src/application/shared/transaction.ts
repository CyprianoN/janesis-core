import type {
  TransactionContext,
  TransactionRunner,
} from '../../infrastructure/ports/transaction.port.js';

// Application-facing transaction entry point (IADP Phase 7, WP7-5). It knows only the port.
export function runInTransaction<T>(
  runner: TransactionRunner,
  work: (tx: TransactionContext) => Promise<T>,
): Promise<T> {
  return runner.run(work);
}
