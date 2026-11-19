import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../../src/transport/http/app.js';

// WP8-07B: route-inventory guard. buildApp() must register only the approved routes. A future
// phase that adds a route must (1) validate its body, parameters and query with validateInput, as
// shown in validation-http.test.ts and combined-request-validation.test.ts, and (2) consciously
// extend APPROVED_ROUTES below. Fastify has no public route-listing API, so this parses the text of
// printRoutes, which is verified here against the installed Fastify version.
const APPROVED_ROUTES: readonly string[] = ['GET /health', 'GET /ready'];

const LINE = /^[\u2502\u251C\u2514\u2500\s]*(\S+)\s+\(([A-Z, ]+)\)$/;

function parseRoutes(printed: string): string[] {
  const entries: string[] = [];
  for (const raw of printed.split('\n')) {
    const text = raw.trim();
    if (text === '') continue;
    const match = LINE.exec(text);
    if (match === null) throw new Error('Unparseable route line: ' + JSON.stringify(text));
    const path = match[1] ?? '';
    for (const method of (match[2] ?? '').split(',')) entries.push(method.trim() + ' ' + path);
  }
  // Fastify generates a HEAD route for every GET route; only those derived routes are dropped.
  return entries
    .filter((e) => !(e.startsWith('HEAD ') && entries.includes('GET ' + e.slice(5))))
    .sort();
}

async function registered(app: FastifyInstance): Promise<string[]> {
  await app.ready();
  const printed = app.printRoutes({ commonPrefix: false });
  await app.close();
  return parseRoutes(printed);
}

const unapproved = (routes: string[]): string[] =>
  routes.filter((r) => !APPROVED_ROUTES.includes(r));

test('buildApp registers only the approved routes', async () => {
  const routes = await registered(buildApp());
  const extra = unapproved(routes);
  assert.deepEqual(
    extra,
    [],
    'Unapproved routes registered by buildApp(): ' +
      extra.join(', ') +
      '. Validate their body, params and query with validateInput, then update APPROVED_ROUTES consciously.',
  );
  assert.deepEqual(routes, [...APPROVED_ROUTES].sort(), 'an approved route is missing');
});

test('parser: parameter routes, multiple methods, derived HEAD and a lone HEAD', () => {
  const sample = [
    '\u251C\u2500\u2500 /health (GET, HEAD)',
    '\u251C\u2500\u2500 /v1/items/:id (POST)',
    '\u251C\u2500\u2500 /v1/things (GET, HEAD)',
    '\u2514\u2500\u2500 /only-head (HEAD)',
  ].join('\n');
  assert.deepEqual(parseRoutes(sample), [
    'GET /health',
    'GET /v1/things',
    'HEAD /only-head',
    'POST /v1/items/:id',
  ]);
});

test('parser: an unreadable line fails loudly instead of yielding an empty list', () => {
  assert.throws(() => parseRoutes('not a route line'), /Unparseable route line/);
});

test('control: routes added to a fresh app are reported as unapproved', async () => {
  const app = buildApp();
  app.get('/v1/things', async () => ({}));
  app.post('/v1/items/:id', async () => ({}));
  const routes = await registered(app);
  assert.deepEqual(unapproved(routes), ['GET /v1/things', 'POST /v1/items/:id']);
});
