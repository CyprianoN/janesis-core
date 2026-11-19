import type pg from 'pg';

// Maps validated pool settings to node-postgres options (IADP Phase 7, WP7-4). Settings arrive by
// argument: adapters never import config/. Provisional values, not Neon limits (TSDS 47.4).
export interface PoolSettings {
  max: number;
  idleTimeoutMs: number;
  connectionTimeoutMs: number;
}

export function toPoolConfig(connectionString: string, settings: PoolSettings): pg.PoolConfig {
  return {
    connectionString,
    max: settings.max,
    idleTimeoutMillis: settings.idleTimeoutMs,
    connectionTimeoutMillis: settings.connectionTimeoutMs,
  };
}
