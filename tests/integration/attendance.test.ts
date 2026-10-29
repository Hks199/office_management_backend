import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import request, { type Response } from 'supertest';
import { Types } from 'mongoose';
import { testConfig } from '../helpers.js';
import { createApp } from '../../src/app.js';
import { connectDatabase, disconnectDatabase } from '../../src/config/database.js';
import { createLogger } from '../../src/config/logger.js';
import { createIdentityIndexes } from '../../src/modules/auth/identity-indexes.js';
import { createOrganizationIndexes } from '../../src/modules/hierarchy/organization-indexes.js';
import { createAttendanceIndexes } from '../../src/modules/attendance/attendance-indexes.js';
import { bootstrapMd } from '../../src/modules/auth/bootstrap.service.js';
import { AuthService } from '../../src/modules/auth/auth.service.js';
import { CredentialDeliveryModel } from '../../src/modules/auth/credential-delivery.model.js';
import { decryptSecret } from '../../src/shared/utils/crypto.js';
import { UserModel } from '../../src/modules/users/user.model.js';
import { RoleModel } from '../../src/modules/roles/role.model.js';
import { BranchModel } from '../../src/modules/branches/branch.model.js';
import { StateModel, DistrictModel } from '../../src/modules/locations/location.model.js';
import { OfficeSettingsModel } from '../../src/modules/attendance/office-settings.model.js';
import { AttendanceModel } from '../../src/modules/attendance/attendance.model.js';
import { FileModel } from '../../src/modules/files/file.model.js';
import { FileService } from '../../src/modules/files/file.service.js';
import type { PhotoStorage } from '../../src/modules/files/s3-storage.js';
import { ActivityLogModel } from '../../src/modules/activity-logs/activity-log.model.js';
import { LoginAttemptModel } from '../../src/modules/auth/auth.models.js';
import { businessDate } from '../../src/shared/utils/business-date.js';
import { defaultAttendancePolicy } from '../../src/modules/attendance/attendance-policy.js';
import { AttendanceService } from '../../src/modules/attendance/attendance.service.js';
import { AppError } from '../../src/shared/errors/app-error.js';

const config = testConfig({ rateLimitMax: 10000, awsRegion: 'ap-south-1', s3Bucket: 'test-private-photos' });
const storage = { upload: vi.fn<PhotoStorage['upload']>().mockResolvedValue({ url: 'https://s3.example.invalid', fields: { key: 'generated' } }),
  verify: vi.fn<PhotoStorage['verify']>().mockResolvedValue('immutable-version'),
  download: vi.fn<PhotoStorage['download']>().mockResolvedValue('https://s3.example.invalid/signed-private-version'),
  remove: vi.fn<PhotoStorage['remove']>().mockResolvedValue(undefined) };
const app = createApp(config, { logger: createLogger(config), isDatabaseReady: () => Promise.resolve(true), photoStorage: storage });
const auth = new AuthService(config); const password = 'Attendance fixture password 2026!';
let replica: MongoMemoryReplSet | undefined;
let rootId: Types.ObjectId; let rootToken: string; let employeeId: Types.ObjectId; let employeeToken: string;
let peerId: Types.ObjectId; let peerToken: string; let headToken: string; let branchId: Types.ObjectId;
let otherToken: string; let otherId: Types.ObjectId; let subtreeToken: string; let directToken: string;
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- Known response shape at HTTP test boundary.
const data = <T>(res: Response): T => (res.body as { data: T }).data;
const bearer = (token = employeeToken) => `Bearer ${token}`;
interface RecordDto { _id: string; revision: number; employeeId: string; branchId: string | null; attendanceDate: string; checkInAt: string;
  effectiveCheckInAt: string; effectiveCheckOutAt: string | null; checkOutAt: string | null; reviewStatus: string; evidenceFlags: string[]; checkInPhotoFileId: string }
