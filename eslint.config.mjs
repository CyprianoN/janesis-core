import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// Boundary rules encode the TSDS 7.2 dependency matrix (IADP Phase 4) and the Phase 5 config rules.
// BOUNDARY_REPORT_ONLY=1 downgrades them to warnings for a first look at existing violations.
// The architecture tests always run in enforcement mode.
const SEVERITY = process.env.BOUNDARY_REPORT_ONLY === '1' ? 'warn' : 'error';
const PROVIDERS = [
  'fastify',
  'fastify-*',
  '@fastify/*',
  '@clerk/*',
  'drizzle-orm',
  'drizzle-orm/*',
  'pg',
  '@neondatabase/*',
  '@upstash/*',
  'thirdweb',
  'thirdweb/*',
  '@google-cloud/*',
  '@sentry/*',
  'posthog-node',
];
const pattern = (group, message, extra = {}) => ({ group, message, ...extra });
const noConfig = {
  regex: '(^|/)config(/|$)',
  message:
    'config/ may be imported only by bootstrap/ and transport/. Adapters receive configuration from the composition root (Phase 5, Decision 3).',
};
const layer = (name, files, patterns) => ({
  name: `boundaries/${name}`,
  files,
  rules: { '@typescript-eslint/no-restricted-imports': [SEVERITY, { patterns }] },
});

const PROCESS_ENV_MESSAGE =
  'Read process.env only in src/config/env.ts and pass configuration by argument (Phase 5, Decision 3).';

export default [
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },
  js.configs.recommended,
  {
    files: ['**/*.mjs'],
    languageOptions: { globals: { process: 'readonly' } },
  },
  ...tseslint.configs.recommended,
  layer(
    'domain',
    ['src/domain/**/*.ts'],
    [
      pattern(
        ['**/transport/**', '**/application/**', '**/infrastructure/**', '**/bootstrap/**'],
        'Domain imports domain-owned code only (TSDS 7.2).',
      ),
      pattern(
        [...PROVIDERS, 'zod'],
        'No provider, framework or Zod imports in domain (IADP 4.7, D6).',
      ),
      noConfig,
    ],
  ),
  layer(
    'application',
    ['src/application/**/*.ts'],
    [
      pattern(
        ['**/transport/**', '**/bootstrap/**', '**/adapters/**'],
        'Application depends on domain and ports only (TSDS 7.2).',
      ),
      pattern(PROVIDERS, 'Provider SDKs stay behind ports (Architecture 31.1).'),
      noConfig,
    ],
  ),
  layer(
    'transport',
    ['src/transport/**/*.ts'],
    [
      pattern(
        ['**/adapters/**', '**/bootstrap/**'],
        'Transport must not import adapters (TSDS 7.2).',
      ),
      {
        regex: '(^|/)domain/(?!shared/errors/)',
        message:
          'No domain logic in transport; error types excepted (proposed E1, pending confirmation).',
      },
    ],
  ),
  layer(
    'ports',
    ['src/infrastructure/ports/**/*.ts'],
    [
      pattern(
        ['**/adapters/**', '**/application/**', '**/transport/**'],
        'Ports are provider-neutral contracts.',
      ),
      pattern(PROVIDERS, 'No provider SDKs in ports.'),
      noConfig,
    ],
  ),
  layer(
    'adapters',
    ['src/infrastructure/adapters/**/*.ts'],
    [
      pattern(
        ['**/application/**', '**/transport/**', '**/bootstrap/**'],
        'Adapters must not depend on orchestration.',
      ),
      pattern(['**/domain/**'], 'Adapters may import domain types, never domain logic.', {
        allowTypeImports: true,
      }),
      noConfig,
    ],
  ),
  layer(
    'validators',
    ['src/validators/**/*.ts'],
    [
      pattern(
        ['**/domain/**', '**/application/**', '**/infrastructure/**', '**/transport/**'],
        'Validators are independent of domain (IADP Phase 8).',
      ),
      noConfig,
    ],
  ),
  {
    name: 'config/process-env-only-in-env-ts',
    files: ['src/**/*.ts'],
    ignores: ['src/config/env.ts'],
    rules: {
      'no-restricted-syntax': [
        SEVERITY,
        {
          selector: "MemberExpression[object.name='process'][property.name='env']",
          message: PROCESS_ENV_MESSAGE,
        },
        {
          selector: "MemberExpression[object.name='process'][property.value='env']",
          message: PROCESS_ENV_MESSAGE,
        },
        {
          selector: "MemberExpression[object.property.name='process'][property.name='env']",
          message: PROCESS_ENV_MESSAGE,
        },
        {
          selector:
            "VariableDeclarator[init.name='process'] > ObjectPattern > Property[key.name='env']",
          message: PROCESS_ENV_MESSAGE,
        },
        {
          selector: 'ImportDeclaration[source.value=/^(node:)?process$/]',
          message: 'Do not import node:process; ' + PROCESS_ENV_MESSAGE,
        },
      ],
    },
  },
  // src/bootstrap/** is the composition root and may import config/ and adapters (proposed E2, pending confirmation).
];
