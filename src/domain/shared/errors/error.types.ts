import type { ErrorCode } from './error-code.js';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** Optional, safe, non-sensitive metadata attached to an error (TSDS 46.3). Never a string. */
export type ErrorDetails = { readonly [key: string]: JsonValue };

/** The canonical public error body (TSDS 46.3). `details` is omitted when there is nothing to report. */
export interface ErrorEnvelope {
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
    readonly details?: ErrorDetails;
  };
}

export type DetailsRule =
  | 'not-an-object'
  | 'unsupported-value'
  | 'accessor-property'
  | 'custom-serialization'
  | 'unsafe-key'
  | 'sensitive-key'
  | 'symbol-key'
  | 'sparse-array'
  | 'cycle'
  | 'too-deep'
  | 'too-large'
  | 'string-too-long'
  | 'too-many-items'
  | 'too-many-keys'
  | 'sensitive-value';

/**
 * Thrown when error details are unsafe. This is a programming error. The message names only
 * the violated rule, never a key or a value.
 */
export class InvalidErrorDetailsError extends Error {
  readonly rule: DetailsRule;

  constructor(rule: DetailsRule) {
    super(`Unsafe error details: ${rule}`);
    this.name = 'InvalidErrorDetailsError';
    this.rule = rule;
  }
}

// Limits approved in the Phase 6 Work Breakdown, revision 3.
const MAX_DEPTH = 4;
const MAX_SIZE_BYTES = 2048;
const MAX_STRING_LENGTH = 256;
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 50;

const UNSAFE_PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// A key is rejected when its normalized form contains any of these fragments. The list errs on
// the side of rejecting, so a harmless key such as "tokenizer" is rejected rather than risk a leak.
const SENSITIVE_KEY_FRAGMENTS = [
  'authorization',
  'cookie',
  'password',
  'passwd',
  'passphrase',
  'secret',
  'token',
  'apikey',
  'credential',
  'connectionstring',
  'dsn',
  'stack',
  'privatekey',
  'bearer',
] as const;

/**
 * Decomposes the key, drops accents and combining marks, lower-cases it and removes everything
 * except letters and digits, so access_token, accessToken, X-Api-Key and full-width or
 * zero-width disguises all reduce to the same plain text. Best-effort: lookalike letters from
 * other scripts are not mapped.
 */
function normalizeKey(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function isSensitiveKey(name: string): boolean {
  const normalized = normalizeKey(name);
  return SENSITIVE_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

// Best-effort screening of string values. It is defense in depth, not a guarantee.
const SENSITIVE_VALUE_PATTERNS: readonly RegExp[] = [
  // a URL with embedded credentials, with or without a password
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+(?::[^\s/@]*)?@/i,
  // the whole value is a Bearer or Basic header value
  /^\s*(?:bearer|basic)\s+[A-Za-z0-9._~+/-]{8,}=*\s*$/i,
  // an Authorization header written as text
  /authorization\s*[:=]/i,
  // a JWT-like value
  /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
  // a PEM private key block
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

interface Walk {
  ancestors: Set<object>;
  bytes: number;
}

function fail(rule: DetailsRule): never {
  throw new InvalidErrorDetailsError(rule);
}

/** Adds to the conservative size estimate and rejects once the limit is passed. */
function spend(walk: Walk, bytes: number): void {
  walk.bytes += bytes;
  if (walk.bytes > MAX_SIZE_BYTES) fail('too-large');
}

/**
 * UTF-8 length of a string as it would appear inside JSON quotes, computed without
 * JSON.stringify. Characters JSON escapes (quote, backslash, control characters and lone
 * surrogates) count as 6 bytes, which is never less than their real encoding.
 */
function escapedUtf8Length(text: string): number {
  let total = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit === 0x22 || unit === 0x5c || unit < 0x20) {
      total += 6;
    } else if (unit < 0x80) {
      total += 1;
    } else if (unit < 0x800) {
      total += 2;
    } else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        total += 4;
        index += 1;
      } else {
        total += 6;
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      total += 6;
    } else {
      total += 3;
    }
  }
  return total;
}

