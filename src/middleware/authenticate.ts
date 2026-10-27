import type { RequestHandler } from 'express';
import type { AuthService } from '../modules/auth/auth.service.js';
import { AppError } from '../shared/errors/app-error.js';
import { EmployeePanelService } from '../modules/auth/employee-panel.service.js';
import { employeePanelContext } from '../modules/auth/employee-panel-context.js';

export function authenticate(service: AuthService): RequestHandler {
  return async (req, res, next) => {
    if (res.locals.principal) { next(); return; }
    const header = req.get('Authorization');
    if (!header || !/^Bearer [A-Za-z0-9_.-]+$/.test(header) || header.length > 4096) {
      throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
    }
    const manager = await service.authenticate(header.slice(7));
    const panelToken = req.get('X-Employee-Panel');
    const path = req.originalUrl.split('?')[0] ?? '';
    // Control endpoints use the manager's own authenticated session.
    if (panelToken && !path.startsWith('/api/v1/auth/employee-panels')) {
      if (/^\/api\/v1\/auth\/(?!me\/?$)/i.test(path)) throw new AppError(403, 'EMPLOYEE_PANEL_RESTRICTED', 'Account-security actions require the account owner');
      const principal = await new EmployeePanelService().resolve(manager, panelToken);
      res.locals.principal = principal;
      const panel = principal.employeePanel;
      if (!panel) throw new AppError(403, 'EMPLOYEE_PANEL_FORBIDDEN', 'Employee panel unavailable');
      employeePanelContext.run({ managerId: panel.managerId, employeeId: principal.userId, panelId: panel.id }, next);
      return;
    }
    res.locals.principal = manager;
    next();
  };
}
