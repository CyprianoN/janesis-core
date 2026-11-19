import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

// IADP Phase 7: pg and drizzle-orm are imported only inside the database adapter folder.
// The scanner reads the syntax tree, so comments and string literals are never mistaken for imports.
const ROOT = join(import.meta.dirname, '..', '..');
const ALLOWED = 'src/infrastructure/adapters/database/';
const RESTRICTED = /^(pg|drizzle-orm)(\/|$)/;

export function restrictedImports(source: string): string[] {
  const file = ts.createSourceFile('scan.ts', source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      found.push(node.moduleSpecifier.text);
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      found.push(node.moduleReference.expression.text);
    }
    if (ts.isCallExpression(node)) {
      const arg = node.arguments[0];
      const dynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const required = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if ((dynamic || required) && arg !== undefined && ts.isStringLiteralLike(arg)) {
        found.push(arg.text);
      }
    }
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      found.push(node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found.filter((specifier) => RESTRICTED.test(specifier));
}

const MUST_DETECT: Array<[string, string, string]> = [
  ['static import', "import pg from 'pg';", 'pg'],
  ['type-only import', "import type { Pool } from 'pg';", 'pg'],
  [
    'drizzle subpath',
    "import { drizzle } from 'drizzle-orm/node-postgres';",
    'drizzle-orm/node-postgres',
  ],
  ['re-export', "export { sql } from 'drizzle-orm';", 'drizzle-orm'],
  ['dynamic import', "const m = await import('pg');", 'pg'],
  ['require call', "const pg = require('pg');", 'pg'],
  ['import equals', "import pg = require('pg');", 'pg'],
  ['import type node', "type P = import('pg').Pool;", 'pg'],
];

for (const [label, code, expected] of MUST_DETECT) {
  test('the scanner detects: ' + label, () => {
    assert.deepEqual(restrictedImports(code), [expected]);
  });
}

test('the scanner ignores comments, strings and look-alike package names', () => {
  const code = [
    "// import pg from 'pg';",
    "/* import { sql } from 'drizzle-orm'; */",
    'const text = "import pg from \'pg\'";',
    "import { x } from 'pg-native';",
    "import { y } from 'drizzle-orm-extras';",
    "import { z } from './pg.js';",
  ].join('\n');
  assert.deepEqual(restrictedImports(code), []);
});

function sourceFiles(): string[] {
  return (readdirSync(join(ROOT, 'src'), { recursive: true }) as string[])
    .map((entry) => entry.replace(/\\/g, '/'))
    .filter((entry) => entry.endsWith('.ts'))
    .map((entry) => 'src/' + entry);
}

test('the scanner sees the real driver imports inside the database adapter folder', () => {
  const inside = sourceFiles().filter((file) => file.startsWith(ALLOWED));
  const withImports = inside.filter(
    (file) => restrictedImports(readFileSync(join(ROOT, file), 'utf8')).length > 0,
  );
  assert.ok(withImports.length > 0, 'the scanner found no driver import in the adapter folder');
});

test('pg and drizzle-orm are imported nowhere in src outside the database adapter folder', () => {
  const offenders = sourceFiles()
    .filter((file) => !file.startsWith(ALLOWED))
    .filter((file) => restrictedImports(readFileSync(join(ROOT, file), 'utf8')).length > 0);
  assert.deepEqual(offenders, []);
});
