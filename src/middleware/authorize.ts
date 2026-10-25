import type { RequestHandler } from 'express';
import type { PermissionCode } from '../constants/permissions.js';
import { AuthorizationService } from '../modules/permissions/authorization.service.js';
import { AppError } from '../shared/errors/app-error.js';

export function authorize(action: PermissionCode): RequestHandler {
  return (_req, res, next) => {
    if (!res.locals.principal) throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
    new AuthorizationService().require(res.locals.principal, action);
    next();
  };
}
