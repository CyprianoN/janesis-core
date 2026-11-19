import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import { type AppError } from '../../../src/domain/shared/errors/app-error.js';
import { ERROR_CODES, type ErrorCode } from '../../../src/domain/shared/errors/error-code.js';
import {
  conflict,
  forbidden,
  internalError,
  notFound,
  unauthorized,
  validationError,
} from '../../../src/domain/shared/errors/error-factory.js';
import {
  HTTP_STATUS_BY_CODE,
  registerErrorHandler,
} from '../../../src/transport/http/plugins/error-handler.plugin.js';

type Raiser = (message?: string, details?: Readonly<Record<string, unknown>>) => AppError;

const RAISERS: Readonly<Record<ErrorCode, Raiser>> = {
  VALIDATION_ERROR: validationError,
  UNAUTHORIZED: unauthorized,
  FORBIDDEN: forbidden,
  NOT_FOUND: notFound,
  CONFLICT: conflict,
  INTERNAL_ERROR: internalError,
};

function buildTestApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  app.get('/__test/ok', async () => ({ ok: true }));
  for (const code of ERROR_CODES) {
    const raise = RAISERS[code];
    app.get(`/__test/async/${code}`, async () => {
      throw raise('A safe message.', { field: 'email' });
    });
    app.get(`/__test/sync/${code}`, () => {
      throw raise('A safe message.');
    });
  }
  return app;
}

test('maps each canonical code to its approved HTTP status, as a frozen total table', () => {
  assert.deepEqual(HTTP_STATUS_BY_CODE, {
    VALIDATION_ERROR: 400,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    CONFLICT: 409,
    INTERNAL_ERROR: 500,
  });
  assert.ok(Object.isFrozen(HTTP_STATUS_BY_CODE));
  assert.deepEqual(Object.keys(HTTP_STATUS_BY_CODE).sort(), [...ERROR_CODES].sort());
});

test('an AppError from an async handler gives the mapped status and the canonical envelope', async () => {
  const app = buildTestApp();
  for (const code of ERROR_CODES) {
    const response = await app.inject({ method: 'GET', url: `/__test/async/${code}` });
    assert.equal(response.statusCode, HTTP_STATUS_BY_CODE[code], code);
    assert.deepEqual(response.json(), {
      error: { code, message: 'A safe message.', details: { field: 'email' } },
    });
  }
  await app.close();
});

test('an AppError thrown synchronously is handled the same way', async () => {
  const app = buildTestApp();
  for (const code of ERROR_CODES) {
    const response = await app.inject({ method: 'GET', url: `/__test/sync/${code}` });
    assert.equal(response.statusCode, HTTP_STATUS_BY_CODE[code], code);
    assert.deepEqual(response.json(), { error: { code, message: 'A safe message.' } });
  }
  await app.close();
});

test('details are omitted from the body when the error has none', async () => {
  const app = buildTestApp();
  const response = await app.inject({ method: 'GET', url: '/__test/sync/CONFLICT' });
  assert.ok(!response.body.includes('details'));
  await app.close();
});

test('error responses are JSON', async () => {
  const app = buildTestApp();
  const response = await app.inject({ method: 'GET', url: '/__test/async/FORBIDDEN' });
  assert.match(String(response.headers['content-type']), /^application\/json/);
  await app.close();
});

test('the body never carries a stack, the class name or a cause', async () => {
  const app = buildTestApp();
  const response = await app.inject({ method: 'GET', url: '/__test/async/INTERNAL_ERROR' });
  for (const word of ['stack', 'AppError', 'cause', 'at ']) {
    assert.ok(!response.body.includes(word), `the body contained "${word}"`);
  }
  await app.close();
});

test('a route that replies normally is not affected', async () => {
  const app = buildTestApp();
  const response = await app.inject({ method: 'GET', url: '/__test/ok' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { ok: true });
  await app.close();
});