const evidence = (photoFileId: string) => ({ photoFileId, capturedAt: new Date().toISOString(), location: { latitude: 22.5, longitude: 88.3, accuracyMeters: 10 } });
async function signIn(id: Types.ObjectId, email: string) {
  const user = await UserModel.findById(id).select('+passwordHash').lean();
  if (!user?.passwordHash) {
    const job = await CredentialDeliveryModel.findOne({ userId: id }).select('+encryptedToken').lean();
    if (!job) throw new Error('Missing invitation fixture');
    await auth.resetPassword(decryptSecret(job.encryptedToken, config.tokenEncryptionKey), password, 'INVITATION', { requestId: 'fixture' });
  }
  return (await auth.login(email, password, { requestId: 'fixture' })).accessToken;
}
async function upload(purpose: 'ATTENDANCE_CHECK_IN' | 'ATTENDANCE_CHECK_OUT' = 'ATTENDANCE_CHECK_IN', token = employeeToken, confirm = true) {
  const response = await request(app).post('/api/v1/files/upload-intents').set('Authorization', bearer(token)).send({
    purpose, filename: 'camera.png', contentType: 'image/png', size: 32, checksumSHA256: Buffer.alloc(32, 7).toString('base64'),
  }).expect(201);
  const id = data<{ fileId: string }>(response).fileId;
  if (confirm) {
    const confirmed = await request(app).post(`/api/v1/files/${id}/confirm`).set('Authorization', bearer(token)).expect(200);
    for (const field of ['objectKey', 'bucket', 'versionId', 'checksumSHA256']) expect(confirmed.text).not.toContain(field);
  }
  return id;
}
async function checkIn(token = employeeToken): Promise<RecordDto> {
  const id = await upload('ATTENDANCE_CHECK_IN', token);
  return data<RecordDto>(await request(app).post('/api/v1/attendance/check-in').set('Authorization', bearer(token)).send(evidence(id)).expect(201));
}
beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await connectDatabase({ ...config, mongodbUri: replica.getUri('attendance') }, createLogger(config));
  await createIdentityIndexes(); await createOrganizationIndexes(); await createAttendanceIndexes();
  rootId = await bootstrapMd({ employeeCode: 'ATT-MD', firstName: 'Fixture', lastName: 'Director', email: 'att-md@example.invalid', mobileNumber: '+919999999999' }, config.tokenEncryptionKey);
  rootToken = await signIn(rootId, 'att-md@example.invalid');
  const state = await StateModel.create({ code: 'TST', name: 'Synthetic state', createdBy: rootId });
  const district = await DistrictModel.create({ code: 'TST', name: 'Synthetic district', stateId: state._id, createdBy: rootId });
  const branch = await BranchModel.create({ branchCode: 'ATT', branchName: 'Fixture office', address: 'Fixture address',
    contactNumber: '+919000000000', stateId: state._id, districtId: district._id, createdBy: rootId }); branchId = branch._id;
  const branchB = await BranchModel.create({ branchCode: 'OTHER', branchName: 'Other office', address: 'Fixture address',
    contactNumber: '+919000000001', stateId: state._id, districtId: district._id, createdBy: rootId });
  let sequence = 0;
  const employee = async (roleCode: string, managerId: Types.ObjectId, branch: Types.ObjectId | null) => {
    const role = await RoleModel.findOne({ code: roleCode }).lean(); if (!role) throw new Error('Role missing'); sequence++;
    const email = `attendance-${String(sequence)}@example.invalid`;
    const result = await request(app).post('/api/v1/employees').set('Authorization', bearer(rootToken)).send({ employeeCode: `ATT-${String(sequence)}`,
      firstName: 'Fixture', lastName: 'Employee', email, mobileNumber: `+91888000000${String(sequence).padStart(2, '0')}`,
      roleId: role._id, reportingManagerId: managerId, branchId: branch, dateOfJoining: '2026-01-01' }).expect(201);
    const id = new Types.ObjectId(data<{ _id: string }>(result)._id); return { id, token: await signIn(id, email) };
  };
  const bdo = await employee('BDO', rootId, null); subtreeToken = bdo.token;
  const head = await employee('BH', bdo.id, branchId); headToken = head.token;
  const staff = await employee('SEX', head.id, branchId); employeeId = staff.id; employeeToken = staff.token;
  const peer = await employee('TC', rootId, branchId); peerId = peer.id; peerToken = peer.token;
  const other = await employee('SEX', rootId, branchB._id); otherId = other.id; otherToken = other.token;
  // Explicit DIRECT_REPORTS role exercises scope independently of default subtree/branch grants.
  const role = await RoleModel.findOne({ code: 'BDO' }); if (!role) throw new Error('Missing role');
  const direct = await employee('BDO', rootId, null);
  const copy = await RoleModel.create({ name: 'Direct fixture', code: 'ATT_DIRECT', allowsNoBranch: true, createdBy: rootId,
    permissions: role.permissions.map((grant) => ({ permissionId: grant.permissionId, scope: grant.scope === 'REPORTING_SUBTREE' ? 'DIRECT_REPORTS' : grant.scope })) });
  await UserModel.updateOne({ _id: direct.id }, { $set: { roleId: copy._id } }); directToken = direct.token;
  await UserModel.updateOne({ _id: head.id }, { $set: { reportingManagerId: direct.id } });
  // BDO subtree now uses direct manager as its child.
  await UserModel.updateOne({ _id: direct.id }, { $set: { reportingManagerId: bdo.id } });
}, 180000);
beforeEach(async () => {
  await OfficeSettingsModel.deleteMany({});
  await AttendanceModel.deleteMany({}); await FileModel.deleteMany({}); await LoginAttemptModel.deleteMany({});
  await BranchModel.updateOne({ _id: branchId }, { $set: { attendancePolicy: defaultAttendancePolicy } });
  storage.verify.mockResolvedValue('immutable-version'); storage.remove.mockResolvedValue(undefined); vi.clearAllMocks();
});
afterAll(async () => { vi.restoreAllMocks(); await disconnectDatabase(); await replica?.stop(); });

