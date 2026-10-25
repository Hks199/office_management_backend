import type { RequestHandler } from 'express';
import type { AuthService } from '../modules/auth/auth.service.js';
import { AppError } from '../shared/errors/app-error.js';

export function authenticate(service: AuthService): RequestHandler {
  return async (req, res, next) => {
    const header = req.get('Authorization');
    if (!header || !/^Bearer [A-Za-z0-9_.-]+$/.test(header) || header.length > 4096) {
      throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
    }
    res.locals.principal = await service.authenticate(header.slice(7));
    next();
  };
}
