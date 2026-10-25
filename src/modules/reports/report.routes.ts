import { Router, type Request, type Response } from 'express';
import Joi from 'joi';
import { Types } from 'mongoose';
import type { AppConfig } from '../../config/env.js';
import type { AuthService } from '../auth/auth.service.js';
import type { PhotoStorage } from '../files/s3-storage.js';
import type { UploadInput } from '../files/file.model.js';
import { uploadSchema } from '../files/file.validator.js';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { objectIdSchema } from '../../shared/utils/validation-schemas.js';
import { idParams } from '../roles/role.validator.js';
import { bodyFrom, principalFrom } from '../auth/auth.controller.js';
import { sendSuccess } from '../../shared/utils/response.js';
import { pageMeta } from '../../shared/utils/query.js';
import { AppError } from '../../shared/errors/app-error.js';
import { ReportService, reportDto } from './report.service.js';
import { ReportPhotosService } from './report-photos.service.js';
import { customerQuerySchema } from '../leads/commercial.validator.js';
import type { CommercialQuery } from '../leads/commercial.types.js';
import { callSchema, visitSchema, completeSchema, reviewSchema, reportQuerySchema, type CallInput, type VisitInput, type CompleteInput, type ReviewInput, type ReportQuery } from './report.validator.js';
const id = (res: Response) => new Types.ObjectId((res.locals.validated?.params as { id: string }).id);
const fileId = (res: Response) => new Types.ObjectId((res.locals.validated?.params as { fileId: string }).fileId);
const query = (res: Response) => res.locals.validated?.query as ReportQuery;
function key(req: Request): string {
  const value = req.get('Idempotency-Key'); if (!value || !/^[A-Za-z0-9_-]{16,100}$/.test(value)) throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Supply a 16-100 character Idempotency-Key'); return value;
}
export function reportRoutes(config: AppConfig, auth: AuthService, storage?: PhotoStorage): Router {
  const router = Router(); const reports = new ReportService(); const photos = new ReportPhotosService(config, storage);
  router.use(['/telecaller-reports', '/sales-reports'], authenticate(auth), (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.get('/telecaller-reports/contact-options', authorize('reports:create'), authorize('customers:read'), validate({ query: customerQuerySchema }), async (_req, res) => {
    const options = res.locals.validated?.query as CommercialQuery;
    const result = await reports.contactOptions(principalFrom(res), options);
    sendSuccess(res, result.data, 'Assigned contacts retrieved', 200, pageMeta(options, result.total));
  });
  router.post('/telecaller-reports/calls', authorize('reports:create'), validate({ body: callSchema }), async (req, res) => { sendSuccess(res, await reports.call(principalFrom(res), bodyFrom<CallInput>(res), key(req), res.locals), 'Call recorded', 201); });
  router.get('/telecaller-reports/daily', authorize('reports:read'), validate({ query: reportQuerySchema }), async (_req, res) => {
    const result = await reports.daily(principalFrom(res), query(res)); sendSuccess(res, { timezone: result.timezone, days: result.data }, 'Daily calls retrieved', 200, pageMeta(query(res), result.total));
  });
  router.post('/sales-reports/visits', authorize('reports:create'), validate({ body: visitSchema }), async (req, res) => { sendSuccess(res, await reports.start(principalFrom(res), bodyFrom<VisitInput>(res), key(req), res.locals), 'Visit started', 201); });
  router.patch('/sales-reports/visits/:id/complete', authorize('reports:create'), validate({ params: idParams, body: completeSchema }), async (_req, res) => { sendSuccess(res, await reports.complete(principalFrom(res), id(res), bodyFrom<CompleteInput>(res), res.locals), 'Visit submitted'); });
  for (const [path, kind] of [['telecaller-reports/calls', 'CALL'], ['sales-reports/visits', 'VISIT']] as const) {
    router.get(`/${path}`, authorize('reports:read'), validate({ query: reportQuerySchema }), async (_req, res) => { const result = await reports.list(principalFrom(res), kind, query(res)); sendSuccess(res, result.data, 'Reports retrieved', 200, pageMeta(query(res), result.total)); });
    router.get(`/${path}/:id`, authorize('reports:read'), validate({ params: idParams }), async (_req, res) => { sendSuccess(res, reportDto(await reports.get(principalFrom(res), kind, id(res)))); });
    router.get(`/${path}/:id/history`, authorize('reports:read'), validate({ params: idParams, query: reportQuerySchema }), async (_req, res) => { const result = await reports.history(principalFrom(res), kind, id(res), query(res)); sendSuccess(res, result.data, 'Report history retrieved', 200, pageMeta(query(res), result.total)); });
    router.patch(`/${path}/:id/review`, authorize('reports:review'), validate({ params: idParams, body: reviewSchema }), async (_req, res) => { sendSuccess(res, await reports.review(principalFrom(res), kind, id(res), bodyFrom<ReviewInput>(res), res.locals)); });
  }
  const photoParams = Joi.object({ id: objectIdSchema.required(), fileId: objectIdSchema.required() });
  router.post('/sales-reports/visits/:id/photos/upload-intents', authorize('reports:create'), authorize('files:upload'), validate({ params: idParams, body: uploadSchema.fork('purpose', (schema) => schema.forbidden()) }), async (_req, res) => { sendSuccess(res, await photos.upload(principalFrom(res), id(res), bodyFrom<Omit<UploadInput, 'purpose'>>(res), res.locals), 'Visit photo authorized', 201); });
  router.post('/sales-reports/visits/:id/photos/:fileId/confirm', authorize('reports:create'), authorize('files:upload'), validate({ params: photoParams }), async (_req, res) => { sendSuccess(res, await photos.confirm(principalFrom(res), id(res), fileId(res), res.locals), 'Visit photo confirmed'); });
  router.get('/sales-reports/visits/:id/photos/:fileId/download', authorize('reports:read'), validate({ params: photoParams }), async (_req, res) => { sendSuccess(res, await photos.download(principalFrom(res), id(res), fileId(res))); });
  return router;
}
