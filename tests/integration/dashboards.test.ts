import { Readable } from 'node:stream';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
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
import { createDashboardIndexes } from '../../src/modules/dashboards/dashboard-indexes.js';
import { bootstrapMd } from '../../src/modules/auth/bootstrap.service.js';
import { AuthService } from '../../src/modules/auth/auth.service.js';
import { hashPassword } from '../../src/shared/utils/crypto.js';
import { UserModel } from '../../src/modules/users/user.model.js';
import { RoleModel } from '../../src/modules/roles/role.model.js';
import { PermissionModel } from '../../src/modules/permissions/permission.model.js';
import { StateModel, DistrictModel } from '../../src/modules/locations/location.model.js';
import { BranchModel } from '../../src/modules/branches/branch.model.js';
import { LeadModel, CustomerModel } from '../../src/modules/leads/commercial.models.js';
import { ReportModel } from '../../src/modules/reports/report.model.js';
import { AttendanceModel } from '../../src/modules/attendance/attendance.model.js';
import { defaultAttendancePolicy } from '../../src/modules/attendance/attendance-policy.js';
import { TargetModel, TargetEvidenceModel } from '../../src/modules/targets/target.model.js';
import { ImportModel } from '../../src/modules/csv-imports/import.models.js';
import { FileModel } from '../../src/modules/files/file.model.js';
import { FileService } from '../../src/modules/files/file.service.js';
import type { CommercialStorage } from '../../src/modules/csv-imports/commercial-storage.js';
import { AttendanceCalendarModel, DashboardExportModel } from '../../src/modules/dashboards/dashboard.model.js';
import { DashboardExportService } from '../../src/modules/dashboards/dashboard-export.service.js';
import { ActivityLogModel } from '../../src/modules/activity-logs/activity-log.model.js';
import { businessDate } from '../../src/shared/utils/business-date.js';
import type { DataScope, PermissionCode } from '../../src/constants/permissions.js';
const config = testConfig({ rateLimitMax: 100000, awsRegion: 'ap-south-1', s3Bucket: 'dashboard-test-exports' });
const blobs = new Map<string, Buffer>();
const writeBase: CommercialStorage['write'] = (file, bytes) => { blobs.set(file.objectKey, bytes); return Promise.resolve('dashboard-version'); };
const write = vi.fn<CommercialStorage['write']>().mockImplementation(writeBase); const download = vi.fn<CommercialStorage['download']>().mockResolvedValue('https://storage.example.invalid/dashboard-signed');
const storage: CommercialStorage = { write, download, upload: () => Promise.resolve({ url: 'https://storage.example.invalid', fields: {} }), verifyCsv: () => Promise.resolve('version'), open: () => Promise.resolve(Readable.from([])) };
const app = createApp(config, { logger: createLogger(config), isDatabaseReady: () => Promise.resolve(true), commercialStorage: storage }); const worker = new DashboardExportService(config, storage);
let replica: MongoMemoryReplSet | undefined; let md: Employee; let bdo: Employee; let mh: Employee; let bh: Employee; let tc: Employee; let sex: Employee; let peerTc: Employee; let peerSex: Employee; let other: Employee;
let branch: Types.ObjectId; let foreignBranch: Types.ObjectId; let stateId: Types.ObjectId; let districtId: Types.ObjectId; let sequence = 0; let passwordHash: string;
interface Employee { id: Types.ObjectId; token: string }
interface Payload<T> { kind: string; asOf: string; data: T }
interface Row { id: string; name: string; approvedCalls: number; approvedVisits: number; approvedConversions: number; salesValue: string | null; employeeCount: number }
interface Performance { rows: Row[]; total: number; financialMetricsAvailable: boolean }
interface Job { _id: string; status: string; errorCode: string; fileId: string; asOf: string }
const range = { startDate: '2026-10-01', endDate: '2026-11-01' };
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- Assert response shape at the HTTP boundary.
const data = <T>(res: Response): T => (res.body as { data: T }).data;
const bearer = (actor = md) => `Bearer ${actor.token}`;
const key = () => `dashboard-fixture-${String(++sequence).padStart(8, '0')}`;
async function employee(code: string, managerId: Types.ObjectId, branchId: Types.ObjectId | null): Promise<Employee> {
  const role = await RoleModel.findOne({ code }).lean(); if (!role) throw new Error('Fixture role missing'); sequence++; const email = `dash-${String(sequence)}@example.invalid`;
  const user = await UserModel.create({ employeeCode: key(), firstName: 'Fixture', lastName: 'Employee', email, mobileNumber: `+91666${String(sequence).padStart(7, '0')}`, passwordHash,
    roleId: role._id, branchId, reportingManagerId: managerId, createdBy: md.id, dateOfJoining: new Date('2026-01-01') });
  return { id: user._id, token: (await new AuthService(config).login(email, 'Dashboard fixture password 2026!', { requestId: 'fixture' })).accessToken };
}
async function get<T>(kind: string, actor = md, extra = {}): Promise<Payload<T>> {
  return data<Payload<T>>(await request(app).get(`/api/v1/dashboard/${kind}`).set('Authorization', bearer(actor)).query({ ...range, ...extra }).expect(200));
}
async function activity(actor = tc, changes = {}) {
  const at = new Date(Date.parse('2026-10-10T06:00:00Z') + ++sequence * 1000);
  return ReportModel.create({ kind: 'CALL', employeeId: actor.id, branchId: actor.id.equals(other.id) ? foreignBranch : branch, businessDate: '2026-10-10', idempotencyKey: key(), requestHash: key(),
    customerName: 'Private customer', customerMobile: '+919876543210', siteAddress: 'Private site address', callStartedAt: new Date(at.getTime() - 1000), callEndedAt: at, callDurationSeconds: 1,
    callOutcome: 'CONNECTED', status: 'SUBMITTED', reviewStatus: 'APPROVED', createdAt: at, ...changes });
}
async function lead(actor = sex, creator = tc, changes = {}) {
  return LeadModel.create({ leadCode: key(), customerName: 'Private customer', mobileNumber: '+919876543211', siteAddress: 'Private address', stateId, districtId, branchId: actor.id.equals(other.id) ? foreignBranch : branch,
    requiredCapacityKw: '5.00', ratePerKw: '55000.00', estimatedProjectValue: '275000.00', paymentMode: 'BANK', panelBrand: 'TEST', panelTechnology: 'TEST', leadSource: 'WEB', status: 'CONVERTED', workflowVersion: 1,
    createdBy: creator.id, assignedTo: actor.id, assignedBy: md.id, assignedAt: new Date(), salesExecutiveId: actor.id, createdAt: new Date('2026-10-10T06:00:00Z'), ...changes });
}
async function proof(actor = sex, value = '10.25', changes = {}) {
  const item = await lead(actor, actor.id.equals(other.id) ? other : tc);
  return TargetEvidenceModel.create({ leadId: item._id, sourceEventId: new Types.ObjectId(), milestone: 'CONVERTED', employeeId: actor.id, branchId: item.branchId, createdBy: item.createdBy, assignedTo: actor.id, performedBy: actor.id,
    occurredAt: new Date('2026-10-10T06:00:00Z'), valueAtConversion: value, reviewStatus: 'APPROVED', ...changes });
}
async function attendance(actor = tc, changes = {}) {
  const at = new Date(Date.now() - 60000);
  return AttendanceModel.create({ employeeId: actor.id, branchId: actor.id.equals(other.id) ? foreignBranch : branch, attendanceDate: businessDate(), checkInAt: at, effectiveCheckInAt: at, checkInCapturedAt: at,
    checkInPhotoFileId: new Types.ObjectId(), checkInLocation: { latitude: 22, longitude: 88 }, policySnapshot: defaultAttendancePolicy, lateArrival: false, reviewStatus: 'APPROVED', ...changes });
}
async function configureCalendar(office = branch, changes = {}) { return request(app).put(`/api/v1/dashboard/attendance-calendars/${office.toHexString()}`).set('Authorization', bearer()).send({ revision: 0, workingWeekdays: [1, 2, 3, 4, 5, 6, 7], holidays: [], ...changes }).expect(200); }
async function exportJob(kind = 'employee-performance', actor = md, query = {}) { return data<Job>(await request(app).post('/api/v1/dashboard/exports').set('Authorization', bearer(actor)).send({ kind, query: { ...range, ...query } }).expect(202)); }
async function job(id: string, actor = md) { return data<Job>(await request(app).get(`/api/v1/dashboard/exports/${id}`).set('Authorization', bearer(actor)).expect(200)); }
async function withScope(roleCode: string, permissionCode: PermissionCode, scope: DataScope | null, work: () => Promise<void>) {
  const role = await RoleModel.findOne({ code: roleCode }).lean(); const permission = await PermissionModel.findOne({ code: permissionCode }).lean(); if (!role || !permission) throw new Error('Fixture permissions missing');
  const rest = role.permissions.filter((grant) => !grant.permissionId.equals(permission._id));
  await RoleModel.updateOne({ _id: role._id }, { $set: { permissions: scope ? [...rest, { permissionId: permission._id, scope }] : rest } });
  try { await work(); } finally { await RoleModel.updateOne({ _id: role._id }, { $set: { permissions: role.permissions } }); }
}
beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } }); await connectDatabase({ ...config, mongodbUri: replica.getUri('dashboards') }, createLogger(config));
  await createIdentityIndexes(); await createOrganizationIndexes(); await createAttendanceIndexes(); await createCommercialIndexes(); await createReportIndexes(); await createTargetIndexes(); await createDashboardIndexes();
  const root = await bootstrapMd({ employeeCode: 'DASH-MD', firstName: 'Fixture', lastName: 'Director', email: 'dash-md@example.invalid', mobileNumber: '+919999999999' }, config.tokenEncryptionKey);
  passwordHash = await hashPassword('Dashboard fixture password 2026!'); await UserModel.updateOne({ _id: root }, { $set: { passwordHash } });
  md = { id: root, token: (await new AuthService(config).login('dash-md@example.invalid', 'Dashboard fixture password 2026!', { requestId: 'fixture' })).accessToken };
  stateId = (await StateModel.create({ code: 'DASH', name: 'Synthetic state', createdBy: root }))._id; districtId = (await DistrictModel.create({ code: 'D1', name: 'Synthetic district', stateId, createdBy: root }))._id;
  const office = async (code: string) => (await BranchModel.create({ branchCode: code, branchName: code, address: 'Synthetic office', stateId, districtId, contactNumber: '+919000000000', createdBy: root }))._id;
  branch = await office('DASH-A'); foreignBranch = await office('DASH-B'); bdo = await employee('BDO', root, null); mh = await employee('MH', bdo.id, branch); bh = await employee('BH', mh.id, branch);
  tc = await employee('TC', bh.id, branch); sex = await employee('SEX', bh.id, branch); peerTc = await employee('TC', root, branch); peerSex = await employee('SEX', root, branch); other = await employee('SEX', root, foreignBranch);
}, 180000);
beforeEach(async () => {
  await Promise.all([LeadModel.deleteMany({}), CustomerModel.deleteMany({}), ReportModel.deleteMany({}), AttendanceModel.deleteMany({}), TargetModel.deleteMany({}), TargetEvidenceModel.deleteMany({}), ImportModel.deleteMany({}), AttendanceCalendarModel.deleteMany({}), DashboardExportModel.deleteMany({}), FileModel.deleteMany({})]);
  blobs.clear(); vi.clearAllMocks(); write.mockReset().mockImplementation(writeBase);
});
afterAll(async () => { vi.restoreAllMocks(); await disconnectDatabase(); await replica?.stop(); });
describe('shared scope-aware dashboards', () => {
  it('requires authentication and dashboard grants, while source grants remain independent', async () => {
    await request(app).get('/api/v1/dashboard/overview').expect(401);
    await withScope('TC', 'dashboard:read', null, async () => { await request(app).get('/api/v1/dashboard/overview').set('Authorization', bearer(tc)).expect(403); });
    await withScope('TC', 'reports:read', null, async () => {
      const result = await get<{ activities: { available: boolean }; employees: { available: boolean } }>('overview', tc); expect(result.data.activities.available).toBe(false); expect(result.data.employees.available).toBe(true);
      await request(app).get('/api/v1/dashboard/employee-performance').set('Authorization', bearer(tc)).expect(403);
    });
  });
  it('separates company, current subtree, branch and self data for all default roles', async () => {
    await activity(); await activity(peerTc); await activity(other);
    const counts: [Employee, number][] = [[md, 3], [bdo, 1], [mh, 1], [bh, 2], [tc, 1], [sex, 0]];
    for (const [actor, expected] of counts) {
      const result = await get<{ activities: { approvedCalls: number } }>('overview', actor); expect(result.data.activities.approvedCalls).toBe(expected);
    }
    expect((await get<Performance>('employee-performance', mh)).data.rows.map((row) => row.id)).not.toContain(peerTc.id.toHexString());
  });
  it('intersects a broad source permission with SELF dashboard scope and vice versa', async () => {
    await activity(); await activity(peerTc);
    await withScope('TC', 'reports:read', 'ALL', async () => { expect((await get<{ activities: { approvedCalls: number } }>('overview', tc)).data.activities.approvedCalls).toBe(1); });
    await withScope('TC', 'dashboard:read', 'ALL', async () => { expect((await get<{ activities: { approvedCalls: number } }>('overview', tc)).data.activities.approvedCalls).toBe(1); });
  });
  it('supports custom role codes without changing semantics and exposes no contact/GPS/storage secrets', async () => {
    const role = await RoleModel.findOne({ code: 'TC' }).lean(); if (!role) throw new Error('Fixture role missing');
    await RoleModel.create({ name: 'Custom analytics employee', code: 'DASH_CUSTOM', permissions: role.permissions, createdBy: md.id }); const custom = await employee('DASH_CUSTOM', bh.id, branch);
    try {
      await activity(custom); await activity(peerTc);
      const result = await request(app).get('/api/v1/dashboard/overview').set('Authorization', bearer(custom)).query(range).expect(200);
      expect(data<Payload<{ activities: { approvedCalls: number } }>>(result).data.activities.approvedCalls).toBe(1);
      expect(result.text).not.toMatch(/Private customer|919876543210|Private site|passwordHash|authVersion|objectKey|checksumSHA256|latitude|longitude/); expect(result.headers['cache-control']).toBe('no-store');
    } finally { await UserModel.deleteOne({ _id: custom.id }); }
  });
  it('treats SELF lead visibility as owned or currently assigned work, then intersects source scope', async () => {
    await lead(); await lead(peerSex, peerTc); await lead(other, other);
    expect((await get<{ totalLeads: number }>('leads', sex)).data.totalLeads).toBe(1);
    expect((await get<{ totalLeads: number }>('leads', tc)).data.totalLeads).toBe(1);
    // A manager above the branch head can see the managed branch's lead queue and assignments.
    expect((await get<{ totalLeads: number }>('leads', mh)).data.totalLeads).toBe(2);
    expect((await get<{ totalLeads: number }>('leads', bh)).data.totalLeads).toBe(2);
  });
  it('filters before grouping/counts and rejects malformed calendars, injection and oversized ranges', async () => {
    await activity(); await activity(peerTc); const tcRole = await RoleModel.findOne({ code: 'TC' }).lean(); if (!tcRole) throw new Error('Role missing');
    const filtered = await get<Performance>('employee-performance', md, { roleId: tcRole._id.toHexString(), managerId: bh.id.toHexString(), branchId: branch.toHexString() }); expect(filtered.data.total).toBe(1); expect(filtered.data.rows[0]?.id).toBe(tc.id.toHexString());
    const peerFilter = await get<Performance>('employee-performance', mh, { employeeId: peerTc.id.toHexString() }); expect(peerFilter.data.total).toBe(0);
    expect((await get<Performance>('branch-performance', bh, { employeeId: other.id.toHexString() })).data.total).toBe(0);
    for (const query of [{ startDate: '2026-02-30' }, { startDate: '2025-01-01', endDate: '2027-01-01' }, { limit: 101 }, { branchId: 'bad' }, { employeeId: { $ne: '' } }, { sortBy: 'passwordHash' }]) await request(app).get('/api/v1/dashboard/overview').set('Authorization', bearer()).query(query).expect(400);
  });
  it('uses authorized branch geography, multi-status filters, lead sources and cohort conversion rates', async () => {
    await lead(sex, tc, { status: 'INTERESTED' }); await lead(sex, tc, { status: 'LOST', leadSource: 'REFERRAL' });
    const result = await get<{ totalLeads: number; createdInPeriod: number; cohortConversionPercentage: string }>('lead-funnel', md, { stateId: stateId.toHexString(), leadStatus: ['INTERESTED', 'CONVERTED'], leadSource: 'WEB' });
    expect(result.data).toMatchObject({ totalLeads: 1, createdInPeriod: 1, cohortConversionPercentage: '0.00' });
    expect((await get<Performance>('branch-performance', bh)).data.rows.map((row) => row.id)).toEqual([branch.toHexString()]);
  });
});
describe('approved performance, trends and target consistency', () => {
  it('ranks globally before pagination with exact financial values and excludes unapproved conversions', async () => {
    await proof(sex, '9007199254740993.25'); await proof(peerSex, '9007199254740993.26'); await proof(sex, '9999999999999999.99', { reviewStatus: 'PENDING' });
    const result = await get<Performance>('employee-performance', md, { sortBy: 'salesValue', limit: 1 }); expect(result.data.rows[0]).toMatchObject({ id: peerSex.id.toHexString(), salesValue: '9007199254740993.26' }); expect(result.data.total).toBe(9);
    const second = await get<Performance>('employee-performance', md, { sortBy: 'salesValue', limit: 1, page: 2 }); expect(second.data.rows[0]?.id).toBe(sex.id.toHexString());
  });
  it('aggregates current role and historical branch metrics without mixing inaccessible employees', async () => {
    await activity(); await activity(peerTc); await proof(); await proof(other, '999999.00');
    const result = await get<Performance>('role-performance', mh); expect(result.data.rows.reduce((sum, row) => sum + row.approvedCalls, 0)).toBe(1); expect(result.data.rows.reduce((sum, row) => sum + row.employeeCount, 0)).toBe(4);
    const branchRows = await get<Performance>('branch-performance', bh); expect(branchRows.data.rows[0]).toMatchObject({ approvedCalls: 2, approvedConversions: 1, salesValue: '10.25', employeeCount: 6 });
  });
  it('keeps submitted versus approved activity separate and retains attribution after reassignment', async () => {
    await activity(); await activity(tc, { reviewStatus: 'PENDING' }); await activity(tc, { reviewStatus: 'REJECTED' });
    const event = await proof(); await LeadModel.updateOne({ _id: event.leadId }, { $set: { assignedTo: other.id } });
    const result = await get<{ activities: { submittedCalls: number; approvedCalls: number; pendingReports: number }; sales: { approvedConversions: number } }>('overview', mh);
    expect(result.data.activities).toMatchObject({ submittedCalls: 3, approvedCalls: 1, pendingReports: 1 }); expect(result.data.sales.approvedConversions).toBe(1);
  });
  it('uses Kolkata monthly event buckets and equal elapsed comparison windows with identical scope', async () => {
    await activity(tc, { callEndedAt: new Date('2026-09-30T18:30:00Z') }); await activity(peerTc, { callEndedAt: new Date('2026-10-01T00:00:00Z') });
    await activity(tc, { callEndedAt: new Date('2026-09-30T18:29:59.999Z') });
    const result = await get<{ rows: { month: string; value: string }[]; previous: { window: { start: string; end: string }; rows: { value: string }[] }; period: { start: string; end: string } }>('trends', mh, { startDate: '2026-10-01', endDate: '2026-10-02' });
    expect(result.data.rows).toMatchObject([{ month: '2026-10', value: '1' }]); expect(result.data.previous.rows).toMatchObject([{ value: '1' }]);
    expect(Date.parse(result.data.period.end) - Date.parse(result.data.period.start)).toBe(Date.parse(result.data.previous.window.end) - Date.parse(result.data.previous.window.start));
  });
  it('shares Phase 7 exact, approved, full-interval target calculations and keeps incompatible goals separate', async () => {
    await activity(); await activity(); await TargetModel.create({ employeeId: tc.id, branchId: branch, targetType: 'CALLS_COMPLETED', targetValue: '1.00', periodType: 'MONTHLY', startDate: new Date('2026-09-30T18:30:00Z'), endDate: new Date('2026-10-31T18:30:00Z'), assignedBy: md.id });
    const result = await get<{ rows: { actualValue: string; achievementPercentage: string }[] }>('targets', tc); expect(result.data.rows).toMatchObject([{ actualValue: '2.00', achievementPercentage: '200.00' }]);
    const id = await TargetModel.findOne({ employeeId: tc.id }).lean(); if (!id) throw new Error('Target missing');
    const targetResult = data<{ actualValue: string }>(await request(app).get(`/api/v1/targets/${id._id.toHexString()}/progress`).set('Authorization', bearer(tc)).expect(200)); expect(result.data.rows[0]?.actualValue).toBe(targetResult.actualValue);
  });
  it('does not infer verified conversions or sales from current lead status alone', async () => {
    await lead();
    const result = await get<{ leads: { convertedLeads: number }; sales: { approvedConversions: number; salesValue: string } }>('overview', md); expect(result.data.leads.convertedLeads).toBe(1); expect(result.data.sales).toMatchObject({ approvedConversions: 0, salesValue: '0.00' });
  });
  it('counts owned import jobs without exposing staged contacts or other creators jobs', async () => {
    const role = await RoleModel.findOne({ code: 'MH' }).lean(); if (!role) throw new Error('Role missing');
    await ImportModel.create({ createdBy: mh.id, branchId: branch, principal: { userId: mh.id, roleId: role._id, sessionId: new Types.ObjectId(), authVersion: 0 }, fileId: new Types.ObjectId(), columnMapping: {}, duplicateScope: 'BRANCH', status: 'COMPLETED', totalRows: 10, importedRows: 8, rejectedRows: 1, duplicateRows: 1, requestId: key(), expiresAt: new Date(Date.now() + 86400000), createdAt: new Date('2026-10-10T06:00:00Z') });
    const result = await get<{ imports: { statuses: { jobs: number; importedRows: number }[] } }>('overview', mh); expect(result.data.imports.statuses).toMatchObject([{ jobs: 1, importedRows: 8 }]);
    expect((await get<{ imports: { available: boolean } }>('overview', tc)).data.imports.available).toBe(false);
  });
});
describe('attendance eligibility and provisional absence', () => {
  it('does not invent absence without calendars; counts distinct current staff with any visible check-in', async () => {
    const unknown = await get<{ absence: { available: boolean; absentEmployees: number | null } }>('attendance', bh); expect(unknown.data.absence.available).toBe(false); expect(unknown.data.absence.absentEmployees).toBeNull();
    await configureCalendar(); await attendance(tc, { reviewStatus: 'PENDING' });
    const result = await get<{ absence: { eligibleEmployees: number; employeesWithVisibleCheckIn: number; absentEmployees: number; absenceIsProvisional: boolean } }>('attendance', bh); expect(result.data.absence).toMatchObject({ eligibleEmployees: 6, employeesWithVisibleCheckIn: 1, absentEmployees: 5, absenceIsProvisional: true });
    expect((await get<{ absence: { eligibleEmployees: number; absentEmployees: number } }>('attendance', tc)).data.absence).toMatchObject({ eligibleEmployees: 1, absentEmployees: 0 });
  });
  it('excludes holidays, on-leave/future staff and never claims historical employment-based absence', async () => {
    await configureCalendar(branch, { holidays: [businessDate()] });
    const holiday = await get<{ absence: { eligibleEmployees: number; absentEmployees: number } }>('attendance', bh); expect(holiday.data.absence).toMatchObject({ eligibleEmployees: 0, absentEmployees: 0 });
    await request(app).put(`/api/v1/dashboard/attendance-calendars/${branch.toHexString()}`).set('Authorization', bearer()).send({ revision: 1, workingWeekdays: [1, 2, 3, 4, 5, 6, 7], holidays: [] }).expect(200);
    await UserModel.updateOne({ _id: peerSex.id }, { $set: { employmentStatus: 'ON_LEAVE' } });
    try { expect((await get<{ absence: { eligibleEmployees: number } }>('attendance', bh)).data.absence.eligibleEmployees).toBe(5); }
    finally { await UserModel.updateOne({ _id: peerSex.id }, { $set: { employmentStatus: 'ACTIVE' } }); }
    await UserModel.updateOne({ _id: peerSex.id }, { $set: { dateOfJoining: new Date(Date.now() + 3 * 86400000) } });
    try { expect((await get<{ absence: { eligibleEmployees: number } }>('attendance', bh)).data.absence.eligibleEmployees).toBe(5); }
    finally { await UserModel.updateOne({ _id: peerSex.id }, { $set: { dateOfJoining: new Date('2026-01-01') } }); }
    const historical = await get<{ absence: { available: boolean; reason: string } }>('attendance', bh, { startDate: '2026-10-01', endDate: '2026-10-02' }); expect(historical.data.absence).toMatchObject({ available: false, reason: 'HISTORICAL_EMPLOYMENT_CALENDAR_UNAVAILABLE' });
  });
  it('limits the eligible universe to attendance source scope even when users and dashboards are broad', async () => {
    await configureCalendar(); await attendance();
    await withScope('TC', 'dashboard:read', 'ALL', async () => { await withScope('TC', 'users:read', 'ALL', async () => { expect((await get<{ absence: { eligibleEmployees: number } }>('attendance', tc)).data.absence.eligibleEmployees).toBe(1); }); });
    await withScope('TC', 'attendance:create', null, async () => { expect((await get<{ absence: { eligibleEmployees: number } }>('attendance', bh)).data.absence.eligibleEmployees).toBe(4); });
  });
  it('requires ALL settings authority, checks calendar revisions and rolls back failed calendar audit', async () => {
    await request(app).put(`/api/v1/dashboard/attendance-calendars/${branch.toHexString()}`).set('Authorization', bearer(bh)).send({ revision: 0, workingWeekdays: [1], holidays: [] }).expect(403);
    const spy = vi.spyOn(ActivityLogModel, 'create').mockRejectedValueOnce(new Error('Audit unavailable'));
    try { await request(app).put(`/api/v1/dashboard/attendance-calendars/${branch.toHexString()}`).set('Authorization', bearer()).send({ revision: 0, workingWeekdays: [1], holidays: [] }).expect(500); } finally { spy.mockRestore(); }
    expect(await AttendanceCalendarModel.countDocuments()).toBe(0); await configureCalendar();
    await request(app).put(`/api/v1/dashboard/attendance-calendars/${branch.toHexString()}`).set('Authorization', bearer()).send({ revision: 0, workingWeekdays: [1], holidays: [] }).expect(409);
  });
});
describe('private queued dashboard exports', () => {
  it('requires export authority, generates all bounded rows and pins private versioned downloads', async () => {
    await activity(); await proof(); await request(app).post('/api/v1/dashboard/exports').set('Authorization', bearer(tc)).send({ kind: 'overview', query: range }).expect(403);
    const queued = await exportJob(); expect(await worker.runOne()).toBe(true); const completed = await job(queued._id); expect(completed.status).toBe('COMPLETED');
    const bytes = [...blobs.values()][0]; expect(bytes?.toString()).toContain(tc.id.toHexString()); expect(bytes?.toString()).not.toContain('Private customer');
    await request(app).get(`/api/v1/dashboard/exports/${queued._id}/download`).set('Authorization', bearer()).expect(200);
    expect(download).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'DASHBOARD_EXPORT', status: 'ATTACHED' }), 'dashboard-version');
    expect((await request(app).get(`/api/v1/dashboard/exports/${queued._id}`).set('Authorization', bearer()).expect(200)).text).not.toMatch(/principal|fingerprint|query|objectKey|authVersion/);
    expect(await worker.runOne()).toBe(false);
  });
  it('intersects restricted export scope, rejects other owners and permission removal before download', async () => {
    await activity(); await activity(peerTc); const queued = await exportJob('employee-performance'); expect(await worker.runOne()).toBe(true);
    await withScope('MD', 'dashboard:export', 'SELF', async () => { await request(app).get(`/api/v1/dashboard/exports/${queued._id}/download`).set('Authorization', bearer()).expect(409); });
    await withScope('MD', 'dashboard:read', null, async () => { await request(app).get(`/api/v1/dashboard/exports/${queued._id}/download`).set('Authorization', bearer()).expect(403); });
    await request(app).get(`/api/v1/dashboard/exports/${queued._id}`).set('Authorization', bearer(tc)).expect(403);
    await withScope('TC', 'dashboard:export', 'SELF', async () => { await request(app).get(`/api/v1/dashboard/exports/${queued._id}`).set('Authorization', bearer(tc)).expect(404); });
  });
  it('blocks stale approved-data exports and permission changes during S3 publication', async () => {
    const report = await activity(); const queued = await exportJob('trends'); expect(await worker.runOne()).toBe(true);
    await ReportModel.updateOne({ _id: report._id }, { $set: { reviewStatus: 'REJECTED' } });
    await request(app).get(`/api/v1/dashboard/exports/${queued._id}/download`).set('Authorization', bearer()).expect(409);
    const again = await exportJob('trends'); write.mockImplementationOnce(async (file, bytes) => { const version = await writeBase(file, bytes); await ReportModel.updateOne({ _id: report._id }, { $set: { reviewStatus: 'APPROVED' } }); return version; });
    expect(await worker.runOne()).toBe(true); expect((await job(again._id)).status).toBe('FAILED'); expect((await job(again._id)).errorCode).toBe('DASHBOARD_EXPORT_STALE');
  });
  it('recovers expired worker leases and retries storage failures with tracked orphan metadata', async () => {
    const queued = await exportJob('trends'); await DashboardExportModel.updateOne({ _id: queued._id }, { $set: { status: 'PROCESSING', leaseId: 'dead-worker', leaseUntil: new Date(Date.now() - 1000) } });
    write.mockRejectedValueOnce(new Error('private-provider-secret')); expect(await worker.runOne()).toBe(true); expect((await job(queued._id)).status).toBe('QUEUED');
    expect(await FileModel.countDocuments({ purpose: 'DASHBOARD_EXPORT', status: 'PENDING' })).toBe(1); expect((await job(queued._id)).errorCode).toBe('STORAGE_OR_JOB_FAILURE');
    expect(await worker.runOne()).toBe(true); expect((await job(queued._id)).status).toBe('COMPLETED');
  });
  it('reauthorizes the source grants again after upload, before attaching a usable export', async () => {
    await activity(); const queued = await exportJob('overview'); const role = await RoleModel.findOne({ code: 'MD' }).lean(); const permission = await PermissionModel.findOne({ code: 'reports:read' }).lean(); if (!role || !permission) throw new Error('Fixture grants missing');
    write.mockImplementationOnce(async (file, bytes) => { const version = await writeBase(file, bytes); await RoleModel.updateOne({ _id: role._id }, { $set: { permissions: role.permissions.filter((grant) => !grant.permissionId.equals(permission._id)) } }); return version; });
    try { expect(await worker.runOne()).toBe(true); } finally { await RoleModel.updateOne({ _id: role._id }, { $set: { permissions: role.permissions } }); }
    expect((await job(queued._id)).status).toBe('FAILED'); expect(await FileModel.countDocuments({ purpose: 'DASHBOARD_EXPORT', status: 'ATTACHED' })).toBe(0);
  });
  it('enforces outstanding-job/lifetime bounds and stops revoked creators before uploading', async () => {
    for (let index = 0; index < 5; index++) await exportJob('trends');
    await request(app).post('/api/v1/dashboard/exports').set('Authorization', bearer()).send({ kind: 'trends', query: range }).expect(429);
    await withScope('MD', 'dashboard:export', null, async () => { expect(await worker.runOne()).toBe(true); }); expect(write).not.toHaveBeenCalled();
    await DashboardExportModel.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } }); expect(await worker.runOne()).toBe(false);
    expect(await DashboardExportModel.countDocuments({ status: 'FAILED' })).toBe(5);
  });
  it('keeps dashboard orphans compatible with existing version cleanup and preserves attached exports', async () => {
    const queued = await exportJob('trends'); expect(await worker.runOne()).toBe(true);
    const remove = vi.fn().mockResolvedValue(undefined); const files = new FileService(config, { upload: () => Promise.resolve({ url: '', fields: {} }), verify: () => Promise.resolve(''), download: () => Promise.resolve(''), remove });
    await FileModel.create({ ownerId: md.id, purpose: 'DASHBOARD_EXPORT', contentType: 'text/csv', size: 100, objectKey: key(), bucket: 'test', checksumSHA256: 'test', status: 'PENDING', expiresAt: new Date(Date.now() - 2 * 86400000) });
    expect(await files.cleanup()).toBe(1); expect(remove).toHaveBeenCalledOnce(); expect((await job(queued._id)).status).toBe('COMPLETED');
  });
});
