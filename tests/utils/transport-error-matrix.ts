// Data only. No logic. Independent expectations from the Phase 6 handoff brief (T10a, T10b).
// The expected statuses are written out here on purpose and are not read from the handler.

export interface AppErrorRow {
  readonly code: string;
  readonly status: number;
}

export interface FrameworkRow {
  readonly name: string;
  readonly status: number;
  readonly contentType: string;
  readonly payload: string;
}

export const SENTINEL = 'sentinel-secret-value-7f3a91';

export const APP_ERROR_ROWS: readonly AppErrorRow[] = [
  { code: 'VALIDATION_ERROR', status: 400 },
  { code: 'UNAUTHORIZED', status: 401 },
  { code: 'FORBIDDEN', status: 403 },
  { code: 'NOT_FOUND', status: 404 },
  { code: 'CONFLICT', status: 409 },
  { code: 'INTERNAL_ERROR', status: 500 },
];

export const FRAMEWORK_ROWS: readonly FrameworkRow[] = [
  {
    name: 'malformed JSON',
    status: 400,
    contentType: 'application/json',
    payload: '{"broken": ' + SENTINEL,
  },
  {
    name: 'oversized body',
    status: 413,
    contentType: 'application/json',
    payload: '{"a":"' + 'x'.repeat(1048600) + '"}',
  },
  {
    name: 'unsupported media type',
    status: 415,
    contentType: 'text/xml',
    payload: '<a/>',
  },
];
