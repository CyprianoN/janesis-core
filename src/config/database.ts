// Database pool settings: defaults and bounds (IADP Phase 7, WP7-2).
// These are approved engineering bounds, not claims about Neon provider limits. Production values
// depend on Neon capacity and Cloud Run maximum instances and need load testing (TSDS 47.4).

export interface DatabasePoolConfig {
  max: number;
  idleTimeoutMs: number;
  connectionTimeoutMs: number;
}

export interface PoolBounds {
  readonly min: number;
  readonly max: number;
  readonly default: number;
}

export const DB_POOL_MAX_BOUNDS: PoolBounds = { min: 1, max: 20, default: 5 };
export const DB_IDLE_TIMEOUT_MS_BOUNDS: PoolBounds = { min: 1000, max: 300000, default: 10000 };
export const DB_CONNECTION_TIMEOUT_MS_BOUNDS: PoolBounds = { min: 100, max: 60000, default: 5000 };
