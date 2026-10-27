import { createHmac, randomUUID } from 'node:crypto';
import { Types, type ClientSession } from 'mongoose';
import type { AppConfig } from '../../config/env.js';
import { AppError } from '../../shared/errors/app-error.js';
import { randomToken, tokenHash, csrfToken, constantEqual, hashPassword, verifyPassword, encryptSecret } from '../../shared/utils/crypto.js';
import { AuthRepository } from './auth.repository.js';
import { TokenService } from './token.service.js';
import { AuthorizationService } from '../permissions/authorization.service.js';
import { audit, type AuditContext } from '../activity-logs/audit.service.js';
import type { Principal, SessionCredentials } from './auth.types.js';

const denied = () => new AppError(401, 'INVALID_CREDENTIALS', 'Invalid credentials or session');

export class AuthService {
  readonly tokens: TokenService;
  private readonly authorization = new AuthorizationService();
  private dummyHash: Promise<string> | undefined;
  constructor(private readonly config: AppConfig, private readonly repository = new AuthRepository()) {
    this.tokens = new TokenService(config);
  }

  private async throttle(email: string, operation: string, limit: number): Promise<void> {
    const windowMs = 15 * 60 * 1000;
    const key = createHmac('sha256', this.config.jwtSecret).update(`${operation}:${email}`).digest('hex');
    if (await this.repository.reserveLogin(key, new Date(Date.now() + windowMs)) > limit) {
      throw new AppError(429, 'AUTH_RATE_LIMITED', 'Too many authentication attempts; try again later');
    }
  }

  async login(email: string, password: string, context: AuditContext): Promise<SessionCredentials> {
    await this.throttle(email, 'login', 10);
    const user = await this.repository.userByEmail(email);
    const hash = user?.passwordHash ?? await (this.dummyHash ??= hashPassword(randomToken()).catch((error: unknown) => {
      this.dummyHash = undefined;
      throw error;
    }));
    const valid = await verifyPassword(hash, password);
    if (!user || !valid || !user.isActive || user.employmentStatus === 'EXITED') throw denied();
    return this.repository.transaction(async (session) => {
      const locked = await this.repository.lockUser(user._id, session);
      if (!locked || locked.passwordHash !== hash || !(await this.authorization.grants(locked.roleId, session))) throw denied();
      const credentials = await this.newSession(locked._id, locked.authVersion, randomUUID(), null,
        new Date(Date.now() + this.config.refreshAbsoluteDays * 86400000), session);
      await this.repository.loggedIn(locked._id, session);
      await audit(session, context, 'LOGIN', locked._id, 'refresh_session', credentials.sessionId);
      return credentials.value;
    });
  }

  private async newSession(userId: Types.ObjectId, authVersion: number, familyId: string,
    parentId: Types.ObjectId | null, absoluteExpiresAt: Date, session: ClientSession,
    sessionId = new Types.ObjectId()): Promise<{ sessionId: Types.ObjectId; value: SessionCredentials }> {
    const refreshToken = randomToken();
    const csrf = csrfToken(familyId, this.config.jwtSecret);
    const expiresAt = new Date(Math.min(Date.now() + this.config.refreshTtlDays * 86400000, absoluteExpiresAt.getTime()));
    await this.repository.createSession({ _id: sessionId, userId, familyId, parentId, tokenHash: tokenHash(refreshToken),
      csrfHash: tokenHash(csrf), expiresAt, absoluteExpiresAt, authVersion }, session);
    return { sessionId, value: { refreshToken, csrfToken: csrf,
      accessToken: await this.tokens.sign(userId, sessionId, authVersion), expiresAt } };
  }

  private async cookieSession(refreshToken: string, csrf: string) {
    const record = await this.repository.sessionByHash(tokenHash(refreshToken));
    if (!record || !constantEqual(record.csrfHash, tokenHash(csrf))) throw denied();
    return record;
  }

  async csrf(refreshToken: string): Promise<string> {
    const record = await this.repository.sessionByHash(tokenHash(refreshToken));
    if (!record || record.consumedAt || record.revokedAt || record.expiresAt.getTime() <= Date.now() ||
      record.absoluteExpiresAt.getTime() <= Date.now()) throw denied();
    const user = await this.repository.userById(record.userId);
    if (!user?.isActive || user.employmentStatus === 'EXITED' || user.authVersion !== record.authVersion ||
      !(await this.authorization.grants(user.roleId))) throw denied();
    return csrfToken(record.familyId, this.config.jwtSecret);
  }

  async refresh(refreshToken: string, csrf: string, context: AuditContext): Promise<SessionCredentials> {
    const initial = await this.cookieSession(refreshToken, csrf);
    const outcome = await this.repository.transaction(async (session) => {
      const user = await this.repository.lockUser(initial.userId, session);
      const record = await this.repository.sessionByHash(tokenHash(refreshToken), session);
      if (!record || record.revokedAt || record.expiresAt.getTime() <= Date.now() || record.absoluteExpiresAt.getTime() <= Date.now()) {
        return null;
      }
      if (record.consumedAt || !user || user.authVersion !== record.authVersion || !(await this.authorization.grants(user.roleId, session))) {
        await this.repository.revokeFamily(record.familyId, session);
        await audit(session, context, record.consumedAt ? 'REFRESH_REPLAY_DETECTED' : 'SESSION_REVOKED',
          record.userId, 'refresh_session', record._id);
        return null; // Commit revocation before returning 401; throwing here would roll it back.
      }
      const replacement = new Types.ObjectId();
      if (!(await this.repository.consumeSession(record._id, replacement, session))) return null;
      const credentials = await this.newSession(user._id, user.authVersion, record.familyId, record._id,
        record.absoluteExpiresAt, session, replacement);
      await audit(session, context, 'SESSION_REFRESHED', user._id, 'refresh_session', replacement);
      return credentials.value;
    });
    if (!outcome) throw denied();
    return outcome;
  }

