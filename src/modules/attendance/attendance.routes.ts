import { Router, type RequestHandler } from 'express';
import { Types } from 'mongoose';
import type { AuthService } from '../auth/auth.service.js';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { idParams } from '../roles/role.validator.js';
import { bodyFrom, principalFrom } from '../auth/auth.controller.js';
import { sendSuccess } from '../../shared/utils/response.js';
import { pageMeta } from '../../shared/utils/query.js';
import { evidenceSchema, attendanceQuerySchema, reviewSchema, correctionSchema } from './attendance.validator.js';
import type { AttendanceEvidence, AttendanceQuery, ReviewInput, CorrectionInput } from './attendance.types.js';
import { AttendanceService } from './attendance.service.js';
import type { FileService } from '../files/file.service.js';
export function attendanceRoutes(auth: AuthService, files: FileService): Router {
  const router = Router(); const service = new AttendanceService(files); router.use(authenticate(auth));
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  for (const checkout of [false, true]) router.post(checkout ? '/check-out' : '/check-in', authorize('attendance:create'), validate({ body: evidenceSchema }), async (_req, res) => {
    sendSuccess(res, await service.mark(principalFrom(res), bodyFrom<AttendanceEvidence>(res), checkout, res.locals), checkout ? 'Checked out' : 'Checked in', checkout ? 200 : 201);
  });
  const list = (kind: 'all' | 'self' | 'employee' | 'branch'): RequestHandler => async (_req, res) => {
    const query = { ...(res.locals.validated?.query as AttendanceQuery) };
    const params = res.locals.validated?.params as { id: string } | undefined;
    if (kind === 'employee' && params) query.employeeId = params.id;
    if (kind === 'branch' && params) query.branchId = params.id;
    const result = await service.list(principalFrom(res), query, kind === 'self');
    sendSuccess(res, result.data, 'Attendance retrieved', 200, pageMeta(query, result.total));
  };
  router.get('/', authorize('attendance:read'), validate({ query: attendanceQuerySchema }), list('all'));
  router.get('/me', authorize('attendance:read'), validate({ query: attendanceQuerySchema }), list('self'));
  router.get('/me/status', authorize('attendance:create'), async (_req, res) => {
    sendSuccess(res, await service.selfStatus(principalFrom(res)), 'Current attendance action');
  });
  router.get('/summary', authorize('attendance:read'), validate({ query: attendanceQuerySchema }), async (_req, res) => {
    sendSuccess(res, await service.summary(principalFrom(res), res.locals.validated?.query as AttendanceQuery));
  });
  router.get('/employee/:id', authorize('attendance:read'), validate({ params: idParams, query: attendanceQuerySchema }), list('employee'));
  router.get('/branch/:id', authorize('attendance:read'), validate({ params: idParams, query: attendanceQuerySchema }), list('branch'));
  for (const checkout of [false, true]) router.get(`/:id/photos/${checkout ? 'check-out' : 'check-in'}`, authorize('attendance:read'), validate({ params: idParams }), async (_req, res) => {
    sendSuccess(res, await files.attendancePhoto(principalFrom(res), new Types.ObjectId((res.locals.validated?.params as { id: string }).id), checkout));
  });
  router.patch('/:id/review', authorize('attendance:review'), validate({ params: idParams, body: reviewSchema }), async (_req, res) => {
    sendSuccess(res, await service.review(principalFrom(res), new Types.ObjectId((res.locals.validated?.params as { id: string }).id), bodyFrom<ReviewInput>(res), res.locals), 'Attendance reviewed');
  });
  router.post('/:id/corrections', authorize('attendance:correct'), validate({ params: idParams, body: correctionSchema }), async (_req, res) => {
    sendSuccess(res, await service.correct(principalFrom(res), new Types.ObjectId((res.locals.validated?.params as { id: string }).id), bodyFrom<CorrectionInput>(res), res.locals), 'Attendance corrected');
  }); return router;
}
