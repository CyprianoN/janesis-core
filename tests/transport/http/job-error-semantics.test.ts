import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { AppError } from '../../../src/domain/shared/errors/app-error.js';
import type { ErrorCode } from '../../../src/domain/shared/errors/error-code.js';
import { registerErrorHandler } from '../../../src/transport/http/plugins/error-handler.plugin.js';
import { APP_ERROR_ROWS, FRAMEWORK_ROWS, SENTINEL } from '../../utils/transport-error-matrix.js';

// HANDLER-LEVEL CONTRACT TESTS. They use a deliberately built Fastify harness with the Phase 6
// error handler registered and throwaway jobs routes. They do not exercise buildApp (the handler
// is wired there in T11) and they do not prove the behavior of actual job routes. The actual
// registered job routes must run the same matrix in Phase 17 (tests/jobs/job-route-semantics.test.ts).

const app = Fastify({ logger: false });
registerErrorHandler(app);
app.get('/__test/jobs/ok', async () => ({ ok: true }));
app.get('/__test/jobs/app/:code', async (request) => {
  throw new AppError((request.params as { code: ErrorCode }).code, 'A safe message.');
});
app.get('/__test/jobs/unexpected', async () => {
  throw new Error('leak ' + SENTINEL);
});
app.post('/__test/jobs/json', async () => ({ ok: true }));
after(async () => {
  await app.close();
});

test('success is 200 and untouched, with no error envelope', async () => {
  const res = await app.inject({ method: 'GET', url: '/__test/jobs/ok' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true });
});

for (const row of APP_ERROR_ROWS) {
  test(
    'AppError ' + row.code + ' gives status ' + row.status + ' and the canonical envelope',
    async () => {
      const res = await app.inject({ method: 'GET', url: '/__test/jobs/app/' + row.code });
      assert.equal(res.statusCode, row.status);
      const body = res.json() as { error: { code: string } };
      assert.equal(body.error.code, row.code);
    },
  );
}

test('an unexpected exception gives a generic 500 and leaks nothing', async () => {
  const res = await app.inject({ method: 'GET', url: '/__test/jobs/unexpected' });
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
      url: '/__test/jobs/json',
      headers: { 'content-type': row.contentType },
      payload: row.payload,
    });
    assert.equal(res.statusCode, row.status);
    assert.ok(!res.body.includes(SENTINEL));
  });
}

test('only INTERNAL_ERROR is a 5xx, so only it is retryable for QStash', async () => {
  for (const row of APP_ERROR_ROWS) {
    const res = await app.inject({ method: 'GET', url: '/__test/jobs/app/' + row.code });
    assert.equal(res.statusCode >= 500, row.code === 'INTERNAL_ERROR', row.code);
    assert.equal(
      res.statusCode >= 400 && res.statusCode < 500,
      row.code !== 'INTERNAL_ERROR',
      row.code,
    );
  }
});
