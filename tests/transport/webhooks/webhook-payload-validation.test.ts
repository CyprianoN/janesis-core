import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { z } from 'zod';
import { unauthorized, validationError } from '../../../src/domain/shared/errors/error-factory.js';
import { buildApp } from '../../../src/transport/http/app.js';
import { validateInput } from '../../../src/transport/http/middlewares/validate-request.js';
import { clerkWebhookPayloadSchema } from '../../../src/validators/auth.schema.js';
import { boundedString } from '../../../src/validators/consistency-registry.js';
import { telegramWebhookPayloadSchema } from '../../../src/validators/user.schema.js';
import { thirdwebWebhookPayloadSchema } from '../../../src/validators/wallet.schema.js';
import { SENTINEL } from '../../utils/transport-error-matrix.js';

// WP8-08 / WP8-08A (DEC-008-01, DEC-008-02). Test-only. The verifier, header and content type below
// are neutral stand-ins, not any provider's signature algorithm, header or payload contract.
// External payload validation establishes structural JSON-object validation and validated-data
// boundaries. Provider-specific payload contracts, signature algorithms, event semantics and
// identifier mappings remain unestablished and deferred to their respective implementation phases.

const NON_OBJECTS: [string, unknown][] = [
  ['null', null],
  ['an array', []],
  ['a string', 'text'],
  ['a number', 42],
  ['a boolean', true],
  ['undefined', undefined],
];

const PROVIDER_SCHEMAS = [
  ['Clerk', clerkWebhookPayloadSchema],
  ['Telegram', telegramWebhookPayloadSchema],
  ['Thirdweb', thirdwebWebhookPayloadSchema],
] as const;

// ---- Part 1: the three W-A payload schemas on their own
for (const [provider, schema] of PROVIDER_SCHEMAS) {
  test(
    provider + ' schema accepts a JSON object, keeps unknown fields and returns a different object',
    () => {
      const input = { anything: 1, nested: { list: [1, 2, 3] } };
      const parsed = schema.parse(input);
      assert.deepEqual(parsed, input);
      assert.notEqual(parsed, input);
    },
  );
  for (const [name, value] of NON_OBJECTS) {
    test(provider + ' schema rejects ' + name, () => {
      assert.equal(schema.safeParse(value).success, false);
    });
  }
  test(provider + ' schema: a __proto__ key does not pollute prototypes', () => {
    const parsed = schema.parse(JSON.parse('{"__proto__":{"polluted":true},"a":1}'));
    assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
    assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
    assert.equal((parsed as Record<string, unknown>)['polluted'], undefined);
  });
}

// ---- Part 2: WP8-08A signature-before-validation proof
const TEST_SIGNING_KEY = 'test'.repeat(8);
const SIGNATURE_HEADER = 'x-test-signature';
const CONTENT_TYPE = 'application/test-webhook';
const NEUTRAL_SCHEMA = z.strictObject({ kind: boundedString(16), count: z.number().int() });

const sign = (bytes: Buffer | string): string =>
  createHmac('sha256', TEST_SIGNING_KEY).update(bytes).digest('hex');

const probe = {
  verifiedBytes: [] as Buffer[],
  validationCalls: 0,
  useCaseCalls: [] as unknown[],
};

function verifySignature(raw: Buffer, header: unknown): void {
  probe.verifiedBytes.push(Buffer.from(raw));
  const expected = Buffer.from(sign(raw), 'hex');
  const provided =
    typeof header === 'string' && /^[0-9a-f]{64}$/.test(header)
      ? Buffer.from(header, 'hex')
      : undefined;
  if (provided === undefined || !timingSafeEqual(provided, expected)) throw unauthorized();
}

function parseAndValidate(raw: Buffer, schema: z.ZodType): unknown {
  let json: unknown;
  try {
    json = JSON.parse(raw.toString('utf8'));
  } catch {
    throw validationError();
  }
  probe.validationCalls += 1;
  return validateInput(schema, json);
}

