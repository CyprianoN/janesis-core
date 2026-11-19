import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { MigrationError, runMigrations } from '../../../scripts/migrate.js';
import { resolveTestDatabaseUrl, withTestSchema } from '../../utils/test-database.js';

// INTEGRATION: needs TEST_DATABASE_URL and never skips. The migrations here are written by the test
// into a temporary folder. The application migrations 0001 and 0002 are never read or run.
const ID = 'JANESIS-CR-2026-11-07-001';

async function fixture(files: Array<{ tag: string; sql: string }>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'janesis-migrations-'));
  await mkdir(join(dir, 'meta'));
  const entries = files.map((file, index) => ({
    idx: index,
    version: '7',
    when: 1700000000000 + index * 1000,
    tag: file.tag,
    breakpoints: true,
  }));
  await writeFile(
    join(dir, 'meta', '_journal.json'),
    JSON.stringify({ version: '7', dialect: 'postgresql', entries }),
  );
  for (const file of files) await writeFile(join(dir, file.tag + '.sql'), file.sql);
  return dir;
}

async function count(client: pg.Client, text: string, values: unknown[] = []): Promise<number> {
  const result = await client.query(text, values);
  return (result.rows[0] as { n: number }).n;
}

const schemaExists = (client: pg.Client, name: string): Promise<number> =>
  count(
    client,
    'select count(*)::int as n from information_schema.schemata where schema_name = $1',
    [name],
  );

test('INTEGRATION: a test migration applies once, a second run applies none, tracking stays in the throwaway schema', async () => {
  const url = resolveTestDatabaseUrl(process.env);
  await withTestSchema(process.env, async (client, schema) => {
    const dir = await fixture([
      { tag: '0000_items', sql: 'create table ' + schema + '.items (id int);' },
    ]);
    try {
      const defaultBefore = await schemaExists(client, 'drizzle');
      const env = { MIGRATION_APPROVAL_ID: ID, MIGRATION_DATABASE_URL: url };
      const options = { migrationsFolder: dir, migrationsSchema: schema };
      const first = await runMigrations(env, options);
      assert.deepEqual(first, { approvalId: ID, total: 1, applied: 1 });
      const second = await runMigrations(env, options);
      assert.deepEqual(second, { approvalId: ID, total: 1, applied: 0 });
      assert.equal(
        await count(client, 'select count(*)::int as n from ' + schema + '.__drizzle_migrations'),
        1,
      );
      assert.equal(await count(client, 'select count(*)::int as n from ' + schema + '.items'), 0);
      assert.equal(await schemaExists(client, 'drizzle'), defaultBefore);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test('INTEGRATION: a failing migration leaves no success record and no partial table, and the pool is closed', async () => {
  const url = resolveTestDatabaseUrl(process.env);
  await withTestSchema(process.env, async (client, schema) => {
    const dir = await fixture([
      {
        tag: '0000_broken',
        sql:
          'create table ' +
          schema +
          '.partial (id int);\n--> statement-breakpoint\nselect * from ' +
          schema +
          '.does_not_exist;',
      },
    ]);
    const real: pg.Pool[] = [];
    try {
      await assert.rejects(
        runMigrations(
          { MIGRATION_APPROVAL_ID: ID, MIGRATION_DATABASE_URL: url },
          {
            migrationsFolder: dir,
            migrationsSchema: schema,
            createPool: (config: { connectionString: string; max: number }) => {
              const pool = new pg.Pool(config as pg.PoolConfig);
              real.push(pool);
              return pool;
            },
          },
        ),
        MigrationError,
      );
      assert.equal(
        await count(client, 'select count(*)::int as n from ' + schema + '.__drizzle_migrations'),
        0,
      );
      assert.equal(
        await count(
          client,
          'select count(*)::int as n from information_schema.tables where table_schema = $1 and table_name = $2',
          [schema, 'partial'],
        ),
        0,
      );
      assert.equal(real.length, 1);
      assert.equal(real[0]?.totalCount, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
