import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerErrorHandler } from '../../../src/transport/http/plugins/error-handler.plugin.js';

// Handler-level contract tests with throwaway routes. They do not prove actual route behavior.
const SENTINEL = 'sentinel-secret-value-7f3a91';
const DIAGNOSTIC_KEYS = ['requestId', 'classification', 'route', 'statusCode', 'time'];
const LOGGER_KEYS = new Set(['level', 'pid', 'hostname', 'reqId']);
const PINO_ERROR = 50;
const PINO_INFO = 30;
const GENERIC_500 = { error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' } };

type LogRecord = Record<string, unknown>;
type Coded = Error & { code?: string; statusCode?: number; classification?: string };

function frameworkError(status: number, code = 'FST_PROBE'): Coded {
  const err: Coded = new Error('probe message');
  err.code = code;
  err.statusCode = status;
  return err;
}

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
  app.post('/__test/json', async () => ({ ok: true }));
  app.get('/__test/plain/:status', async (request) => {
    const err: Coded = new Error('plain ' + SENTINEL);
    err.statusCode = Number((request.params as { status: string }).status);
    throw err;
  });
  app.get('/__test/fst/:status', async (request) => {
    throw frameworkError(Number((request.params as { status: string }).status));
  });
  app.get('/__test/fst-fake-classification', async () => {
    const err = frameworkError(400);
    err.classification = 'app-error';
    throw err;
  });
  app.get('/__test/rate-limited', async (_request, reply) => {
    reply.header('retry-after', '5');
    throw frameworkError(429);
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

function assertRecord(
  record: LogRecord | undefined,
  classification: string,
  route: string,
  statusCode: number,
): void {
  assert.ok(record !== undefined, 'no diagnostic record');
  for (const key of DIAGNOSTIC_KEYS) assert.ok(key in record, 'missing field: ' + key);
  assert.deepEqual(
    Object.keys(record).filter((key) => !DIAGNOSTIC_KEYS.includes(key) && !LOGGER_KEYS.has(key)),
    [],
  );
  assert.equal(record.classification, classification);
  assert.equal(record.route, route);
  assert.equal(record.statusCode, statusCode);
  assert.equal(record.level, statusCode >= 500 ? PINO_ERROR : PINO_INFO);
}

const VALIDATION_BODY = {
  error: { code: 'VALIDATION_ERROR', message: 'The request is invalid.' },
};

test('an unknown route gives the 404 NOT_FOUND envelope and echoes nothing', async () => {
  const { app, raw, records } = buildLoggedApp();
  const res = await app.inject({ method: 'GET', url: '/nope-path?token=' + SENTINEL });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.json(), {
    error: { code: 'NOT_FOUND', message: 'The requested resource was not found.' },
  });
  assert.ok(!res.body.includes('nope-path') && !res.body.includes(SENTINEL));
  const found = diagnostics(records());
  assert.equal(found.length, 1);
  assertRecord(found[0], 'app-error', 'not-found', 404);
  assert.ok(!raw().includes('nope-path') && !raw().includes(SENTINEL));
  await app.close();
});

test('malformed JSON gives 400 VALIDATION_ERROR, generic message, no details', async () => {
  const { app, raw, records } = buildLoggedApp();
  const res = await app.inject({
    method: 'POST',
    url: '/__test/json',
    headers: { 'content-type': 'application/json' },
    payload: '{"broken": ' + SENTINEL,
  });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.json(), VALIDATION_BODY);
  const found = diagnostics(records());
  assert.equal(found.length, 1);
  assertRecord(found[0], 'framework-client-error', '/__test/json', 400);
  assert.ok(!raw().includes(SENTINEL) && !res.body.includes(SENTINEL));
  await app.close();
});

test('an oversized body gives 413 with the generic VALIDATION_ERROR envelope', async () => {
  const { app, records } = buildLoggedApp();
  const res = await app.inject({
    method: 'POST',
    url: '/__test/json',
    headers: { 'content-type': 'application/json' },
    payload: '{"a":"' + 'x'.repeat(1048600) + '"}',
  });
  assert.equal(res.statusCode, 413);
  assert.deepEqual(res.json(), VALIDATION_BODY);
  const found = diagnostics(records());
  assert.equal(found.length, 1);
  assertRecord(found[0], 'framework-client-error', '/__test/json', 413);
  await app.close();
});

test('an unsupported media type gives 415 with the generic VALIDATION_ERROR envelope', async () => {
  const { app, records } = buildLoggedApp();
  const res = await app.inject({
    method: 'POST',
    url: '/__test/json',
    headers: { 'content-type': 'text/xml' },
    payload: '<a/>',
  });
  assert.equal(res.statusCode, 415);
  assert.deepEqual(res.json(), VALIDATION_BODY);
  const found = diagnostics(records());
  assert.equal(found.length, 1);
  assertRecord(found[0], 'framework-client-error', '/__test/json', 415);
  await app.close();
});

test('an error with a 404 statusCode but no FST_ code is not trusted and stays a generic 500', async () => {
  const { app, raw, records } = buildLoggedApp();
  const res = await app.inject({ method: 'GET', url: '/__test/plain/404' });
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.json(), GENERIC_500);
  const found = diagnostics(records());
  assert.equal(found.length, 1);
  assertRecord(found[0], 'unexpected', '/__test/plain/:status', 500);
  assert.ok(!raw().includes(SENTINEL) && !res.body.includes(SENTINEL));
  await app.close();
});