describe('attendance evidence and atomic state transitions', () => {
  it('returns only the valid self action, isolates employees and blocks completed attendance', async () => {
    const path = '/api/v1/attendance/me/status';
    await request(app).get(path).expect(401);
    const status = async (token = employeeToken) => data<{ action: string | null; message: string }>(await request(app).get(path).set('Authorization', bearer(token)).expect(200));
    expect((await status()).action).toBe('check-in');
    await checkIn();
    expect((await status()).action).toBe('check-out');
    expect((await status(rootToken)).action).toBe('check-in');
    await request(app).post('/api/v1/attendance/check-out').set('Authorization', bearer()).send(evidence(await upload('ATTENDANCE_CHECK_OUT'))).expect(200);
    expect(await status()).toMatchObject({ action: null, message: 'You have completed attendance for today.' });
  });
  it('checks old open records independently of monthly history', async () => {
    const record = await checkIn();
    await AttendanceModel.updateOne({ _id: record._id }, { $set: { attendanceDate: '2000-01-01' } });
    const path = '/api/v1/attendance/me/status';
    const response = await request(app).get(path).set('Authorization', bearer()).expect(200);
    expect(data<{ action: string }>(response).action).toBe('check-out');
    await AttendanceModel.updateOne({ _id: record._id }, { $set: { checkInAt: new Date(Date.now() - 86400001) } });
    const expired = await request(app).get(path).set('Authorization', bearer()).expect(200);
    expect(data<{ action: string | null }>(expired).action).toBeNull();
    expect(expired.text).toContain('authorized manager');
  });
  it('requires authentication and rejects forged actor/time fields and invalid GPS', async () => {
    await request(app).post('/api/v1/attendance/check-in').send({}).expect(401);
    const photo = await upload();
    for (const fields of [{ employeeId: peerId }, { branchId }, { checkInAt: new Date().toISOString() }, { capturedAt: 'bad' },
      { capturedAt: '2026-02-30T10:00:00Z' }, { location: { latitude: 91, longitude: 0 } },
      { location: { latitude: 0, longitude: -181 } }, { location: { latitude: 0, longitude: 0, accuracyMeters: -1 } }]) {
      await request(app).post('/api/v1/attendance/check-in').set('Authorization', bearer()).send({ ...evidence(photo), ...fields }).expect(400);
    }
  });
  it('uses authenticated actor, authoritative UTC time, Kolkata date and branch snapshot', async () => {
    const before = Date.now(); const record = await checkIn();
    expect(record.employeeId).toBe(employeeId.toHexString()); expect(record.branchId).toBe(branchId.toHexString());
    expect(record.attendanceDate).toBe(businessDate()); expect(new Date(record.checkInAt).getTime()).toBeGreaterThanOrEqual(before);
    expect(record.reviewStatus).toBe('PENDING'); expect(record.evidenceFlags).toEqual([]);
    expect(await FileModel.findById(record.checkInPhotoFileId).lean()).toMatchObject({ status: 'ATTACHED', attendanceId: new Types.ObjectId(record._id) });
  });
  it('permits exactly one concurrent daily check-in and rolls back the losing photo', async () => {
    const ids = [await upload(), await upload()];
    const results = await Promise.all(ids.map((id) => request(app).post('/api/v1/attendance/check-in').set('Authorization', bearer()).send(evidence(id))));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await AttendanceModel.countDocuments({ employeeId })).toBe(1); expect(await FileModel.countDocuments({ status: 'ATTACHED' })).toBe(1);
    expect(await FileModel.countDocuments({ status: 'READY' })).toBe(1);
  });
  it('checks out once under concurrency and rejects checkout before check-in and repeat check-in after completion', async () => {
    await request(app).post('/api/v1/attendance/check-out').set('Authorization', bearer()).send(evidence(await upload('ATTENDANCE_CHECK_OUT'))).expect(409);
    await checkIn(); const ids = [await upload('ATTENDANCE_CHECK_OUT'), await upload('ATTENDANCE_CHECK_OUT')];
    const results = await Promise.all(ids.map((id) => request(app).post('/api/v1/attendance/check-out').set('Authorization', bearer()).send(evidence(id))));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    await request(app).post('/api/v1/attendance/check-in').set('Authorization', bearer()).send(evidence(await upload())).expect(409);
  });
  it('rejects foreign, pending, stale, wrong-purpose and missing photo IDs', async () => {
    const foreign = await upload('ATTENDANCE_CHECK_IN', peerToken); const pending = await upload('ATTENDANCE_CHECK_IN', employeeToken, false);
    const wrong = await upload('ATTENDANCE_CHECK_OUT'); const expired = await upload();
    await FileModel.updateOne({ _id: expired }, { $set: { expiresAt: new Date(Date.now() - 1) } });
    for (const id of [foreign, pending, wrong, expired, new Types.ObjectId().toHexString()]) {
      await request(app).post('/api/v1/attendance/check-in').set('Authorization', bearer()).send(evidence(id)).expect(400);
    }
    expect(await AttendanceModel.countDocuments()).toBe(0);
  });
  it('flags suspicious capture time, missing/poor accuracy and geofence evidence without claiming spoof prevention', async () => {
    await BranchModel.updateOne({ _id: branchId }, { $set: { attendancePolicy: { ...defaultAttendancePolicy,
      geofence: { latitude: 0, longitude: 0, radiusMeters: 100 }, startMinute: 0, endMinute: 1439 } } });
    const photo = await upload(); const record = data<RecordDto>(await request(app).post('/api/v1/attendance/check-in').set('Authorization', bearer()).send({
      ...evidence(photo), capturedAt: new Date(Date.now() - 3600000).toISOString(), location: { latitude: 22, longitude: 88, accuracyMeters: 500 },
    }).expect(201));
    expect(record.evidenceFlags).toEqual(expect.arrayContaining(['CAPTURE_TIME_SKEW', 'LOW_GPS_ACCURACY', 'OUTSIDE_GEOFENCE']));
    const out = data<RecordDto>(await request(app).post('/api/v1/attendance/check-out').set('Authorization', bearer()).send({
      ...evidence(await upload('ATTENDANCE_CHECK_OUT')), location: { latitude: 0, longitude: 0 },
    }).expect(200)); expect(out.evidenceFlags).toContain('ACCURACY_MISSING');
  });
  it('preserves the business date through real Kolkata midnight and refuses a stale open record', async () => {
    const actor = await auth.authenticate(employeeToken); const service = new AttendanceService(new FileService(config, storage));
    const midnight = new Date(`${businessDate()}T00:00:00+05:30`).getTime() + 86400000;
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(midnight - 1000);
      const photos: { _id: Types.ObjectId }[] = [];
      for (const purpose of ['ATTENDANCE_CHECK_IN', 'ATTENDANCE_CHECK_OUT'] as const) photos.push(await FileModel.create({ ownerId: employeeId, purpose,
        objectKey: `fixture/${purpose}`, bucket: 'test-private-photos', contentType: 'image/png', size: 32, checksumSHA256: Buffer.alloc(32).toString('base64'),
        versionId: 'immutable-version', status: 'READY', confirmedAt: new Date(), expiresAt: new Date(midnight + 300000) }));
      const first = photos[0]; const second = photos[1]; if (!first || !second) throw new Error('Missing photos');
      const record = await service.mark(actor, evidence(first._id.toHexString()), false, { requestId: 'midnight' });
      vi.setSystemTime(midnight + 1000);
      const out = await service.mark(actor, evidence(second._id.toHexString()), true, { requestId: 'midnight' });
      expect(out.attendanceDate).toBe(record.attendanceDate); expect(out.attendanceDate).not.toBe(businessDate());
      expect(out.checkOutAt?.getTime()).toBe(midnight + 1000);
      await AttendanceModel.updateOne({ _id: record._id }, { $set: { status: 'OPEN', checkInAt: new Date(Date.now() - 86400001) } });
      await expect(service.mark(actor, evidence(second._id.toHexString()), true, { requestId: 'expired' })).rejects.toMatchObject({ code: 'ATTENDANCE_EXPIRED' });
    } finally { vi.useRealTimers(); }
  });
});

