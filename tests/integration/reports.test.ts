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
import { createCommercialIndexes } from '../../src/modules/leads/commercial-indexes.js';
import { createReportIndexes } from '../../src/modules/reports/report-indexes.js';
import { bootstrapMd } from '../../src/modules/auth/bootstrap.service.js';
import { AuthService } from '../../src/modules/auth/auth.service.js';
import { hashPassword } from '../../src/shared/utils/crypto.js';
import { UserModel } from '../../src/modules/users/user.model.js';
import { RoleModel } from '../../src/modules/roles/role.model.js';
import { PermissionModel } from '../../src/modules/permissions/permission.model.js';
import { BranchModel } from '../../src/modules/branches/branch.model.js';
import { StateModel, DistrictModel } from '../../src/modules/locations/location.model.js';
import { CustomerModel, LeadModel, LeadEventModel, WorkflowModel, type LeadStatus } from '../../src/modules/leads/commercial.models.js';
import { FileModel } from '../../src/modules/files/file.model.js';
import { FileService } from '../../src/modules/files/file.service.js';
import type { PhotoStorage } from '../../src/modules/files/s3-storage.js';
import { ReportModel, ReportHistoryModel } from '../../src/modules/reports/report.model.js';
import { ActivityLogModel } from '../../src/modules/activity-logs/activity-log.model.js';
const config = testConfig({ rateLimitMax: 100000, awsRegion: 'ap-south-1', s3Bucket: 'test-report-photos' });
const download = vi.fn<PhotoStorage['download']>().mockResolvedValue('https://storage.example.invalid/signed');
const remove = vi.fn<PhotoStorage['remove']>().mockResolvedValue(undefined);
const storage: PhotoStorage = {
  upload: vi.fn<PhotoStorage['upload']>().mockResolvedValue({ url: 'https://storage.example.invalid', fields: {} }),
  verify: vi.fn<PhotoStorage['verify']>().mockResolvedValue('immutable-version'),
  download,
  remove,
};
const app = createApp(config, { logger: createLogger(config), isDatabaseReady: () => Promise.resolve(true), photoStorage: storage });
let replica: MongoMemoryReplSet | undefined; let md: Employee; let mh: Employee; let tc: Employee; let tc2: Employee; let sex: Employee; let outsider: Employee;
let branch: Types.ObjectId; let foreignBranch: Types.ObjectId; let stateId: Types.ObjectId; let districtId: Types.ObjectId; let sequence = 0; let passwordHash: string;
interface Employee { id: Types.ObjectId; token: string }
interface Report { _id: string; revision: number; status: string; callDurationSeconds: number; photoFileIds: string[]; estimatedProjectValue: string; evidenceFlags: string[]; reviewStatus: string; point: { coordinates: number[] } }
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- Assert shape at the HTTP response boundary.
const data = <T>(res: Response): T => (res.body as { data: T }).data;
const bearer = (actor = md) => `Bearer ${actor.token}`;
const location = { latitude: 22.57, longitude: 88.36, accuracyMeters: 10 };
const captured = () => new Date().toISOString();
const calls = '/api/v1/telecaller-reports/calls'; const visits = '/api/v1/sales-reports/visits';
const nextKey = () => `report-fixture-${String(++sequence).padStart(8, '0')}`;
const input = (customerId: Types.ObjectId, changes = {}) => ({ customerId: customerId.toHexString(), callStartedAt: new Date(Date.now() - 120000).toISOString(), callEndedAt: new Date(Date.now() - 60000).toISOString(), callOutcome: 'INTERESTED', customerInterest: 'INTERESTED', remarks: 'Synthetic call observation', ...changes });
async function employee(code: string, manager: Types.ObjectId, office: Types.ObjectId): Promise<Employee> {
  const role = await RoleModel.findOne({ code }).lean(); if (!role) throw new Error('Fixture role missing'); sequence++;
  const email = `report-${String(sequence)}@example.invalid`;
  const user = await UserModel.create({ employeeCode: `REP-${String(sequence)}`, firstName: 'Fixture', lastName: 'Employee', email, mobileNumber: `+91888${String(sequence).padStart(7, '0')}`, passwordHash,
    roleId: role._id, branchId: office, reportingManagerId: manager, createdBy: md.id, dateOfJoining: new Date() });
  return { id: user._id, token: (await new AuthService(config).login(email, 'Reporting fixture password 2026!', { requestId: 'fixture' })).accessToken };
}
async function customer(actor = tc) {
  const item = await CustomerModel.create({ customerName: 'Synthetic customer', mobileNumber: '+919876543210', siteAddress: 'Synthetic site', stateId, districtId, branchId: branch,
    dedupeKey: nextKey(), importId: new Types.ObjectId(), importRow: 1, createdBy: md.id, assignedTo: actor.id, assignedBy: md.id, assignedAt: new Date() }); return item._id;
}
async function lead(actor = sex, status: LeadStatus = 'SITE_VISIT_SCHEDULED') {
  const item = await LeadModel.create({ leadCode: nextKey(), customerName: 'Synthetic lead', mobileNumber: '+919876543211', siteAddress: 'Synthetic site', stateId, districtId, branchId: branch,
    requiredCapacityKw: '5.00', ratePerKw: '55000.00', estimatedProjectValue: '275000.00', paymentMode: 'BANK', panelBrand: 'TEST', panelTechnology: 'TEST', leadSource: 'TEST',
    status, workflowVersion: 1, createdBy: md.id, assignedTo: actor.id, assignedBy: md.id, assignedAt: new Date(), salesExecutiveId: actor.id }); return item._id;
}
async function start(leadId?: Types.ObjectId, actor = sex) {
  return data<Report>(await request(app).post(visits).set('Authorization', bearer(actor)).set('Idempotency-Key', nextKey()).send({ leadId: leadId ?? await lead(actor), location, clientCapturedAt: captured() }).expect(201));
}
async function photo(report: Report, actor = sex) {
  const result = await request(app).post(`${visits}/${report._id}/photos/upload-intents`).set('Authorization', bearer(actor)).send({ filename: 'site.jpg', contentType: 'image/jpeg', size: 100, checksumSHA256: Buffer.alloc(32).toString('base64') }).expect(201);
  const id = data<{ fileId: string }>(result).fileId;
  await request(app).post(`${visits}/${report._id}/photos/${id}/confirm`).set('Authorization', bearer(actor)).expect(200); return id;
}
const completion = (fileId: string, changes = {}) => ({ revision: 0, photoFileIds: [fileId], location, clientCapturedAt: captured(), discussionNotes: 'Synthetic site assessment', customerInterest: 'INTERESTED', installationReadiness: 'READY', visitOutcome: 'COMPLETED', requiredCapacityKw: '6.50', ...changes });
beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } }); await connectDatabase({ ...config, mongodbUri: replica.getUri('reporting') }, createLogger(config));
  await createIdentityIndexes(); await createOrganizationIndexes(); await createAttendanceIndexes(); await createCommercialIndexes(); await createReportIndexes();
  const root = await bootstrapMd({ employeeCode: 'REP-MD', firstName: 'Fixture', lastName: 'Director', email: 'rep-md@example.invalid', mobileNumber: '+919999999999' }, config.tokenEncryptionKey);
  passwordHash = await hashPassword('Reporting fixture password 2026!'); await UserModel.updateOne({ _id: root }, { $set: { passwordHash } });
  md = { id: root, token: (await new AuthService(config).login('rep-md@example.invalid', 'Reporting fixture password 2026!', { requestId: 'fixture' })).accessToken };
  stateId = (await StateModel.create({ code: 'REP', name: 'Synthetic state', createdBy: root }))._id;
  districtId = (await DistrictModel.create({ code: 'D1', name: 'Synthetic district', stateId, createdBy: root }))._id;
  const makeBranch = async (code: string) => (await BranchModel.create({ branchCode: code, branchName: 'Synthetic branch', address: 'Synthetic office', stateId, districtId, contactNumber: '+919000000000', createdBy: root }))._id;
  branch = await makeBranch('REP-A'); foreignBranch = await makeBranch('REP-B'); mh = await employee('MH', root, branch);
  tc = await employee('TC', mh.id, branch); tc2 = await employee('TC', root, branch); sex = await employee('SEX', mh.id, branch); outsider = await employee('SEX', root, foreignBranch);
}, 180000);
beforeEach(async () => { await Promise.all([ReportModel.deleteMany({}), CustomerModel.deleteMany({}), LeadModel.deleteMany({}), FileModel.deleteMany({})]); vi.clearAllMocks(); });
afterAll(async () => { vi.restoreAllMocks(); await disconnectDatabase(); await replica?.stop(); });
describe('individual calls and scoped daily reporting', () => {
  it('resolves display names in bounded batches without exposing references outside the actor scope', async () => {
    const own = await customer(); const outside = await customer(tc2);
    const references = [
      { kind: 'employee', id: tc.id.toHexString() }, { kind: 'employee', id: tc2.id.toHexString() },
      { kind: 'contact', id: own.toHexString() }, { kind: 'contact', id: outside.toHexString() },
      { kind: 'state', id: stateId.toHexString() }, { kind: 'district', id: districtId.toHexString() },
    ];
    const endpoint = '/api/v1/display-references';
    await request(app).post(endpoint).send({ references }).expect(401);
    const response = await request(app).post(endpoint).set('Authorization', bearer(tc)).send({ references }).expect(200);
    const labels = data<{ kind: string; id: string; name: string }[]>(response);
    expect(labels).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'employee', id: tc.id.toHexString(), name: 'Fixture Employee' }),
      expect.objectContaining({ kind: 'contact', id: own.toHexString(), name: 'Synthetic customer' }),
      expect.objectContaining({ kind: 'state', name: 'Synthetic state' }),
      expect.objectContaining({ kind: 'district', name: 'Synthetic district' }),
    ]));
    expect(labels.some(row => row.id === tc2.id.toHexString() || row.id === outside.toHexString())).toBe(false);
    expect(response.text).not.toMatch(/passwordHash|mobileNumber|email|session|objectKey|bucket/);
    const manager = data<{ id: string }[]>(await request(app).post(endpoint).set('Authorization', bearer(mh)).send({ references }).expect(200));
    expect(manager.some(row => row.id === tc.id.toHexString())).toBe(true);
    expect(manager.some(row => row.id === tc2.id.toHexString() || row.id === outside.toHexString())).toBe(false);
    await request(app).post(endpoint).set('Authorization', bearer(tc)).send({ references: Array.from({ length: 101 }, () => references[0]) }).expect(400);
    await request(app).post(endpoint).set('Authorization', bearer(tc)).send({ references: [{ kind: 'secrets', id: own.toHexString() }] }).expect(400);
  });
  it('returns each call for the exact contact with pagination and caller names, within report scope', async () => {
    const id = await customer(); const sameName = await customer(tc2);
    for (const [index, actor] of [tc, tc, mh].entries()) {
      const start = Date.now() - (index + 1) * 300000;
      await request(app).post(calls).set('Authorization', bearer(actor)).set('Idempotency-Key', nextKey()).send(input(id, {
        callStartedAt: new Date(start).toISOString(), callEndedAt: new Date(start + 60000).toISOString(), remarks: `Separate call ${String(index + 1)}`,
      })).expect(201);
    }
    await request(app).post(calls).set('Authorization', bearer(tc2)).set('Idempotency-Key', nextKey()).send(input(sameName)).expect(201);
    const endpoint = `${calls}?customerId=${id.toHexString()}`;
    const own = await request(app).get(endpoint).set('Authorization', bearer(tc)).expect(200);
    expect(data<{ remarks: string }[]>(own).map(row => row.remarks).sort()).toEqual(['Separate call 1', 'Separate call 2']);
    const identifiers = new Set<string>();
    for (let page = 1; page <= 3; page++) {
      const result = await request(app).get(`${endpoint}&limit=1&page=${String(page)}`).set('Authorization', bearer(mh)).expect(200);
      const [row] = data<{ _id: string; customerId: string; employeeName: string }[]>(result);
      if (!row) throw new Error('Expected a paginated call');
      expect(row.customerId).toBe(id.toHexString()); expect(row.employeeName).toBe('Fixture Employee');
      identifiers.add(row._id);
      expect((result.body as { meta: { total: number } }).meta.total).toBe(3);
      expect(result.text).not.toMatch(/passwordHash|requestHash|idempotencyKey|@example/);
    }
    expect(identifiers.size).toBe(3);
    expect(data<unknown[]>(await request(app).get(endpoint).set('Authorization', bearer(tc2)).expect(200))).toEqual([]);
  });
  it('marks the matching contact Interested atomically and only once on an Interested call', async () => {
    const id = await customer(); const other = await customer(tc2);
    const key = nextKey(); const body = input(id);
    const submit = () => request(app).post(calls).set('Authorization', bearer(tc)).set('Idempotency-Key', key).send(body);
    const first = await submit().expect(201);
    await submit().expect(201);
    expect(await CustomerModel.findById(id).lean()).toMatchObject({ status: 'INTERESTED', revision: 1, assignedTo: tc.id });
    expect(await CustomerModel.findById(other).lean()).toMatchObject({ status: 'AVAILABLE', revision: 0 });
    expect(await ReportModel.countDocuments({ customerId: id })).toBe(1);
    const audits = await ActivityLogModel.find({ entityId: id, action: 'CUSTOMER_STATUS_CHANGED' }).lean();
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0])).toContain(data<{ _id: string }>(first)._id);
    const later = input(id, { callStartedAt: new Date(Date.now() - 3600000).toISOString(), callEndedAt: new Date(Date.now() - 3540000).toISOString() });
    await request(app).post(calls).set('Authorization', bearer(mh)).set('Idempotency-Key', nextKey()).send(later).expect(201);
    expect(await CustomerModel.findById(id).lean()).toMatchObject({ status: 'INTERESTED', revision: 1 });
    expect(await ActivityLogModel.countDocuments({ entityId: id, action: 'CUSTOMER_STATUS_CHANGED' })).toBe(1);
  });
  it('preserves contact status for other outcomes and failed or unauthorized reports', async () => {
    const id = await customer();
    await request(app).post(calls).set('Authorization', bearer(tc2)).set('Idempotency-Key', nextKey()).send(input(id)).expect(404);
    await request(app).post(calls).set('Authorization', bearer(tc)).set('Idempotency-Key', nextKey()).send(input(id, { followUpAt: new Date(Date.now() - 1000).toISOString() })).expect(400);
    expect(await ReportModel.countDocuments({ customerId: id })).toBe(0);
    expect(await CustomerModel.findById(id).lean()).toMatchObject({ status: 'AVAILABLE', revision: 0 });
    await request(app).post(calls).set('Authorization', bearer(tc)).set('Idempotency-Key', nextKey()).send(input(id, { callOutcome: 'NOT_INTERESTED' })).expect(201);
    expect(await CustomerModel.findById(id).lean()).toMatchObject({ status: 'AVAILABLE', revision: 0 });
    expect(await ActivityLogModel.countDocuments({ entityId: id, action: 'CUSTOMER_STATUS_CHANGED' })).toBe(0);
  });
  it('derives stored interest from the single call outcome and ignores conflicting legacy interest', async () => {
    const id = await customer();
    for (const [index, outcome] of ['INTERESTED', 'NOT_INTERESTED', 'CONNECTED', 'NOT_ANSWERED', 'CALLBACK_REQUESTED'].entries()) {
      const start = Date.now() - (index + 1) * 300000;
      const body = { ...input(id), callOutcome: outcome, callStartedAt: new Date(start).toISOString(), callEndedAt: new Date(start + 60000).toISOString() };
      const singleChoice = { ...body, customerInterest: undefined };
      const key = nextKey();
      const created = await request(app).post(calls).set('Authorization', bearer(tc)).set('Idempotency-Key', key).send(singleChoice).expect(201);
      const expected = ['INTERESTED', 'NOT_INTERESTED'].includes(outcome) ? outcome : 'UNKNOWN';
      expect(data<{ customerInterest: string }>(created).customerInterest).toBe(expected);
      const replay = await request(app).post(calls).set('Authorization', bearer(tc)).set('Idempotency-Key', key).send({ ...singleChoice, customerInterest: 'UNDECIDED' }).expect(201);
      expect(data<{ _id: string }>(replay)._id).toBe(data<{ _id: string }>(created)._id);
      expect(data<{ customerInterest: string }>(replay).customerInterest).toBe(expected);
    }
  });
  it('only offers Available and Interested contacts and rejects excluded statuses on submission', async () => {
    const available = await customer(); const interested = await customer();
    const rejected = await customer(); const converted = await customer();
    await CustomerModel.updateOne({ _id: interested }, { $set: { status: 'INTERESTED' } });
    await CustomerModel.updateOne({ _id: rejected }, { $set: { status: 'NOT_INTERESTED' } });
    await CustomerModel.updateOne({ _id: converted }, { $set: { status: 'CONVERTED' } });
    const endpoint = '/api/v1/telecaller-reports/contact-options';
    for (const actor of [tc, mh, md]) {
      const result = await request(app).get(`${endpoint}?limit=100&search=Synthetic`).set('Authorization', bearer(actor)).expect(200);
      expect(data<{ _id: string }[]>(result).map(row => row._id).sort()).toEqual([available.toHexString(), interested.toHexString()].sort());
      expect((result.body as { meta: { total: number } }).meta.total).toBe(2);
      await request(app).get(`${endpoint}?status=NOT_INTERESTED`).set('Authorization', bearer(actor)).expect(200).then(res => { expect(data<unknown[]>(res)).toEqual([]); });
      for (const excluded of [rejected, converted]) await request(app).post(calls).set('Authorization', bearer(actor)).set('Idempotency-Key', nextKey()).send(input(excluded)).expect(404);
    }
    await request(app).post(calls).set('Authorization', bearer(tc)).set('Idempotency-Key', nextKey()).send(input(interested)).expect(201);
    await CustomerModel.updateOne({ _id: available }, { $set: { status: 'NOT_INTERESTED' } });
    await request(app).post(calls).set('Authorization', bearer(tc)).set('Idempotency-Key', nextKey()).send(input(available)).expect(404);
  });
  it('limits contact lookup to assigned contacts within the caller or manager scope, including search and pagination', async () => {
    const own = await customer(); const other = await customer(tc2);
    const unassigned = await customer();
    await CustomerModel.updateOne({ _id: unassigned }, { $set: { assignedTo: null } });
    const lookup = '/api/v1/telecaller-reports/contact-options?limit=100';
    const rows = async (actor: Employee, suffix = '') => data<{ _id: string }[]>(await request(app).get(`${lookup}${suffix}`).set('Authorization', bearer(actor)).expect(200));
    expect((await rows(tc)).map(row => row._id)).toEqual([own.toHexString()]);
    expect(await rows(tc, `&assignedTo=${tc2.id.toHexString()}`)).toEqual([]);
    expect((await rows(tc, '&search=Synthetic&page=1')).map(row => row._id)).toEqual([own.toHexString()]);
    expect((await rows(mh)).map(row => row._id)).toEqual([own.toHexString()]);
    expect(await rows(mh, `&assignedTo=${tc2.id.toHexString()}`)).toEqual([]);
    expect((await rows(md)).map(row => row._id).sort()).toEqual([own.toHexString(), other.toHexString()].sort());
    await request(app).get(lookup).expect(401);
  });
  it('requires authentication, assignment and an eligible calling employee', async () => {
    const id = await customer(); const body = input(id);
    await request(app).post(calls).send(body).expect(401);
    await request(app).post(calls).set('Authorization', bearer(tc2)).set('Idempotency-Key', nextKey()).send(body).expect(404);
    await request(app).post(calls).set('Authorization', bearer()).set('Idempotency-Key', nextKey()).send(body).expect(201);
    await request(app).post(calls).set('Authorization', bearer(tc)).send(body).expect(400);
  });
  it('allows managers to call contacts in their authorized hierarchy and preserves caller identity and assignment', async () => {
    const own = await customer(); const outside = await customer(tc2);
    const created = await request(app).post(calls).set('Authorization', bearer(mh)).set('Idempotency-Key', nextKey()).send(input(own)).expect(201);
    expect(data<{ employeeId: string }>(created).employeeId).toBe(mh.id.toHexString());
    expect((await CustomerModel.findById(own).lean())?.assignedTo.equals(tc.id)).toBe(true);
    expect(await CustomerModel.findById(own).lean()).toMatchObject({ status: 'INTERESTED', revision: 1 });
    await request(app).post(calls).set('Authorization', bearer(mh)).set('Idempotency-Key', nextKey()).send(input(outside)).expect(404);
    await CustomerModel.updateOne({ _id: own }, { $set: { assignedTo: tc2.id } });
    await request(app).post(calls).set('Authorization', bearer(mh)).set('Idempotency-Key', nextKey()).send(input(own)).expect(404);
  });
  it('derives duration, snapshots customer data, replays once, and rejects conflicting reuse', async () => {
    const customerId = await customer(); const body = input(customerId); const key = nextKey();
    const make = () => request(app).post(calls).set('Authorization', bearer(tc)).set('Idempotency-Key', key).send(body);
    const responses = await Promise.all([make(), make()]); expect(responses.map((res) => res.status)).toEqual([201, 201]);
    const report = data<Report>(responses[0]); expect(report.callDurationSeconds).toBe(60); expect(await ReportModel.countDocuments()).toBe(1);
    expect(data<Report>(responses[1])._id).toBe(report._id); expect(responses[0].text).not.toMatch(/requestHash|idempotencyKey/);
    await request(app).post(calls).set('Authorization', bearer(tc)).set('Idempotency-Key', key).send({ ...body, remarks: 'Changed' }).expect(409);
    await request(app).post(calls).set('Authorization', bearer(tc)).set('Idempotency-Key', nextKey()).send({ ...body, callDurationSeconds: 999 }).expect(400);
    await CustomerModel.updateOne({ _id: customerId }, { $set: { customerName: 'Changed customer' } });
    expect(data<{ customerName: string }>(await request(app).get(`${calls}/${report._id}`).set('Authorization', bearer(tc)).expect(200)).customerName).toBe('Synthetic customer');
    await CustomerModel.updateOne({ _id: customerId }, { $set: { assignedTo: tc2.id } }); await make().expect(404);
  });
  it('rejects invalid, future, stale, implausible and overlapping intervals', async () => {
    const id = await customer(); const now = Date.now();
    for (const changes of [{ callStartedAt: '2026-02-30T12:00:00Z' }, { callEndedAt: new Date(now + 60000).toISOString() }, { callStartedAt: new Date(now - 8 * 86400000).toISOString() },
      { callStartedAt: new Date(now - 5 * 3600000).toISOString() }, { callStartedAt: new Date(now - 1000).toISOString() }, { callStartedAt: '2026-01-01' }, { followUpAt: new Date(now - 1000).toISOString() }]) {
      await request(app).post(calls).set('Authorization', bearer(tc)).set('Idempotency-Key', nextKey()).send(input(id, changes)).expect(400);
    }
    const body = input(id); await request(app).post(calls).set('Authorization', bearer(tc)).set('Idempotency-Key', nextKey()).send(body).expect(201);
    await request(app).post(calls).set('Authorization', bearer(tc)).set('Idempotency-Key', nextKey()).send(body).expect(409);
  });
  it('scopes records and aggregates before pagination, separating reviewed totals', async () => {
    const first = data<Report>(await request(app).post(calls).set('Authorization', bearer(tc)).set('Idempotency-Key', nextKey()).send(input(await customer())).expect(201));
    await request(app).post(calls).set('Authorization', bearer(tc2)).set('Idempotency-Key', nextKey()).send(input(await customer(tc2))).expect(201);
    expect(data<Report[]>(await request(app).get(calls).set('Authorization', bearer(tc)).expect(200))).toHaveLength(1);
    await request(app).get(`${calls}/${first._id}`).set('Authorization', bearer(tc2)).expect(404);
    const daily = async (actor: Employee) => data<{ days: { totalCalls: number; approvedCalls: number; approvedDurationSeconds: number }[] }>(await request(app).get('/api/v1/telecaller-reports/daily').set('Authorization', bearer(actor)).expect(200));
    expect((await daily(mh)).days).toMatchObject([{ totalCalls: 1, approvedCalls: 0, outcomeCounts: { INTERESTED: 1, CONNECTED: 0, NOT_ANSWERED: 0 } }]);
    await request(app).patch(`${calls}/${first._id}/review`).set('Authorization', bearer(mh)).send({ revision: 0, reviewStatus: 'APPROVED', remarks: 'Evidence reviewed' }).expect(200);
    expect((await daily(mh)).days).toMatchObject([{ totalCalls: 1, approvedCalls: 1, approvedDurationSeconds: 60 }]); expect((await daily(md)).days).toHaveLength(2);
    await request(app).get(`${calls}?employeeId=${tc2.id.toHexString()}`).set('Authorization', bearer(mh)).expect(200).then((res) => { expect(data<Report[]>(res)).toHaveLength(0); });
  });
  it('supports inclusive Kolkata dates and rejects malformed calendar ranges', async () => {
    const id = await customer(); const date = new Date(Date.now() - 86400000).toISOString().slice(0, 10); const startAt = `${date}T18:29:00Z`; const endAt = `${date}T18:31:00Z`;
    await request(app).post(calls).set('Authorization', bearer(tc)).set('Idempotency-Key', nextKey()).send(input(id, { callStartedAt: startAt, callEndedAt: endAt })).expect(201);
    expect(data<Report[]>(await request(app).get(`${calls}?from=${date}&to=${date}`).set('Authorization', bearer(tc)).expect(200))).toHaveLength(1);
    for (const suffix of ['from=2026-02-30', 'from=2026-10-18&to=2026-10-17', 'limit=101', 'from=garbage']) await request(app).get(`${calls}?${suffix}`).set('Authorization', bearer(tc)).expect(400);
  });
  it('keeps append-only revision history and rejects concurrent stale reviews', async () => {
    const report = data<Report>(await request(app).post(calls).set('Authorization', bearer(tc)).set('Idempotency-Key', nextKey()).send(input(await customer())).expect(201));
    const responses = await Promise.all(['APPROVED', 'REJECTED'].map((reviewStatus) => request(app).patch(`${calls}/${report._id}/review`).set('Authorization', bearer(mh)).send({ revision: 0, reviewStatus, remarks: 'Evidence checked' })));
    expect(responses.map((res) => res.status).sort()).toEqual([200, 409]);
    const history = data<{ action: string }[]>(await request(app).get(`${calls}/${report._id}/history`).set('Authorization', bearer(tc)).expect(200)); expect(history.map((entry) => entry.action)).toEqual(['REVIEWED', 'CREATED']);
    await request(app).get(`${calls}/${report._id}/history`).set('Authorization', bearer(tc2)).expect(404);
    await expect(ReportHistoryModel.updateOne({ reportId: report._id }, { $set: { remarks: 'Overwrite' } })).rejects.toThrow('append-only');
    const original = await ReportHistoryModel.findOne({ reportId: report._id }); if (!original) throw new Error('History missing'); original.remarks = 'Edited';
    await expect(original.save()).rejects.toThrow('append-only'); await expect(original.deleteOne()).rejects.toThrow('append-only');
    expect(await ActivityLogModel.countDocuments({ entityId: report._id, action: 'REPORT_REVIEWED' })).toBe(1);
  });
  it('rejects inactive branches and on-leave callers even with an existing authenticated session', async () => {
    const id = await customer(); await BranchModel.updateOne({ _id: branch }, { $set: { isActive: false } });
    try { await request(app).post(calls).set('Authorization', bearer(tc)).set('Idempotency-Key', nextKey()).send(input(id)).expect(409); }
    finally { await BranchModel.updateOne({ _id: branch }, { $set: { isActive: true } }); }
    await UserModel.updateOne({ _id: tc.id }, { $set: { employmentStatus: 'ON_LEAVE' } });
    try { await request(app).post(calls).set('Authorization', bearer(tc)).set('Idempotency-Key', nextKey()).send(input(id)).expect(400); }
    finally { await UserModel.updateOne({ _id: tc.id }, { $set: { employmentStatus: 'ACTIVE' } }); }
  });
});
describe('site visit submission and private evidence', () => {
  it('uses current assignment, rejects terminal leads and never authorizes historical salesExecutiveId', async () => {
    const id = await lead(); await LeadModel.updateOne({ _id: id }, { $set: { assignedTo: outsider.id, salesExecutiveId: sex.id } });
    await request(app).post(visits).set('Authorization', bearer(sex)).set('Idempotency-Key', nextKey()).send({ leadId: id, location, clientCapturedAt: captured() }).expect(404);
    await request(app).post(visits).set('Authorization', bearer(sex)).set('Idempotency-Key', nextKey()).send({ leadId: await lead(sex, 'CONVERTED'), location, clientCapturedAt: captured() }).expect(409);
    await request(app).post(visits).set('Authorization', bearer(sex)).set('Idempotency-Key', nextKey()).send({ leadId: await lead(), location: { ...location, latitude: 91 }, clientCapturedAt: captured() }).expect(400);
  });
  it('replays starts with a durable key and preserves separate completed visits', async () => {
    const leadId = await lead(); const key = nextKey(); const body = { leadId, location, clientCapturedAt: captured() };
    const first = data<Report>(await request(app).post(visits).set('Authorization', bearer(sex)).set('Idempotency-Key', key).send(body).expect(201));
    const replay = data<Report>(await request(app).post(visits).set('Authorization', bearer(sex)).set('Idempotency-Key', key).send(body).expect(201)); expect(replay._id).toBe(first._id);
    await request(app).patch(`${visits}/${first._id}/complete`).set('Authorization', bearer(sex)).send(completion(await photo(first))).expect(200);
    const second = await start(leadId); expect(second._id).not.toBe(first._id); expect(await ReportModel.countDocuments({ leadId })).toBe(2);
    await request(app).post(visits).set('Authorization', bearer(sex)).set('Idempotency-Key', key).send({ ...body, location: { ...location, longitude: 77 } }).expect(409);
  });
  it('attaches confirmed immutable versions, computes exact value, and advances only scheduled leads', async () => {
    const leadId = await lead(); const report = await start(leadId); const fileId = await photo(report);
    const completed = data<Report>(await request(app).patch(`${visits}/${report._id}/complete`).set('Authorization', bearer(sex)).send(completion(fileId)).expect(200));
    expect(completed).toMatchObject({ status: 'SUBMITTED', revision: 1, estimatedProjectValue: '357500.00', photoFileIds: [fileId] }); expect(completed.point.coordinates).toEqual([88.36, 22.57]);
    expect((await LeadModel.findById(leadId).lean())?.status).toBe('SITE_VISITED'); expect(await LeadEventModel.countDocuments({ leadId, toStatus: 'SITE_VISITED' })).toBe(1);
    await request(app).get(`${visits}/${report._id}/photos/${fileId}/download`).set('Authorization', bearer(mh)).expect(200);
    expect(download).toHaveBeenCalledWith(expect.objectContaining({ versionId: 'immutable-version', status: 'ATTACHED' }), 'immutable-version');
    await request(app).get(`${visits}/${report._id}/photos/${fileId}/download`).set('Authorization', bearer(outsider)).expect(404);
    const privateResponse = await request(app).get(`${visits}/${report._id}`).set('Authorization', bearer(sex)).expect(200); expect(privateResponse.text).not.toMatch(/objectKey|bucket|versionId|checksumSHA256/);
    await request(app).patch(`${visits}/${report._id}/complete`).set('Authorization', bearer(sex)).send(completion(fileId, { revision: 1 })).expect(404);
  });
  it('rolls back attachment when any photo is invalid and rejects photos from another visit', async () => {
    const first = await start(); const second = await start(); const fileId = await photo(first);
    await request(app).patch(`${visits}/${first._id}/complete`).set('Authorization', bearer(sex)).send(completion(fileId, { photoFileIds: [fileId, new Types.ObjectId().toHexString()] })).expect(400);
    expect((await FileModel.findById(fileId).lean())?.status).toBe('READY'); expect((await ReportModel.findById(first._id).lean())?.status).toBe('OPEN');
    await request(app).patch(`${visits}/${second._id}/complete`).set('Authorization', bearer(sex)).send(completion(fileId)).expect(400);
    await request(app).patch(`${visits}/${first._id}/complete`).set('Authorization', bearer(tc)).send(completion(fileId)).expect(404);
    await request(app).patch(`${visits}/${first._id}/complete`).set('Authorization', bearer(sex)).send(completion(fileId, { photoFileIds: [] })).expect(400);
  });
  it('rechecks lead assignment and eligibility before accepting photos or completion', async () => {
    const id = await lead(); const report = await start(id); const fileId = await photo(report);
    await LeadModel.updateOne({ _id: id }, { $set: { assignedTo: outsider.id } });
    await request(app).patch(`${visits}/${report._id}/complete`).set('Authorization', bearer(sex)).send(completion(fileId)).expect(404);
    await request(app).post(`${visits}/${report._id}/photos/${fileId}/confirm`).set('Authorization', bearer(sex)).expect(404);
    expect((await FileModel.findById(fileId).lean())?.status).toBe('READY');
  });
  it('flags stale/poor GPS, preserves raw start evidence, and expires open visits after 24 hours', async () => {
    const report = await start(); const fileId = await photo(report);
    const completed = data<Report>(await request(app).patch(`${visits}/${report._id}/complete`).set('Authorization', bearer(sex)).send(completion(fileId, { clientCapturedAt: new Date(Date.now() - 600000).toISOString(), location: { ...location, accuracyMeters: 500 } })).expect(200));
    expect(completed.evidenceFlags).toEqual(expect.arrayContaining(['CAPTURE_TIME_SKEW', 'LOW_GPS_ACCURACY'])); expect(completed.reviewStatus).toBe('PENDING');
    const leadId = await lead(); const old = await start(leadId); await ReportModel.updateOne({ _id: old._id }, { $set: { visitStartedAt: new Date(Date.now() - 86400001) } });
    await request(app).patch(`${visits}/${old._id}/complete`).set('Authorization', bearer(sex)).send(completion(fileId)).expect(409);
    const replacement = await start(leadId); expect(replacement._id).not.toBe(old._id); expect((await ReportModel.findById(old._id).lean())?.status).toBe('EXPIRED');
    expect(await ReportHistoryModel.countDocuments({ reportId: old._id, action: 'EXPIRED' })).toBe(1);
  });
  it('requires completed submission for reviews, rejects self review and preserves review history', async () => {
    const report = await start(); const body = { revision: 0, reviewStatus: 'APPROVED', remarks: 'Visit evidence checked' };
    await request(app).patch(`${visits}/${report._id}/review`).set('Authorization', bearer(mh)).send(body).expect(409);
    await request(app).patch(`${visits}/${report._id}/complete`).set('Authorization', bearer(sex)).send(completion(await photo(report))).expect(200);
    await request(app).patch(`${visits}/${report._id}/review`).set('Authorization', bearer(mh)).send({ ...body, revision: 1 }).expect(200);
    const history = data<{ action: string }[]>(await request(app).get(`${visits}/${report._id}/history`).set('Authorization', bearer(sex)).expect(200)); expect(history.map((entry) => entry.action)).toEqual(['REVIEWED', 'SUBMITTED', 'CREATED']);
    // MD has review authority, but cannot approve their own report even with ALL scope.
    await ReportModel.updateOne({ _id: report._id }, { $set: { employeeId: md.id } });
    await request(app).patch(`${visits}/${report._id}/review`).set('Authorization', bearer()).send({ ...body, revision: 2 }).expect(403);
  });
  it('protects pending photo downloads, enforces expiry and cleans orphan visit versions', async () => {
    const report = await start(); const fileId = await photo(report);
    await request(app).get(`${visits}/${report._id}/photos/${fileId}/download`).set('Authorization', bearer(sex)).expect(404);
    await request(app).post(`/api/v1/files/${fileId}/confirm`).set('Authorization', bearer(sex)).expect(404);
    await FileModel.updateOne({ _id: fileId }, { $set: { expiresAt: new Date(Date.now() - 2 * 86400000) } });
    await request(app).patch(`${visits}/${report._id}/complete`).set('Authorization', bearer(sex)).send(completion(fileId)).expect(400);
    expect(await new FileService(config, storage).cleanup()).toBe(1); expect(remove).toHaveBeenCalledOnce(); expect((await FileModel.findById(fileId).lean())?.status).toBe('DELETED');
  });
  it('does not regress later stages or bypass a pinned custom workflow', async () => {
    const leadId = await lead(sex, 'QUOTATION_SENT'); const report = await start(leadId);
    await request(app).patch(`${visits}/${report._id}/complete`).set('Authorization', bearer(sex)).send(completion(await photo(report))).expect(200);
    expect((await LeadModel.findById(leadId).lean())?.status).toBe('QUOTATION_SENT');
    const workflow = await WorkflowModel.create({ version: 2, transitions: [{ from: 'NEW', to: 'CONTACTED' }], createdBy: md.id });
    const scheduledId = await lead(); await LeadModel.updateOne({ _id: scheduledId }, { $set: { workflowVersion: workflow.version } }); const scheduled = await start(scheduledId);
    await request(app).patch(`${visits}/${scheduled._id}/complete`).set('Authorization', bearer(sex)).send(completion(await photo(scheduled))).expect(200);
    expect((await LeadModel.findById(scheduledId).lean())?.status).toBe('SITE_VISIT_SCHEDULED');
  });
  it('commits one concurrent completion and one lead event, with frozen valuation and follow-up', async () => {
    const leadId = await lead(); const report = await start(leadId); const fileId = await photo(report); const followUp = new Date(Date.now() + 86400000).toISOString();
    const body = completion(fileId, { nextFollowUpAt: followUp });
    const responses = await Promise.all([0, 1].map(() => request(app).patch(`${visits}/${report._id}/complete`).set('Authorization', bearer(sex)).send(body)));
    expect(responses.map((res) => res.status).sort()).toEqual([200, 404]); expect(await LeadEventModel.countDocuments({ leadId })).toBe(1);
    expect((await LeadModel.findById(leadId).lean())?.nextFollowUpAt?.toISOString()).toBe(followUp);
    await LeadModel.updateOne({ _id: leadId }, { $set: { ratePerKw: '1.00' } });
    expect(data<Report>(await request(app).get(`${visits}/${report._id}`).set('Authorization', bearer(sex)).expect(200)).estimatedProjectValue).toBe('357500.00');
  });
  it('rolls back photos, report, lead and history if audit insertion fails', async () => {
    const leadId = await lead(); const report = await start(leadId); const fileId = await photo(report);
    const spy = vi.spyOn(ActivityLogModel, 'create').mockRejectedValueOnce(new Error('Audit unavailable'));
    try { await request(app).patch(`${visits}/${report._id}/complete`).set('Authorization', bearer(sex)).send(completion(fileId)).expect(500); }
    finally { spy.mockRestore(); }
    expect((await FileModel.findById(fileId).lean())?.status).toBe('READY'); expect((await ReportModel.findById(report._id).lean())?.status).toBe('OPEN');
    expect((await LeadModel.findById(leadId).lean())?.status).toBe('SITE_VISIT_SCHEDULED'); expect(await LeadEventModel.countDocuments({ leadId })).toBe(0);
    expect(await ReportHistoryModel.countDocuments({ reportId: report._id })).toBe(1);
  });
  it('retains submission without silently gaining lead-update rights', async () => {
    const leadId = await lead(); const report = await start(leadId); const fileId = await photo(report);
    const role = await RoleModel.findOne({ code: 'SEX' }).lean(); const permission = await PermissionModel.findOne({ code: 'leads:update' }).lean();
    if (!role || !permission) throw new Error('Fixture permission missing');
    await RoleModel.updateOne({ _id: role._id }, { $set: { permissions: role.permissions.filter((grant) => !grant.permissionId.equals(permission._id)) } });
    try { await request(app).patch(`${visits}/${report._id}/complete`).set('Authorization', bearer(sex)).send(completion(fileId, { nextFollowUpAt: new Date(Date.now() + 86400000).toISOString() })).expect(200); }
    finally { await RoleModel.updateOne({ _id: role._id }, { $set: { permissions: role.permissions } }); }
    expect((await LeadModel.findById(leadId).lean())?.status).toBe('SITE_VISIT_SCHEDULED'); expect((await LeadModel.findById(leadId).lean())?.nextFollowUpAt).toBeNull();
  });
  it('enforces fresh revisions, bounded future follow-ups, MIME matching and parent scope for uploads', async () => {
    const report = await start(); const fileId = await photo(report);
    await request(app).patch(`${visits}/${report._id}/complete`).set('Authorization', bearer(sex)).send(completion(fileId, { revision: 9 })).expect(409);
    await request(app).patch(`${visits}/${report._id}/complete`).set('Authorization', bearer(sex)).send(completion(fileId, { nextFollowUpAt: new Date(Date.now() - 1000).toISOString() })).expect(400);
    await request(app).patch(`${visits}/${report._id}/complete`).set('Authorization', bearer(sex)).send(completion(fileId, { requiredCapacityKw: '5.123' })).expect(400);
    const upload = { filename: 'site.png', contentType: 'image/jpeg', size: 100, checksumSHA256: Buffer.alloc(32).toString('base64') };
    await request(app).post(`${visits}/${report._id}/photos/upload-intents`).set('Authorization', bearer(sex)).send(upload).expect(400);
    await request(app).post(`${visits}/${report._id}/photos/upload-intents`).set('Authorization', bearer(outsider)).send({ ...upload, filename: 'site.jpg' }).expect(404);
    expect((await FileModel.findById(fileId).lean())?.status).toBe('READY');
  });
  it('requires explicit receive-assignment capability even when read and reporting grants remain', async () => {
    const report = await start(); const fileId = await photo(report);
    const role = await RoleModel.findOne({ code: 'SEX' }).lean(); const permission = await PermissionModel.findOne({ code: 'leads:receive_assignment' }).lean();
    if (!role || !permission) throw new Error('Fixture permission missing');
    await RoleModel.updateOne({ _id: role._id }, { $set: { permissions: role.permissions.filter((grant) => !grant.permissionId.equals(permission._id)) } });
    try { await request(app).patch(`${visits}/${report._id}/complete`).set('Authorization', bearer(sex)).send(completion(fileId)).expect(400); }
    finally { await RoleModel.updateOne({ _id: role._id }, { $set: { permissions: role.permissions } }); }
    expect((await ReportModel.findById(report._id).lean())?.status).toBe('OPEN');
  });
  it('applies dynamic permission removal immediately to an existing session', async () => {
    const role = await RoleModel.findOne({ code: 'SEX' }).lean(); const permission = await PermissionModel.findOne({ code: 'reports:create' }).lean();
    if (!role || !permission) throw new Error('Fixture permission missing');
    const previous = role.permissions; await RoleModel.updateOne({ _id: role._id }, { $set: { permissions: previous.filter((grant) => !grant.permissionId.equals(permission._id)) } });
    try { await request(app).post(visits).set('Authorization', bearer(sex)).set('Idempotency-Key', nextKey()).send({ leadId: await lead(), location, clientCapturedAt: captured() }).expect(403); }
    finally { await RoleModel.updateOne({ _id: role._id }, { $set: { permissions: previous } }); }
  });
});