for (const status of [399, 500]) {
  test(
    'an FST_ error with status ' + status + ' is outside 400-499 and stays a generic 500',
    async () => {
      const { app, records } = buildLoggedApp();
      const res = await app.inject({ method: 'GET', url: '/__test/fst/' + status });
      assert.equal(res.statusCode, 500);
      assert.deepEqual(res.json(), GENERIC_500);
      assertRecord(diagnostics(records())[0], 'unexpected', '/__test/fst/:status', 500);
      await app.close();
    },
  );
}

const MAPPED: ReadonlyArray<[number, string, string]> = [
  [401, 'UNAUTHORIZED', 'Authentication is required.'],
  [403, 'FORBIDDEN', 'You do not have permission to perform this action.'],
  [404, 'NOT_FOUND', 'The requested resource was not found.'],
  [409, 'CONFLICT', 'The request conflicts with the current state of the resource.'],
  [418, 'VALIDATION_ERROR', 'The request is invalid.'],
];
for (const [status, code, message] of MAPPED) {
  test(
    'an FST_ error with status ' + status + ' keeps its status and maps to ' + code,
    async () => {
      const { app, records } = buildLoggedApp();
      const res = await app.inject({ method: 'GET', url: '/__test/fst/' + status });
      assert.equal(res.statusCode, status);
      assert.deepEqual(res.json(), { error: { code, message } });
      const found = diagnostics(records());
      assert.equal(found.length, 1);
      assertRecord(found[0], 'framework-client-error', '/__test/fst/:status', status);
      await app.close();
    },
  );
}

test('a fabricated classification property on a framework error does not control the logged value', async () => {
  const { app, records } = buildLoggedApp();
  const res = await app.inject({ method: 'GET', url: '/__test/fst-fake-classification' });
  assert.equal(res.statusCode, 400);
  const found = diagnostics(records());
  assert.equal(found.length, 1);
  assertRecord(found[0], 'framework-client-error', '/__test/fst-fake-classification', 400);
  await app.close();
});

test('a 429 keeps its status and retry-after header, is never 400 or 500, and leaks no stack', async () => {
  const { app, raw, records } = buildLoggedApp();
  const res = await app.inject({ method: 'GET', url: '/__test/rate-limited' });
  assert.equal(res.statusCode, 429);
  assert.equal(res.headers['retry-after'], '5');
  assert.notEqual(res.statusCode, 400);
  assert.notEqual(res.statusCode, 500);
  assert.ok(!res.body.includes('"stack"') && !res.body.includes(SENTINEL));
  const found = diagnostics(records());
  assert.equal(found.length, 1);
  assertRecord(found[0], 'framework-client-error', '/__test/rate-limited', 429);
  assert.ok(!raw().includes('"stack"') && !raw().includes('"err"'));
  await app.close();
});
