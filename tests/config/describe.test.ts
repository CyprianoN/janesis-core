import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDER_VARIABLES, describeConfig, loadConfig } from '../../src/config/env.js';

const SENTINEL = 'sentinel-secret-value-7f3a91';
const PROVIDER_NAMES = Object.keys(PROVIDER_VARIABLES);

const everyProvider: Record<string, string> = {
  CLERK_SECRET_KEY: SENTINEL,
  CLERK_WEBHOOK_SECRET: `${SENTINEL}-2`,
  DATABASE_URL: `postgres://user:${SENTINEL}@db.${SENTINEL}.example.invalid/app`,
  UPSTASH_REDIS_REST_URL: `https://${SENTINEL}.example.invalid`,
  UPSTASH_REDIS_REST_TOKEN: `${SENTINEL}-3`,
  QSTASH_TOKEN: `${SENTINEL}-4`,
  QSTASH_CURRENT_SIGNING_KEY: `${SENTINEL}-5`,
  QSTASH_NEXT_SIGNING_KEY: `${SENTINEL}-6`,
  R2_ACCOUNT_ID: `${SENTINEL}-7`,
  R2_ACCESS_KEY_ID: `${SENTINEL}-8`,
  R2_SECRET_ACCESS_KEY: `${SENTINEL}-9`,
  R2_BUCKET: `${SENTINEL}-10`,
  THIRDWEB_SECRET_KEY: `${SENTINEL}-11`,
  THIRDWEB_WEBHOOK_SECRET: `${SENTINEL}-12`,
  ALCHEMY_API_KEY: `${SENTINEL}-13`,
  SENTRY_DSN: `https://${SENTINEL}@example.invalid/1`,
  POSTHOG_API_KEY: `${SENTINEL}-14`,
  POSTHOG_HOST: `https://${SENTINEL}.example.invalid`,
  TURNSTILE_SECRET_KEY: `${SENTINEL}-15`,
  X_BEARER_TOKEN: `${SENTINEL}-16`,
  TELEGRAM_BOT_TOKEN: `${SENTINEL}-17`,
  TELEGRAM_WEBHOOK_SECRET: `${SENTINEL}-18`,
};

test('summarizes the non-secret core settings', () => {
  const summary = describeConfig(
    loadConfig({
      APP_ENV: 'staging',
      PORT: '3000',
      SHUTDOWN_TIMEOUT_MS: '5000',
      DATABASE_URL: 'postgres://user:placeholder@example.invalid/db',
    }),
  );
  assert.equal(summary.appEnv, 'staging');
  assert.equal(summary.port, 3000);
  assert.equal(summary.shutdownTimeoutMs, 5000);
});

test('lists every provider and marks unconfigured ones', () => {
  const summary = describeConfig(loadConfig({ APP_ENV: 'development' }));
  assert.deepEqual(Object.keys(summary.providers), PROVIDER_NAMES);
  assert.ok(Object.values(summary.providers).every((status) => status === 'not configured'));
});

test('marks configured providers without exposing any value', () => {
  const summary = describeConfig(loadConfig({ APP_ENV: 'development', ...everyProvider }));
  assert.ok(Object.values(summary.providers).every((status) => status === 'configured'));
  const text = JSON.stringify(summary);
  assert.ok(!text.includes(SENTINEL), 'a supplied secret appeared in the summary');
  assert.ok(!text.includes('example.invalid'), 'a supplied URL part appeared in the summary');
});

test('marks only complete groups as configured', () => {
  const summary = describeConfig(
    loadConfig({ APP_ENV: 'development', SENTRY_DSN: 'https://public@example.invalid/1' }),
  );
  assert.equal(summary.providers['sentry'], 'configured');
  assert.equal(summary.providers['clerk'], 'not configured');
});

test('the summary is plain JSON, safe to log', () => {
  const summary = describeConfig(loadConfig({ APP_ENV: 'development', ...everyProvider }));
  assert.deepEqual(JSON.parse(JSON.stringify(summary)), summary);
});
