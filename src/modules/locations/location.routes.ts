import { Router } from 'express';
import type { AuthService } from '../auth/auth.service.js';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { idParams } from '../roles/role.validator.js';
import { LocationController } from './location.controller.js';
import { locationCreateSchema, locationQuerySchema, locationUpdateSchema } from './location.validator.js';
export function locationRoutes(auth: AuthService): Router {
  const router = Router(); router.use(authenticate(auth));
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  for (const kind of ['states', 'districts', 'blocks'] as const) {
    const controller = new LocationController(kind);
    router.get(`/${kind}`, authorize('locations:read'), validate({ query: locationQuerySchema(kind) }), controller.list);
    router.post(`/${kind}`, authorize('locations:manage'), validate({ body: locationCreateSchema(kind) }), controller.create);
    router.patch(`/${kind}/:id`, authorize('locations:manage'), validate({ params: idParams, body: locationUpdateSchema }), controller.update);
  }
  return router;
}
