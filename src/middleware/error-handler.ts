import type { ErrorRequestHandler } from 'express';
import type { Logger } from 'pino';
import { AppError } from '../shared/errors/app-error.js';

function normalizeError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 11000) {
    return new AppError(409, 'DUPLICATE_RESOURCE', 'A resource with these identifiers already exists');
  }
  if (typeof error === 'object' && error !== null && 'type' in error) {
    if (error.type === 'entity.parse.failed') return new AppError(400, 'INVALID_JSON', 'Request body is not valid JSON');
    if (error.type === 'entity.too.large') return new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
    if (error.type === 'encoding.unsupported' || error.type === 'charset.unsupported') {
      return new AppError(415, 'UNSUPPORTED_ENCODING', 'Request encoding is not supported');
    }
    if (error.type === 'request.aborted' || error.type === 'request.size.invalid') {
      return new AppError(400, 'INVALID_REQUEST', 'Request body is incomplete');
    }
  }
  return new AppError(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
}

export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (error: unknown, _req, res, next) => {
    if (res.headersSent) { next(error); return; }
    const appError = normalizeError(error);
    if (appError.statusCode >= 500) {
      // Never serialize arbitrary driver errors: they can embed connection credentials.
      logger.error({ requestId: res.locals.requestId, code: appError.code }, 'Request failed');
    }
    res.status(appError.statusCode).json({
      success: false, message: appError.message,
      error: { code: appError.code, details: appError.details },
    });
  };
}