  async logout(refreshToken: string, csrf: string, context: AuditContext): Promise<void> {
    const record = await this.cookieSession(refreshToken, csrf);
    await this.repository.transaction(async (session) => {
      await this.repository.lockUser(record.userId, session);
      await this.repository.revokeFamily(record.familyId, session);
      await audit(session, context, 'LOGOUT', record.userId, 'refresh_session', record._id);
    });
  }

  async authenticate(accessToken: string): Promise<Principal> {
    const claims = await this.tokens.verify(accessToken);
    const user = await this.repository.userById(claims.userId);
    if (!user?.isActive || user.employmentStatus === 'EXITED' || user.authVersion !== claims.authVersion) throw denied();
    const session = await this.repository.activeSession(claims.sessionId, claims.userId);
    if (!session || session.authVersion !== user.authVersion) throw denied();
    const grants = await this.authorization.grants(user.roleId);
    if (!grants) throw denied();
    return { userId: user._id, roleId: user.roleId, sessionId: session._id,
      branchId: user.branchId ?? null, grants, authVersion: user.authVersion };
  }

  async me(principal: Principal) {
    const user = await this.repository.userById(principal.userId);
    if (!user) throw denied();
    return { id: user._id, employeeCode: user.employeeCode, firstName: user.firstName, lastName: user.lastName,
      email: user.email, mobileNumber: user.mobileNumber, roleId: user.roleId, branchId: user.branchId,
      reportingManagerId: user.reportingManagerId, grants: principal.grants,
      ...(principal.employeePanel ? { employeePanel: { managerName: principal.employeePanel.managerName,
        expiresAt: principal.employeePanel.expiresAt } } : {}) };
  }

  async logoutAll(principal: Principal, context: AuditContext): Promise<void> {
    await this.repository.transaction(async (session) => {
      const user = await this.repository.lockUser(principal.userId, session);
      if (!user || user.authVersion !== principal.authVersion || !(await this.repository.activeSession(principal.sessionId, user._id, session))) throw denied();
      await this.repository.revokeAll(user._id, session);
      await audit(session, context, 'LOGOUT_ALL', user._id, 'user', user._id);
    });
  }

  async changePassword(principal: Principal, current: string, next: string, context: AuditContext): Promise<void> {
    const user = await this.repository.userById(principal.userId);
    if (!user?.passwordHash || !(await verifyPassword(user.passwordHash, current))) throw denied();
    const hash = await hashPassword(next);
    await this.repository.transaction(async (session) => {
      const locked = await this.repository.lockUser(user._id, session);
      if (!locked || locked.passwordHash !== user.passwordHash || locked.authVersion !== principal.authVersion ||
        !(await this.repository.activeSession(principal.sessionId, locked._id, session))) throw denied();
      await this.repository.changePassword(locked._id, hash, session);
      await audit(session, context, 'PASSWORD_CHANGED', locked._id, 'user', locked._id);
    });
  }

  async forgotPassword(email: string, context: AuditContext): Promise<void> {
    await this.throttle(email, 'recovery', 3);
    const user = await this.repository.userByEmail(email);
    if (!user?.isActive || !user.passwordHash || user.employmentStatus === 'EXITED') return;
    const token = randomToken();
    await this.repository.transaction(async (session) => {
      const locked = await this.repository.lockUser(user._id, session);
      if (!locked?.passwordHash) return;
      await this.repository.queueCredential(user._id, 'PASSWORD_RESET', tokenHash(token),
        encryptSecret(token, this.config.tokenEncryptionKey), new Date(Date.now() + 30 * 60000), session);
      await audit(session, context, 'PASSWORD_RESET_REQUESTED', user._id, 'user', user._id);
    });
  }

  // Internal operational command only; never exposed through a public HTTP route.
  async reissueInvitation(employeeCode: string, context: AuditContext): Promise<void> {
    const employee = await this.repository.userByEmployeeCode(employeeCode);
    if (!employee) throw new AppError(404, 'NOT_FOUND', 'Pending employee not found');
    await this.repository.transaction(async (session) => {
      const user = await this.repository.lockUser(employee._id, session);
      if (!user || user.passwordHash || !(await this.authorization.grants(user.roleId, session))) {
        throw new AppError(409, 'INVITATION_NOT_ALLOWED', 'Employee is not eligible for an initial invitation');
      }
      const token = randomToken();
      await this.repository.queueCredential(user._id, 'INVITATION', tokenHash(token),
        encryptSecret(token, this.config.tokenEncryptionKey), new Date(Date.now() + 86400000), session);
      await audit(session, context, 'INVITATION_REISSUED', null, 'user', user._id);
    });
  }

  async resetPassword(token: string, password: string, purpose: 'INVITATION' | 'PASSWORD_RESET', context: AuditContext): Promise<void> {
    const hash = await hashPassword(password);
    await this.repository.transaction(async (session) => {
      const credential = await this.repository.credentialByHash(tokenHash(token), purpose, session);
      if (!credential) throw denied();
      const user = await this.repository.lockUser(credential.userId, session);
      if (!user || (purpose === 'INVITATION' && user.passwordHash) || !(await this.authorization.grants(user.roleId, session)) ||
        !(await this.repository.consumeCredential(credential._id, session))) throw denied();
      await this.repository.changePassword(user._id, hash, session);
      await audit(session, context, purpose === 'INVITATION' ? 'INVITATION_ACCEPTED' : 'PASSWORD_RESET', user._id, 'user', user._id);
    });
  }
}
