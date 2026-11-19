import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { AppError } from '../../../src/domain/shared/errors/app-error.js';
import type { ErrorCode } from '../../../src/domain/shared/errors/error-code.js';
import { registerErrorHandler } from '../../../src/transport/http/plugins/error-handler.plugin.js';
import { APP_ERROR_ROWS, FRAMEWORK_ROWS, SENTINEL } from '../../utils/transport-error-matrix.js';

// HANDLER-LEVEL CONTRACT TESTS. They use a deliberately built Fastify harness with the Phase 6
// error handler registered and throwaway webhooks routes. They do not exercise buildApp (the handler
// is wired there in T11) and they do not prove the behavior of actual webhook routes. The actual
// registered webhook routes must run the same matrix in Phase 18 (tests/transport/webhooks/webhook-route-semantics.test.ts).

const app = Fastify({ logger: false });
registerErrorHandler(app);
app.get('/__test/webhooks/ok', async () => ({ ok: true }));
app.get('/__test/webhooks/app/:code', async (request) => {
  throw new AppError((request.params as { code: ErrorCode }).code, 'A safe message.');
});
app.get('/__test/webhooks/unexpected', async () => {
  throw new Error('leak ' + SENTINEL);
});
app.post('/__test/webhooks/json', async () => ({ ok: true }));
after(async () => {
  await app.close();
});

test('success is 200 and untouched, with no error envelope', async () => {
  const res = await app.inject({ method: 'GET', url: '/__test/webhooks/ok' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true });
});

for (const row of APP_ERROR_ROWS) {
  test(
    'AppError ' + row.code + ' gives status ' + row.status + ' and the canonical envelope',
    async () => {
      const res = await app.inject({ method: 'GET', url: '/__test/webhooks/app/' + row.code });
      assert.equal(res.statusCode, row.status);
      const body = res.json() as { error: { code: string } };
      assert.equal(body.error.code, row.code);
    },
  );
}

test('an unexpected exception gives a generic 500 and leaks nothing', async () => {
  const res = await app.inject({ method: 'GET', url: '/__test/webhooks/unexpected' });
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.json(), {
    error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' },
  });
  assert.ok(!res.body.includes(SENTINEL));
});

for (const row of FRAMEWORK_ROWS) {
  test('framework error ' + row.name + ' keeps status ' + row.status, async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/__test/webhooks/json',
      headers: { 'content-type': row.contentType },
      payload: row.payload,
    });
    assert.equal(res.statusCode, row.status);
    assert.ok(!res.body.includes(SENTINEL));
  });
}

test('an invalid signature stand-in (UNAUTHORIZED) gives 401 and an invalid payload stand-in (VALIDATION_ERROR) gives 400', async () => {
  const signature = await app.inject({ method: 'GET', url: '/__test/webhooks/app/UNAUTHORIZED' });
  assert.equal(signature.statusCode, 401);
  const payload = await app.inject({ method: 'GET', url: '/__test/webhooks/app/VALIDATION_ERROR' });
  assert.equal(payload.statusCode, 400);
});

test('no error path returns a 2xx', async () => {
  const statuses: number[] = [];
  for (const row of APP_ERROR_ROWS) {
    statuses.push(
      (await app.inject({ method: 'GET', url: '/__test/webhooks/app/' + row.code })).statusCode,
    );
  }
  statuses.push(
    (await app.inject({ method: 'GET', url: '/__test/webhooks/unexpected' })).statusCode,
  );
  for (const row of FRAMEWORK_ROWS) {
    statuses.push(
      (
        await app.inject({
          method: 'POST',
          url: '/__test/webhooks/json',
          headers: { 'content-type': row.contentType },
          payload: row.payload,
        })
      ).statusCode,
    );
  }
  assert.equal(statuses.length, APP_ERROR_ROWS.length + 1 + FRAMEWORK_ROWS.length);
  for (const status of statuses) assert.ok(status >= 400, 'error path returned ' + status);
});
