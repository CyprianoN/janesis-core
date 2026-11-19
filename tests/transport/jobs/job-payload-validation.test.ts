import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { z } from 'zod';
import { buildApp } from '../../../src/transport/http/app.js';
import { validateInput } from '../../../src/transport/http/middlewares/validate-request.js';
import { badgeIssuanceJobPayloadSchema } from '../../../src/validators/badge.schema.js';
import { fraudScoringJobPayloadSchema } from '../../../src/validators/fraud.schema.js';
import { referralProcessingJobPayloadSchema } from '../../../src/validators/referral.schema.js';
import { rewardProcessingJobPayloadSchema } from '../../../src/validators/reward.schema.js';
import { trustScoreUpdatesJobPayloadSchema } from '../../../src/validators/scoring.schema.js';
import { genesisOnboardingJobPayloadSchema } from '../../../src/validators/user.schema.js';
import { questVerificationJobPayloadSchema } from '../../../src/validators/verification.schema.js';
import { SENTINEL } from '../../utils/transport-error-matrix.js';

// WP8-09 (DEC-009-01, J-A): job payload validation through a test-only harness. Job payload
// validation establishes structural JSON-object validation and validated-data boundaries only.
// Job-specific payload contracts and delivery semantics are not established here and remain
// deferred to the phases that implement each job. No real job route, queue provider or redelivery
// behavior is exercised or asserted.

interface JobFamily {
  family: string;
  schema: z.ZodType;
  file: string;
}

const FAMILIES: readonly JobFamily[] = [
  {
    family: 'genesis-onboarding',
    schema: genesisOnboardingJobPayloadSchema,
    file: 'user.schema.ts',
  },
  {
    family: 'quest-verification',
    schema: questVerificationJobPayloadSchema,
    file: 'verification.schema.ts',
  },
  { family: 'fraud-scoring', schema: fraudScoringJobPayloadSchema, file: 'fraud.schema.ts' },
  {
    family: 'reward-processing',
    schema: rewardProcessingJobPayloadSchema,
    file: 'reward.schema.ts',
  },
  { family: 'badge-issuance', schema: badgeIssuanceJobPayloadSchema, file: 'badge.schema.ts' },
  {
    family: 'trust-score-updates',
    schema: trustScoreUpdatesJobPayloadSchema,
    file: 'scoring.schema.ts',
  },
  {
    family: 'referral-processing',
    schema: referralProcessingJobPayloadSchema,
    file: 'referral.schema.ts',
  },
];

const received: { family: string; parsed: unknown; raw: unknown }[] = [];

const app = buildApp();
for (const { family, schema } of FAMILIES) {
  app.post('/__test/jobs/' + family, async (request) => {
    const parsed = validateInput(schema, request.body);
    received.push({ family, parsed, raw: request.body });
    return { ok: true };
  });
  app.post('/__test/jobs/' + family + '/explode', async (request) => {
    validateInput(schema, request.body);
    throw new Error('leak ' + SENTINEL);
  });
}
after(async () => {
  await app.close();
});
beforeEach(() => {
  received.length = 0;
});

function post(url: string, payload: string, headers: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', ...headers },
    payload,
  });
}

const VALID_PAYLOAD = JSON.stringify({ anything: 1, nested: { list: [1, 2] } });
const VALID_PARSED = { anything: 1, nested: { list: [1, 2] } };

const INVALID: [string, string][] = [
  ['null', 'null'],
  ['an array', '[]'],
  ['a string', JSON.stringify(SENTINEL)],
  ['a number', '42'],
  ['a boolean', 'true'],
  ['an empty body', ''],
];

for (const { family } of FAMILIES) {
  test(
    family + ': a JSON object with unknown fields gets 200 and reaches the use case parsed',
    async () => {
      const res = await post('/__test/jobs/' + family, VALID_PAYLOAD);
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json(), { ok: true });
      assert.equal(received.length, 1);
      assert.deepEqual(received[0]?.parsed, VALID_PARSED);
      assert.notEqual(received[0]?.parsed, received[0]?.raw);
    },
  );

  for (const [name, payload] of INVALID) {
    test(
      family + ': ' + name + ' gives 400 VALIDATION_ERROR and never reaches the use case',
      async () => {
        const res = await post('/__test/jobs/' + family, payload);
        assert.equal(res.statusCode, 400);
        const body = res.json() as { error: { code: string; message: string } };
        assert.deepEqual(Object.keys(body), ['error']);
        assert.equal(body.error.code, 'VALIDATION_ERROR');
        assert.equal(body.error.message, 'The request is invalid.');
        assert.equal(received.length, 0);
        assert.ok(!res.body.includes(SENTINEL));
      },
    );
  }
}

test('the seven job payload schemas are distinct objects, one per owning feature file', () => {
  assert.equal(FAMILIES.length, 7);
  assert.equal(new Set(FAMILIES.map((entry) => entry.schema)).size, 7);
});

test('the seven job payload schema files contain no queue-provider text', () => {
  const dir = join(import.meta.dirname, '..', '..', '..', 'src', 'validators');
  const files = [...new Set(FAMILIES.map((entry) => entry.file))];
  assert.equal(files.length, 7);
  for (const file of files) {
    assert.doesNotMatch(readFileSync(join(dir, file), 'utf8'), /qstash|upstash/i, file);
  }
});

test('delivery-style headers never become part of the validated payload', async () => {
  for (const { family } of FAMILIES) {
    received.length = 0;
    const res = await post('/__test/jobs/' + family, '{"a":1}', {
      'x-test-delivery-id': 'abc',
      'x-test-attempt': '3',
    });
    assert.equal(res.statusCode, 200, family);
    assert.deepEqual(received[0]?.parsed, { a: 1 }, family);
  }
});

test('an invalid payload is below 500 and an unexpected use-case failure is a generic 500', async () => {
  for (const { family } of FAMILIES) {
    const invalid = await post('/__test/jobs/' + family + '/explode', '[]');
    assert.equal(invalid.statusCode, 400, family);
    const failed = await post('/__test/jobs/' + family + '/explode', '{"a":1}');
    assert.equal(failed.statusCode, 500, family);
    assert.deepEqual(
      failed.json(),
      { error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' } },
      family,
    );
    assert.ok(!failed.body.includes(SENTINEL), family);
  }
});
