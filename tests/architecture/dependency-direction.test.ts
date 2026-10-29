import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ESLint } from 'eslint';

const RULE = '@typescript-eslint/no-restricted-imports';
const eslint = new ESLint({ overrideConfigFile: 'eslint.config.mjs' });

async function violations(filePath: string, code: string) {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).filter((m) => m.ruleId === RULE && m.severity === 2);
}

const D = 'src/domain/rewards/x.ts';
const A = 'src/application/rewards/x.usecase.ts';
const T = 'src/transport/http/routes/v1/x.ts';
const P = 'src/infrastructure/ports/x.port.ts';
const AD = 'src/infrastructure/adapters/database/x.ts';
const V = 'src/validators/x.schema.ts';

const MUST_FAIL: Array<[string, string, string]> = [
  ['domain -> drizzle', D, "import { sql } from 'drizzle-orm';"],
  ['domain -> zod', D, "import { z } from 'zod';"],
  ['domain -> adapter', D, "import { db } from '../../infrastructure/adapters/database/client';"],
  [
    'application -> adapter',
    A,
    "import { redis } from '../../infrastructure/adapters/cache/redis';",
  ],
  [
    'transport -> adapter',
    T,
    "import { db } from '../../../../infrastructure/adapters/database/client';",
  ],
  [
    'transport -> domain logic',
    T,
    "import { calculateJrs } from '../../../../domain/scoring/calculate-jrs';",
  ],
  ['port -> adapter', P, "import { redis } from '../adapters/cache/redis';"],
  ['adapter -> application', AD, "import { run } from '../../../application/shared/transaction';"],
  [
    'adapter value import from domain',
    AD,
    "import { calculateIntegrity } from '../../../domain/integrity/calculate-integrity';",
  ],
  [
    'validators -> domain (even type-only)',
    V,
    "import type { RewardPool } from '../domain/rewards/reward-pool';",
  ],
];

const MUST_PASS: Array<[string, string, string]> = [
  [
    'application -> port',
    A,
    "import type { UserRepository } from '../../infrastructure/ports/user-repository.port';",
  ],
  [
    'application -> domain',
    A,
    "import { deriveTrustTier } from '../../domain/scoring/derive-trust-tier';",
  ],
  [
    'transport -> application',
    T,
    "import { claim } from '../../../../application/rewards/claim-reward.usecase';",
  ],
  [
    'transport -> domain errors (E1)',
    T,
    "import { AppError } from '../../../../domain/shared/errors/app-error';",
  ],
  ['adapter -> port', AD, "import type { Port } from '../../ports/user-repository.port';"],
  [
    'adapter type-only from domain',
    AD,
    "import type { RewardPool } from '../../../domain/rewards/reward-pool';",
  ],
  [
    'bootstrap -> adapter (E2)',
    'src/bootstrap/container-entry.ts',
    "import { db } from '../infrastructure/adapters/database/client';",
  ],
];

test('boundary tests run in enforcement mode, not report-only', () => {
  assert.notEqual(process.env['BOUNDARY_REPORT_ONLY'], '1');
});

for (const [label, file, code] of MUST_FAIL) {
  test(`rejects: ${label}`, async () => {
    assert.ok(
      (await violations(file, code)).length > 0,
      `expected a boundary violation for: ${code}`,
    );
  });
}

for (const [label, file, code] of MUST_PASS) {
  test(`accepts: ${label}`, async () => {
    assert.deepEqual(await violations(file, code), []);
  });
}

test('no boundary violations exist in the actual src tree', async () => {
  const results = await eslint.lintFiles(['src/**/*.ts']);
  const found = results.flatMap((result) =>
    result.messages
      .filter((m) => m.ruleId === RULE && m.severity === 2)
      .map((m) => `${result.filePath}:${m.line} ${m.message}`),
  );
  assert.deepEqual(found, []);
});
