import { Router } from 'express';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';

export function healthRoutes(isDatabaseReady: () => Promise<boolean>): Router {
  const router = Router();
  const controller = new HealthController(new HealthService(isDatabaseReady));
  router.get('/live', controller.live);
  router.get('/ready', controller.ready);
  return router;
}
