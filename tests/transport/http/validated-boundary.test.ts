import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { AppError } from '../../../src/domain/shared/errors/app-error.js';
import { validateInput } from '../../../src/transport/http/middlewares/validate-request.js';
import { SENTINEL } from '../../utils/transport-error-matrix.js';

const SCHEMA = z.object({ name: z.string(), count: z.coerce.number() });

function spyUseCase() {
  const calls: unknown[] = [];
  const useCase = (input: z.output<typeof SCHEMA>): string => {
    calls.push(input);
    return 'done';
  };
  return { calls, useCase };
}

// The only way raw input reaches the use case is through validateInput.
function guarded(useCase: (input: z.output<typeof SCHEMA>) => string) {
  return (raw: unknown) => useCase(validateInput(SCHEMA, raw));
}

test('invalid input never invokes the use case', () => {
  const { calls, useCase } = spyUseCase();
  const entry = guarded(useCase);
  const invalid = [
    undefined,
    null,
    'x',
    42,
    [],
    {},
    { name: 1, count: 1 },
    { name: 'a', count: 'abc' },
  ];
  for (const raw of invalid) {
    assert.throws(
      () => entry(raw),
      (error: unknown) => error instanceof AppError && error.code === 'VALIDATION_ERROR',
    );
  }
  assert.equal(calls.length, 0);
});

test('valid input passes the parsed value, not the raw object', () => {
  const { calls, useCase } = spyUseCase();
  const raw = { name: 'quest', count: '3', [SENTINEL]: 'extra' };
  assert.equal(guarded(useCase)(raw), 'done');
  assert.equal(calls.length, 1);
  assert.notEqual(calls[0], raw);
  assert.deepEqual(calls[0], { name: 'quest', count: 3 });
  assert.equal(typeof (calls[0] as { count: unknown }).count, 'number');
});

test('extra raw fields never reach the use case', () => {
  const { calls, useCase } = spyUseCase();
  guarded(useCase)({ name: 'quest', count: '3', [SENTINEL]: 'extra' });
  assert.ok(!JSON.stringify(calls[0]).includes(SENTINEL));
});

test('control: a bypassing wrapper is detected by the same assertions', () => {
  const { calls, useCase } = spyUseCase();
  const raw = { name: 'quest', count: '3', [SENTINEL]: 'extra' };
  useCase(raw as never);
  assert.equal(calls[0], raw);
  assert.ok(JSON.stringify(calls[0]).includes(SENTINEL));
  assert.equal(typeof (calls[0] as { count: unknown }).count, 'string');
});

test('types: only validateInput turns raw unknown into a use-case input', () => {
  const raw: unknown = { name: 'a', count: '1' };
  const parsed = validateInput(SCHEMA, raw);
  const count: number = parsed.count;
  assert.equal(count, 1);
  // @ts-expect-error a coerced count is a number and never a string
  const asString: string = parsed.count;
  void asString;
  const { useCase } = spyUseCase();
  useCase(parsed);
  // @ts-expect-error raw unknown input must not be accepted by a use case
  useCase(raw);
});

const CAST = /\bas\s+(any|never|z\.output|S\b)/;

test('the helper never casts or suppresses types on the validated boundary', () => {
  assert.match('return x as z.output<S>;', CAST);
  assert.match('return x as any;', CAST);
  assert.doesNotMatch('const a = b as readonly string[];', CAST);
  const source = readFileSync(
    join(
      import.meta.dirname,
      '..',
      '..',
      '..',
      'src',
      'transport',
      'http',
      'middlewares',
      'validate-request.ts',
    ),
    'utf8',
  );
  assert.doesNotMatch(source, /@ts-(ignore|expect-error|nocheck)/);
  assert.doesNotMatch(source, CAST);
  assert.doesNotMatch(source, /:\s*any\b/);
  assert.match(source, /if \(result\.success\) return result\.data;/);
});
