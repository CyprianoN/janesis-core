import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError, toEnvelope } from '../../../domain/shared/errors/app-error.js';
import type { ErrorCode } from '../../../domain/shared/errors/error-code.js';
import {
  conflict,
  forbidden,
  internalError,
  notFound,
  unauthorized,
  validationError,
} from '../../../domain/shared/errors/error-factory.js';
import { InvalidErrorDetailsError } from '../../../domain/shared/errors/error.types.js';

/** How the handler itself classified an error. Assigned by the handler, never read from the error. */
type ErrorClassification =
  'app-error' | 'framework-client-error' | 'invalid-error-details' | 'unexpected';

/** The approved HTTP status for each canonical code. Lives in transport; the domain knows no HTTP. */
export const HTTP_STATUS_BY_CODE: Readonly<Record<ErrorCode, number>> = Object.freeze({
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INTERNAL_ERROR: 500,
});

/**
 * Returns the status of a trusted framework client error, otherwise undefined. An error is trusted
 * only when its code is a string starting with FST_ and its status is an integer from 400 to 499.
 * An arbitrary error that merely carries a statusCode is never trusted.
 */
function frameworkClientStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { code, statusCode } = error as { code?: unknown; statusCode?: unknown };
  if (typeof code !== 'string' || !code.startsWith('FST_')) return undefined;
  if (typeof statusCode !== 'number' || !Number.isInteger(statusCode)) return undefined;
  return statusCode >= 400 && statusCode <= 499 ? statusCode : undefined;
}

/** Maps a trusted framework status to a canonical AppError with its generic default message. */
function frameworkAppError(status: number): AppError {
  switch (status) {
    case 401:
      return unauthorized();
    case 403:
      return forbidden();
    case 404:
      return notFound();
    case 409:
      return conflict();
    default:
      return validationError();
  }
}

/**
 * Writes one safe diagnostic record with fixed fields only. The logger adds the timestamp as
 * time. Never the error object, message, stack, attached fields or the raw URL. A request with no
 * matched route (an unknown route) is recorded as not-found.
 */
function logDiagnostic(
  request: FastifyRequest,
  classification: ErrorClassification,
  statusCode: number,
): void {
  const diagnostic = {
    requestId: request.id,
    classification,
    route: request.routeOptions.url ?? 'not-found',
    statusCode,
  };
  if (statusCode >= 500) {
    request.log.error(diagnostic);
  } else {
    request.log.info(diagnostic);
  }
}

/**
 * Registers the canonical error handler and the not-found handler on the app. An AppError becomes
 * its mapped status with the canonical envelope. A trusted framework client error keeps its status
 * with a canonical envelope; a 429 is passed through untouched (Phase 12 owns the 429 contract).
 * Anything else becomes a generic INTERNAL_ERROR, so no message, stack or attached field from an
 * unexpected error can reach a client.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const frameworkStatus = error instanceof AppError ? undefined : frameworkClientStatus(error);
    if (frameworkStatus !== undefined) {
      logDiagnostic(request, 'framework-client-error', frameworkStatus);
      if (frameworkStatus === 429) return reply.send(error);
      return reply.code(frameworkStatus).send(toEnvelope(frameworkAppError(frameworkStatus)));
    }
    const classification: ErrorClassification =
      error instanceof AppError
        ? 'app-error'
        : error instanceof InvalidErrorDetailsError
          ? 'invalid-error-details'
          : 'unexpected';
    const appError = error instanceof AppError ? error : internalError();
    const statusCode = HTTP_STATUS_BY_CODE[appError.code];
    logDiagnostic(request, classification, statusCode);
    return reply.code(statusCode).send(toEnvelope(appError));
  });

  app.setNotFoundHandler((request, reply) => {
    const appError = notFound();
    const statusCode = HTTP_STATUS_BY_CODE[appError.code];
    logDiagnostic(request, 'app-error', statusCode);
    return reply.code(statusCode).send(toEnvelope(appError));
  });
}
