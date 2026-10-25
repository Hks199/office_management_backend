import type { Request, Response, CookieOptions } from 'express';
import type { AppConfig } from '../../config/env.js';
import type { AuthService } from './auth.service.js';
import type { Principal, SessionCredentials } from './auth.types.js';
import { AppError } from '../../shared/errors/app-error.js';
import { sendSuccess } from '../../shared/utils/response.js';

export const REFRESH_COOKIE = 'sunvika_refresh';
export function principalFrom(res: Response): Principal {
  if (!res.locals.principal) throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
  return res.locals.principal;
}
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- Explicit DTO assertion after route-level Joi validation.
export function bodyFrom<T>(res: Response): T { return res.locals.validated?.body as T; }

export class AuthController {
  private readonly cookieOptions: CookieOptions;
  constructor(private readonly config: AppConfig, private readonly service: AuthService) {
    this.cookieOptions = { httpOnly: true, secure: config.nodeEnv === 'production', sameSite: 'strict', path: '/api/v1/auth' };
  }
  private cookie(req: Request): string {
    const cookies: unknown = req.cookies;
    if (!cookies || typeof cookies !== 'object' || !(REFRESH_COOKIE in cookies) ||
      typeof cookies[REFRESH_COOKIE] !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(cookies[REFRESH_COOKIE])) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid credentials or session');
    }
    return cookies[REFRESH_COOKIE];
  }
  private origin(req: Request): void {
    const origin = req.get('Origin');
    if (!origin || !this.config.corsOrigins.includes(origin)) throw new AppError(403, 'CSRF_FAILED', 'Valid Origin and CSRF token required');
  }
  private csrf(req: Request): string {
    this.origin(req);
    const token = req.get('X-CSRF-Token');
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new AppError(403, 'CSRF_FAILED', 'Valid Origin and CSRF token required');
    return token;
  }
  private credentials(res: Response, value: SessionCredentials): void {
    res.cookie(REFRESH_COOKIE, value.refreshToken, { ...this.cookieOptions, expires: value.expiresAt });
    sendSuccess(res, { accessToken: value.accessToken, csrfToken: value.csrfToken,
      expiresIn: this.config.accessTtlSeconds }, 'Authenticated');
  }
  login = async (_req: Request, res: Response): Promise<void> => {
    const body = bodyFrom<{ email: string; password: string }>(res);
    this.credentials(res, await this.service.login(body.email, body.password, res.locals));
  };
  refresh = async (req: Request, res: Response): Promise<void> => {
    const csrf = this.csrf(req);
    this.credentials(res, await this.service.refresh(this.cookie(req), csrf, res.locals));
  };
  logout = async (req: Request, res: Response): Promise<void> => {
    const csrf = this.csrf(req);
    await this.service.logout(this.cookie(req), csrf, res.locals);
    res.clearCookie(REFRESH_COOKIE, this.cookieOptions);
    sendSuccess(res, {}, 'Logged out');
  };
  csrfToken = async (req: Request, res: Response): Promise<void> => {
    this.origin(req);
    sendSuccess(res, { csrfToken: await this.service.csrf(this.cookie(req)) });
  };
  me = async (_req: Request, res: Response): Promise<void> => { sendSuccess(res, await this.service.me(principalFrom(res))); };
  logoutAll = async (_req: Request, res: Response): Promise<void> => {
    await this.service.logoutAll(principalFrom(res), res.locals);
    res.clearCookie(REFRESH_COOKIE, this.cookieOptions);
    sendSuccess(res, {}, 'All sessions revoked');
  };
  changePassword = async (_req: Request, res: Response): Promise<void> => {
    const body = bodyFrom<{ currentPassword: string; newPassword: string }>(res);
    await this.service.changePassword(principalFrom(res), body.currentPassword, body.newPassword, res.locals);
    res.clearCookie(REFRESH_COOKIE, this.cookieOptions);
    sendSuccess(res, {}, 'Password changed; sign in again');
  };
  forgotPassword = async (_req: Request, res: Response): Promise<void> => {
    await this.service.forgotPassword(bodyFrom<{ email: string }>(res).email, res.locals);
    sendSuccess(res, {}, 'If the account is eligible, password reset instructions will be sent', 202);
  };
  resetPassword = async (_req: Request, res: Response): Promise<void> => {
    const body = bodyFrom<{ token: string; newPassword: string }>(res);
    await this.service.resetPassword(body.token, body.newPassword, 'PASSWORD_RESET', res.locals);
    res.clearCookie(REFRESH_COOKIE, this.cookieOptions);
    sendSuccess(res, {}, 'Password reset; sign in again');
  };
  acceptInvitation = async (_req: Request, res: Response): Promise<void> => {
    const body = bodyFrom<{ token: string; newPassword: string }>(res);
    await this.service.resetPassword(body.token, body.newPassword, 'INVITATION', res.locals);
    sendSuccess(res, {}, 'Password configured; sign in');
  };
}
