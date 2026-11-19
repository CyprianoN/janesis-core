/**
 * The closed set of canonical Core error codes (TSDS 46.3).
 * No code may be added or removed without architectural change control.
 */
export const ERROR_CODES = Object.freeze([
  'VALIDATION_ERROR',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'INTERNAL_ERROR',
] as const);

export type ErrorCode = (typeof ERROR_CODES)[number];
