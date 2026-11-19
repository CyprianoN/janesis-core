import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import config from '../../drizzle.config.js';

const settings = config as Record<string, unknown>;

test('the configuration targets PostgreSQL, the schema folder and the migrations folder', () => {
  assert.equal(settings['dialect'], 'postgresql');
  assert.equal(settings['schema'], './src/infrastructure/adapters/database/schema/*.ts');
  assert.equal(settings['out'], './src/infrastructure/adapters/database/migrations');
});

test('the committed configuration holds no credential and reads no environment', () => {
  const text = JSON.stringify(settings);
  assert.ok(!('dbCredentials' in settings));
  assert.ok(!text.includes('postgres://') && !text.includes('postgresql://'));
  assert.ok(!readFileSync('drizzle.config.ts', 'utf8').includes('process.env'));
});