function isPlainObject(value: unknown): value is object {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

const isIndex = (name: string): boolean => /^(0|[1-9]\d*)$/.test(name);

/** Reads a data property through its descriptor, so a getter or setter is never invoked. */
function readOwnData(target: object, name: string): { enumerable: boolean; value: unknown } {
  const descriptor = Object.getOwnPropertyDescriptor(target, name);
  if (descriptor === undefined) return fail('unsupported-value');
  if (!('value' in descriptor)) return fail('accessor-property');
  return { enumerable: descriptor.enumerable === true, value: descriptor.value as unknown };
}

function copyString(text: string, walk: Walk): string {
  if (text.length > MAX_STRING_LENGTH) return fail('string-too-long');
  if (SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(text))) {
    return fail('sensitive-value');
  }
  spend(walk, escapedUtf8Length(text) + 2);
  return text;
}

function copyArray(array: readonly unknown[], walk: Walk, depth: number): JsonValue {
  if (Object.getPrototypeOf(array) !== Array.prototype) return fail('unsupported-value');
  if (array.length > MAX_ARRAY_ITEMS) return fail('too-many-items');
  if (Object.getOwnPropertySymbols(array).length > 0) return fail('symbol-key');
  const extra = Object.getOwnPropertyNames(array).find(
    (name) => name !== 'length' && !isIndex(name),
  );
  if (extra !== undefined) {
    return extra === 'toJSON' ? fail('custom-serialization') : fail('unsupported-value');
  }
  const copy: JsonValue[] = [];
  for (let index = 0; index < array.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(array, index)) return fail('sparse-array');
    spend(walk, 1);
    copy.push(copyValue(readOwnData(array, String(index)).value, walk, depth + 1));
  }
  return Object.freeze(copy);
}

function copyObject(object: object, walk: Walk, depth: number): JsonValue {
  if (!isPlainObject(object)) return fail('unsupported-value');
  if (Object.getOwnPropertySymbols(object).length > 0) return fail('symbol-key');
  const names = Object.getOwnPropertyNames(object);
  if (names.length > MAX_OBJECT_KEYS) return fail('too-many-keys');
  const copy: Record<string, JsonValue> = {};
  for (const name of names) {
    if (name.length > MAX_STRING_LENGTH) return fail('string-too-long');
    if (name === 'toJSON') return fail('custom-serialization');
    if (UNSAFE_PROTOTYPE_KEYS.has(name)) return fail('unsafe-key');
    if (isSensitiveKey(name)) return fail('sensitive-key');
    spend(walk, escapedUtf8Length(name) + 4);
    const { enumerable, value } = readOwnData(object, name);
    if (!enumerable) return fail('unsupported-value');
    copy[name] = copyValue(value, walk, depth + 1);
  }
  return Object.freeze(copy);
}

/** `depth` is the level of the container being entered; the top-level object is level 1. */
function copyValue(value: unknown, walk: Walk, depth: number): JsonValue {
  if (value === null) {
    spend(walk, 4);
    return null;
  }
  switch (typeof value) {
    case 'string':
      return copyString(value, walk);
    case 'boolean':
      spend(walk, 5);
      return value;
    case 'number':
      if (!Number.isFinite(value)) return fail('unsupported-value');
      spend(walk, String(value).length);
      return value;
    case 'object':
      break;
    default:
      return fail('unsupported-value');
  }
  if (depth > MAX_DEPTH) return fail('too-deep');
  const reference = value as object;
  if (walk.ancestors.has(reference)) return fail('cycle');
  walk.ancestors.add(reference);
  try {
    spend(walk, 2);
    return Array.isArray(reference)
      ? copyArray(reference as unknown[], walk, depth)
      : copyObject(reference, walk, depth);
  } finally {
    walk.ancestors.delete(reference);
  }
}

/**
 * Validates error details and returns a frozen deep copy. It walks the structure itself and
 * never invokes getters, setters or toJSON, and never uses JSON.stringify.
 */
export function copySafeDetails(input: unknown): ErrorDetails {
  if (!isPlainObject(input)) return fail('not-an-object');
  return copyValue(input, { ancestors: new Set<object>(), bytes: 0 }, 1) as ErrorDetails;
}
