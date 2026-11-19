import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../../../src/domain/shared/errors/app-error.js';
import { buildApp } from '../../../src/transport/http/app.js';

// COMPOSITION TESTS through the real buildApp. The throwaway routes are added before the first
// inject and are not production routes.
const SENTINEL = 'sentinel-secret-value-7f3a91';

function composedApp(isReady = true) {
  const app = buildApp({ isReady: () => isReady });
  app.get('/__test/conflict', async () => {
    throw new AppError('CONFLICT', 'A safe message.');
  });
  app.get('/__test/unexpected', async () => {
    throw new Error('leak ' + SENTINEL);
  });
  return app;
}

test('an unknown route gives the canonical 404 and echoes neither path nor query', async () => {
  const app = composedApp();
  const res = await app.inject({ method: 'GET', url: '/nope-path?token=' + SENTINEL });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.json(), {
    error: { code: 'NOT_FOUND', message: 'The requested resource was not found.' },
  });
  assert.ok(!res.body.includes('nope-path') && !res.body.includes(SENTINEL));
  await app.close();
});

test('an AppError CONFLICT reaches the handler through the composed app', async () => {
  const app = composedApp();
  const res = await app.inject({ method: 'GET', url: '/__test/conflict' });
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.json(), { error: { code: 'CONFLICT', message: 'A safe message.' } });
  await app.close();
});

test('an unexpected error gives the generic 500 and leaks nothing through the composed app', async () => {
  const app = composedApp();
  const res = await app.inject({ method: 'GET', url: '/__test/unexpected' });
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.json(), {
    error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' },
  });
  assert.ok(!res.body.includes(SENTINEL));
  await app.close();
});

test('GUARD: /ready not ready is exactly 503 { status: not_ready }, untouched by the handler', async () => {
  const app = composedApp(false);
  const res = await app.inject({ method: 'GET', url: '/ready' });
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.json(), { status: 'not_ready' });
  assert.ok(!('error' in (res.json() as object)));
  await app.close();
});

test('GUARD: /health is 200 { status: ok } through the composed app', async () => {
  const app = composedApp();
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { status: 'ok' });
  await app.close();
});
