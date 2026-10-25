import { Router, type Response } from 'express';
import { Types } from 'mongoose';
import Joi from 'joi';
import type { AuthService } from '../auth/auth.service.js';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { idParams } from '../roles/role.validator.js';
import { bodyFrom, principalFrom } from '../auth/auth.controller.js';
import { sendSuccess } from '../../shared/utils/response.js';
import { pageMeta, type PageQuery } from '../../shared/utils/query.js';
import { TargetService } from './target.service.js';
import { TargetEvidenceService } from './evidence.service.js';
import { targetCreateSchema, targetUpdateSchema, targetQuerySchema, historyQuerySchema, evidenceQuerySchema, evidenceReviewSchema } from './target.validator.js';
import type { TargetInput, TargetUpdate, TargetQuery, EvidenceQuery, EvidenceReview } from './target.types.js';
import type { Milestone } from './target-evidence.js';
const id = (res: Response) => new Types.ObjectId((res.locals.validated?.params as { id: string }).id);
const query = (res: Response) => res.locals.validated?.query as TargetQuery;
export function targetRoutes(auth: AuthService): Router {
  const router = Router(); const targets = new TargetService(); const evidence = new TargetEvidenceService();
  router.use(['/targets', '/target-evidence'], authenticate(auth), (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.post('/targets', authorize('targets:create'), validate({ body: targetCreateSchema }), async (_req, res) => { sendSuccess(res, await targets.create(principalFrom(res), bodyFrom<TargetInput>(res), res.locals), 'Target assigned', 201); });
  router.get('/targets', authorize('targets:read'), validate({ query: targetQuerySchema }), async (_req, res) => { const result = await targets.list(principalFrom(res), query(res)); sendSuccess(res, result.data, 'Targets retrieved', 200, pageMeta(query(res), result.total)); });
  for (const kind of ['summary', 'reports'] as const) router.get(`/targets/${kind}`, authorize('targets:read'), validate({ query: targetQuerySchema }), async (_req, res) => {
    const result = kind === 'summary' ? await targets.summary(principalFrom(res), query(res)) : await targets.report(principalFrom(res), query(res));
    sendSuccess(res, { rows: result.data, asOf: result.asOf, timezone: 'Asia/Kolkata', verifiedOnly: true, actualIsScoped: true }, 'Target metrics retrieved', 200, pageMeta(query(res), result.total));
  });
  router.get('/targets/:id', authorize('targets:read'), validate({ params: idParams }), async (_req, res) => { sendSuccess(res, await targets.read(principalFrom(res), id(res))); });
  router.patch('/targets/:id', authorize('targets:update'), validate({ params: idParams, body: targetUpdateSchema }), async (_req, res) => { sendSuccess(res, await targets.update(principalFrom(res), id(res), bodyFrom<TargetUpdate>(res), res.locals)); });
  router.get('/targets/:id/progress', authorize('targets:read'), validate({ params: idParams }), async (_req, res) => { sendSuccess(res, await targets.progress(principalFrom(res), id(res))); });
  router.get('/targets/:id/revisions', authorize('targets:read'), validate({ params: idParams, query: historyQuerySchema }), async (_req, res) => { const page = res.locals.validated?.query as PageQuery; const result = await targets.revisions(principalFrom(res), id(res), page.page, page.limit); sendSuccess(res, result.data, 'Target revisions retrieved', 200, pageMeta(page, result.total)); });
  router.get('/target-evidence', authorize('reports:read'), authorize('leads:read'), validate({ query: evidenceQuerySchema }), async (_req, res) => { const page = res.locals.validated?.query as EvidenceQuery; const result = await evidence.list(principalFrom(res), page); sendSuccess(res, result.data, 'Milestone evidence retrieved', 200, pageMeta(page, result.total)); });
  router.post('/target-evidence/leads/:id/capture', authorize('reports:review'), authorize('leads:read'), validate({ params: idParams, body: Joi.object({ milestone: Joi.string().valid('CREATED', 'QUALIFIED', 'CONVERTED').required() }).required() }), async (_req, res) => { sendSuccess(res, await evidence.capture(principalFrom(res), id(res), bodyFrom<{ milestone: Milestone }>(res).milestone, res.locals), 'Milestone evidence captured'); });
  router.patch('/target-evidence/:id/review', authorize('reports:review'), authorize('leads:read'), validate({ params: idParams, body: evidenceReviewSchema }), async (_req, res) => { sendSuccess(res, await evidence.review(principalFrom(res), id(res), bodyFrom<EvidenceReview>(res), res.locals)); });
  router.get('/target-evidence/:id/history', authorize('reports:read'), authorize('leads:read'), validate({ params: idParams, query: historyQuerySchema }), async (_req, res) => { const page = res.locals.validated?.query as PageQuery; const result = await evidence.history(principalFrom(res), id(res), page.page, page.limit); sendSuccess(res, result.data, 'Evidence reviews retrieved', 200, pageMeta(page, result.total)); });
  return router;
}