describe('scoped attendance history, summaries and photos', () => {
  it('isolates SELF, BRANCH, REPORTING_SUBTREE, DIRECT_REPORTS and ALL before aggregation', async () => {
    const own = await checkIn(); await checkIn(peerToken); await checkIn(otherToken); await checkIn(headToken);
    const count = async (token: string, expected: number) => {
      const response = await request(app).get('/api/v1/attendance').set('Authorization', bearer(token)).expect(200);
      expect(response.body).toHaveProperty('meta.total', expected);
      const summary = data<{ days: { records: number }[] }>(await request(app).get('/api/v1/attendance/summary').set('Authorization', bearer(token)).expect(200));
      expect(summary.days.reduce((sum, day) => sum + day.records, 0)).toBe(expected);
    };
    await count(employeeToken, 1); await count(headToken, 3); await count(subtreeToken, 2); await count(directToken, 1); await count(rootToken, 4);
    const filtered = await request(app).get(`/api/v1/attendance/employee/${peerId.toHexString()}`).set('Authorization', bearer()).expect(200);
    expect(filtered.body).toHaveProperty('meta.total', 0);
    const me = await request(app).get('/api/v1/attendance/me').set('Authorization', bearer(headToken)).expect(200); expect(me.body).toHaveProperty('meta.total', 1);
    await request(app).get(`/api/v1/attendance/${own._id}/photos/check-in`).set('Authorization', bearer(headToken)).expect(200);
    await request(app).get(`/api/v1/attendance/${own._id}/photos/check-in`).set('Authorization', bearer(otherToken)).expect(404);
    await request(app).get(`/api/v1/files/${own.checkInPhotoFileId}/download`).set('Authorization', bearer(peerToken)).expect(404);
    await request(app).get(`/api/v1/files/${own.checkInPhotoFileId}/download`).set('Authorization', bearer()).expect(200);
    expect(storage.download.mock.calls.at(-1)?.[1]).toBe('immutable-version');
  });
  it('bounds filters, validates month/pagination and paginates stable results', async () => {
    await checkIn(); await checkIn(peerToken);
    const response = await request(app).get('/api/v1/attendance?limit=1&sortOrder=asc').set('Authorization', bearer(rootToken)).expect(200);
    expect(data<unknown[]>(response)).toHaveLength(1); expect(response.body).toHaveProperty('meta.total', 2);
    const month = '2000-01'; const empty = await request(app).get(`/api/v1/attendance?month=${month}`).set('Authorization', bearer()).expect(200);
    expect(data<unknown[]>(empty)).toEqual([]);
    for (const query of ['month=2026-13', 'limit=101', 'page=0', 'sortBy=passwordHash', 'employeeId=bad', 'month[$ne]=bad']) {
      await request(app).get(`/api/v1/attendance?${query}`).set('Authorization', bearer()).expect(400);
    }
  });
  it('rejects revoked/deactivated sessions at attendance and photo routes', async () => {
    const record = await checkIn(otherToken);
    await UserModel.updateOne({ _id: otherId }, { $set: { isActive: false } });
    await request(app).get('/api/v1/attendance').set('Authorization', bearer(otherToken)).expect(401);
    await request(app).get(`/api/v1/attendance/${record._id}/photos/check-in`).set('Authorization', bearer(otherToken)).expect(401);
    await UserModel.updateOne({ _id: otherId }, { $set: { isActive: true } });
  });
});

