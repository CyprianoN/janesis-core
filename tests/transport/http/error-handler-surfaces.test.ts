import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import Fastify, { type FastifyPluginAsync } from 'fastify';
import { AppError } from '../../../src/domain/shared/errors/app-error.js';
import { ERROR_CODES, type ErrorCode } from '../../../src/domain/shared/errors/error-code.js';
import {
  HTTP_STATUS_BY_CODE,
  registerErrorHandler,
} from '../../../src/transport/http/plugins/error-handler.plugin.js';

// Handler-level contract tests with throwaway routes. They do not prove actual route behavior.
// The same plugin is registered under /v1, /internal/v1 and unprefixed (the control).
const SENTINEL = 'sentinel-secret-value-7f3a91';
const SURFACES = ['', '/v1', '/internal/v1'] as const;
type LogRecord = Record<string, unknown>;
type Coded = Error & { code?: string; statusCode?: number };

const throwaway: FastifyPluginAsync = async (instance) => {
  instance.get('/__test/app/:code', async (request) => {
    throw new AppError((request.params as { code: ErrorCode }).code, 'A safe message.');
  });
  instance.get('/__test/unexpected', async () => {
    const err: Coded = new Error('leak ' + SENTINEL);
    throw err;
  });
  instance.get('/__test/fst/:status', async (request) => {
    const err: Coded = new Error('probe message');
    err.code = 'FST_PROBE';
    err.statusCode = Number((request.params as { status: string }).status);
    throw err;
  });
  instance.get('/__test/rate-limited', async (_request, reply) => {
    reply.header('retry-after', '5');
    const err: Coded = new Error('probe message');
    err.code = 'FST_PROBE';
    err.statusCode = 429;
    throw err;
  });
  instance.post('/__test/json', async () => ({ ok: true }));
};

interface Case {
  name: string;
  method: 'GET' | 'POST';
  path: string;
  pattern: string;
  status: number;
  headers?: Record<string, string>;
  payload?: string;
}

const CASES: Case[] = [
  ...ERROR_CODES.map((code): Case => ({
    name: 'AppError ' + code,
    method: 'GET',
    path: '/__test/app/' + code,
    pattern: '/__test/app/:code',
    status: HTTP_STATUS_BY_CODE[code],
  })),
  {
    name: 'unexpected error',
    method: 'GET',
    path: '/__test/unexpected?token=' + SENTINEL,
    pattern: '/__test/unexpected',
    status: 500,
  },
  {
    name: 'FST_ 418',
    method: 'GET',
    path: '/__test/fst/418',
    pattern: '/__test/fst/:status',
    status: 418,
  },
  {
    name: 'FST_ 429 with retry-after',
    method: 'GET',
    path: '/__test/rate-limited',
    pattern: '/__test/rate-limited',
    status: 429,
  },
  {
    name: 'malformed JSON',
    method: 'POST',
    path: '/__test/json',
    pattern: '/__test/json',
    status: 400,
    headers: { 'content-type': 'application/json' },
    payload: '{"broken": ' + SENTINEL,
  },
  {
    name: 'oversized body',
    method: 'POST',
    path: '/__test/json',
    pattern: '/__test/json',
    status: 413,
    headers: { 'content-type': 'application/json' },
    payload: '{"a":"' + 'x'.repeat(1048600) + '"}',
  },
  {
    name: 'unsupported media type',
    method: 'POST',
    path: '/__test/json',
    pattern: '/__test/json',
    status: 415,
    headers: { 'content-type': 'text/xml' },
    payload: '<a/>',
  },
  {
    name: 'unknown route',
    method: 'GET',
    path: '/__test/nope?token=' + SENTINEL,
    pattern: 'not-found',
    status: 404,
  },
];

async function run(surface: string, c: Case) {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  const app = Fastify({ logger: { level: 'info', stream }, disableRequestLogging: true });
  registerErrorHandler(app);
  if (surface === '') await app.register(throwaway);
  else await app.register(throwaway, { prefix: surface });
  const res = await app.inject({
    method: c.method,
    url: surface + c.path,
    ...(c.headers ? { headers: c.headers } : {}),
    ...(c.payload ? { payload: c.payload } : {}),
  });
  await app.close();
  const raw = chunks.join('');
  const records = raw
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LogRecord)
    .filter((record) => 'classification' in record);
  return { res, raw, records };
}

for (const c of CASES) {
  test('identical status, body and safe diagnostics on every surface: ' + c.name, async () => {
    const control = await run('', c);
    for (const surface of SURFACES) {
      const out = surface === '' ? control : await run(surface, c);
      const record = out.records[0];
      console.log(
        'MEASURED ' +
          c.name +
          ' | surface "' +
          surface +
          '" | status ' +
          out.res.statusCode +
          ' | route ' +
          String(record?.route) +
          ' | classification ' +
          String(record?.classification),
      );
      assert.equal(out.res.statusCode, c.status);
      assert.equal(out.res.body, control.res.body);
      assert.equal(out.res.headers['content-type'], control.res.headers['content-type']);
      assert.equal(out.res.headers['retry-after'], control.res.headers['retry-after']);
      assert.equal(out.records.length, 1);
      assert.equal(record?.statusCode, c.status);
      assert.equal(record?.classification, control.records[0]?.classification);
      assert.equal(record?.level, control.records[0]?.level);
      assert.equal(record?.route, c.pattern === 'not-found' ? 'not-found' : surface + c.pattern);
      assert.ok(!out.res.body.includes(SENTINEL) && !out.raw.includes(SENTINEL));
      assert.ok(!out.raw.includes('token=') && !out.raw.includes('"stack"'));
    }
  });
}
