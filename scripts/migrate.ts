import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

// Migration runner (IADP Phase 7, WP7-8). Local databases only. It needs an explicit approval
// identifier, reads only MIGRATION_DATABASE_URL, and never prints a URL or credentials. Importing
// this file runs nothing: the entry point is guarded at the bottom.

export class MigrationConfigError extends Error {
  readonly variable: string;
  constructor(variable: string, reason: string) {
    super('Invalid migration configuration: ' + variable + ' ' + reason);
    this.name = 'MigrationConfigError';
    this.variable = variable;
  }
}

export class MigrationError extends Error {
  constructor() {
    super('The migration run failed.');
    this.name = 'MigrationError';
  }
}

export interface MigrationResult {
  approvalId: string;
  total: number;
  applied: number;
}

export interface RunOptions {
  migrationsFolder: string;
  migrationsSchema?: string;
  createPool?: (config: { connectionString: string; max: number }) => unknown;
}

type Env = Readonly<Record<string, string | undefined>>;

const APPROVAL = /^JANESIS-CR-(\d{4})-(\d{2})-(\d{2})-(\d{3})$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);
const TRACKING_TABLE = '__drizzle_migrations';
const DEFAULT_TRACKING_SCHEMA = 'drizzle';

function validDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

export function resolveMigrationConfig(env: Env): { approvalId: string; databaseUrl: string } {
  const approvalId = env['MIGRATION_APPROVAL_ID'];
  const match = approvalId === undefined ? null : APPROVAL.exec(approvalId);
  if (approvalId === undefined || match === null) {
    throw new MigrationConfigError(
      'MIGRATION_APPROVAL_ID',
      'is required and must look like JANESIS-CR-YYYY-MM-DD-NNN',
    );
  }
  if (!validDate(Number(match[1]), Number(match[2]), Number(match[3]))) {
    throw new MigrationConfigError('MIGRATION_APPROVAL_ID', 'must contain a real calendar date');
  }

  const databaseUrl = env['MIGRATION_DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new MigrationConfigError('MIGRATION_DATABASE_URL', 'is required');
  }
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new MigrationConfigError('MIGRATION_DATABASE_URL', 'is not a valid URL');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new MigrationConfigError(
      'MIGRATION_DATABASE_URL',
      'must be a postgres:// or postgresql:// URL',
    );
  }
  if (!LOCAL_HOSTS.has(url.hostname)) {
    throw new MigrationConfigError(
      'MIGRATION_DATABASE_URL',
      'must point at localhost or 127.0.0.1 (local databases only)',
    );
  }
  return { approvalId, databaseUrl };
}

export function formatMigrationResult(result: MigrationResult): string {
  return (
    'Migrations complete (approval ' +
    result.approvalId +
    '): applied ' +
    result.applied +
    ' of ' +
    result.total
  );
}

function quote(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

function journalCount(folder: string): number {
  const journal = JSON.parse(readFileSync(join(folder, 'meta', '_journal.json'), 'utf8')) as {
    entries?: unknown;
  };
  if (!Array.isArray(journal.entries)) throw new Error('journal has no entries');
  return journal.entries.length;
}

async function trackedCount(pool: pg.Pool, schema: string): Promise<number> {
  const name = quote(schema) + '.' + quote(TRACKING_TABLE);
  const present = await pool.query('select to_regclass($1) is not null as present', [name]);
  if (!(present.rows[0] as { present: boolean }).present) return 0;
  const result = await pool.query('select count(*)::int as n from ' + name);
  return (result.rows[0] as { n: number }).n;
}

export async function runMigrations(env: Env, options: RunOptions): Promise<MigrationResult> {
  const { approvalId, databaseUrl } = resolveMigrationConfig(env);
  const make =
    options.createPool ??
    ((config: { connectionString: string; max: number }) => new pg.Pool(config));
  const pool = make({ connectionString: databaseUrl, max: 1 }) as pg.Pool;
  // An idle-client error must not crash the process.
  pool.on('error', () => undefined);
  const schema = options.migrationsSchema ?? DEFAULT_TRACKING_SCHEMA;
  let result: MigrationResult;
  try {
    const total = journalCount(options.migrationsFolder);
    const before = await trackedCount(pool, schema);
    await migrate(drizzle(pool), {
      migrationsFolder: options.migrationsFolder,
      migrationsSchema: schema,
      migrationsTable: TRACKING_TABLE,
    });
    const after = await trackedCount(pool, schema);
    result = { approvalId, total, applied: after - before };
  } catch {
    // Driver errors can carry connection details, so none of them is passed on.
    // The migration failure stays primary, so a failed close cannot replace it.
    try {
      await pool.end();
    } catch {
      // Intentionally ignored: the migration error is the one reported.
    }
    throw new MigrationError();
  }
  try {
    await pool.end();
  } catch {
    // Success must not be reported when the pool could not be closed.
    throw new MigrationError();
  }
  return result;
}

const APPLICATION_MIGRATIONS = './src/infrastructure/adapters/database/migrations';

async function main(): Promise<void> {
  try {
    const result = await runMigrations(process.env, { migrationsFolder: APPLICATION_MIGRATIONS });
    console.log(formatMigrationResult(result));
  } catch (error) {
    console.error(
      error instanceof MigrationConfigError || error instanceof MigrationError
        ? error.message
        : 'The migration run failed.',
    );
    process.exitCode = 1;
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href) {
  void main();
}