describe('attendance reviews, corrections and transaction audit', () => {
  it('uses snapshotted hours and effective durations in scoped monthly summaries, excluding rejected minutes', async () => {
    const own = await checkIn();
    const date = businessDate(new Date(Date.now() - 86400000));
    // Historical fixture permits deterministic schedule/duration checks at any wall-clock hour.
    await AttendanceModel.updateOne({ _id: own._id }, { $set: { attendanceDate: date, checkInAt: new Date(`${date}T09:10:00+05:30`),
      effectiveCheckInAt: new Date(`${date}T09:10:00+05:30`), policySnapshot: { ...defaultAttendancePolicy, startMinute: 540, endMinute: 1080, graceMinutes: 10 } } });
    await BranchModel.updateOne({ _id: branchId }, { $set: { attendancePolicy: { ...defaultAttendancePolicy, startMinute: 600, endMinute: 960 } } });
    const record = data<RecordDto>(await request(app).post(`/api/v1/attendance/${own._id}/corrections`).set('Authorization', bearer(headToken)).send({
      revision: 0, effectiveCheckInAt: `${date}T09:10:00+05:30`, effectiveCheckOutAt: `${date}T17:00:00+05:30`, reason: 'Historical schedule correction',
    }).expect(200));
    expect(record).toMatchObject({ lateArrival: false, earlyExit: true, status: 'COMPLETED' });
    const summary = async () => data<{ days: { workedMinutes: number; completed: number; earlyExits: number; rejected: number }[] }>(
      await request(app).get(`/api/v1/attendance/summary?month=${date.slice(0, 7)}&earlyExit=true`).set('Authorization', bearer()).expect(200));
    expect((await summary()).days[0]).toMatchObject({ workedMinutes: 470, completed: 1, earlyExits: 1, rejected: 0 });
    await request(app).patch(`/api/v1/attendance/${own._id}/review`).set('Authorization', bearer(headToken)).send({ revision: 1, reviewStatus: 'REJECTED', reason: 'Evidence not accepted' }).expect(200);
    expect((await summary()).days[0]).toMatchObject({ workedMinutes: 0, rejected: 1 });
  });
  it('rejects self/unrelated reviews and stale revisions, records audited review', async () => {
    const own = await checkIn(); const root = await checkIn(rootToken);
    const review = { revision: 0, reviewStatus: 'APPROVED', reason: 'Evidence reviewed' };
    await request(app).patch(`/api/v1/attendance/${own._id}/review`).set('Authorization', bearer()).send(review).expect(403);
    await request(app).patch(`/api/v1/attendance/${root._id}/review`).set('Authorization', bearer(rootToken)).send(review).expect(403);
    await request(app).patch(`/api/v1/attendance/${root._id}/review`).set('Authorization', bearer(headToken)).send(review).expect(404);
    await request(app).patch(`/api/v1/attendance/${own._id}/review`).set('Authorization', bearer(headToken)).send(review).expect(200);
    await request(app).patch(`/api/v1/attendance/${own._id}/review`).set('Authorization', bearer(headToken)).send(review).expect(409);
    expect(await ActivityLogModel.countDocuments({ action: 'ATTENDANCE_REVIEWED', entityId: own._id })).toBe(1);
    await request(app).post('/api/v1/attendance/check-out').set('Authorization', bearer()).send(evidence(await upload('ATTENDANCE_CHECK_OUT'))).expect(200);
    expect(await AttendanceModel.findById(own._id).lean()).toMatchObject({ reviewStatus: 'PENDING', reviewedAt: null });
  });
  it('preserves original evidence on correction, resets review and audits before/after with a mandatory reason', async () => {
    const own = await checkIn(); const originalIn = new Date(own.checkInAt); const corrected = new Date(Math.max(originalIn.getTime() - 1000, new Date(`${own.attendanceDate}T00:00:00+05:30`).getTime()));
    const input = { revision: 0, effectiveCheckInAt: corrected.toISOString(), effectiveCheckOutAt: new Date().toISOString(), reason: 'Supervisor verified missed checkout' };
    await request(app).post(`/api/v1/attendance/${own._id}/corrections`).set('Authorization', bearer()).send(input).expect(403);
    const after = data<RecordDto>(await request(app).post(`/api/v1/attendance/${own._id}/corrections`).set('Authorization', bearer(headToken)).send(input).expect(200));
    expect(after.checkInAt).toBe(own.checkInAt); expect(after.checkOutAt).toBeNull(); expect(after.effectiveCheckInAt).toBe(corrected.toISOString());
    expect(after.reviewStatus).toBe('PENDING'); expect(after.checkInPhotoFileId).toBe(own.checkInPhotoFileId);
    expect(await ActivityLogModel.findOne({ action: 'ATTENDANCE_CORRECTED', entityId: own._id }).lean()).toHaveProperty('metadata.reason', input.reason);
    await request(app).post(`/api/v1/attendance/${own._id}/corrections`).set('Authorization', bearer(headToken)).send(input).expect(409);
    await request(app).post(`/api/v1/attendance/${own._id}/corrections`).set('Authorization', bearer(headToken)).send({ ...input, revision: 1, reason: '' }).expect(400);
    await request(app).post(`/api/v1/attendance/${own._id}/corrections`).set('Authorization', bearer(headToken)).send({ ...input, revision: 1, effectiveCheckOutAt: null }).expect(400);
  });
  it('rolls back attendance and photo attachment when immutable audit insertion fails', async () => {
    const photo = await upload(); const spy = vi.spyOn(ActivityLogModel, 'create').mockRejectedValueOnce(new Error('Audit offline'));
    await request(app).post('/api/v1/attendance/check-in').set('Authorization', bearer()).send(evidence(photo)).expect(500); spy.mockRestore();
    expect(await AttendanceModel.countDocuments()).toBe(0); expect(await FileModel.findById(photo).lean()).toMatchObject({ status: 'READY', attendanceId: null });
  });
});

