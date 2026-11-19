import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');
const pkg = JSON.parse(read('package.json')) as { engines?: { node?: string } };
const pinned = pkg.engines?.node ?? '';

test('package.json pins one exact Node version', () => {
  assert.match(pinned, /^\d+\.\d+\.\d+$/);
});

test('the running Node version matches the pinned version', () => {
  assert.equal(process.versions.node, pinned);
});

test('the Dockerfile uses the pinned Node version for every stage', () => {
  const dockerfile = read('Dockerfile');
  const escaped = pinned.replaceAll('.', '\\.');
  assert.match(dockerfile, new RegExp(`^ARG NODE_VERSION=${escaped}\\s*$`, 'm'));
  const fromLines = dockerfile.match(/^FROM .+$/gm) ?? [];
  assert.ok(fromLines.length > 0);
  for (const line of fromLines) {
    assert.ok(line.includes('node:${NODE_VERSION}-'), `stage does not use NODE_VERSION: ${line}`);
  }
});

test('CI reads the Node version from package.json', () => {
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /node-version-file:\s*package\.json/);
  assert.doesNotMatch(ci, /^\s*node-version:/m);
});
