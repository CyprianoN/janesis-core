import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ConfigError,
  PROVIDER_REQUIREMENTS,
  PROVIDER_VARIABLES,
  loadConfig,
  type RequirementPolicy,
} from '../../src/config/env.js';

const SENTINEL = 'sentinel-secret-value-7f3a91';
const ENVIRONMENTS = ['development', 'staging', 'production'] as const;
// Mechanics tests exercise one provider at a time, so the database requirement (Phase 7) is switched off here.
const OPTIONAL: RequirementPolicy = { ...PROVIDER_REQUIREMENTS, database: false };

function failure(env: Record<string, string | undefined>, policy?: RequirementPolicy): ConfigError {
  try {
    loadConfig(env, policy);
  } catch (error) {
    assert.ok(error instanceof ConfigError, 'expected a ConfigError');
    return error;
  }
  return assert.fail('expected loadConfig to throw');
}

const variables = (error: ConfigError): string[] =>
  error.issues.map((issue) => issue.variable).sort();

test('defines the approved provider groups and their variables', () => {
  assert.deepEqual(PROVIDER_VARIABLES, {
    clerk: ['CLERK_SECRET_KEY', 'CLERK_WEBHOOK_SECRET'],
    database: ['DATABASE_URL'],
    redis: ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'],
    qstash: ['QSTASH_TOKEN', 'QSTASH_CURRENT_SIGNING_KEY', 'QSTASH_NEXT_SIGNING_KEY'],
    r2: ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'],
    thirdweb: ['THIRDWEB_SECRET_KEY', 'THIRDWEB_WEBHOOK_SECRET'],
    alchemy: ['ALCHEMY_API_KEY'],
    sentry: ['SENTRY_DSN'],
    posthog: ['POSTHOG_API_KEY', 'POSTHOG_HOST'],
    turnstile: ['TURNSTILE_SECRET_KEY'],
    x: ['X_BEARER_TOKEN'],
    telegram: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET'],
  });
});

test('the current policy requires only the database; each consuming phase flips its own flag', () => {
  const required = Object.entries(PROVIDER_REQUIREMENTS)
    .filter(([, isRequired]) => isRequired)
    .map(([name]) => name);
  assert.deepEqual(required, ['database']);
});

test('loads with no provider configured under an all-optional policy', () => {
  for (const appEnv of ENVIRONMENTS) {
    assert.deepEqual(loadConfig({ APP_ENV: appEnv }, OPTIONAL).providers, {}, appEnv);
  }
});

test('exposes a complete single-variable group as typed values', () => {
  const config = loadConfig({
    APP_ENV: 'development',
    SENTRY_DSN: 'https://public@example.invalid/1',
  });
  assert.deepEqual(config.providers, { sentry: { dsn: 'https://public@example.invalid/1' } });
});

test('exposes a complete multi-variable group as typed values', () => {
  const config = loadConfig({
    APP_ENV: 'development',
    CLERK_SECRET_KEY: 'placeholder-clerk-secret',
    CLERK_WEBHOOK_SECRET: 'placeholder-clerk-webhook',
  });
  assert.deepEqual(config.providers, {
    clerk: { secretKey: 'placeholder-clerk-secret', webhookSecret: 'placeholder-clerk-webhook' },
  });
});

test('a partially set group is invalid in every environment and names the missing variable', () => {
  for (const appEnv of ENVIRONMENTS) {
    const error = failure(
      { APP_ENV: appEnv, CLERK_SECRET_KEY: 'placeholder-clerk-secret' },
      OPTIONAL,
    );
    assert.deepEqual(variables(error), ['CLERK_WEBHOOK_SECRET'], appEnv);
    assert.match(error.message, /required/);
  }
});

test('URL variables must be well-formed with an allowed protocol', () => {
  const bad = ['not a url', 'http://example.invalid/db', '', ' postgres://example.invalid/db'];
  for (const value of bad) {
    assert.deepEqual(
      variables(failure({ APP_ENV: 'development', DATABASE_URL: value })),
      ['DATABASE_URL'],
      JSON.stringify(value),
    );
  }
  for (const value of [
    'postgres://user:placeholder@example.invalid/db',
    'postgresql://example.invalid/db',
  ]) {
    assert.ok(loadConfig({ APP_ENV: 'development', DATABASE_URL: value }).providers.database);
  }
  assert.deepEqual(
    variables(
      failure({
        APP_ENV: 'development',
        UPSTASH_REDIS_REST_URL: 'http://example.invalid',
        UPSTASH_REDIS_REST_TOKEN: 'placeholder-token',
      }),
    ),
    ['UPSTASH_REDIS_REST_URL'],
  );
  assert.deepEqual(
    variables(failure({ APP_ENV: 'development', SENTRY_DSN: 'ftp://example.invalid/1' })),
    ['SENTRY_DSN'],
  );
});