const app = buildApp();
app.addContentTypeParser(CONTENT_TYPE, { parseAs: 'buffer' }, (_request, body, done) => {
  done(null, body);
});

function registerWebhook(instance: FastifyInstance, name: string, schema: z.ZodType): void {
  instance.post('/__test/webhooks/' + name, async (request) => {
    const raw = request.body as Buffer;
    verifySignature(raw, request.headers[SIGNATURE_HEADER]);
    probe.useCaseCalls.push(parseAndValidate(raw, schema));
    return { ok: true };
  });
}
registerWebhook(app, 'neutral', NEUTRAL_SCHEMA);
for (const [provider, schema] of PROVIDER_SCHEMAS)
  registerWebhook(app, provider.toLowerCase(), schema);

// Control: validates before verifying, the wrong order. The same probes must expose it.
app.post('/__test/webhooks/wrong-order', async (request) => {
  const raw = request.body as Buffer;
  const parsed = parseAndValidate(raw, NEUTRAL_SCHEMA);
  verifySignature(raw, request.headers[SIGNATURE_HEADER]);
  probe.useCaseCalls.push(parsed);
  return { ok: true };
});

after(async () => {
  await app.close();
});
beforeEach(() => {
  probe.verifiedBytes.length = 0;
  probe.validationCalls = 0;
  probe.useCaseCalls.length = 0;
});

async function post(route: string, body: Buffer | string, signature?: string) {
  const headers: Record<string, string> = { 'content-type': CONTENT_TYPE };
  if (signature !== undefined) headers[SIGNATURE_HEADER] = signature;
  return app.inject({ method: 'POST', url: '/__test/webhooks/' + route, headers, payload: body });
}

function assertCanonical(
  res: LightMyRequestResponse,
  status: number,
  code: string,
  message: string,
): void {
  assert.equal(res.statusCode, status);
  const body = res.json() as { error: { code: string; message: string } };
  assert.deepEqual(Object.keys(body), ['error']);
  assert.equal(body.error.code, code);
  assert.equal(body.error.message, message);
  assert.ok(!res.body.includes(SENTINEL));
}
const assertUnauthorized = (res: LightMyRequestResponse): void =>
  assertCanonical(res, 401, 'UNAUTHORIZED', 'Authentication is required.');
const assertInvalid = (res: LightMyRequestResponse): void =>
  assertCanonical(res, 400, 'VALIDATION_ERROR', 'The request is invalid.');
function assertNothingRan(): void {
  assert.equal(probe.validationCalls, 0);
  assert.equal(probe.useCaseCalls.length, 0);
}

const VALID_BODY = JSON.stringify({ kind: 'ping', count: 2 });

test('1. missing signature gives 401 UNAUTHORIZED and reaches neither validation nor the use case', async () => {
  assertUnauthorized(await post('neutral', VALID_BODY));
  assertNothingRan();
});

test('2. invalid signature gives 401 UNAUTHORIZED and reaches neither validation nor the use case', async () => {
  assertUnauthorized(await post('neutral', VALID_BODY, sign('some other body')));
  assertNothingRan();
});

for (const [name, header] of [
  ['non-hex', 'zz'],
  ['empty', ''],
] as const) {
  test('3. a malformed signature (' + name + ') gives 401, not a server error', async () => {
    assertUnauthorized(await post('neutral', VALID_BODY, header));
    assertNothingRan();
  });
}

test('4. invalid signature and invalid payload gives 401 and reaches neither validation nor the use case', async () => {
  assertUnauthorized(await post('neutral', '[1]', sign('some other body')));
  assertNothingRan();
});

