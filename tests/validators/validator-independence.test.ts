import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const VALIDATORS_DIR = join(import.meta.dirname, '..', '..', 'src', 'validators');
const FORBIDDEN = /(^|\/)(domain|application|infrastructure|transport|config|bootstrap)(\/|$)/;
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

function forbiddenImports(source: string): string[] {
  return [...source.matchAll(SPECIFIER)].map((m) => m[1] ?? '').filter((s) => FORBIDDEN.test(s));
}

test('scanner detects forbidden imports, including type-only and dynamic ones', () => {
  assert.equal(forbiddenImports("import { x } from '../domain/shared/a.js';").length, 1);
  assert.equal(forbiddenImports("import type { T } from '../../domain/x.js';").length, 1);
  assert.equal(forbiddenImports("const m = await import('../transport/y.js');").length, 1);
  assert.equal(forbiddenImports("import { z } from 'zod';").length, 0);
  assert.equal(forbiddenImports("import { a } from './auth.schema.js';").length, 0);
});

test('no src/validators file imports domain, application, infrastructure, transport, config or bootstrap', () => {
  const files = readdirSync(VALIDATORS_DIR).filter((f) => f.endsWith('.ts'));
  assert.ok(files.length > 0);
  const violations = files.flatMap((f) =>
    forbiddenImports(readFileSync(join(VALIDATORS_DIR, f), 'utf8')).map((s) => f + ' -> ' + s),
  );
  assert.deepEqual(violations, []);
});
