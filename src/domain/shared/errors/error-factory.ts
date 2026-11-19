import { AppError } from './app-error.js';
import type { ErrorCode } from './error-code.js';

/**
 * Generic, client-safe default messages, one per canonical code. The wording of every entry except
 * INTERNAL_ERROR is provisional until reviewed at Phase 6 Gate C.
 */
export const DEFAULT_MESSAGES: Readonly<Record<ErrorCode, string>> = Object.freeze({
  VALIDATION_ERROR: 'The request is invalid.',
  UNAUTHORIZED: 'Authentication is required.',
  FORBIDDEN: 'You do not have permission to perform this action.',
  NOT_FOUND: 'The requested resource was not found.',
  CONFLICT: 'The request conflicts with the current state of the resource.',
  INTERNAL_ERROR: 'An unexpected error occurred.',
});

type DetailsInput = Readonly<Record<string, unknown>>;

export const validationError = (
  message: string = DEFAULT_MESSAGES.VALIDATION_ERROR,
  details?: DetailsInput,
): AppError => new AppError('VALIDATION_ERROR', message, details);

export const unauthorized = (
  message: string = DEFAULT_MESSAGES.UNAUTHORIZED,
  details?: DetailsInput,
): AppError => new AppError('UNAUTHORIZED', message, details);

export const forbidden = (
  message: string = DEFAULT_MESSAGES.FORBIDDEN,
  details?: DetailsInput,
): AppError => new AppError('FORBIDDEN', message, details);

export const notFound = (
  message: string = DEFAULT_MESSAGES.NOT_FOUND,
  details?: DetailsInput,
): AppError => new AppError('NOT_FOUND', message, details);

export const conflict = (
  message: string = DEFAULT_MESSAGES.CONFLICT,
  details?: DetailsInput,
): AppError => new AppError('CONFLICT', message, details);

export const internalError = (
  message: string = DEFAULT_MESSAGES.INTERNAL_ERROR,
  details?: DetailsInput,
): AppError => new AppError('INTERNAL_ERROR', message, details);
