import { Router, type Response } from 'express';
import { Types } from 'mongoose';
import type { AppConfig } from '../../config/env.js';
import type { AuthService } from '../auth/auth.service.js';
import type { CommercialStorage } from '../csv-imports/commercial-storage.js';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { principalFrom, bodyFrom } from '../auth/auth.controller.js';
import { idParams } from '../roles/role.validator.js';
import { sendSuccess } from '../../shared/utils/response.js';
import { DashboardService } from './dashboard.service.js';
import { DashboardExportService } from './dashboard-export.service.js';
import { dashboardQuerySchema, dashboardExportSchema, calendarSchema } from './dashboard.validator.js';
import { DASHBOARD_KINDS, type DashboardKind, type DashboardQuery, type CalendarInput } from './dashboard.types.js';
const id = (res: Response) => new Types.ObjectId((res.locals.validated?.params as { id: string }).id);
export function dashboardRoutes(config: AppConfig, auth: AuthService, storage?: CommercialStorage): Router {
  const router = Router(); const dashboards = new DashboardService(); const exports = new DashboardExportService(config, storage);
  router.use(authenticate(auth), (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  for (const kind of DASHBOARD_KINDS) router.get(`/${kind}`, authorize('dashboard:read'), validate({ query: dashboardQuerySchema }), async (_req, res) => {
    sendSuccess(res, await dashboards.snapshot(principalFrom(res), kind, res.locals.validated?.query as DashboardQuery));
  });
  router.post('/exports', authorize('dashboard:export'), authorize('dashboard:read'), validate({ body: dashboardExportSchema }), async (_req, res) => { const input = bodyFrom<{ kind: DashboardKind; query: DashboardQuery }>(res); sendSuccess(res, await exports.create(principalFrom(res), input.kind, input.query, res.locals), 'Dashboard export queued', 202); });
  router.get('/exports/:id', authorize('dashboard:export'), authorize('dashboard:read'), validate({ params: idParams }), async (_req, res) => { sendSuccess(res, await exports.get(principalFrom(res), id(res))); });
  router.get('/exports/:id/download', authorize('dashboard:export'), authorize('dashboard:read'), validate({ params: idParams }), async (_req, res) => { sendSuccess(res, await exports.download(principalFrom(res), id(res))); });
  router.get('/attendance-calendars/:id', authorize('dashboard:read'), authorize('branches:read'), validate({ params: idParams }), async (_req, res) => { sendSuccess(res, await dashboards.calendar(principalFrom(res), id(res))); });
  router.put('/attendance-calendars/:id', authorize('settings:manage'), authorize('dashboard:read'), authorize('branches:read'), validate({ params: idParams, body: calendarSchema }), async (_req, res) => { sendSuccess(res, await dashboards.calendar(principalFrom(res), id(res), bodyFrom<CalendarInput>(res), res.locals)); });
  return router;
}
