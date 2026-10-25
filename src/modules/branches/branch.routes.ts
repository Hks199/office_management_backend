import { Router } from 'express';
import type { AuthService } from '../auth/auth.service.js';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { idParams } from '../roles/role.validator.js';
import { BranchController } from './branch.controller.js';
import { branchCreateSchema, branchUpdateSchema, branchHeadSchema, branchQuerySchema } from './branch.validator.js';
export function branchRoutes(auth: AuthService): Router {
  const router = Router(); const controller = new BranchController(); router.use(authenticate(auth));
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.get('/', authorize('branches:read'), validate({ query: branchQuerySchema }), controller.list);
  router.post('/', authorize('branches:create'), validate({ body: branchCreateSchema }), controller.create);
  router.get('/:id', authorize('branches:read'), validate({ params: idParams }), controller.get);
  router.patch('/:id', authorize('branches:update'), validate({ params: idParams, body: branchUpdateSchema }), controller.update);
  router.patch('/:id/head', authorize('branches:assign_head'), validate({ params: idParams, body: branchHeadSchema }), controller.head);
  return router;
}
