import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {
  TestDatabaseConfigError,
  resolveTestDatabaseUrl,
  withTestSchema,
} from '../../utils/test-database.js';

// Validation cases need no database. Integration cases need TEST_DATABASE_URL and never skip.
const SENTINEL = 'sentinel-secret-value-7f3a91';
const VALID = 'postgres://ci_user:' + SENTINEL + '@localhost:5432/janesis_test';

function configError(env: Record<string, string | undefined>): TestDatabaseConfigError {
  try {
    resolveTestDatabaseUrl(env);
  } catch (error) {
    assert.ok(error instanceof TestDatabaseConfigError, 'expected a TestDatabaseConfigError');
    const visible = [error.message, String(error)].join(' ');
    assert.ok(!visible.includes(SENTINEL), 'a credential appeared in the error output');
    return error;
  }
  return assert.fail('expected resolveTestDatabaseUrl to throw');
}

test('a missing TEST_DATABASE_URL fails and names the variable', () => {
  assert.match(configError({}).message, /TEST_DATABASE_URL/);
  assert.match(configError({ TEST_DATABASE_URL: '' }).message, /TEST_DATABASE_URL/);
});

test('DATABASE_URL alone never satisfies the configuration and its value is never echoed', () => {
  const error = configError({ DATABASE_URL: VALID });
  assert.match(error.message, /TEST_DATABASE_URL/);
});

test('a database name without the _test suffix is rejected', () => {
  for (const name of ['janesis', 'janesis_prod', 'test', 'janesis_test_x']) {
    configError({ TEST_DATABASE_URL: 'postgres://u:' + SENTINEL + '@localhost:5432/' + name });
  }
});

test('a remote host is rejected', () => {
  for (const host of ['db.example.invalid', '10.0.0.5', 'localhost.example.invalid']) {
    configError({
      TEST_DATABASE_URL: 'postgres://u:' + SENTINEL + '@' + host + ':5432/janesis_test',
    });
  }
});

test('a malformed URL or a non-postgres protocol is rejected', () => {
  configError({ TEST_DATABASE_URL: 'not a url ' + SENTINEL });
  configError({ TEST_DATABASE_URL: 'http://localhost/janesis_test' });
});

test('a valid local test URL is returned unchanged', () => {
  assert.equal(resolveTestDatabaseUrl({ TEST_DATABASE_URL: VALID }), VALID);
  const ip = 'postgresql://u:p@127.0.0.1:5432/janesis_test';
  assert.equal(resolveTestDatabaseUrl({ TEST_DATABASE_URL: ip }), ip);
});

test('withTestSchema rejects an unsafe configuration before running any work', async () => {
  let ran = false;
  await assert.rejects(
    withTestSchema({ DATABASE_URL: VALID }, async () => {
      ran = true;
    }),
    TestDatabaseConfigError,
  );
  assert.equal(ran, false);
});

async function schemaCount(url: string, schema: string): Promise<number> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const result = await client.query(
      'select count(*)::int as n from information_schema.schemata where schema_name = $1',
      [schema],
    );
    return (result.rows[0] as { n: number }).n;
  } finally {
    await client.end();
  }
}

test('INTEGRATION: select 1 works and the test-owned schema is created then dropped', async () => {
  const url = resolveTestDatabaseUrl(process.env);
  let seen = '';
  await withTestSchema(process.env, async (client, schema) => {
    seen = schema;
    const one = await client.query('select 1 as one');
    assert.equal((one.rows[0] as { one: number }).one, 1);
    assert.equal(await schemaCount(url, schema), 1);
  });
  assert.ok(seen.length > 0);
  assert.equal(await schemaCount(url, seen), 0);
});

test('INTEGRATION: the schema is dropped and the error preserved when the work throws', async () => {
  const url = resolveTestDatabaseUrl(process.env);
  let seen = '';
  await assert.rejects(
    withTestSchema(process.env, async (_client, schema) => {
      seen = schema;
      throw new Error('forced failure');
    }),
    /forced failure/,
  );
  assert.equal(await schemaCount(url, seen), 0);
});

test('INTEGRATION: each call uses a distinct schema name', async () => {
  const names = new Set<string>();
  for (let i = 0; i < 3; i += 1) {
    await withTestSchema(process.env, async (_client, schema) => {
      names.add(schema);
    });
  }
  assert.equal(names.size, 3);
});
