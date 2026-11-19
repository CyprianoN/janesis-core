import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import { AppError } from '../../../src/domain/shared/errors/app-error.js';
import { registerErrorHandler } from '../../../src/transport/http/plugins/error-handler.plugin.js';

const SENTINEL = 'sentinel-secret-value-7f3a91';
// The five approved diagnostic fields (Technical Lead ruling, T7). 'time' is the logger's timestamp.
const DIAGNOSTIC_KEYS = ['requestId', 'classification', 'route', 'statusCode', 'time'];
// Keys the logger itself may add. Anything else is an unapproved field.
const LOGGER_KEYS = new Set(['level', 'pid', 'hostname', 'reqId']);
const PINO_ERROR = 50;
const PINO_INFO = 30;

type LogRecord = Record<string, unknown>;

function buildLoggedApp(): { app: FastifyInstance; raw: () => string; records: () => LogRecord[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  const app = Fastify({ logger: { level: 'info', stream }, disableRequestLogging: true });
  registerErrorHandler(app);
  app.get('/__test/unexpected/:id', async () => {
    const err = new Error('leak ' + SENTINEL) as Error & Record<string, unknown>;
    err.providerResponse = SENTINEL;
    err.classification = 'app-error';
    throw err;
  });
  app.get('/__test/unsafe-details', async () => {
    throw new AppError('VALIDATION_ERROR', 'Invalid.', { password: SENTINEL });
  });
  app.get('/__test/app-error', async () => {
    throw new AppError('VALIDATION_ERROR', 'Invalid.', { field: 'email' });
  });
  const raw = (): string => chunks.join('');
  const records = (): LogRecord[] =>
    raw()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LogRecord);
  return { app, raw, records };
}

function diagnostics(records: LogRecord[]): LogRecord[] {
  return records.filter((record) => 'classification' in record);
}

function assertSafeRecord(record: LogRecord, route: string, statusCode: number): void {
  for (const key of DIAGNOSTIC_KEYS) {
    assert.ok(key in record, 'missing diagnostic field: ' + key);
  }
  assert.deepEqual(
    Object.keys(record).filter((key) => !DIAGNOSTIC_KEYS.includes(key) && !LOGGER_KEYS.has(key)),
    [],
  );
  assert.equal(typeof record.requestId, 'string');
  assert.equal(record.route, route);
  assert.equal(record.statusCode, statusCode);
  assert.equal(typeof record.time, 'number');
  assert.equal(record.level, statusCode >= 500 ? PINO_ERROR : PINO_INFO);
}

test('an unexpected error logs one safe record and leaks nothing, whatever the error carries', async () => {
  const { app, raw, records } = buildLoggedApp();
  const res = await app.inject({ method: 'GET', url: '/__test/unexpected/42?token=' + SENTINEL });
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.json(), {
    error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' },
  });
  const found = diagnostics(records());
  assert.equal(found.length, 1);
  assert.equal(found[0]?.classification, 'unexpected');
  assertSafeRecord(found[0] as LogRecord, '/__test/unexpected/:id', 500);
  assert.ok(!raw().includes(SENTINEL));
  assert.ok(!raw().includes('token='));
  assert.ok(!raw().includes('"err"'));
  assert.ok(!raw().includes('"stack"'));
  assert.ok(!res.body.includes(SENTINEL));
  await app.close();
});

test('unsafe error details are classified invalid-error-details and never logged or returned', async () => {
  const { app, raw, records } = buildLoggedApp();
  const res = await app.inject({ method: 'GET', url: '/__test/unsafe-details' });
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.json(), {
    error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' },
  });
  const found = diagnostics(records());
  assert.equal(found.length, 1);
  assert.equal(found[0]?.classification, 'invalid-error-details');
  assertSafeRecord(found[0] as LogRecord, '/__test/unsafe-details', 500);
  assert.ok(!raw().includes(SENTINEL));
  assert.ok(!res.body.includes(SENTINEL));
  await app.close();
});

test('an AppError is classified app-error and logged at info', async () => {
  const { app, records } = buildLoggedApp();
  const res = await app.inject({ method: 'GET', url: '/__test/app-error' });
  assert.equal(res.statusCode, 400);
  const found = diagnostics(records());
  assert.equal(found.length, 1);
  assert.equal(found[0]?.classification, 'app-error');
  assertSafeRecord(found[0] as LogRecord, '/__test/app-error', 400);
  await app.close();
});
