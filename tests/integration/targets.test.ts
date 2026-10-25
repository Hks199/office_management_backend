import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from 'vitest';
import request, { type Response } from 'supertest';
import { Types } from 'mongoose';
import { testConfig } from '../helpers.js';
import { createApp } from '../../src/app.js';
import { createLogger } from '../../src/config/logger.js';
import { connectDatabase, disconnectDatabase } from '../../src/config/database.js';
import { createIdentityIndexes } from '../../src/modules/auth/identity-indexes.js';
import { createOrganizationIndexes } from '../../src/modules/hierarchy/organization-indexes.js';
import { createAttendanceIndexes } from '../../src/modules/attendance/attendance-indexes.js';
import { createCommercialIndexes } from '../../src/modules/leads/commercial-indexes.js';
import { createReportIndexes } from '../../src/modules/reports/report-indexes.js';
import { createTargetIndexes } from '../../src/modules/targets/target-indexes.js';
import { bootstrapMd } from '../../src/modules/auth/bootstrap.service.js';
import { AuthService } from '../../src/modules/auth/auth.service.js';
import { hashPassword } from '../../src/shared/utils/crypto.js';
import { UserModel } from '../../src/modules/users/user.model.js';
import { RoleModel } from '../../src/modules/roles/role.model.js';
import { PermissionModel } from '../../src/modules/permissions/permission.model.js';
import { BranchModel } from '../../src/modules/branches/branch.model.js';
import { StateModel, DistrictModel } from '../../src/modules/locations/location.model.js';
import { LeadModel, LeadEventModel, AssignmentModel, CustomerModel, ReferenceModel } from '../../src/modules/leads/commercial.models.js';
import { ReportModel } from '../../src/modules/reports/report.model.js';
import { TargetModel, TargetRevisionModel, TargetEvidenceModel, TargetEvidenceReviewModel } from '../../src/modules/targets/target.model.js';
import { ActivityLogModel } from '../../src/modules/activity-logs/activity-log.model.js';
import type { TargetType } from '../../src/modules/targets/target.types.js';
import type { Milestone } from '../../src/modules/targets/target-evidence.js';
const config = testConfig({ rateLimitMax: 100000 });
const app = createApp(config, { logger: createLogger(config), isDatabaseReady: () => Promise.resolve(true) });
let replica: MongoMemoryReplSet | undefined; let md: Employee; let mh: Employee; let bh: Employee; let tc: Employee; let tc2: Employee; let sex: Employee; let other: Employee;
let branch: Types.ObjectId; let foreignBranch: Types.ObjectId; let stateId: Types.ObjectId; let districtId: Types.ObjectId; let passwordHash: string; let sequence = 0;
interface Employee { id: Types.ObjectId; token: string }
interface Target { _id: string; revision: number; branchId: string; targetValue: string; actualValue: string; achievementPercentage: string; status: string }
interface Evidence { _id: string; employeeId: string; revision: number; valueAtConversion: string | null; reviewStatus: string; occurredAt: string }
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- Assert the response shape at the HTTP boundary.
const data = <T>(res: Response): T => (res.body as { data: T }).data;
const bearer = (actor = md) => `Bearer ${actor.token}`;
const key = () => `target-fixture-${String(++sequence).padStart(8, '0')}`;
const period = { periodType: 'MONTHLY', startDate: '2026-10-01', endDate: '2026-11-01' };
async function employee(code: string, manager: Types.ObjectId, office: Types.ObjectId): Promise<Employee> {
  const role = await RoleModel.findOne({ code }).lean(); if (!role) throw new Error('Fixture role missing'); sequence++; const email = `target-${String(sequence)}@example.invalid`;
  const user = await UserModel.create({ employeeCode: key(), firstName: 'Fixture', lastName: 'Employee', email, mobileNumber: `+91777${String(sequence).padStart(7, '0')}`, passwordHash,
    roleId: role._id, branchId: office, reportingManagerId: manager, createdBy: md.id, dateOfJoining: new Date() });
  return { id: user._id, token: (await new AuthService(config).login(email, 'Target fixture password 2026!', { requestId: 'fixture' })).accessToken };
}
const body = (actor = tc, type: TargetType = 'CALLS_COMPLETED', extra = {}) => ({ employeeId: actor.id.toHexString(), targetType: type, targetValue: '2', ...period, ...extra });
async function target(actor = tc, type: TargetType = 'CALLS_COMPLETED', extra = {}, manager = md) { return data<Target>(await request(app).post('/api/v1/targets').set('Authorization', bearer(manager)).send(body(actor, type, extra)).expect(201)); }
async function progress(item: Target, actor = md) { return data<Target>(await request(app).get(`/api/v1/targets/${item._id}/progress`).set('Authorization', bearer(actor)).expect(200)); }
async function activity(actor = tc, changes = {}) {
  const at = new Date(new Date('2026-10-03T06:00:00Z').getTime() + ++sequence * 1000);
  return ReportModel.create({ kind: 'CALL', employeeId: actor.id, branchId: actor.id.equals(other.id) ? foreignBranch : branch, businessDate: '2026-10-03', idempotencyKey: key(), requestHash: key(),
    customerName: 'Synthetic customer', customerMobile: '+919876543210', siteAddress: 'Synthetic site', callStartedAt: new Date(at.getTime() - 1000), callEndedAt: at, callDurationSeconds: 1, callOutcome: 'CONNECTED', status: 'SUBMITTED', reviewStatus: 'APPROVED', ...changes });
}
async function lead(actor = sex, changes = {}, eventCreatedAt?: Date) {
  const record = await LeadModel.create({ leadCode: key(), customerName: 'Synthetic lead', mobileNumber: '+919876543211', siteAddress: 'Synthetic site', stateId, districtId, branchId: branch,
    requiredCapacityKw: '5.00', ratePerKw: '55000.00', estimatedProjectValue: '275000.00', paymentMode: 'BANK', panelBrand: 'TEST', panelTechnology: 'TEST', leadSource: 'TEST', status: 'QUOTATION_SENT', workflowVersion: 1,
    createdBy: tc.id, assignedTo: actor.id, assignedBy: md.id, assignedAt: new Date(), salesExecutiveId: actor.id, ...changes });
  await LeadEventModel.create({ leadId: record._id, toStatus: 'NEW', actorId: tc.id, workflowVersion: 1, leadRevision: 0, createdAt: eventCreatedAt ?? record.createdAt });
  await AssignmentModel.create({ entityType: 'LEAD', entityId: record._id, assignedTo: actor.id, assignedBy: md.id, entityRevision: 0, reason: 'Fixture initial assignment' }); return record;
}
async function convert(id: Types.ObjectId, revision = 0, actor = sex) { return request(app).patch(`/api/v1/leads/${id.toHexString()}/status`).set('Authorization', bearer(actor)).send({ revision, status: 'CONVERTED', reason: 'Synthetic customer accepted offer' }).expect(200); }
async function evidence(leadId: Types.ObjectId, milestone: Milestone = 'CONVERTED') { const result = await TargetEvidenceModel.findOne({ leadId, milestone }).lean(); if (!result) throw new Error('Evidence missing'); return result; }
async function approve(id: Types.ObjectId, actor = mh, revision = 0) { return data<Evidence>(await request(app).patch(`/api/v1/target-evidence/${id.toHexString()}/review`).set('Authorization', bearer(actor)).send({ revision, reviewStatus: 'APPROVED', remarks: 'Underlying milestone verified' }).expect(200)); }
beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } }); await connectDatabase({ ...config, mongodbUri: replica.getUri('targets') }, createLogger(config));
  await createIdentityIndexes(); await createOrganizationIndexes(); await createAttendanceIndexes(); await createCommercialIndexes(); await createReportIndexes(); await createTargetIndexes();
  const root = await bootstrapMd({ employeeCode: 'TAR-MD', firstName: 'Fixture', lastName: 'Director', email: 'tar-md@example.invalid', mobileNumber: '+919999999999' }, config.tokenEncryptionKey);
  passwordHash = await hashPassword('Target fixture password 2026!'); await UserModel.updateOne({ _id: root }, { $set: { passwordHash } });
  md = { id: root, token: (await new AuthService(config).login('tar-md@example.invalid', 'Target fixture password 2026!', { requestId: 'fixture' })).accessToken };
  stateId = (await StateModel.create({ code: 'TAR', name: 'Synthetic state', createdBy: root }))._id; districtId = (await DistrictModel.create({ code: 'D1', name: 'Synthetic district', stateId, createdBy: root }))._id;
  const office = async (code: string) => (await BranchModel.create({ branchCode: code, branchName: 'Synthetic office', address: 'Synthetic address', stateId, districtId, contactNumber: '+919000000000', createdBy: root }))._id;
  branch = await office('TAR-A'); foreignBranch = await office('TAR-B'); mh = await employee('MH', root, branch); bh = await employee('BH', mh.id, branch);
  tc = await employee('TC', bh.id, branch); sex = await employee('SEX', bh.id, branch); tc2 = await employee('TC', root, branch); other = await employee('SEX', root, foreignBranch);
  for (const [category, code] of [['PAYMENT_MODE', 'BANK'], ['PANEL_BRAND', 'TEST'], ['PANEL_TECHNOLOGY', 'TEST'], ['LEAD_SOURCE', 'TEST']] as const) await ReferenceModel.create({ category, code, label: 'Synthetic reference', createdBy: root });
}, 180000);
beforeEach(async () => { await Promise.all([TargetModel.deleteMany({}), TargetEvidenceModel.deleteMany({}), ReportModel.deleteMany({}), LeadModel.deleteMany({}), CustomerModel.deleteMany({})]); });
afterAll(async () => { vi.restoreAllMocks(); await disconnectDatabase(); await replica?.stop(); });
describe('target definitions, assignment and history', () => {
  it('shows the assigning director name on own targets and revisions without directory access', async () => {
    const item = await target();
    await request(app).get(`/api/v1/employees/${md.id.toHexString()}`).set('Authorization', bearer(tc)).expect(404);
    const detail = data<Record<string, unknown>>(await request(app).get(`/api/v1/targets/${item._id}`).set('Authorization', bearer(tc)).expect(200));
    expect(detail).toMatchObject({ assignedByName: 'Fixture Director', assignedByCode: 'TAR-MD' });
    const revisions = await request(app).get(`/api/v1/targets/${item._id}/revisions`).set('Authorization', bearer(tc)).expect(200);
    expect(data<Record<string, unknown>[]>(revisions)).toEqual(expect.arrayContaining([expect.objectContaining({ assignedByName: 'Fixture Director', assignedByCode: 'TAR-MD' })]));
    expect(revisions.text).not.toMatch(/passwordHash|mobileNumber|email|permissions/);
  });
  it('enforces authentication, manager scope and employee activity capabilities', async () => {
    await request(app).post('/api/v1/targets').send(body()).expect(401);
    await request(app).post('/api/v1/targets').set('Authorization', bearer(tc)).send(body()).expect(403);
    await request(app).post('/api/v1/targets').set('Authorization', bearer(mh)).send(body(tc2)).expect(404);
    await request(app).post('/api/v1/targets').set('Authorization', bearer(bh)).send(body(other, 'SITE_VISITS')).expect(404);
    await request(app).post('/api/v1/targets').set('Authorization', bearer()).send(body(sex)).expect(400);
    const assigned = await target(tc2, 'CALLS_COMPLETED', {}, bh); expect(assigned.branchId).toBe(branch.toHexString());
  });
  it('validates canonical periods, exact values, dates and server-owned fields', async () => {
    for (const extra of [{ targetValue: '-1' }, { targetValue: '0.5' }, { targetValue: 10 }, { startDate: '2026-02-30' }, { periodType: 'WEEKLY' },
      { assignedBy: md.id }, { branchId: foreignBranch }, { actualValue: '99' }, { periodType: 'CUSTOM', endDate: '2028-01-01' }]) await request(app).post('/api/v1/targets').set('Authorization', bearer()).send(body(tc, 'CALLS_COMPLETED', extra)).expect(400);
    const daily = await target(tc, 'CALLS_COMPLETED', { periodType: 'DAILY', startDate: '2026-10-01', endDate: '2026-10-02' });
    const result = await request(app).get(`/api/v1/targets/${daily._id}`).set('Authorization', bearer(tc)).expect(200); expect(data<{ startDate: string }>(result).startDate).toBe('2026-09-30T18:30:00.000Z');
  });
  it('serializes overlapping creates while allowing adjacent periods and separate period types', async () => {
    const responses = await Promise.all([0, 1].map(() => request(app).post('/api/v1/targets').set('Authorization', bearer()).send(body())));
    expect(responses.map((res) => res.status).sort()).toEqual([201, 409]); expect(await TargetModel.countDocuments()).toBe(1);
    await target(tc, 'CALLS_COMPLETED', { startDate: '2026-11-01', endDate: '2026-12-01' });
    await target(tc, 'CALLS_COMPLETED', { periodType: 'DAILY', startDate: '2026-10-01', endDate: '2026-10-02' });
    await target(tc, 'CALLS_COMPLETED', { periodType: 'CUSTOM', startDate: '2026-10-01', endDate: '2026-10-10' });
    await request(app).post('/api/v1/targets').set('Authorization', bearer()).send(body(tc, 'CALLS_COMPLETED', { periodType: 'CUSTOM', startDate: '2026-10-09', endDate: '2026-10-12' })).expect(409);
  });
  it('uses scoped lists, counts, single records and revision history', async () => {
    const own = await target(); const peer = await target(tc2); const foreign = await target(other, 'SITE_VISITS');
    expect(data<Target[]>(await request(app).get('/api/v1/targets?limit=1').set('Authorization', bearer(mh)).expect(200))).toHaveLength(1);
    await request(app).get(`/api/v1/targets/${peer._id}`).set('Authorization', bearer(mh)).expect(404);
    await request(app).get(`/api/v1/targets/${foreign._id}/revisions`).set('Authorization', bearer(bh)).expect(404);
    expect(data<Target[]>(await request(app).get(`/api/v1/targets?employeeId=${tc2.id.toHexString()}`).set('Authorization', bearer(tc)).expect(200))).toHaveLength(0);
    expect(data<Target[]>(await request(app).get(`/api/v1/targets/${own._id}/revisions`).set('Authorization', bearer(tc)).expect(200))).toHaveLength(1);
  });
  it('records full immutable revisions and rejects stale concurrent updates', async () => {
    const item = await target();
    const responses = await Promise.all(['3', '4'].map((targetValue) => request(app).patch(`/api/v1/targets/${item._id}`).set('Authorization', bearer(bh)).send({ revision: 0, targetValue, reason: 'Reviewed goal adjustment' })));
    expect(responses.map((res) => res.status).sort()).toEqual([200, 409]); expect(await TargetRevisionModel.countDocuments({ targetId: item._id })).toBe(2);
    await expect(TargetRevisionModel.updateOne({ targetId: item._id }, { $set: { reason: 'Overwrite' } })).rejects.toThrow('append-only');
    const first = await TargetRevisionModel.findOne({ targetId: item._id, revision: 0 }); if (!first) throw new Error('Revision missing'); first.reason = 'Overwrite'; await expect(first.save()).rejects.toThrow('append-only');
  });
  it('cancels without deleting history and checks overlap on reactivation', async () => {
    const item = await target(); await request(app).patch(`/api/v1/targets/${item._id}`).set('Authorization', bearer()).send({ revision: 0, status: 'CANCELLED', reason: 'Cancelled after review' }).expect(200);
    await target(); await request(app).patch(`/api/v1/targets/${item._id}`).set('Authorization', bearer()).send({ revision: 1, status: 'ACTIVE', reason: 'Reactivate old target' }).expect(409);
    expect(data<Target[]>(await request(app).get('/api/v1/targets?status=CANCELLED').set('Authorization', bearer(tc)).expect(200))).toHaveLength(1);
  });
  it('retains historical branch attribution and requires both old and current destination scope', async () => {
    const item = await target(); await activity(); await UserModel.updateOne({ _id: tc.id }, { $set: { branchId: foreignBranch, reportingManagerId: md.id } });
    try {
      await request(app).patch(`/api/v1/targets/${item._id}`).set('Authorization', bearer(bh)).send({ revision: 0, targetValue: '3', reason: 'Outside current branch' }).expect(404);
      await activity(tc, { branchId: foreignBranch }); expect((await progress(item, tc)).actualValue).toBe('1.00');
      const newBranch = await target(); expect(newBranch.branchId).toBe(foreignBranch.toHexString()); expect((await progress(newBranch)).actualValue).toBe('1.00');
    } finally { await UserModel.updateOne({ _id: tc.id }, { $set: { branchId: branch, reportingManagerId: bh.id } }); }
  });
  it('rolls back target and revision when audit fails, and supports inactive-employee cancellation', async () => {
    const spy = vi.spyOn(ActivityLogModel, 'create').mockRejectedValueOnce(new Error('Audit unavailable'));
    try { await request(app).post('/api/v1/targets').set('Authorization', bearer()).send(body()).expect(500); } finally { spy.mockRestore(); }
    expect(await TargetModel.countDocuments()).toBe(0);
    const item = await target(); await UserModel.updateOne({ _id: tc.id }, { $set: { employmentStatus: 'ON_LEAVE' } });
    try {
      await request(app).patch(`/api/v1/targets/${item._id}`).set('Authorization', bearer()).send({ revision: 0, targetValue: '4', reason: 'Inactive employee' }).expect(400);
      await request(app).patch(`/api/v1/targets/${item._id}`).set('Authorization', bearer()).send({ revision: 0, status: 'CANCELLED', reason: 'Cancelled while on leave' }).expect(200);
    } finally { await UserModel.updateOne({ _id: tc.id }, { $set: { employmentStatus: 'ACTIVE' } }); }
  });
});
describe('verified actuals and uncapped achievement', () => {
  it('counts approved ended calls once, excludes rejected/pending work, and exceeds 100 percent', async () => {
    const item = await target(tc, 'CALLS_COMPLETED', { targetValue: '1' });
    await activity(); await activity(); await activity(tc, { reviewStatus: 'PENDING' }); await activity(tc, { reviewStatus: 'REJECTED' }); await activity(tc2);
    expect(await progress(item, tc)).toMatchObject({ targetValue: '1.00', actualValue: '2.00', achievementPercentage: '200.00' });
    const zero = await target(tc, 'CALLS_COMPLETED', { ...period, startDate: '2026-11-01', endDate: '2026-12-01', targetValue: '0' }); expect((await progress(zero)).achievementPercentage).toBe('0.00');
  });
  it('uses Kolkata half-open end-time boundaries and excludes future activity', async () => {
    const item = await target(tc, 'CALLS_COMPLETED', { periodType: 'DAILY', startDate: '2026-10-03', endDate: '2026-10-04' });
    for (const time of ['2026-10-02T18:29:59.999Z', '2026-10-02T18:30:00.000Z', '2026-10-03T18:29:59.999Z', '2026-10-03T18:30:00.000Z']) await activity(tc, { callEndedAt: new Date(time) });
    expect((await progress(item)).actualValue).toBe('2.00');
    const monthly = await target(); await activity(tc, { callEndedAt: new Date(Date.now() + 3600000) }); expect((await progress(monthly)).actualValue).toBe('4.00');
  });
  it('uses explicit connected outcomes and excludes unavailable/open visits', async () => {
    const callTarget = await target(tc, 'CONNECTED_CALLS');
    for (const callOutcome of ['CONNECTED', 'INTERESTED', 'NOT_INTERESTED', 'CALLBACK_REQUESTED', 'BUSY', 'NOT_ANSWERED']) await activity(tc, { callOutcome });
    expect((await progress(callTarget)).actualValue).toBe('4.00');
    const visitTarget = await target(sex, 'SITE_VISITS');
    for (const visitOutcome of ['COMPLETED', 'FOLLOW_UP_REQUIRED', 'NOT_INTERESTED', 'CUSTOMER_UNAVAILABLE']) await activity(sex, { kind: 'VISIT', visitOutcome, visitCompletedAt: new Date('2026-10-03T08:00:00Z') });
    await activity(sex, { kind: 'VISIT', status: 'OPEN', reviewStatus: 'PENDING', leadId: new Types.ObjectId() });
    expect((await progress(visitTarget)).actualValue).toBe('3.00');
  });
  it('requires source grants and never exposes out-of-scope progress', async () => {
    const item = await target(); await activity(); await request(app).get(`/api/v1/targets/${item._id}/progress`).set('Authorization', bearer(tc2)).expect(404);
    const role = await RoleModel.findOne({ code: 'TC' }).lean(); const permission = await PermissionModel.findOne({ code: 'reports:read' }).lean(); if (!role || !permission) throw new Error('Fixture grants missing');
    await RoleModel.updateOne({ _id: role._id }, { $set: { permissions: role.permissions.filter((grant) => !grant.permissionId.equals(permission._id)) } });
    try { await request(app).get(`/api/v1/targets/${item._id}/progress`).set('Authorization', bearer(tc)).expect(403); }
    finally { await RoleModel.updateOne({ _id: role._id }, { $set: { permissions: role.permissions } }); }
  });
  it('aggregates compatible goals without adding daily to monthly targets or leaking peer employees', async () => {
    await target(); await target(tc2); await target(tc, 'CALLS_COMPLETED', { periodType: 'DAILY', startDate: '2026-10-03', endDate: '2026-10-04' }); await activity(); await activity(tc2);
    const result = data<{ rows: { targetValue: string; actualValue: string; employeeCount: number }[] }>(await request(app).get('/api/v1/targets/summary?periodType=MONTHLY').set('Authorization', bearer()).expect(200));
    expect(result.rows).toMatchObject([{ targetValue: '4.00', actualValue: '2.00', employeeCount: 2 }]);
    const scoped = data<{ rows: { targetValue: string; actualValue: string }[] }>(await request(app).get('/api/v1/targets/summary?periodType=MONTHLY').set('Authorization', bearer(mh)).expect(200)); expect(scoped.rows).toMatchObject([{ targetValue: '2.00', actualValue: '1.00' }]);
    const report = await request(app).get('/api/v1/targets/reports?limit=1').set('Authorization', bearer(tc)).expect(200); expect(data<{ rows: unknown[] }>(report).rows).toHaveLength(1); expect(report.body).toHaveProperty('meta.total', 2);
  });
});
describe('reviewed lead milestones and frozen conversion value', () => {
  it('captures new conversion evidence transactionally, counts only approval and preserves exact money', async () => {
    const item = await lead(sex, { estimatedProjectValue: '9007199254740993.25' }); const count = await target(sex, 'CONVERSIONS'); const value = await target(sex, 'SALES_VALUE', { targetValue: '9007199254740993.25' });
    await convert(item._id); const proof = await evidence(item._id); expect((await progress(count)).actualValue).toBe('0.00'); await approve(proof._id);
    expect((await progress(count, sex)).actualValue).toBe('1.00'); expect(await progress(value, sex)).toMatchObject({ actualValue: '9007199254740993.25', achievementPercentage: '100.00' });
    await LeadModel.updateOne({ _id: item._id }, { $set: { estimatedProjectValue: '1.00', assignedTo: other.id } }); expect((await progress(value, sex)).actualValue).toBe('9007199254740993.25');
  });
  it('never re-credits a reopened conversion or changes its original employee/value/time', async () => {
    const item = await lead(); await convert(item._id); const proof = await evidence(item._id); await approve(proof._id);
    await request(app).patch(`/api/v1/leads/${item._id.toHexString()}/status`).set('Authorization', bearer()).send({ revision: 1, status: 'CONTACTED', reason: 'Reopen for negotiation' }).expect(200);
    await LeadModel.updateOne({ _id: item._id }, { $set: { status: 'QUOTATION_SENT', estimatedProjectValue: '999999.00' } }); await convert(item._id, 2);
    const retained = await evidence(item._id); expect(await TargetEvidenceModel.countDocuments({ leadId: item._id, milestone: 'CONVERTED' })).toBe(1); expect(retained._id).toEqual(proof._id); expect(retained.valueAtConversion?.toString()).toBe('275000.00'); expect(retained.occurredAt).toEqual(proof.occurredAt);
  });
  it('counts first approved qualification and generated lead independently of repeat status changes', async () => {
    const item = await lead(sex, { status: 'INTERESTED' });
    await request(app).patch(`/api/v1/leads/${item._id.toHexString()}/status`).set('Authorization', bearer(sex)).send({ revision: 0, status: 'QUALIFIED', reason: 'Customer qualified' }).expect(200);
    const qualified = await evidence(item._id, 'QUALIFIED'); await approve(qualified._id); const qualifiedTarget = await target(sex, 'QUALIFIED_LEADS'); expect((await progress(qualifiedTarget)).actualValue).toBe('1.00');
    const captured = data<Evidence>(await request(app).post(`/api/v1/target-evidence/leads/${item._id.toHexString()}/capture`).set('Authorization', bearer()).send({ milestone: 'CREATED' }).expect(200));
    await approve(new Types.ObjectId(captured._id)); const generated = await target(tc, 'LEADS_GENERATED'); expect((await progress(generated, tc)).actualValue).toBe('1.00');
    await request(app).post(`/api/v1/target-evidence/leads/${item._id.toHexString()}/capture`).set('Authorization', bearer()).send({ milestone: 'CREATED' }).expect(200); expect((await progress(generated)).actualValue).toBe('1.00');
  });
  it('creates pending generated-lead evidence through the real customer conversion API', async () => {
    const customer = await CustomerModel.create({ customerName: 'Synthetic customer', mobileNumber: '+919876543210', siteAddress: 'Synthetic site', stateId, districtId, branchId: branch, dedupeKey: key(), importId: new Types.ObjectId(), importRow: 1,
      createdBy: md.id, assignedTo: tc.id, assignedBy: md.id, assignedAt: new Date(), status: 'INTERESTED' });
    const converted = await request(app).post(`/api/v1/customers/${customer._id.toHexString()}/convert`).set('Authorization', bearer(tc)).set('Idempotency-Key', key()).send({ revision: 0, requirements: { requiredCapacityKw: '5.00', ratePerKw: '55000.00', paymentMode: 'BANK', panelBrand: 'TEST', panelTechnology: 'TEST', leadSource: 'TEST' } }).expect(200);
    const proof = await evidence(new Types.ObjectId(data<{ _id: string }>(converted)._id), 'CREATED'); expect(proof.employeeId).toEqual(tc.id); expect(proof.reviewStatus).toBe('PENDING');
    const item = await target(tc, 'LEADS_GENERATED'); await approve(proof._id, mh); expect((await progress(item, tc)).actualValue).toBe('1.00'); expect((await progress(item, mh)).actualValue).toBe('1.00');
    // The unassigned lead is now in the queue of a branch headed by this manager's descendant.
    await request(app).get(`/api/v1/leads/${proof.leadId.toHexString()}`).set('Authorization', bearer(mh)).expect(200);
  });
  it('enforces independent scoped verification, revision races and append-only review history', async () => {
    const item = await lead(); await convert(item._id); const proof = await evidence(item._id);
    await request(app).patch(`/api/v1/target-evidence/${proof._id.toHexString()}/review`).set('Authorization', bearer( other)).send({ revision: 0, reviewStatus: 'APPROVED', remarks: 'Out of scope' }).expect(403);
    const responses = await Promise.all(['APPROVED', 'REJECTED'].map((reviewStatus) => request(app).patch(`/api/v1/target-evidence/${proof._id.toHexString()}/review`).set('Authorization', bearer(mh)).send({ revision: 0, reviewStatus, remarks: 'Verified original evidence' })));
    expect(responses.map((res) => res.status).sort()).toEqual([200, 409]); expect(await TargetEvidenceReviewModel.countDocuments({ evidenceId: proof._id })).toBe(1);
    await request(app).get(`/api/v1/target-evidence/${proof._id.toHexString()}/history`).set('Authorization', bearer(sex)).expect(200);
    await expect(TargetEvidenceReviewModel.deleteMany({ evidenceId: proof._id })).rejects.toThrow('append-only');
    await TargetEvidenceModel.updateOne({ _id: proof._id }, { $set: { performedBy: md.id } });
    await request(app).patch(`/api/v1/target-evidence/${proof._id.toHexString()}/review`).set('Authorization', bearer()).send({ revision: 1, reviewStatus: 'APPROVED', remarks: 'Self review forbidden' }).expect(403);
  });
  it('reaudits withdrawal and removes rejected evidence from progress', async () => {
    const item = await lead(); await convert(item._id); const proof = await evidence(item._id); const goal = await target(sex, 'CONVERSIONS'); await approve(proof._id);
    await request(app).patch(`/api/v1/target-evidence/${proof._id.toHexString()}/review`).set('Authorization', bearer(mh)).send({ revision: 1, reviewStatus: 'REJECTED', remarks: 'Verification withdrawn after checking evidence' }).expect(200);
    expect((await progress(goal)).actualValue).toBe('0.00'); expect(await TargetEvidenceReviewModel.countDocuments({ evidenceId: proof._id })).toBe(2);
  });
  it('recovers legacy first-event attribution from assignment revisions and rejects fabricated milestones', async () => {
    const item = await lead(); const first = await LeadEventModel.create({ leadId: item._id, toStatus: 'CONVERTED', fromStatus: 'QUOTATION_SENT', actorId: mh.id, workflowVersion: 1, leadRevision: 1, valueAtConversion: '123.45', createdAt: new Date('2026-10-03T08:00:00Z') });
    await AssignmentModel.create({ entityType: 'LEAD', entityId: item._id, previousAssigneeId: sex.id, assignedTo: other.id, assignedBy: md.id, entityRevision: 2, reason: 'Later assignment' }); await LeadModel.updateOne({ _id: item._id }, { $set: { assignedTo: other.id, revision: 2 } });
    const captured = data<Evidence>(await request(app).post(`/api/v1/target-evidence/leads/${item._id.toHexString()}/capture`).set('Authorization', bearer()).send({ milestone: 'CONVERTED' }).expect(200)); expect(captured.employeeId).toBe(sex.id.toHexString()); expect(captured.occurredAt).toBe(first.createdAt.toISOString());
    await request(app).post(`/api/v1/target-evidence/leads/${item._id.toHexString()}/capture`).set('Authorization', bearer()).send({ milestone: 'QUALIFIED' }).expect(404);
    await approve(new Types.ObjectId(captured._id), md); const goal = await target(sex, 'SALES_VALUE'); expect((await progress(goal)).actualValue).toBe('123.45');
  });
  it('keeps milestones pending and rolls back the lead transition when capture audit fails', async () => {
    const item = await lead(); const spy = vi.spyOn(ActivityLogModel, 'create').mockRejectedValueOnce(new Error('Evidence audit unavailable'));
    try { await request(app).patch(`/api/v1/leads/${item._id.toHexString()}/status`).set('Authorization', bearer(sex)).send({ revision: 0, status: 'CONVERTED', reason: 'Conversion attempted' }).expect(500); } finally { spy.mockRestore(); }
    expect((await LeadModel.findById(item._id).lean())?.status).toBe('QUOTATION_SENT'); expect(await TargetEvidenceModel.countDocuments({ leadId: item._id })).toBe(0);
  });
  it('rolls back evidence approval and immutable review history when audit insertion fails', async () => {
    const item = await lead(); await convert(item._id); const proof = await evidence(item._id);
    const spy = vi.spyOn(ActivityLogModel, 'create').mockRejectedValueOnce(new Error('Review audit unavailable'));
    try { await request(app).patch(`/api/v1/target-evidence/${proof._id.toHexString()}/review`).set('Authorization', bearer(mh)).send({ revision: 0, reviewStatus: 'APPROVED', remarks: 'Evidence checked' }).expect(500); }
    finally { spy.mockRestore(); }
    expect((await evidence(item._id)).reviewStatus).toBe('PENDING'); expect(await TargetEvidenceReviewModel.countDocuments({ evidenceId: proof._id })).toBe(0);
  });
  it('never guesses a missing legacy frozen conversion value', async () => {
    const item = await lead(); await LeadEventModel.create({ leadId: item._id, toStatus: 'CONVERTED', actorId: sex.id, workflowVersion: 1, leadRevision: 1 });
    const proof = data<Evidence>(await request(app).post(`/api/v1/target-evidence/leads/${item._id.toHexString()}/capture`).set('Authorization', bearer()).send({ milestone: 'CONVERTED' }).expect(200));
    await request(app).patch(`/api/v1/target-evidence/${proof._id}/review`).set('Authorization', bearer(mh)).send({ revision: 0, reviewStatus: 'APPROVED', remarks: 'Cannot verify missing value' }).expect(409);
  });
  it('attributes generated leads to original creation time rather than a later source-event insert', async () => {
    const item = await lead(sex, { createdAt: new Date('2026-10-02T18:30:00Z') }, new Date('2026-10-03T18:30:00Z'));
    const captured = data<Evidence>(await request(app).post(`/api/v1/target-evidence/leads/${item._id.toHexString()}/capture`).set('Authorization', bearer()).send({ milestone: 'CREATED' }).expect(200));
    expect(captured.occurredAt).toBe('2026-10-02T18:30:00.000Z'); await approve(new Types.ObjectId(captured._id));
    const goal = await target(tc, 'LEADS_GENERATED', { periodType: 'DAILY', startDate: '2026-10-03', endDate: '2026-10-04' }); expect((await progress(goal, mh)).actualValue).toBe('1.00');
  });
  it('requires lead source grants for conversion progress even when reports remain readable', async () => {
    const item = await lead(); await convert(item._id); const proof = await evidence(item._id); await approve(proof._id); const goal = await target(sex, 'CONVERSIONS');
    const role = await RoleModel.findOne({ code: 'SEX' }).lean(); const permission = await PermissionModel.findOne({ code: 'leads:read' }).lean(); if (!role || !permission) throw new Error('Fixture grants missing');
    await RoleModel.updateOne({ _id: role._id }, { $set: { permissions: role.permissions.filter((grant) => !grant.permissionId.equals(permission._id)) } });
    try { await request(app).get(`/api/v1/targets/${goal._id}/progress`).set('Authorization', bearer(sex)).expect(403); }
    finally { await RoleModel.updateOne({ _id: role._id }, { $set: { permissions: role.permissions } }); }
  });
});