describe('private upload lifecycle and orphan cleanup', () => {
  it('bounds outstanding upload intents per employee', async () => {
    for (let index = 0; index < 20; index++) await FileModel.create({ ownerId: employeeId, purpose: 'ATTENDANCE_CHECK_IN', objectKey: `cap/${String(index)}`,
      bucket: 'test-private-photos', contentType: 'image/png', size: 32, checksumSHA256: Buffer.alloc(32).toString('base64'), expiresAt: new Date(Date.now() + 300000) });
    await request(app).post('/api/v1/files/upload-intents').set('Authorization', bearer()).send({ purpose: 'ATTENDANCE_CHECK_IN',
      filename: 'camera.png', contentType: 'image/png', size: 32, checksumSHA256: Buffer.alloc(32).toString('base64') }).expect(429);
    expect(await FileModel.countDocuments({ ownerId: employeeId })).toBe(20);
  });
  it('rejects arbitrary keys/purposes/paths, type-extension mismatch, oversized and bad checksums', async () => {
    const input = { purpose: 'ATTENDANCE_CHECK_IN', filename: 'camera.png', contentType: 'image/png', size: 32, checksumSHA256: Buffer.alloc(32).toString('base64') };
    for (const fields of [{ objectKey: 'arbitrary' }, { purpose: 'IMPORT' }, { filename: '../camera.png' }, { filename: 'camera.svg' },
      { contentType: 'image/jpeg' }, { size: 5242881 }, { checksumSHA256: 'bad' }]) {
      await request(app).post('/api/v1/files/upload-intents').set('Authorization', bearer()).send({ ...input, ...fields }).expect(400);
    }
  });
  it('confirms only the owner once before expiry and keeps failed evidence pending', async () => {
    const id = await upload('ATTENDANCE_CHECK_IN', employeeToken, false);
    await request(app).post(`/api/v1/files/${id}/confirm`).set('Authorization', bearer(peerToken)).expect(404);
    storage.verify.mockRejectedValueOnce(new AppError(400, 'INVALID_PHOTO', 'Signature mismatch'));
    await request(app).post(`/api/v1/files/${id}/confirm`).set('Authorization', bearer()).expect(400);
    expect(await FileModel.findById(id).lean()).toMatchObject({ status: 'PENDING' });
    await request(app).post(`/api/v1/files/${id}/confirm`).set('Authorization', bearer()).expect(200);
    await request(app).post(`/api/v1/files/${id}/confirm`).set('Authorization', bearer()).expect(404);
    await request(app).get(`/api/v1/files/${id}/download`).set('Authorization', bearer()).expect(404);
    const expired = await upload('ATTENDANCE_CHECK_IN', employeeToken, false);
    await FileModel.updateOne({ _id: expired }, { $set: { expiresAt: new Date(Date.now() - 1) } });
    await request(app).post(`/api/v1/files/${expired}/confirm`).set('Authorization', bearer()).expect(404);
  });
  it('claims only expired unattached files and safely retries deletion failures', async () => {
    const attached = await checkIn(); const orphan = await upload(); const fresh = await upload();
    await FileModel.updateOne({ _id: orphan }, { $set: { expiresAt: new Date(Date.now() - 90000000) } });
    await FileModel.updateOne({ _id: attached.checkInPhotoFileId }, { $set: { expiresAt: new Date(Date.now() - 90000000) } });
    const service = new FileService(config, storage); storage.remove.mockRejectedValueOnce(new Error('Temporary S3 failure'));
    await expect(service.cleanup()).rejects.toThrow('Temporary S3 failure');
    expect(await FileModel.findById(orphan).lean()).toMatchObject({ status: 'DELETING' });
    expect(await service.cleanup()).toBe(1); expect(await service.cleanup()).toBe(0);
    expect(await FileModel.findById(fresh).lean()).toMatchObject({ status: 'READY' });
    expect(await FileModel.findById(attached.checkInPhotoFileId).lean()).toMatchObject({ status: 'ATTACHED' });
  });
  it('restricts branch evidence policy changes to ALL branch administrators and validates schedules', async () => {
    const branch = await BranchModel.findById(branchId).lean(); if (!branch) throw new Error('Missing branch');
    await request(app).patch(`/api/v1/branches/${branchId.toHexString()}`).set('Authorization', bearer(headToken)).send({ revision: branch.revision, attendancePolicy: defaultAttendancePolicy }).expect(403);
    for (const policy of [{ ...defaultAttendancePolicy, startMinute: 600, endMinute: null }, { ...defaultAttendancePolicy, startMinute: 600, endMinute: 500 }]) {
      await request(app).patch(`/api/v1/branches/${branchId.toHexString()}`).set('Authorization', bearer(rootToken)).send({ revision: branch.revision, attendancePolicy: policy }).expect(400);
    }
    await request(app).patch(`/api/v1/branches/${branchId.toHexString()}`).set('Authorization', bearer(rootToken)).send({ revision: branch.revision,
      attendancePolicy: { ...defaultAttendancePolicy, startMinute: 540, endMinute: 1080, graceMinutes: 10 } }).expect(200);
  });
});


