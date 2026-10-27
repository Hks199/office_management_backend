import { Router } from 'express';
import Joi from 'joi';
import { Types } from 'mongoose';
import type { AuthService } from './auth.service.js';
import { EmployeePanelService } from './employee-panel.service.js';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { principalFrom, bodyFrom } from './auth.controller.js';
import { sendSuccess } from '../../shared/utils/response.js';
import { objectIdSchema } from '../../shared/utils/validation-schemas.js';
import { AppError } from '../../shared/errors/app-error.js';

export function employeePanelRoutes(auth: AuthService) {
  const router = Router(); const panels = new EmployeePanelService();
  router.use(authenticate(auth));
  router.get('/:id/availability', authorize('users:open_panel'), validate({ params: Joi.object({ id: objectIdSchema.required() }) }), async (_req, res) => {
    const id = (res.locals.validated?.params as { id: string }).id;
    sendSuccess(res, await panels.available(principalFrom(res), new Types.ObjectId(id)));
  });
  router.post('/start', authorize('users:open_panel'), validate({ body: Joi.object({ employeeId: objectIdSchema.required() }).required() }), async (req, res) => {
    if (req.get('X-Employee-Panel')) throw new AppError(403, 'EMPLOYEE_PANEL_RESTRICTED', 'Return to your own account before opening another employee panel');
    const { employeeId } = bodyFrom<{ employeeId: string }>(res);
    sendSuccess(res, await panels.start(principalFrom(res), new Types.ObjectId(employeeId), res.locals), 'Employee panel opened');
  });
  router.post('/stop', async (req, res) => {
    const token = req.get('X-Employee-Panel');
    if (!token) throw new AppError(400, 'EMPLOYEE_PANEL_REQUIRED', 'No employee panel is open');
    await panels.stop(principalFrom(res), token, res.locals);
    sendSuccess(res, {}, 'Returned to your account');
  });
  return router;
}
