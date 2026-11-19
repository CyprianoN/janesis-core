import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../../src/transport/http/app.js';

test('GET /health returns 200 ok', async () => {
  const app = buildApp();
  const response = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: 'ok' });
  await app.close();
});

test('GET /ready returns 200 when ready', async () => {
  const app = buildApp({ isReady: () => true });
  const response = await app.inject({ method: 'GET', url: '/ready' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: 'ready' });
  await app.close();
});

test('GET /ready returns 503 while not ready (starting or draining)', async () => {
  const app = buildApp({ isReady: () => false });
  const response = await app.inject({ method: 'GET', url: '/ready' });
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), { status: 'not_ready' });
  await app.close();
});

test('GET /health stays 200 while not ready (liveness is independent of readiness)', async () => {
  const app = buildApp({ isReady: () => false });
  const response = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(response.statusCode, 200);
  await app.close();
});
