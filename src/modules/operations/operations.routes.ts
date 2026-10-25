import { Router } from 'express';
import Joi from 'joi';
import type { AuthService } from '../auth/auth.service.js';
import { principalFrom } from '../auth/auth.controller.js';
import { authenticate } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { sendSuccess } from '../../shared/utils/response.js';
import type { HttpTelemetry } from './telemetry.js';
import { OperationsService } from './operations.service.js';

export function operationsRoutes(auth: AuthService, telemetry: HttpTelemetry): Router {
  const router = Router(); const service = new OperationsService(telemetry);
  router.use(authenticate(auth), (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.get('/metrics', validate({ query: Joi.object({}).unknown(false) }), async (_req, res) => {
    sendSuccess(res, await service.snapshot(principalFrom(res)));
  });
  return router;
}
