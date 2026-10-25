import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Response as TestResponse } from 'supertest';
import { Types, trusted } from 'mongoose';
import type { PermissionCode, DataScope } from '../../src/constants/permissions.js';
import { SignJWT } from 'jose';
import express from 'express';
import { testApp, testConfig } from '../helpers.js';
import { connectDatabase, disconnectDatabase } from '../../src/config/database.js';
import { createLogger } from '../../src/config/logger.js';
import { createIdentityIndexes } from '../../src/modules/auth/identity-indexes.js';
import { bootstrapMd } from '../../src/modules/auth/bootstrap.service.js';
import { UserModel } from '../../src/modules/users/user.model.js';
import { RoleModel } from '../../src/modules/roles/role.model.js';
import { PermissionModel } from '../../src/modules/permissions/permission.model.js';
import { RefreshSessionModel, LoginAttemptModel, CredentialTokenModel } from '../../src/modules/auth/auth.models.js';
import { CredentialDeliveryModel } from '../../src/modules/auth/credential-delivery.model.js';
import { ActivityLogModel } from '../../src/modules/activity-logs/activity-log.model.js';
import { hashPassword, tokenHash, decryptSecret, encryptSecret } from '../../src/shared/utils/crypto.js';
import { deliverCredentials } from '../../src/jobs/credential-delivery.js';
import { CredentialDeliveryWorker } from '../../src/jobs/credential-delivery-worker.js';
import { AuthService } from '../../src/modules/auth/auth.service.js';
import { ScopeService } from '../../src/modules/permissions/authorization.service.js';
import { authenticate } from '../../src/middleware/authenticate.js';
import { authorize } from '../../src/middleware/authorize.js';
import { authorizeScope } from '../../src/middleware/authorize-scope.js';
import { errorHandler } from '../../src/middleware/error-handler.js';
import type { Principal } from '../../src/modules/auth/auth.types.js';

const config = testConfig({ rateLimitMax: 1000 });
const password = 'Correct horse battery 2026!';
const origin = 'http://localhost:5173';
const mdEmail = 'director@example.invalid';
let replica: MongoMemoryReplSet | undefined;
let rootId: Types.ObjectId;
let counter = 0;
let fixtureHash: string;
const app = () => testApp({ rateLimitMax: 1000 });
interface Credentials { accessToken: string; csrfToken: string }
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- Explicit assertion at the HTTP test boundary.
const data = <T>(response: TestResponse): T => (response.body as { data: T }).data;
function cookie(response: TestResponse): string {
  const cookies: unknown = response.headers['set-cookie'];
  if (!Array.isArray(cookies) || typeof cookies[0] !== 'string') throw new Error('Missing refresh cookie');
  return cookies[0].split(';')[0] ?? '';
}
async function login(email = mdEmail, client = app()) {
  const response = await request(client).post('/api/v1/auth/login').send({ email, password }).expect(200);
  return { ...data<Credentials>(response), cookie: cookie(response), response };
}
async function makeUser(roleCode = 'SEX', options: { branchId?: Types.ObjectId; managerId?: Types.ObjectId; roleId?: Types.ObjectId } = {}) {
  const role = options.roleId ? { _id: options.roleId } : await RoleModel.findOne({ code: roleCode }).lean();
  if (!role) throw new Error('Fixture role missing');
  counter++;
  return UserModel.create({ employeeCode: `TEST-${String(counter)}`, firstName: 'Test', lastName: 'Employee',
    email: `employee${String(counter)}@example.invalid`, mobileNumber: `+919000${String(counter).padStart(6, '0')}`,
    passwordHash: fixtureHash, roleId: role._id, branchId: options.branchId ?? new Types.ObjectId(),
    reportingManagerId: options.managerId ?? rootId, dateOfJoining: new Date(), createdBy: rootId });
}
async function customRole(grants: { code: PermissionCode; scope: DataScope }[]) {
  counter++;
  const permissions = [];
  for (const grant of grants) {
    const definition = await PermissionModel.findOne({ code: grant.code }).lean();
    if (!definition) throw new Error('Fixture permission missing');
    permissions.push({ permissionId: definition._id, scope: grant.scope });
  }
  return RoleModel.create({ name: `Custom ${String(counter)}`, code: `CUSTOM_${String(counter)}`, permissions, createdBy: rootId });
}

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await connectDatabase({ ...config, mongodbUri: replica.getUri('phase-two') }, createLogger(config));
  await createIdentityIndexes();
  rootId = await bootstrapMd({ employeeCode: 'MD-001', firstName: 'Managing', lastName: 'Director',
    email: mdEmail, mobileNumber: '+919999999999' }, config.tokenEncryptionKey);
  const delivery = await CredentialDeliveryModel.findOne({ userId: rootId }).select('+encryptedToken').lean();
  if (!delivery) throw new Error('Bootstrap invitation missing');
  const token = decryptSecret(delivery.encryptedToken, config.tokenEncryptionKey);
  await request(app()).post('/api/v1/auth/accept-invitation').send({ token, newPassword: password }).expect(200);
  fixtureHash = await hashPassword(password);
}, 180000);
beforeEach(async () => { await LoginAttemptModel.deleteMany({}); });
afterAll(async () => { await disconnectDatabase(); await replica?.stop(); });

