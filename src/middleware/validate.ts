import type { RequestHandler } from 'express';
import type Joi from 'joi';
import { AppError } from '../shared/errors/app-error.js';

export interface ValidatedRequest {
  body?: unknown;
  params?: unknown;
  query?: unknown;
}
export type RequestSchemas = Partial<Record<keyof ValidatedRequest, Joi.ObjectSchema<unknown>>>;

export function validate(schemas: RequestSchemas): RequestHandler {
  return (req, res, next) => {
    const validated: ValidatedRequest = {};
    for (const part of ['body', 'params', 'query'] as const) {
      const schema = schemas[part];
      if (!schema) continue;
      const result = schema.validate(req[part], {
        abortEarly: false, allowUnknown: false, stripUnknown: false, convert: true,
      });
      if (result.error) {
        next(new AppError(400, 'VALIDATION_ERROR', 'Request validation failed',
          result.error.details.map((detail) => ({ field: `${part}.${detail.path.join('.')}`, code: detail.type }))));
        return;
      }
      validated[part] = result.value;
    }
    // Express 5 query is a getter. Keep validated input separate from untrusted raw input.
    res.locals.validated = validated;
    next();
  };
}