for (const [name, body] of [
  ['an array', '[1]'],
  ['a wrong-typed field', '{"kind":"ping","count":"x"}'],
  ['an unknown field', '{"kind":"ping","count":1,"extra":true}'],
] as const) {
  test(
    '5. valid signature and invalid payload (' +
      name +
      ') gives 400 VALIDATION_ERROR and no use-case call',
    async () => {
      assertInvalid(await post('neutral', body, sign(body)));
      assert.equal(probe.validationCalls, 1);
      assert.equal(probe.useCaseCalls.length, 0);
    },
  );
}

test('6. valid signature and valid payload reaches the use case as the parsed value', async () => {
  const res = await post('neutral', VALID_BODY, sign(VALID_BODY));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true });
  assert.equal(probe.validationCalls, 1);
  assert.deepEqual(probe.useCaseCalls, [{ kind: 'ping', count: 2 }]);
});

const SPACED_BODY = '{ "kind" :  "p\u00efng",\n  "count": 2 }\n';

test('7. the verifier receives the exact signed bytes, including odd spacing, unicode and a trailing newline', async () => {
  assert.notEqual(JSON.stringify(JSON.parse(SPACED_BODY)), SPACED_BODY);
  const res = await post('neutral', SPACED_BODY, sign(SPACED_BODY));
  assert.equal(res.statusCode, 200);
  assert.equal(probe.verifiedBytes.length, 1);
  assert.ok(probe.verifiedBytes[0]?.equals(Buffer.from(SPACED_BODY, 'utf8')));
  assert.deepEqual(probe.useCaseCalls, [{ kind: 'p\u00efng', count: 2 }]);
});

test('8. a signature over re-serialized JSON does not substitute for the signed bytes', async () => {
  const reserialized = JSON.stringify(JSON.parse(SPACED_BODY));
  assert.notEqual(sign(reserialized), sign(SPACED_BODY));
  assertUnauthorized(await post('neutral', SPACED_BODY, sign(reserialized)));
  assertNothingRan();
});

test('9. valid signature and malformed JSON gives 400 VALIDATION_ERROR (harness choice) and no use-case call', async () => {
  const body = '{"kind": ';
  assertInvalid(await post('neutral', body, sign(body)));
  assert.equal(probe.validationCalls, 0);
  assert.equal(probe.useCaseCalls.length, 0);
});

test('10a. a sentinel in the signature header is never echoed', async () => {
  assertUnauthorized(await post('neutral', JSON.stringify({ kind: SENTINEL, count: 1 }), SENTINEL));
  assertNothingRan();
});

test('10b. a sentinel in an invalid signed payload is never echoed', async () => {
  const body = JSON.stringify({ kind: SENTINEL, password: SENTINEL, count: 'x' });
  const res = await post('neutral', body, sign(body));
  assertInvalid(res);
  assert.ok(!res.body.includes('password'));
  assert.equal(probe.useCaseCalls.length, 0);
});

for (const [provider] of PROVIDER_SCHEMAS) {
  const route = provider.toLowerCase();
  test(
    '11. ' +
      provider +
      ' route: a signed JSON object passes validation and reaches the use case parsed',
    async () => {
      const body = JSON.stringify({ anything: 1, nested: { list: [1, 2] } });
      const res = await post(route, body, sign(body));
      assert.equal(res.statusCode, 200);
      assert.equal(probe.validationCalls, 1);
      assert.deepEqual(probe.useCaseCalls, [{ anything: 1, nested: { list: [1, 2] } }]);
    },
  );
  test(
    '11. ' +
      provider +
      ' route: a signed non-object gives 400 VALIDATION_ERROR and no use-case call',
    async () => {
      assertInvalid(await post(route, '[1]', sign('[1]')));
      assert.equal(probe.validationCalls, 1);
      assert.equal(probe.useCaseCalls.length, 0);
    },
  );
}

test('12. control: a route that validates before verifying is exposed by the same probes', async () => {
  const res = await post('wrong-order', '[1]', sign('some other body'));
  assert.equal(res.statusCode, 400);
  assert.equal(probe.validationCalls, 1);
});
