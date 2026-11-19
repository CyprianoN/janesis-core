// Provider-neutral transaction contract (IADP Phase 7, WP7-5). Application code sees only this
// opaque context: no pool, no client and no Drizzle executor. The brand is an unexported symbol, so
// a context cannot be forged and carries no string-named property.
declare const brand: unique symbol;

export interface TransactionContext {
  readonly [brand]: true;
}

export interface TransactionRunner {
  /** Runs the work in one transaction: commit on success, rollback on any throw. */
  run<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T>;
}
