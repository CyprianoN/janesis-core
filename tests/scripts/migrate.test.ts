import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import {
  MigrationConfigError,
  MigrationError,
  formatMigrationResult,
  resolveMigrationConfig,
  runMigrations,
} from '../../scripts/migrate.js';

// No database is used here. The fake pool only records that it was created and ended.
const SENTINEL = 'sentinel-secret-value-7f3a91';
const ID = 'JANESIS-CR-2026-11-07-001';
const URL_OK = 'postgres://user:' + SENTINEL + '@localhost:5432/janesis_migrate_test';

type Env = Record<string, string | undefined>;

function refusal(env: Env): MigrationConfigError {
  try {
    resolveMigrationConfig(env);
  } catch (error) {
    assert.ok(error instanceof MigrationConfigError, 'expected a MigrationConfigError');
    assert.ok(!error.message.includes(SENTINEL), 'a supplied value appeared in the error');
    return error;
  }
  return assert.fail('expected the configuration to be refused');
}

test('a missing or malformed approval identifier is refused and names the variable', () => {
  const bad = [
    undefined,
    '',
    ' ' + ID,
    ID + ' ',
    'janesis-cr-2026-11-07-001',
    'JANESIS-CR-2026-11-07-01',
    'JANESIS-CR-2026-11-07-0001',
    'JANESIS-CR-2026-13-01-001',
    'JANESIS-CR-2026-02-30-001',
    'JANESIS-2026-11-07-001',
  ];
  for (const value of bad) {
    const error = refusal({ MIGRATION_APPROVAL_ID: value, MIGRATION_DATABASE_URL: URL_OK });
    assert.equal(error.variable, 'MIGRATION_APPROVAL_ID', JSON.stringify(value));
  }
});

test('a missing database URL is refused and names MIGRATION_DATABASE_URL', () => {
  for (const value of [undefined, '']) {
    const error = refusal({ MIGRATION_APPROVAL_ID: ID, MIGRATION_DATABASE_URL: value });
    assert.equal(error.variable, 'MIGRATION_DATABASE_URL');
  }
});

test('DATABASE_URL and TEST_DATABASE_URL are never used as a fallback', () => {
  const error = refusal({
    MIGRATION_APPROVAL_ID: ID,
    DATABASE_URL: URL_OK,
    TEST_DATABASE_URL: URL_OK,
  });
  assert.equal(error.variable, 'MIGRATION_DATABASE_URL');
});

test('a non-postgres protocol and every non-local host are refused', () => {
  const bad = [
    'http://localhost/janesis_migrate_test',
    'not a url ' + SENTINEL,
    'postgres://u:' + SENTINEL + '@10.0.0.5:5432/db',
    'postgres://u:' + SENTINEL + '@db.example.invalid:5432/db',
    'postgres://u:' + SENTINEL + '@localhost.example.invalid:5432/db',
    'postgres://u:' + SENTINEL + '@[::1]:5432/db',
  ];
  for (const value of bad) {
    const error = refusal({ MIGRATION_APPROVAL_ID: ID, MIGRATION_DATABASE_URL: value });
    assert.equal(error.variable, 'MIGRATION_DATABASE_URL');
  }
});

test('a valid identifier and a local URL are accepted unchanged', () => {
  assert.deepEqual(
    resolveMigrationConfig({ MIGRATION_APPROVAL_ID: ID, MIGRATION_DATABASE_URL: URL_OK }),
    { approvalId: ID, databaseUrl: URL_OK },
  );
  const ip = 'postgresql://u:p@127.0.0.1:5432/janesis_migrate_test';
  assert.equal(
    resolveMigrationConfig({ MIGRATION_APPROVAL_ID: ID, MIGRATION_DATABASE_URL: ip }).databaseUrl,
    ip,
  );
});

test('the result line carries the approval identifier and the counts, and no URL', () => {
  const line = formatMigrationResult({ approvalId: ID, total: 3, applied: 2 });
  assert.ok(line.includes(ID));
  assert.match(line, /applied 2 of 3/);
  assert.ok(!line.includes('postgres'));
});

class FakePool extends EventEmitter {
  ended = 0;
  async query(): Promise<never> {
    throw new Error('driver failure ' + SENTINEL + ' ' + URL_OK);
  }
  async connect(): Promise<never> {
    throw new Error('driver failure ' + SENTINEL + ' ' + URL_OK);
  }
  async end(): Promise<void> {
    this.ended += 1;
  }
}

test('an invalid configuration is refused before any pool is created', async () => {
  let created = 0;
  await assert.rejects(
    runMigrations(
      { MIGRATION_APPROVAL_ID: 'bad', MIGRATION_DATABASE_URL: URL_OK },
      {
        migrationsFolder: 'unused',
        createPool: () => {
          created += 1;
          return new FakePool();
        },
      },
    ),
    MigrationConfigError,
  );
  assert.equal(created, 0);
});

test('a failed run closes the pool once and surfaces only a safe error', async () => {
  const pools: FakePool[] = [];
  let caught: unknown;
  try {
    await runMigrations(
      { MIGRATION_APPROVAL_ID: ID, MIGRATION_DATABASE_URL: URL_OK },
      {
        migrationsFolder: '/nonexistent-janesis-migrations',
        createPool: () => {
          const pool = new FakePool();
          pools.push(pool);
          return pool as unknown as pg.Pool;
        },
      },
    );
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof MigrationError, 'expected a MigrationError');
  const visible = [caught.message, String(caught), JSON.stringify(caught)].join(' ');
  assert.ok(!visible.includes(SENTINEL), 'driver detail appeared in the error');
  assert.ok(!visible.includes('postgres://'), 'a connection string appeared in the error');
  assert.equal(pools.length, 1);
  assert.equal(pools[0]?.ended, 1);
});

