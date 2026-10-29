import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage']);
// Approved additions outside the locked tree: the dependency lockfile and the CI workflow (A7, JANESIS-TM-001).
const APPROVED_EXTRAS = new Set(['package-lock.json', '.github/workflows/ci.yml']);

const entries = readFileSync(join(import.meta.dirname, 'locked-tree.manifest.txt'), 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '' && !line.startsWith('#'));
const dirs = entries.filter((e) => e.endsWith('/'));
const files = entries.filter((e) => !e.endsWith('/'));

function walk(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const rel = prefix === '' ? d.name : `${prefix}/${d.name}`;
    if (d.isDirectory()) {
      return IGNORED_DIRS.has(d.name) ? [] : walk(join(dir, d.name), rel);
    }
    return [rel];
  });
}

test('manifest has no duplicate entries', () => {
  assert.equal(new Set(entries).size, entries.length);
});

test('every locked-tree file exists', () => {
  const missing = files.filter((f) => !existsSync(join(ROOT, f)));
  assert.deepEqual(missing, []);
});

test('every locked-tree directory exists', () => {
  const missing = dirs.filter((d) => !existsSync(join(ROOT, d)));
  assert.deepEqual(missing, []);
});

test('no files exist outside the locked tree (tests/ and approved extras excepted)', () => {
  const allowed = new Set(files);
  const unexpected = walk(ROOT).filter(
    (f) =>
      !allowed.has(f) &&
      !APPROVED_EXTRAS.has(f) &&
      !f.endsWith('.gitkeep') &&
      !f.startsWith('tests/'),
  );
  assert.deepEqual(unexpected, []);
});

test('events: exactly 12 canonical event contracts plus the shared envelope (IADP Phase 15)', () => {
  const eventFiles = walk(join(ROOT, 'src/events')).filter((f) => f !== '.gitkeep');
  const contracts = eventFiles.filter((f) => f.endsWith('-event.ts'));
  assert.equal(contracts.length, 12);
  assert.ok(eventFiles.includes('contracts/event-envelope.ts'));
  assert.equal(eventFiles.length, 13);
});

test('jobs: exactly 7 approved job transport families', () => {
  const families = readdirSync(join(ROOT, 'src/transport/jobs'), { withFileTypes: true }).filter(
    (d) => d.isDirectory(),
  );
  assert.equal(families.length, 7);
});

test('webhooks: exactly 3 provider webhook families', () => {
  const families = readdirSync(join(ROOT, 'src/transport/webhooks'), {
    withFileTypes: true,
  }).filter((d) => d.isDirectory());
  assert.equal(families.length, 3);
});
