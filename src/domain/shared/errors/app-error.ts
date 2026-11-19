import { ERROR_CODES, type ErrorCode } from './error-code.js';
import { copySafeDetails, type ErrorDetails, type ErrorEnvelope } from './error.types.js';

/**
 * A deliberate, expected failure carrying a canonical code (TSDS 46.3).
 *
 * `message` is written by the developer and must be safe to show to a client. `details` is
 * optional, validated at construction and stored as a frozen deep copy; an empty object counts as
 * absent. Invalid input throws before an instance exists, and the instance is frozen afterwards.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details: ErrorDetails | undefined;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    // Nothing from the arguments is echoed in these errors, so a bad value can never leak.
    if (!ERROR_CODES.includes(code)) throw new TypeError('Unknown error code');
    if (typeof message !== 'string' || message.trim().length === 0) {
      throw new TypeError('An error message must be a non-blank string');
    }
    const safeDetails = details === undefined ? undefined : copySafeDetails(details);

    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details =
      safeDetails !== undefined && Object.keys(safeDetails).length > 0 ? safeDetails : undefined;
    Object.freeze(this);
  }
}

/**
 * Builds the canonical public error body. Only code, message and (when present) details are
 * exposed; the stack, name and cause never are. Anything that was not built by the AppError
 * constructor is rejected.
 */
export function toEnvelope(error: AppError): ErrorEnvelope {
  const valid =
    error instanceof AppError &&
    Object.isFrozen(error) &&
    ERROR_CODES.includes(error.code) &&
    typeof error.message === 'string' &&
    error.message.trim().length > 0;
  if (!valid) throw new TypeError('toEnvelope requires an AppError');
  const body =
    error.details === undefined
      ? { code: error.code, message: error.message }
      : { code: error.code, message: error.message, details: error.details };
  return Object.freeze({ error: Object.freeze(body) });
}
