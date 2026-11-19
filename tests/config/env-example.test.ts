import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CORE_VARIABLES, PROVIDER_VARIABLES, loadConfig } from '../../src/config/env.js';

const text = readFileSync(join(import.meta.dirname, '..', '..', '.env.example'), 'utf8');

const active = new Map<string, string>();
const commented = new Map<string, string>();
for (const line of text.split(/\r?\n/)) {
  const activeMatch = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
  if (activeMatch?.[1] !== undefined) active.set(activeMatch[1], activeMatch[2] ?? '');
  const commentedMatch = /^#\s*([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
  if (commentedMatch?.[1] !== undefined) commented.set(commentedMatch[1], commentedMatch[2] ?? '');
}

const documented = new Set([...active.keys(), ...commented.keys()]);
const providerVariables = Object.values(PROVIDER_VARIABLES).flat() as string[];
const expected = new Set<string>([...CORE_VARIABLES, ...providerVariables]);

test('every variable the configuration reads appears in .env.example', () => {
  assert.deepEqual([...expected].filter((name) => !documented.has(name)).sort(), []);
});

test('every variable in .env.example is read by the configuration', () => {
  assert.deepEqual([...documented].filter((name) => !expected.has(name)).sort(), []);
});

test('core variables are active and provider variables are only commented-out placeholders', () => {
  assert.deepEqual([...active.keys()].sort(), [...CORE_VARIABLES].sort());
  for (const name of providerVariables) {
    assert.ok(commented.has(name), `${name} should be present as a commented-out placeholder`);
  }
});

test('placeholders cannot be mistaken for real credentials', () => {
  for (const [name, value] of commented) {
    assert.match(value, /^<[a-z0-9-]+>$/, `${name} must use a <placeholder> value`);
  }
});

test('the example defaults to the development environment, never production', () => {
  assert.equal(active.get('APP_ENV'), 'development');
});

test('copying .env.example to .env loads as valid configuration with no provider configured', () => {
  const config = loadConfig(Object.fromEntries(active));
  assert.deepEqual(config.providers, {});
});