describe('MD office schedule and live workforce counts', () => {
  const schedule = { revision: 0, startMinute: 0, endMinute: 1439, graceMinutes: 0,
    workingWeekdays: [1, 2, 3, 4, 5, 6, 7], holidays: [] };
  it('restricts settings to MD and enforces revisions', async () => {
    const path = '/api/v1/attendance/settings';
    await request(app).get(path).expect(401);
    await request(app).get(path).set('Authorization', bearer(headToken)).expect(403);
    await request(app).put(path).set('Authorization', bearer(headToken)).send(schedule).expect(403);
    expect(data<{ configured: boolean }>(await request(app).get(path).set('Authorization', bearer(rootToken)).expect(200)).configured).toBe(false);
    await request(app).put(path).set('Authorization', bearer(rootToken)).send(schedule).expect(200);
    await request(app).put(path).set('Authorization', bearer(rootToken)).send(schedule).expect(409);
    expect(await ActivityLogModel.exists({ action: 'OFFICE_ATTENDANCE_SETTINGS_UPDATED' })).toBeTruthy();
  });
  it('counts a scoped employee absent, then present, and applies the saved policy to new check-ins', async () => {
    await request(app).put('/api/v1/attendance/settings').set('Authorization', bearer(rootToken)).send(schedule).expect(200);
    const before = data<{ totalEmployees: number; absent: number }>(await request(app).get('/api/v1/attendance/workforce').set('Authorization', bearer()).expect(200));
    expect(before).toMatchObject({ totalEmployees: 1, absent: 1 });
    const marked = await checkIn();
    const record = await AttendanceModel.findById(marked._id).lean();
    expect(record?.policySnapshot).toMatchObject({ startMinute: 0, endMinute: 1439, graceMinutes: 0 });
    const after = data<{ present: number; absent: number }>(await request(app).get('/api/v1/attendance/workforce').set('Authorization', bearer()).expect(200));
    expect(after).toMatchObject({ present: 1, absent: 0 });
  });
  it('excludes office holidays from absence for branch employees', async () => {
    await request(app).put('/api/v1/attendance/settings').set('Authorization', bearer(rootToken)).send({ ...schedule, holidays: [businessDate()] }).expect(200);
    const count = data<{ absent: number; nonWorkingDay: number }>(await request(app).get('/api/v1/attendance/workforce').set('Authorization', bearer()).expect(200));
    expect(count).toMatchObject({ absent: 0, nonWorkingDay: 1 });
  });
});