test('a failed run followed by a failed pool close still reports only the safe migration error', async () => {
  class ClosingFails extends FakePool {
    override async end(): Promise<void> {
      this.ended += 1;
      throw new Error('close failure ' + SENTINEL + ' ' + URL_OK);
    }
  }
  const pools: ClosingFails[] = [];
  let caught: unknown;
  try {
    await runMigrations(
      { MIGRATION_APPROVAL_ID: ID, MIGRATION_DATABASE_URL: URL_OK },
      {
        migrationsFolder: '/nonexistent-janesis-migrations',
        createPool: () => {
          const pool = new ClosingFails();
          pools.push(pool);
          return pool as unknown as pg.Pool;
        },
      },
    );
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof MigrationError, 'expected a MigrationError');
  const visible = [caught.message, String(caught), JSON.stringify(caught)].join(' ');
  assert.ok(!visible.includes(SENTINEL) && !visible.includes('postgres://'));
  assert.equal(pools[0]?.ended, 1);
});

test('a successful migration followed by a failed pool close is reported as a safe failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'janesis-one-migration-'));
  await mkdir(join(dir, 'meta'));
  await writeFile(
    join(dir, 'meta', '_journal.json'),
    JSON.stringify({
      version: '7',
      dialect: 'postgresql',
      entries: [{ idx: 0, version: '7', when: 1700000000000, tag: '0000_noop', breakpoints: true }],
    }),
  );
  await writeFile(join(dir, '0000_noop.sql'), 'select 1;');
  const calls: string[] = [];
  const clientStatements: string[] = [];
  const label = (value: unknown): string =>
    typeof value === 'string' ? value : String((value as { text?: unknown }).text);
  class SucceedsThenFailsToClose extends EventEmitter {
    ended = 0;
    async query(sql?: unknown): Promise<{ rows: unknown[]; rowCount: number }> {
      calls.push('pool.query ' + label(sql));
      clientStatements.push(label(sql).toLowerCase());
      if (typeof sql === 'string' && sql.includes('to_regclass')) {
        return { rows: [{ present: false }], rowCount: 1 };
      }
      // No migration has been applied yet, so the history lookup must return no rows.
      if (label(sql).includes('order by created_at')) return { rows: [], rowCount: 0 };
      return { rows: [{ n: 0 }], rowCount: 1 };
    }
    async connect(): Promise<unknown> {
      calls.push('pool.connect');
      return {
        query: async (statement: unknown) => {
          clientStatements.push(label(statement).toLowerCase());
          return { rows: [], rowCount: 0 };
        },
        release: () => {
          calls.push('client.release');
        },
      };
    }
    async end(): Promise<void> {
      this.ended += 1;
      calls.push('pool.end');
      throw new Error('close failure ' + SENTINEL + ' ' + URL_OK);
    }
  }
  const pools: SucceedsThenFailsToClose[] = [];
  let caught: unknown;
  try {
    await runMigrations(
      { MIGRATION_APPROVAL_ID: ID, MIGRATION_DATABASE_URL: URL_OK },
      {
        migrationsFolder: dir,
        createPool: () => {
          const pool = new SucceedsThenFailsToClose();
          pools.push(pool);
          return pool as unknown as pg.Pool;
        },
      },
    );
  } catch (error) {
    caught = error;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const trace = 'calls: ' + calls.join(' | ') + ' || client: ' + clientStatements.join(' | ');
  const ran = clientStatements.findIndex((statement) => statement.includes('select 1'));
  const committed = clientStatements.indexOf('commit');
  assert.ok(ran >= 0, 'the migration SQL never ran, so this proves nothing. ' + trace);
  assert.ok(committed > ran, 'the migration did not commit after its SQL. ' + trace);
  assert.ok(caught instanceof MigrationError, 'expected a MigrationError. ' + trace);
  const visible = [caught.message, String(caught), JSON.stringify(caught)].join(' ');
  assert.ok(!visible.includes(SENTINEL) && !visible.includes('postgres://'));
  assert.equal(pools[0]?.ended, 1);
  assert.ok(calls.indexOf('pool.end') > calls.lastIndexOf('client.release'), trace);
});

function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    'MIGRATION_APPROVAL_ID',
    'MIGRATION_DATABASE_URL',
    'DATABASE_URL',
    'TEST_DATABASE_URL',
  ]) {
    delete env[key];
  }
  return { ...env, ...extra };
}

test('executing the script without configuration exits 1 naming the variable and prints no credential', () => {
  const run = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/migrate.ts'], {
    env: cleanEnv({ DATABASE_URL: URL_OK, TEST_DATABASE_URL: URL_OK }),
    encoding: 'utf8',
    timeout: 30_000,
  });
  const output = run.stdout + run.stderr;
  assert.equal(run.status, 1);
  assert.match(output, /MIGRATION_APPROVAL_ID/);
  assert.ok(!output.includes(SENTINEL), 'a supplied credential appeared in the output');
});

test('importing the script runs nothing, opens no connection and prints nothing', () => {
  const run = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      "await import('./scripts/migrate.ts'); console.log('imported-ok');",
    ],
    {
      env: cleanEnv({
        MIGRATION_APPROVAL_ID: ID,
        MIGRATION_DATABASE_URL: 'postgres://user:' + SENTINEL + '@127.0.0.1:1/janesis_migrate_test',
      }),
      encoding: 'utf8',
      timeout: 30_000,
    },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), 'imported-ok');
  assert.ok(!(run.stdout + run.stderr).includes(SENTINEL));
});
