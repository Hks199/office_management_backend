import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { AppConfig } from '../../config/env.js';
import { AuthController } from './auth.controller.js';
import type { AuthService } from './auth.service.js';
import { authenticate } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { loginSchema, forgotSchema, resetSchema, changePasswordSchema } from './auth.validator.js';
import { rateStore } from '../../middleware/rate-limiter.js';

export function authRoutes(config: AppConfig, service: AuthService): Router {
  const router = Router();
  const controller = new AuthController(config, service);
  const protection = rateLimit({ ...rateStore(config, 'auth', 15 * 60000), windowMs: 15 * 60000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false,
    handler: (_req, res) => { res.status(429).json({ success: false, message: 'Too many authentication attempts',
      error: { code: 'AUTH_RATE_LIMITED', details: [] } }); } });
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.post('/login', protection, validate({ body: loginSchema }), controller.login);
  router.post('/forgot-password', protection, validate({ body: forgotSchema }), controller.forgotPassword);
  router.post('/reset-password', protection, validate({ body: resetSchema }), controller.resetPassword);
  router.post('/accept-invitation', protection, validate({ body: resetSchema }), controller.acceptInvitation);
  router.get('/csrf', protection, controller.csrfToken);
  router.post('/refresh', protection, controller.refresh);
  router.post('/logout', controller.logout);
  router.post('/logout-all', authenticate(service), controller.logoutAll);
  router.post('/change-password', protection, authenticate(service), validate({ body: changePasswordSchema }), controller.changePassword);
  router.get('/me', authenticate(service), controller.me);
  return router;
}
