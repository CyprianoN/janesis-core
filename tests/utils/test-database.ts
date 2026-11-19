import { randomBytes } from 'node:crypto';
import pg from 'pg';

// Test-only database helper (IADP Phase 7, WP7-3). It reads TEST_DATABASE_URL and nothing else:
// it never falls back to DATABASE_URL. Validation runs before any connection is opened, and error
// messages never contain the URL or its credentials.

export type TestEnv = Readonly<Record<string, string | undefined>>;

export class TestDatabaseConfigError extends Error {
  constructor(reason: string) {
    super('Test database configuration is invalid: ' + reason);
    this.name = 'TestDatabaseConfigError';
  }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

export function resolveTestDatabaseUrl(env: TestEnv): string {
  const value = env['TEST_DATABASE_URL'];
  if (value === undefined || value === '') {
    throw new TestDatabaseConfigError(
      'TEST_DATABASE_URL is required (DATABASE_URL is never used for tests)',
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TestDatabaseConfigError('TEST_DATABASE_URL is not a valid URL');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new TestDatabaseConfigError(
      'TEST_DATABASE_URL must be a postgres:// or postgresql:// URL',
    );
  }
  if (!LOCAL_HOSTS.has(url.hostname)) {
    throw new TestDatabaseConfigError('TEST_DATABASE_URL must point at localhost or 127.0.0.1');
  }
  const name = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!name.endsWith('_test')) {
    throw new TestDatabaseConfigError('the test database name must end with _test');
  }
  return value;
}

/**
 * Creates a uniquely named schema, runs the work, then always drops the schema and closes the
 * connection. The schema name is generated here from random hex and is never user-supplied.
 */
export async function withTestSchema(
  env: TestEnv,
  work: (client: pg.Client, schema: string) => Promise<void>,
): Promise<void> {
  const url = resolveTestDatabaseUrl(env);
  const schema = 't_' + randomBytes(8).toString('hex');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('create schema ' + schema);
    await work(client, schema);
  } finally {
    try {
      await client.query('drop schema if exists ' + schema + ' cascade');
    } finally {
      await client.end();
    }
  }
}
