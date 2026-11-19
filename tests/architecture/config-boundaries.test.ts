import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ESLint } from 'eslint';

const eslint = new ESLint({ overrideConfigFile: 'eslint.config.mjs' });
const RESTRICTION_RULES = new Set([
  '@typescript-eslint/no-restricted-imports',
  'no-restricted-syntax',
]);

async function violations(filePath: string, code: string) {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).filter(
    (m) => m.severity === 2 && RESTRICTION_RULES.has(m.ruleId ?? ''),
  );
}

const D = 'src/domain/rewards/x.ts';
const A = 'src/application/rewards/x.usecase.ts';
const P = 'src/infrastructure/ports/x.port.ts';
const AD = 'src/infrastructure/adapters/database/x.ts';
const V = 'src/validators/x.schema.ts';
const T = 'src/transport/http/routes/v1/x.ts';
const B = 'src/bootstrap/x.ts';
const CFG = 'src/config/env.ts';

const MUST_FAIL: Array<[string, string, string]> = [
  ['domain -> config', D, "import { loadConfig } from '../../config/env';"],
  ['application -> config', A, "import { loadConfig } from '../../config/env';"],
  ['port -> config', P, "import { loadConfig } from '../../config/env';"],
  ['adapter -> config', AD, "import { loadConfig } from '../../../config/env';"],
  ['validators -> config', V, "import { loadConfig } from '../config/env';"],
  ['process.env member access outside config/env.ts', A, "export const value = process.env['A'];"],
  ['process.env dot access outside config/env.ts', A, 'export const value = process.env.A;'],
  ['process["env"] computed access', A, "export const value = process['env'];"],
  ['destructured env from process', A, 'const { env } = process;\nexport const value = env;'],
  [
    'env imported from node:process',
    A,
    "import { env } from 'node:process';\nexport const value = env;",
  ],
];

const MUST_PASS: Array<[string, string, string]> = [
  ['transport -> config', T, "import { loadConfig } from '../../../../config/env';"],
  ['bootstrap -> config', B, "import { loadConfig } from '../config/env';"],
  ['config/env.ts reads process.env', CFG, 'export const raw = process.env;'],
  ['process.exit is not restricted', B, 'process.exit(1);'],
  ['process.on is not restricted', B, "process.on('SIGTERM', () => undefined);"],
];

for (const [label, file, code] of MUST_FAIL) {
  test(`rejects: ${label}`, async () => {
    assert.ok((await violations(file, code)).length > 0, `expected a violation for: ${code}`);
  });
}

for (const [label, file, code] of MUST_PASS) {
  test(`accepts: ${label}`, async () => {
    assert.deepEqual(await violations(file, code), []);
  });
}

test('the actual src tree has no config-boundary or process.env violations', async () => {
  const results = await eslint.lintFiles(['src/**/*.ts']);
  const found = results.flatMap((result) =>
    result.messages
      .filter((m) => m.severity === 2 && RESTRICTION_RULES.has(m.ruleId ?? ''))
      .map((m) => `${result.filePath}:${m.line} ${m.message}`),
  );
  assert.deepEqual(found, []);
});
