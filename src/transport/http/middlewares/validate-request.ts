import type { z } from 'zod';
import { validationError } from '../../../domain/shared/errors/error-factory.js';

/**
 * Runtime validation boundary (IADP Phase 8, WP8-05 and WP8-06). Raw external input goes in as
 * unknown. Only the schema-parsed, typed value comes out. A failure becomes a canonical
 * VALIDATION_ERROR carrying only a code and a sanitized path for each issue. Zod's own input and
 * message are never read, so no submitted value can reach a client.
 */

/** The Zod 4 issue codes that may be reported. Anything else is reported as invalid. */
const ZOD_ISSUE_CODES: ReadonlySet<string> = new Set([
  'invalid_type',
  'too_big',
  'too_small',
  'invalid_format',
  'not_multiple_of',
  'unrecognized_keys',
  'invalid_union',
  'invalid_key',
  'invalid_element',
  'invalid_value',
  'custom',
]);

const SAFE_SEGMENT = /^[A-Za-z0-9_]{1,32}$/;

// Sized against the safe-details limits: 6 issues of 8 segments of 32 characters stay under
// 2048 bytes and four levels deep (details, issues, issue, path), so copySafeDetails cannot throw.
const MAX_ISSUES = 6;
const MAX_SEGMENTS = 8;

interface MappedIssue {
  path: string[];
  code: string;
}

function mapSegment(segment: unknown): string {
  if (typeof segment === 'string') return SAFE_SEGMENT.test(segment) ? segment : '*';
  if (typeof segment === 'number' && Number.isSafeInteger(segment) && segment >= 0) {
    return String(segment);
  }
  return '*';
}

function mapIssue(issue: { code?: unknown; path?: unknown }): MappedIssue {
  const { code, path } = issue;
  return {
    path: Array.isArray(path) ? (path as unknown[]).slice(0, MAX_SEGMENTS).map(mapSegment) : [],
    code: typeof code === 'string' && ZOD_ISSUE_CODES.has(code) ? code : 'invalid',
  };
}

export function validateInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const issues = (result.error.issues as readonly { code?: unknown; path?: unknown }[])
    .slice(0, MAX_ISSUES)
    .map(mapIssue);
  throw validationError(undefined, { issues });
}