describe('authentication and secure bootstrap', () => {
  it('bootstraps only once and never stores a plaintext invitation', async () => {
    await expect(bootstrapMd({ employeeCode: 'MD-002', firstName: 'Other', lastName: 'Director',
      email: 'other@example.invalid', mobileNumber: '+918888888888' }, config.tokenEncryptionKey)).rejects.toMatchObject({ code: 'ALREADY_BOOTSTRAPPED' });
    expect(await UserModel.countDocuments({ bootstrapKey: 'INITIAL_MD' })).toBe(1);
    const stored = await CredentialTokenModel.findOne({ userId: rootId }).select('+tokenHash').lean();
    expect(stored?.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect((await UserModel.findById(rootId).select('+passwordHash').lean())?.passwordHash).toMatch(/^\$argon2id\$/);
  });
  it('normalizes login and issues HttpOnly scoped cookies, safe profile, and no-store responses', async () => {
    const credentials = await login('DIRECTOR@EXAMPLE.INVALID');
    const headers: unknown = credentials.response.headers['set-cookie'];
    expect(headers).toEqual([expect.stringContaining('HttpOnly')]);
    expect(headers).toEqual([expect.stringContaining('Path=/api/v1/auth')]);
    expect(headers).toEqual([expect.stringContaining('SameSite=Strict')]);
    expect(credentials.response.headers['cache-control']).toBe('no-store');
    expect(credentials.response.text).not.toContain('refreshToken');
    const me = await request(app()).get('/api/v1/auth/me').set('Authorization', `Bearer ${credentials.accessToken}`).expect(200);
    expect(me.text).not.toContain('passwordHash'); expect(me.text).not.toContain('authFence');
    expect(data<{ email: string }>(me).email).toBe(mdEmail);
  });
  it('uses secure cookies in production', async () => {
    const client = testApp({ nodeEnv: 'production', rateLimitMax: 1000 });
    const credentials = await login(mdEmail, client);
    expect(credentials.response.headers['set-cookie']).toEqual([expect.stringContaining('Secure')]);
  });
  it('gives the same error for wrong, unknown and deactivated credentials', async () => {
    const user = await makeUser(); await UserModel.updateOne({ _id: user._id }, { $set: { isActive: false } });
    const responses = [];
    for (const email of [mdEmail, 'unknown@example.invalid', user.email]) {
      responses.push((await request(app()).post('/api/v1/auth/login').send({ email, password: 'incorrect' }).expect(401)).body as unknown);
    }
    expect(responses[0]).toEqual(responses[1]); expect(responses[1]).toEqual(responses[2]);
    await request(app()).post('/api/v1/auth/login').send({ email: user.email, password }).expect(401);
  }, 10000);
  it('throttles normalized account attempts across app instances', async () => {
    for (let index = 0; index < 10; index++) await request(app()).post('/api/v1/auth/login')
      .send({ email: 'unknown@example.invalid', password: 'incorrect' }).expect(401);
    await request(app()).post('/api/v1/auth/login').send({ email: 'UNKNOWN@EXAMPLE.INVALID', password: 'incorrect' }).expect(429);
  }, 15000);
  it('rejects forged identity fields, weak setup passwords and public registration', async () => {
    await request(app()).post('/api/v1/auth/login').send({ email: mdEmail, password, roleId: rootId.toHexString() }).expect(400);
    await request(app()).post('/api/v1/auth/reset-password').send({ token: 'x'.repeat(43), newPassword: 'short' }).expect(400);
    await request(app()).post('/api/v1/auth/register').send({}).expect(404);
  });
  it('requires a valid access token and live employee/session state', async () => {
    await request(app()).get('/api/v1/auth/me').expect(401);
    const user = await makeUser(); const credentials = await login(user.email);
    await UserModel.updateOne({ _id: user._id }, { $set: { isActive: false } });
    await request(app()).get('/api/v1/auth/me').set('Authorization', `Bearer ${credentials.accessToken}`).expect(401);
  });
  it('rejects incorrect algorithms, issuer, audience and expired tokens', async () => {
    const user = await makeUser(); const credentials = await login(user.email);
    const service = new AuthService(config); const principal = await service.authenticate(credentials.accessToken);
    for (const invalid of ['algorithm', 'issuer', 'audience', 'expired']) {
      const token = await new SignJWT({ sid: principal.sessionId.toHexString(), av: 0 })
        .setProtectedHeader({ alg: invalid === 'algorithm' ? 'HS384' : 'HS256', typ: 'JWT' }).setSubject(user._id.toHexString())
        .setIssuer(invalid === 'issuer' ? 'attacker' : config.jwtIssuer).setAudience(invalid === 'audience' ? 'attacker' : config.jwtAudience)
        .setIssuedAt().setExpirationTime(invalid === 'expired' ? Math.floor(Date.now() / 1000) - 1 : '10m')
        .sign(new TextEncoder().encode(config.jwtSecret));
      await request(app()).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`).expect(401);
    }
  });
});

describe('refresh rotation, CSRF and revocation', () => {
  it('requires Origin and session-bound CSRF for refresh/logout', async () => {
    const credentials = await login();
    await request(app()).post('/api/v1/auth/refresh').set('Cookie', credentials.cookie).expect(403);
    await request(app()).post('/api/v1/auth/refresh').set('Cookie', credentials.cookie).set('Origin', origin).expect(403);
    await request(app()).post('/api/v1/auth/refresh').set('Cookie', credentials.cookie).set('Origin', origin)
      .set('X-CSRF-Token', 'x'.repeat(43)).expect(401);
    await request(app()).post('/api/v1/auth/logout').set('Cookie', credentials.cookie).expect(403);
    const recovered = await request(app()).get('/api/v1/auth/csrf').set('Cookie', credentials.cookie).set('Origin', origin).expect(200);
    expect(data<{ csrfToken: string }>(recovered).csrfToken).toBe(credentials.csrfToken);
  });
  it('rotates hashed tokens and commits family revocation on replay', async () => {
    const credentials = await login(); const client = app();
    const rotated = await request(client).post('/api/v1/auth/refresh').set('Cookie', credentials.cookie).set('Origin', origin)
      .set('X-CSRF-Token', credentials.csrfToken).expect(200);
    expect(cookie(rotated)).not.toBe(credentials.cookie);
    const raw = credentials.cookie.split('=')[1] ?? '';
    const record = await RefreshSessionModel.findOne({ tokenHash: tokenHash(raw) }).select('+tokenHash').lean();
    expect(record?.consumedAt).toBeInstanceOf(Date); expect(record?.tokenHash).not.toBe(raw);
    await request(client).post('/api/v1/auth/refresh').set('Cookie', credentials.cookie).set('Origin', origin)
      .set('X-CSRF-Token', credentials.csrfToken).expect(401);
    await request(client).get('/api/v1/auth/me').set('Authorization', `Bearer ${data<Credentials>(rotated).accessToken}`).expect(401);
    expect(await ActivityLogModel.countDocuments({ action: 'REFRESH_REPLAY_DETECTED' })).toBeGreaterThan(0);
  });
  it('serializes concurrent refresh requests and revokes the replayed family', async () => {
    const credentials = await login(); const client = app();
    const responses = await Promise.all([0, 1].map(() => request(client).post('/api/v1/auth/refresh')
      .set('Cookie', credentials.cookie).set('Origin', origin).set('X-CSRF-Token', credentials.csrfToken)));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 401]);
    const success = responses.find((response) => response.status === 200); if (!success) throw new Error('No rotation succeeded');
    await request(client).get('/api/v1/auth/me').set('Authorization', `Bearer ${data<Credentials>(success).accessToken}`).expect(401);
  });
  it('rejects refresh after employee deactivation or role deactivation', async () => {
    const role = await customRole([]); const user = await makeUser('SEX', { roleId: role._id }); const credentials = await login(user.email);
    await RoleModel.updateOne({ _id: role._id }, { $set: { isActive: false } });
    await request(app()).get('/api/v1/auth/me').set('Authorization', `Bearer ${credentials.accessToken}`).expect(401);
    await request(app()).post('/api/v1/auth/refresh').set('Cookie', credentials.cookie).set('Origin', origin)
      .set('X-CSRF-Token', credentials.csrfToken).expect(401);
    await RoleModel.updateOne({ _id: role._id }, { $set: { isActive: true } });
    const second = await login(user.email);
    await UserModel.updateOne({ _id: user._id }, { $set: { isActive: false } });
    await request(app()).post('/api/v1/auth/refresh').set('Cookie', second.cookie).set('Origin', origin)
      .set('X-CSRF-Token', second.csrfToken).expect(401);
  });
  it('rejects expired refresh sessions and does not extend absolute expiry', async () => {
    const credentials = await login(); const raw = credentials.cookie.split('=')[1] ?? '';
    await RefreshSessionModel.updateOne({ tokenHash: tokenHash(raw) }, { $set: { absoluteExpiresAt: new Date(Date.now() + 120000) } });
    const refreshed = await request(app()).post('/api/v1/auth/refresh').set('Cookie', credentials.cookie).set('Origin', origin)
      .set('X-CSRF-Token', credentials.csrfToken).expect(200);
    const replacement = await RefreshSessionModel.findOne({ tokenHash: tokenHash(cookie(refreshed).split('=')[1] ?? '') }).lean();
    expect(replacement?.expiresAt.getTime()).toBe(replacement?.absoluteExpiresAt.getTime());
    await RefreshSessionModel.updateOne({ _id: replacement?._id }, { $set: { expiresAt: new Date(Date.now() - 1) } });
    await request(app()).post('/api/v1/auth/refresh').set('Cookie', cookie(refreshed)).set('Origin', origin)
      .set('X-CSRF-Token', credentials.csrfToken).expect(401);
  });
  it('revokes access immediately on logout and logout-all', async () => {
    const user = await makeUser(); const first = await login(user.email); const second = await login(user.email);
    await request(app()).post('/api/v1/auth/logout').set('Cookie', first.cookie).set('Origin', origin)
      .set('X-CSRF-Token', first.csrfToken).expect(200);
    await request(app()).get('/api/v1/auth/me').set('Authorization', `Bearer ${first.accessToken}`).expect(401);
    await request(app()).get('/api/v1/auth/me').set('Authorization', `Bearer ${second.accessToken}`).expect(200);
    await request(app()).post('/api/v1/auth/logout-all').set('Authorization', `Bearer ${second.accessToken}`).expect(200);
    await request(app()).get('/api/v1/auth/me').set('Authorization', `Bearer ${second.accessToken}`).expect(401);
  });
});

describe('password reset and encrypted delivery', () => {
  it('reissues an invitation only for a pending employee and invalidates the older invitation', async () => {
    const user = await makeUser();
    await UserModel.updateOne({ _id: user._id }, { $unset: { passwordHash: 1 } });
    const service = new AuthService(config); const context = { requestId: 'test-invitation' };
    await service.reissueInvitation(user.employeeCode, context);
    const first = await CredentialDeliveryModel.findOne({ userId: user._id }).select('+encryptedToken').lean(); if (!first) throw new Error('No invitation');
    await service.reissueInvitation(user.employeeCode, context);
    await expect(service.resetPassword(decryptSecret(first.encryptedToken, config.tokenEncryptionKey), password, 'INVITATION', context)).rejects.toMatchObject({ statusCode: 401 });
    const replacement = await CredentialDeliveryModel.findOne({ userId: user._id, credentialId: trusted({ $ne: first.credentialId }) }).select('+encryptedToken').lean();
    if (!replacement) throw new Error('No replacement');
    await service.resetPassword(decryptSecret(replacement.encryptedToken, config.tokenEncryptionKey), password, 'INVITATION', context);
    await expect(service.reissueInvitation(user.employeeCode, context)).rejects.toMatchObject({ code: 'INVITATION_NOT_ALLOWED' });
  });
  it('serializes concurrent single-use reset redemption', async () => {
    const user = await makeUser(); const client = app();
    await request(client).post('/api/v1/auth/forgot-password').send({ email: user.email }).expect(202);
    const job = await CredentialDeliveryModel.findOne({ userId: user._id }).select('+encryptedToken').lean(); if (!job) throw new Error('Missing job');
    const token = decryptSecret(job.encryptedToken, config.tokenEncryptionKey);
    const responses = await Promise.all([0, 1].map(() => request(client).post('/api/v1/auth/reset-password').send({ token, newPassword: password })));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 401]);
  });
  it('keeps provider failures retryable and prevents parallel workers claiming the same message', async () => {
    const user = await makeUser();
    await request(app()).post('/api/v1/auth/forgot-password').send({ email: user.email }).expect(202);
    const job = await CredentialDeliveryModel.findOne({ userId: user._id }).lean(); if (!job) throw new Error('Missing job');
    const errors: string[] = [];
    await deliverCredentials(config, () => Promise.reject(Object.assign(new Error('private-provider-secret'), { code: 'EAUTH' })), 50,
      undefined, (code) => { errors.push(code); });
    const failed = await CredentialDeliveryModel.findById(job._id).lean();
    expect(failed?.status).toBe('FAILED'); expect(failed?.attempts).toBe(1);
    expect(failed?.lastErrorCode).toBe('SMTP_AUTHENTICATION_FAILED');
    expect(errors).toContain('SMTP_AUTHENTICATION_FAILED');
    expect(JSON.stringify(failed)).not.toContain('private-provider-secret');
    await CredentialDeliveryModel.updateOne({ _id: job._id }, { $set: { leaseUntil: new Date(Date.now() - 1) } });
    let sends = 0;
    const sender = () => { sends++; return Promise.resolve(); };
    await Promise.all([deliverCredentials(config, sender), deliverCredentials(config, sender)]);
    expect(sends).toBe(1);
    expect((await CredentialDeliveryModel.findById(job._id).lean())?.lastErrorCode).toBeUndefined();
  });
  it('automatically delivers a queued credential and stops claiming jobs on shutdown', async () => {
    const user = await makeUser();
    await request(app()).post('/api/v1/auth/forgot-password').send({ email: user.email }).expect(202);
    const recipients: string[] = [];
    const worker = new CredentialDeliveryWorker(1000, createLogger({ logLevel: 'silent' }),
      (signal) => deliverCredentials(config, (message) => { recipients.push(message.to); return Promise.resolve(); }, 50, signal));
    worker.start();
    try {
      await expect.poll(async () => (await CredentialDeliveryModel.findOne({ userId: user._id }).lean())?.status).toBe('SENT');
      expect(recipients).toContain(user.email);
    } finally { await worker.stop(); }
    const controller = new AbortController(); controller.abort();
    expect(await deliverCredentials(config, () => { throw new Error('Must not send after abort'); }, 50, controller.signal)).toBe(0);
  });
  it('returns generic recovery responses and sends a single-use token without storing it in plaintext', async () => {
    const user = await makeUser(); const credentials = await login(user.email); const client = app();
    const known = await request(client).post('/api/v1/auth/forgot-password').send({ email: user.email }).expect(202);
    const unknown = await request(client).post('/api/v1/auth/forgot-password').send({ email: 'unknown@example.invalid' }).expect(202);
    expect(known.body).toEqual(unknown.body);
    const messages: string[] = [];
    await deliverCredentials(config, (message) => { messages.push(message.text); return Promise.resolve(); });
    const message = messages.find((text) => text.includes('/reset-password#token=')); if (!message) throw new Error('No reset message');
    const token = message.match(/#token=([A-Za-z0-9_-]{43})/)?.[1]; if (!token) throw new Error('Missing reset token');
    const stored = await CredentialTokenModel.findOne({ userId: user._id, purpose: 'PASSWORD_RESET' }).select('+tokenHash').lean();
    expect(stored?.tokenHash).toBe(tokenHash(token)); expect(known.text).not.toContain(token);
    const next = 'Another strong password 2026!';
    await request(client).post('/api/v1/auth/reset-password').send({ token, newPassword: next }).expect(200);
    await request(client).post('/api/v1/auth/reset-password').send({ token, newPassword: next }).expect(401);
    await request(client).get('/api/v1/auth/me').set('Authorization', `Bearer ${credentials.accessToken}`).expect(401);
    await request(client).post('/api/v1/auth/login').send({ email: user.email, password: next }).expect(200);
    expect(await CredentialDeliveryModel.countDocuments({ status: 'SENT', encryptedToken: trusted({ $exists: true }) })).toBe(0);
  }, 10000);
  it('expires reset tokens and invalidates superseded tokens', async () => {
    const user = await makeUser(); const client = app();
    await request(client).post('/api/v1/auth/forgot-password').send({ email: user.email }).expect(202);
    const first = await CredentialDeliveryModel.findOne({ userId: user._id }).select('+encryptedToken').lean();
    if (!first) throw new Error('No reset');
    await request(client).post('/api/v1/auth/forgot-password').send({ email: user.email }).expect(202);
    await request(client).post('/api/v1/auth/reset-password').send({ token: decryptSecret(first.encryptedToken, config.tokenEncryptionKey), newPassword: password }).expect(401);
    const second = await CredentialDeliveryModel.findOne({ userId: user._id, credentialId: trusted({ $ne: first.credentialId }) }).select('+encryptedToken').lean();
    if (!second) throw new Error('No second reset');
    await CredentialTokenModel.updateOne({ _id: second.credentialId }, { $set: { expiresAt: new Date(Date.now() - 1) } });
    await request(client).post('/api/v1/auth/reset-password').send({ token: decryptSecret(second.encryptedToken, config.tokenEncryptionKey), newPassword: password }).expect(401);
  });
  it('rejects wrong current passwords and revokes all sessions on change', async () => {
    const user = await makeUser(); const credentials = await login(user.email); const client = app();
    await request(client).post('/api/v1/auth/change-password').set('Authorization', `Bearer ${credentials.accessToken}`)
      .send({ currentPassword: 'wrong', newPassword: 'Updated valid password 2026!' }).expect(401);
    await request(client).post('/api/v1/auth/change-password').set('Authorization', `Bearer ${credentials.accessToken}`)
      .send({ currentPassword: password, newPassword: 'Updated valid password 2026!' }).expect(200);
    await request(client).get('/api/v1/auth/me').set('Authorization', `Bearer ${credentials.accessToken}`).expect(401);
    await request(client).post('/api/v1/auth/login').send({ email: user.email, password }).expect(401);
  });
  it('authenticates encrypted delivery payloads against tampering', () => {
    const encrypted = encryptSecret('secret-token', config.tokenEncryptionKey);
    expect(decryptSecret(encrypted, config.tokenEncryptionKey)).toBe('secret-token');
    expect(() => decryptSecret(encrypted, 'cd'.repeat(32))).toThrow();
  });
});

describe('dynamic roles and delegation', () => {
  it('lists, reads, filters, updates and archives an unused custom role', async () => {
    const credentials = await login(); const client = app(); const authorization = `Bearer ${credentials.accessToken}`;
    const created = await request(client).post('/api/v1/roles').set('Authorization', authorization)
      .send({ name: 'Operations [Test]', code: 'OPS_TEST', permissions: [] }).expect(201);
    const role = data<{ _id: string; revision: number }>(created);
    await request(client).get(`/api/v1/roles/${role._id}`).set('Authorization', authorization).expect(200);
    const list = await request(client).get('/api/v1/roles?search=Operations%20%5B&limit=1&isActive=true').set('Authorization', authorization).expect(200);
    expect(list.body).toHaveProperty('meta.total', 1);
    expect(list.body).toHaveProperty('data.0._id', role._id);
    await request(client).patch(`/api/v1/roles/${role._id}`).set('Authorization', authorization)
      .send({ revision: 0, name: 'Operations Approved' }).expect(200);
    await request(client).delete(`/api/v1/roles/${role._id}`).set('Authorization', authorization).send({ revision: 1 }).expect(200);
    expect((await RoleModel.findById(role._id).lean())?.isActive).toBe(false);
    await request(client).get(`/api/v1/roles/${new Types.ObjectId().toHexString()}`).set('Authorization', authorization).expect(404);
  });
  it('keeps audits immutable and rolls back business writes when their required audit insert fails', async () => {
    const event = await ActivityLogModel.findOne().lean(); if (!event) throw new Error('No audit');
    await expect(ActivityLogModel.updateOne({ _id: event._id }, { $set: { action: 'TAMPERED' } })).rejects.toMatchObject({ code: 'AUDIT_IMMUTABLE' });
    await expect(ActivityLogModel.deleteOne({ _id: event._id })).rejects.toMatchObject({ code: 'AUDIT_IMMUTABLE' });
    // Omit requestId through the service to exercise a real audit schema failure inside the transaction.
    const service = new AuthService(config);
    await expect(service.login(mdEmail, password, { requestId: '' })).rejects.toThrow();
    const sessionsBefore = await RefreshSessionModel.countDocuments({ userId: rootId });
    await expect(service.login(mdEmail, password, { requestId: '' })).rejects.toThrow();
    expect(await RefreshSessionModel.countDocuments({ userId: rootId })).toBe(sessionsBefore);
  });
  it('allows MD role creation and rejects employee access, injected permissions and duplicates', async () => {
    const md = await login(); const employee = await makeUser(); const ordinary = await login(employee.email); const client = app();
    await request(client).get('/api/v1/roles').set('Authorization', `Bearer ${ordinary.accessToken}`).expect(403);
    await request(client).post('/api/v1/roles').set('Authorization', `Bearer ${md.accessToken}`)
      .send({ name: 'Area Manager', code: 'AREA_MANAGER', permissions: [] }).expect(201);
    await request(client).post('/api/v1/roles').set('Authorization', `Bearer ${md.accessToken}`)
      .send({ name: 'Area Manager', code: 'AREA_MANAGER', permissions: [] }).expect(409);
    await request(client).post('/api/v1/roles').set('Authorization', `Bearer ${md.accessToken}`)
      .send({ name: 'Bad Role', code: 'BAD_ROLE', permissions: [{ permissionId: new Types.ObjectId().toHexString(), scope: 'ALL' }] }).expect(400);
    await request(client).get('/api/v1/roles?sortBy=passwordHash').set('Authorization', `Bearer ${md.accessToken}`).expect(400);
    await request(client).post('/api/v1/permissions').set('Authorization', `Bearer ${md.accessToken}`).send({ code: 'execute:anything' }).expect(404);
  });
  it('prevents delegated administrators granting a capability they do not hold', async () => {
    const role = await customRole([{ code: 'roles:create', scope: 'ALL' }, { code: 'permissions:assign', scope: 'ALL' }]);
    const user = await makeUser('SEX', { roleId: role._id }); const credentials = await login(user.email);
    const permission = await PermissionModel.findOne({ code: 'users:read' }).lean(); if (!permission) throw new Error('Missing registry');
    await request(app()).post('/api/v1/roles').set('Authorization', `Bearer ${credentials.accessToken}`)
      .send({ name: 'Escalated', code: 'ESCALATED', permissions: [{ permissionId: permission._id.toHexString(), scope: 'SELF' }] }).expect(403);
  });
  it('requires permission delegation checks before reactivating an existing powerful role', async () => {
    const actorRole = await customRole([{ code: 'roles:update', scope: 'ALL' }]);
    const actor = await makeUser('SEX', { roleId: actorRole._id }); const credentials = await login(actor.email);
    const powerful = await customRole([{ code: 'users:read', scope: 'ALL' }]);
    await RoleModel.updateOne({ _id: powerful._id }, { $set: { isActive: false } });
    await request(app()).patch(`/api/v1/roles/${powerful._id.toHexString()}`).set('Authorization', `Bearer ${credentials.accessToken}`)
      .send({ revision: 0, isActive: true }).expect(403);
  });
  it('protects system roles and the administrator core grants', async () => {
    const credentials = await login(); const md = await RoleModel.findOne({ code: 'MD' }).lean(); if (!md) throw new Error('Missing MD');
    const client = app(); const authorization = `Bearer ${credentials.accessToken}`;
    await request(client).delete(`/api/v1/roles/${md._id.toHexString()}`).set('Authorization', authorization).send({ revision: md.revision }).expect(403);
    await request(client).patch(`/api/v1/roles/${md._id.toHexString()}`).set('Authorization', authorization).send({ revision: md.revision, isActive: false }).expect(403);
    await request(client).patch(`/api/v1/roles/${md._id.toHexString()}`).set('Authorization', authorization).send({ revision: md.revision, permissions: [] }).expect(403);
  });
  it('applies permission changes immediately to an existing access token and enforces revision checks', async () => {
    const role = await customRole([{ code: 'permissions:read', scope: 'ALL' }]); const user = await makeUser('SEX', { roleId: role._id });
    const credentials = await login(user.email); const md = await login(); const client = app();
    await request(client).get('/api/v1/permissions').set('Authorization', `Bearer ${credentials.accessToken}`).expect(200);
    await request(client).patch(`/api/v1/roles/${role._id.toHexString()}`).set('Authorization', `Bearer ${md.accessToken}`)
      .send({ revision: 0, permissions: [] }).expect(200);
    await request(client).get('/api/v1/permissions').set('Authorization', `Bearer ${credentials.accessToken}`).expect(403);
    await request(client).patch(`/api/v1/roles/${role._id.toHexString()}`).set('Authorization', `Bearer ${md.accessToken}`)
      .send({ revision: 0, name: 'Stale edit' }).expect(409);
    await request(client).delete(`/api/v1/roles/${role._id.toHexString()}`).set('Authorization', `Bearer ${md.accessToken}`).send({ revision: 1 }).expect(409);
  });
  it('rejects invalid role-creation policies and permits a valid custom-role relationship', async () => {
    const credentials = await login(); const creator = await customRole([]); const target = await customRole([]); const client = app();
    const md = await RoleModel.findOne({ code: 'MD' }).lean(); if (!md) throw new Error('Missing MD');
    await request(client).post('/api/v1/role-creation-policies').set('Authorization', `Bearer ${credentials.accessToken}`)
      .send({ creatorRoleId: creator._id.toHexString(), targetRoleId: md._id.toHexString(), allowedManagerRoleIds: [creator._id.toHexString()] }).expect(403);
    const response = await request(client).post('/api/v1/role-creation-policies').set('Authorization', `Bearer ${credentials.accessToken}`)
      .send({ creatorRoleId: creator._id.toHexString(), targetRoleId: target._id.toHexString(), allowedManagerRoleIds: [creator._id.toHexString()] }).expect(201);
    expect(data<{ allowCrossBranchReporting: boolean }>(response).allowCrossBranchReporting).toBe(false);
    const policyId = data<{ _id: string }>(response)._id;
    const filtered = await request(client).get(`/api/v1/role-creation-policies?creatorRoleId=${creator._id.toHexString()}&isActive=true&limit=1`)
      .set('Authorization', `Bearer ${credentials.accessToken}`).expect(200);
    expect(filtered.body).toHaveProperty('meta.total', 1);
    await request(client).put(`/api/v1/role-creation-policies/${policyId}`).set('Authorization', `Bearer ${credentials.accessToken}`)
      .send({ revision: 0, creatorRoleId: creator._id.toHexString(), targetRoleId: target._id.toHexString(),
        allowedManagerRoleIds: [creator._id.toHexString()], isActive: false }).expect(200);
    await request(client).put(`/api/v1/role-creation-policies/${policyId}`).set('Authorization', `Bearer ${credentials.accessToken}`)
      .send({ revision: 0, creatorRoleId: creator._id.toHexString(), targetRoleId: target._id.toHexString(),
        allowedManagerRoleIds: [creator._id.toHexString()], isActive: true }).expect(409);
    expect(await ActivityLogModel.countDocuments({ action: 'ROLE_CREATION_POLICY_CHANGED' })).toBeGreaterThan(0);
  });
});

describe('query scope authorization and IDOR', () => {
  it('unions explicit scopes and rejects missing branch/unsupported scope combinations', async () => {
    const manager = await makeUser('BH'); const service = new ScopeService();
    const principal: Principal = { userId: manager._id, roleId: manager.roleId, sessionId: new Types.ObjectId(), branchId: null, authVersion: 0,
      grants: [{ permission: 'users:read', scope: 'BRANCH' }] };
    await expect(service.predicate(principal, 'users:read', { branchField: 'branchId' })).rejects.toMatchObject({ statusCode: 403 });
    principal.grants = [{ permission: 'users:read', scope: 'SELF' }, { permission: 'users:read', scope: 'REPORTING_SUBTREE' }];
    const child = await makeUser('SEX', { managerId: manager._id });
    const predicate = await service.predicate(principal, 'users:read', { ownerField: '_id' });
    expect(await UserModel.countDocuments(predicate)).toBe(2);
    expect(await UserModel.countDocuments(service.combine(predicate, { _id: child._id }))).toBe(1);
    principal.grants = [{ permission: 'users:read', scope: 'ALL' }];
    expect(await service.predicate(principal, 'users:read', {})).toEqual({});
  });
  it('isolates SELF, direct reports, subtree, branch and assigned resources and intersects client filters', async () => {
    const branch = new Types.ObjectId(); const manager = await makeUser('BH', { branchId: branch });
    const direct = await makeUser('SEX', { branchId: branch, managerId: manager._id });
    const deeper = await makeUser('SEX', { branchId: new Types.ObjectId(), managerId: direct._id });
    const peer = await makeUser('SEX', { branchId: branch }); const unrelated = await makeUser();
    const service = new ScopeService();
    const base: Principal = { userId: manager._id, branchId: branch, roleId: manager.roleId, sessionId: new Types.ObjectId(), authVersion: 0, grants: [] };
    for (const [scope, expected] of [
      ['SELF', [manager._id]], ['DIRECT_REPORTS', [direct._id]], ['REPORTING_SUBTREE', [direct._id, deeper._id]],
      ['BRANCH', [manager._id, direct._id, peer._id]],
    ] as const) {
      const predicate = await service.predicate({ ...base, grants: [{ permission: 'users:read', scope }] }, 'users:read', { ownerField: '_id', branchField: 'branchId' });
      const actual = (await UserModel.find(predicate).select('_id').lean()).map((user) => user._id.toHexString()).sort();
      expect(actual).toEqual(expected.map((id) => id.toHexString()).sort());
      expect(await UserModel.countDocuments(service.combine(predicate, { _id: unrelated._id }))).toBe(0);
    }
    const assigned = await service.predicate({ ...base, grants: [{ permission: 'leads:read', scope: 'ASSIGNED' }] }, 'leads:read', { assigneeField: 'assignedTo' });
    expect(assigned).toEqual({ $or: [{ assignedTo: manager._id }] });
    await expect(service.predicate({ ...base, grants: [] }, 'users:read', { ownerField: '_id' })).rejects.toMatchObject({ statusCode: 403 });
  });
  it('enforces scope middleware for list and individual endpoints and reevaluates manager transfers', async () => {
    const manager = await makeUser('BDO'); const child = await makeUser('SEX', { managerId: manager._id }); const peer = await makeUser();
    const credentials = await login(manager.email); const scopedApp = express();
    scopedApp.use(authenticate(new AuthService(config)), authorize('users:read'), authorizeScope('users:read', { ownerField: '_id', branchField: 'branchId' }));
    scopedApp.get('/users', async (_req, res) => { res.json(await UserModel.find(res.locals.scope ?? { _id: null }).select('_id').lean()); });
    scopedApp.get('/users/:id', async (req, res) => {
      const user = await UserModel.findOne({ $and: [res.locals.scope ?? { _id: null }, { _id: req.params.id }] }).select('_id').lean();
      res.status(user ? 200 : 404).json(user);
    });
    scopedApp.use(errorHandler(createLogger(config)));
    const authorization = `Bearer ${credentials.accessToken}`;
    await request(scopedApp).get(`/users/${child._id.toHexString()}`).set('Authorization', authorization).expect(200);
    await request(scopedApp).get(`/users/${peer._id.toHexString()}`).set('Authorization', authorization).expect(404);
    await UserModel.updateOne({ _id: child._id }, { $set: { reportingManagerId: peer._id } });
    await request(scopedApp).get(`/users/${child._id.toHexString()}`).set('Authorization', authorization).expect(404);
    const list = await request(scopedApp).get('/users').set('Authorization', authorization).expect(200);
    expect(list.text).not.toContain(peer._id.toHexString());
  });
});
