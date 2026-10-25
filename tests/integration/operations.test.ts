import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose, { Types } from 'mongoose';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import request from 'supertest';
import { testApp, testConfig } from '../helpers.js';
import { connectDatabase, disconnectDatabase } from '../../src/config/database.js';
import { createLogger } from '../../src/config/logger.js';
import { createProductionIndexes, inspectProductionDatabase } from '../../src/modules/operations/production-indexes.js';
import { RequestLimitModel } from '../../src/modules/operations/rate-limit.model.js';
import { MongoRateStore } from '../../src/modules/operations/mongo-rate-store.js';
import { bootstrapMd } from '../../src/modules/auth/bootstrap.service.js';
import { AuthService } from '../../src/modules/auth/auth.service.js';
import { UserModel } from '../../src/modules/users/user.model.js';
import { RoleModel } from '../../src/modules/roles/role.model.js';
import { PermissionModel } from '../../src/modules/permissions/permission.model.js';
import { CredentialDeliveryModel } from '../../src/modules/auth/credential-delivery.model.js';
import { hashPassword } from '../../src/shared/utils/crypto.js';

const config = testConfig(); let replica: MongoMemoryReplSet | undefined; let token: string; let roleId: Types.ObjectId;
function database() { const db = mongoose.connection.db; if (!db) throw new Error('Missing test database'); return db; }
beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await connectDatabase({ ...config, nodeEnv: 'production', mongodbUri: replica.getUri('production-tests') }, createLogger(config));
  expect(await database().listCollections().toArray()).toEqual([]);
  await createProductionIndexes();
  const root = await bootstrapMd({ employeeCode: 'OPS-MD', firstName: 'Operations', lastName: 'Fixture', email: 'ops@example.invalid', mobileNumber: '+919999999999' }, config.tokenEncryptionKey);
  await UserModel.updateOne({ _id: root }, { $set: { passwordHash: await hashPassword('Operations fixture password 2026!') } });
  token = (await new AuthService(config).login('ops@example.invalid', 'Operations fixture password 2026!', { requestId: 'fixture' })).accessToken;
  const user = await UserModel.findById(root).lean(); if (!user) throw new Error('Missing fixture'); roleId = user.roleId;
}, 180000);
afterAll(async () => { vi.restoreAllMocks(); await disconnectDatabase(); await replica?.stop(); });