test('secret variables must be non-empty without surrounding whitespace', () => {
  for (const value of ['', ' placeholder', 'placeholder ']) {
    assert.deepEqual(
      variables(failure({ APP_ENV: 'development', ALCHEMY_API_KEY: value })),
      ['ALCHEMY_API_KEY'],
      JSON.stringify(value),
    );
  }
});

test('a provider the policy requires must be complete in staging and production only', () => {
  const policy: RequirementPolicy = { ...OPTIONAL, clerk: true };
  assert.deepEqual(loadConfig({ APP_ENV: 'development' }, policy).providers, {});
  for (const appEnv of ['staging', 'production'] as const) {
    assert.deepEqual(
      variables(failure({ APP_ENV: appEnv }, policy)),
      ['CLERK_SECRET_KEY', 'CLERK_WEBHOOK_SECRET'],
      appEnv,
    );
    const config = loadConfig(
      {
        APP_ENV: appEnv,
        CLERK_SECRET_KEY: 'placeholder-clerk-secret',
        CLERK_WEBHOOK_SECRET: 'placeholder-clerk-webhook',
      },
      policy,
    );
    assert.ok(config.providers.clerk, appEnv);
  }
});

test('a required provider does not make other providers required', () => {
  const policy: RequirementPolicy = { ...OPTIONAL, sentry: true };
  const config = loadConfig(
    { APP_ENV: 'production', SENTRY_DSN: 'https://public@example.invalid/1' },
    policy,
  );
  assert.deepEqual(Object.keys(config.providers), ['sentry']);
});

test('provider errors never disclose supplied values', () => {
  const cases: Array<Record<string, string>> = [
    { CLERK_SECRET_KEY: SENTINEL },
    { DATABASE_URL: `postgres://user:${SENTINEL}@` },
    { ALCHEMY_API_KEY: ` ${SENTINEL}` },
    { SENTRY_DSN: SENTINEL },
  ];
  for (const extra of cases) {
    const error = failure({ APP_ENV: 'development', ...extra });
    const visible = [error.message, JSON.stringify(error.issues), String(error)].join(' ');
    assert.ok(
      !visible.includes(SENTINEL),
      `a supplied value appeared for ${Object.keys(extra)[0]}`,
    );
  }
});

test('X and Telegram groups load as typed values when complete', () => {
  const config = loadConfig({
    APP_ENV: 'development',
    X_BEARER_TOKEN: 'placeholder-x-token',
    TELEGRAM_BOT_TOKEN: 'placeholder-telegram-token',
    TELEGRAM_WEBHOOK_SECRET: 'placeholder-telegram-webhook',
  });
  assert.deepEqual(config.providers, {
    x: { bearerToken: 'placeholder-x-token' },
    telegram: {
      botToken: 'placeholder-telegram-token',
      webhookSecret: 'placeholder-telegram-webhook',
    },
  });
});

test('a partial Telegram group is invalid in every environment', () => {
  for (const appEnv of ENVIRONMENTS) {
    const error = failure(
      { APP_ENV: appEnv, TELEGRAM_BOT_TOKEN: 'placeholder-telegram-token' },
      OPTIONAL,
    );
    assert.deepEqual(variables(error), ['TELEGRAM_WEBHOOK_SECRET'], appEnv);
  }
});

test('X and Telegram secrets must be non-empty without surrounding whitespace', () => {
  for (const value of ['', ' placeholder', 'placeholder ']) {
    assert.deepEqual(
      variables(failure({ APP_ENV: 'development', X_BEARER_TOKEN: value })),
      ['X_BEARER_TOKEN'],
      JSON.stringify(value),
    );
  }
  const error = failure({
    APP_ENV: 'development',
    TELEGRAM_BOT_TOKEN: ' placeholder',
    TELEGRAM_WEBHOOK_SECRET: 'placeholder-telegram-webhook',
  });
  assert.deepEqual(variables(error), ['TELEGRAM_BOT_TOKEN']);
});

test('the X requirement can be activated without affecting Telegram', () => {
  const policy: RequirementPolicy = { ...OPTIONAL, x: true };
  assert.deepEqual(variables(failure({ APP_ENV: 'staging' }, policy)), ['X_BEARER_TOKEN']);
  assert.deepEqual(loadConfig({ APP_ENV: 'development' }, policy).providers, {});
});
