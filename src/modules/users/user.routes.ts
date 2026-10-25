import { Router } from 'express';
import type { AppConfig } from '../../config/env.js';
import type { AuthService } from '../auth/auth.service.js';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { idParams } from '../roles/role.validator.js';
import { UserService } from './user.service.js';
import { UserController } from './user.controller.js';
import { employeeCreateSchema, employeeUpdateSchema, employeeManagerSchema, employeeTransferSchema,
  employeeRoleSchema, employeeStatusSchema, employeeQuerySchema, hierarchyQuerySchema, employeeRoleOptionsQuery, employeeBranchOptionsQuery } from './user.validator.js';
export function userRoutes(config: AppConfig, auth: AuthService): Router {
  const router = Router(); const controller = new UserController(new UserService(config)); router.use(authenticate(auth));
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.get('/', authorize('users:read'), validate({ query: employeeQuerySchema }), controller.list);
  router.post('/', authorize('users:create'), validate({ body: employeeCreateSchema }), controller.create);
  router.get('/role-options', authorize('users:create'), validate({ query: employeeRoleOptionsQuery }), controller.roleOptions('users:create'));
  router.get('/role-options/assignment', authorize('roles:assign'), validate({ query: employeeRoleOptionsQuery }), controller.roleOptions('roles:assign'));
  router.get('/branch-options', authorize('users:create'), validate({ query: employeeBranchOptionsQuery }), controller.branchOptions);
  router.get('/manager-options', authorize('users:create'), validate({ query: employeeBranchOptionsQuery }), controller.managerOptions);
  router.get('/hierarchy', authorize('hierarchy:read'), validate({ query: hierarchyQuerySchema }), controller.tree(true));
  router.get('/downlines', authorize('hierarchy:read'), validate({ query: hierarchyQuerySchema }), controller.tree(false));
  router.get('/:id', authorize('users:read'), validate({ params: idParams }), controller.get);
  router.patch('/:id', authorize('users:update'), validate({ params: idParams, body: employeeUpdateSchema }), controller.update);
  router.patch('/:id/manager', authorize('users:change_manager'), validate({ params: idParams, body: employeeManagerSchema }), controller.manager);
  router.patch('/:id/branch', authorize('users:transfer'), validate({ params: idParams, body: employeeTransferSchema }), controller.transfer);
  router.patch('/:id/status', authorize('users:deactivate'), validate({ params: idParams, body: employeeStatusSchema }), controller.status);
  router.patch('/:id/role', authorize('roles:assign'), validate({ params: idParams, body: employeeRoleSchema }), controller.role);
  return router;
}