it('checks all installed index keys/options without modifying roles or dropping extra indexes', async () => {
  const before = JSON.stringify(await RoleModel.findById(roleId).lean());
  await UserModel.collection.createIndex({ firstName: 1 }, { name: 'operator_extra_index' });
  await createProductionIndexes();
  const result = await inspectProductionDatabase();
  expect(result.ready).toBe(true); expect(result.checkedIndexes).toBeGreaterThan(80);
  expect(JSON.stringify(await RoleModel.findById(roleId).lean())).toBe(before);
  expect((await UserModel.collection.indexes()).some((item) => item.name === 'operator_extra_index')).toBe(true);
  await RequestLimitModel.collection.dropIndex('expiresAt_1');
  expect((await inspectProductionDatabase()).missing).toContainEqual({ collection: 'request_limits', key: '{"expiresAt":1}', reason: 'INDEX_MISSING' });
  await RequestLimitModel.collection.createIndex({ expiresAt: 1 });
  expect((await inspectProductionDatabase()).missing).toContainEqual({ collection: 'request_limits', key: '{"expiresAt":1}', reason: 'INDEX_OPTIONS_MISMATCH' });
  await RequestLimitModel.collection.dropIndex('expiresAt_1'); await RequestLimitModel.createIndexes();
});
it('shares concurrent quotas across stores, namespaces windows and hashes client identifiers', async () => {
  // Keep synthetic windows ahead of the real TTL sweeper while advancing deterministically.
  let now = Date.now() + 60000;
  const first = new MongoRateStore(config.jwtSecret, 'http', 1000, () => now);
  const second = new MongoRateStore(config.jwtSecret, 'http', 1000, () => now);
  const hits = await Promise.all(Array.from({ length: 20 }, (_, index) => (index % 2 ? first : second).increment('192.0.2.123')));
  expect(hits.map((item) => item.totalHits).sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
  expect(JSON.stringify(await RequestLimitModel.find({}).lean())).not.toContain('192.0.2.123');
  expect((await new MongoRateStore(config.jwtSecret, 'auth', 1000, () => now).increment('192.0.2.123')).totalHits).toBe(1);
  now += 1000; expect((await first.increment('192.0.2.123')).totalHits).toBe(1);
  await first.decrement('192.0.2.123'); expect((await second.increment('192.0.2.123')).totalHits).toBe(1);
  await first.resetKey('192.0.2.123'); expect((await second.increment('192.0.2.123')).totalHits).toBe(1);
});
it('enforces one HTTP quota across separate applications and fails closed on store errors', async () => {
  await RequestLimitModel.deleteMany({});
  const options = { rateLimitStore: 'mongo' as const, rateLimitMax: 2 };
  const first = testApp(options); const second = testApp(options);
  await request(first).get('/missing').expect(404); await request(second).get('/missing').expect(404);
  await request(first).get('/missing').expect(429);
  const failure = vi.spyOn(RequestLimitModel, 'findOneAndUpdate').mockImplementation(() => { throw new Error('private-database-credentials'); });
  try {
    const response = await request(second).get('/missing').expect(503);
    expect(response.body).toMatchObject({ error: { code: 'RATE_LIMIT_UNAVAILABLE' } });
    expect(response.text).not.toContain('private-database-credentials');
    await request(second).get('/api/v1/health/live').expect(200);
  } finally { failure.mockRestore(); }
});
it('protects metrics with live ALL administration, rejects unknown filters and excludes secrets', async () => {
  const app = testApp(); const path = '/api/v1/operations/metrics';
  await request(app).get(path).expect(401);
  await request(app).get(`${path}?employeeId=forged`).set('Authorization', `Bearer ${token}`).expect(400);
  const result = await request(app).get(path).set('Authorization', `Bearer ${token}`).expect(200);
  expect(result.headers['cache-control']).toBe('no-store');
  expect(result.body).toMatchObject({ data: { http: { scope: 'PROCESS', statuses: { '4xx': 2 } }, queues: { credential_deliveries: [{ status: 'PENDING', count: 1 }] } } });
  const job = await CredentialDeliveryModel.findOne({}).select('+encryptedToken').lean();
  if (!job) throw new Error('Missing fixture job');
  expect(job.encryptedToken).toBeTruthy(); expect(result.text).not.toContain(job.encryptedToken); expect(result.text).not.toContain('ops@example.invalid');
  const permission = await PermissionModel.findOne({ code: 'settings:manage' }).lean();
  const role = await RoleModel.findById(roleId).lean(); if (!permission || !role) throw new Error('Missing permission');
  try {
    await RoleModel.updateOne({ _id: roleId }, { $set: { permissions: role.permissions.filter((item) => !item.permissionId.equals(permission._id)) } });
    await request(app).get(path).set('Authorization', `Bearer ${token}`).expect(403);
  } finally { await RoleModel.updateOne({ _id: roleId }, { $set: { permissions: role.permissions } }); }
});
it('uses the hierarchy index for a bounded direct-report query', async () => {
  const manager = new Types.ObjectId(); const users = database().collection('users');
  const ids = Array.from({ length: 1200 }, () => new Types.ObjectId());
  try {
    await users.insertMany(ids.map((_id, index) => ({ _id, employeeCode: `PERF-${String(index)}`, email: `perf-${String(index)}@example.invalid`, mobileNumber: `+91888${String(index).padStart(7, '0')}`, reportingManagerId: index < 4 ? manager : new Types.ObjectId(), isActive: true })));
    const plan: unknown = await users.find({ reportingManagerId: manager, isActive: true }).limit(5).explain('executionStats');
    expect(JSON.stringify(plan)).toContain('IXSCAN');
    expect(plan).toMatchObject({ executionStats: { nReturned: 4, totalDocsExamined: 4 } });
  } finally { await users.deleteMany({ _id: { $in: ids } }); }
});
it('shares the stricter authentication quota across instances independently of the general quota', async () => {
  await RequestLimitModel.deleteMany({});
  const first = testApp({ rateLimitStore: 'mongo', rateLimitMax: 1000 }); const second = testApp({ rateLimitStore: 'mongo', rateLimitMax: 1000 });
  const results = await Promise.all(Array.from({ length: 30 }, (_, index) => request(index % 2 ? first : second).post('/api/v1/auth/login').send({})));
  expect(results.every((result) => result.status === 400)).toBe(true);
  const limited = await request(second).post('/api/v1/auth/login').send({}).expect(429);
  expect(limited.body).toMatchObject({ error: { code: 'AUTH_RATE_LIMITED' } });
  await request(first).get('/missing').expect(404);
});
it('uses completion-time range bounds rather than scanning an employee entire report history', async () => {
  const employeeId = new Types.ObjectId(); const branchId = new Types.ObjectId();
  const reports = database().collection('report_activities');
  const start = new Date('2026-10-01T00:00:00Z'); const end = new Date('2026-10-02T00:00:00Z');
  const ids = Array.from({ length: 1200 }, () => new Types.ObjectId());
  try {
    await reports.insertMany(ids.map((_id, index) => ({ _id, employeeId, branchId, kind: 'CALL', idempotencyKey: _id.toHexString(),
      callStartedAt: new Date(start.getTime() - index * 10000 - 1000), callEndedAt: new Date(start.getTime() - index * 10000) })));
    const plan: unknown = await reports.find({ $and: [{ $or: [{ employeeId }] }, { kind: 'CALL', callEndedAt: { $gte: start, $lt: end } }] }).explain('executionStats');
    expect(JSON.stringify(plan)).toContain('IXSCAN');
    expect(plan).toMatchObject({ executionStats: { nReturned: 1, totalDocsExamined: 1 } });
  } finally { await reports.deleteMany({ _id: { $in: ids } }); }
});
