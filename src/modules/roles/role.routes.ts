import { Router } from 'express';
import type { AuthService } from '../auth/auth.service.js';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { RoleController } from './role.controller.js';
import { RoleService } from './role.service.js';
import { idParams, roleQuery, policyQuery, roleCreateSchema, roleUpdateSchema, archiveSchema, policyCreateSchema, policyUpdateSchema } from './role.validator.js';

export function administrationRoutes(auth: AuthService): Router {
  const router = Router(); const controller = new RoleController(new RoleService());
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.use(['/roles', '/permissions', '/role-creation-policies'], authenticate(auth));
  router.get('/permissions', authorize('permissions:read'), controller.permissions);
  router.get('/roles', authorize('roles:read'), validate({ query: roleQuery }), controller.list);
  router.post('/roles', authorize('roles:create'), validate({ body: roleCreateSchema }), controller.create);
  router.get('/roles/:id', authorize('roles:read'), validate({ params: idParams }), controller.get);
  router.patch('/roles/:id', authorize('roles:update'), validate({ params: idParams, body: roleUpdateSchema }), controller.update);
  router.delete('/roles/:id', authorize('roles:delete'), validate({ params: idParams, body: archiveSchema }), controller.archive);
  router.get('/role-creation-policies', authorize('policies:manage'), validate({ query: policyQuery }), controller.policies);
  router.post('/role-creation-policies', authorize('policies:manage'), validate({ body: policyCreateSchema }), controller.createPolicy);
  router.put('/role-creation-policies/:id', authorize('policies:manage'), validate({ params: idParams, body: policyUpdateSchema }), controller.updatePolicy);
  return router;
}
