import type { RequestHandler } from 'express';
import type { PermissionCode } from '../constants/permissions.js';
import { ScopeService, type ScopeResource } from '../modules/permissions/authorization.service.js';
import { AppError } from '../shared/errors/app-error.js';

export function authorizeScope(action: PermissionCode, resource: ScopeResource): RequestHandler {
  return async (_req, res, next) => {
    if (!res.locals.principal) throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
    res.locals.scope = await new ScopeService().predicate(res.locals.principal, action, resource);
    next();
  };
}
