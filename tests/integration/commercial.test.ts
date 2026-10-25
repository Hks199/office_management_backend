import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import request, { type Response } from 'supertest';
import { Types, trusted } from 'mongoose';
import { testConfig } from '../helpers.js';
import { createApp } from '../../src/app.js';
import { connectDatabase, disconnectDatabase } from '../../src/config/database.js';
import { createLogger } from '../../src/config/logger.js';
import { createIdentityIndexes } from '../../src/modules/auth/identity-indexes.js';
import { createOrganizationIndexes } from '../../src/modules/hierarchy/organization-indexes.js';
import { createAttendanceIndexes } from '../../src/modules/attendance/attendance-indexes.js';
import { createCommercialIndexes } from '../../src/modules/leads/commercial-indexes.js';
import { enableDefaultCommercialCapabilities } from '../../src/modules/leads/commercial-capabilities.js';
import { bootstrapMd } from '../../src/modules/auth/bootstrap.service.js';
import { AuthService } from '../../src/modules/auth/auth.service.js';
import { CredentialDeliveryModel } from '../../src/modules/auth/credential-delivery.model.js';
import { decryptSecret } from '../../src/shared/utils/crypto.js';
import { UserModel } from '../../src/modules/users/user.model.js';
import { RoleModel } from '../../src/modules/roles/role.model.js';
import { PermissionModel } from '../../src/modules/permissions/permission.model.js';
import { BranchModel } from '../../src/modules/branches/branch.model.js';
import { StateModel, DistrictModel, BlockModel } from '../../src/modules/locations/location.model.js';
import { LeadModel, CustomerModel, AssignmentModel, LeadEventModel, ProposalModel, IdempotencyModel, CommercialSettingsModel, WorkflowModel } from '../../src/modules/leads/commercial.models.js';
import { ImportModel, ImportRowModel, LeadExportModel } from '../../src/modules/csv-imports/import.models.js';
import { FileModel } from '../../src/modules/files/file.model.js';
import { ImportWorker } from '../../src/modules/csv-imports/import.worker.js';
import { ExportService } from '../../src/modules/csv-imports/export.service.js';
import type { CommercialStorage } from '../../src/modules/csv-imports/commercial-storage.js';
import { ActivityLogModel } from '../../src/modules/activity-logs/activity-log.model.js';
import { defaultTransitions } from '../../src/modules/leads/workflow.service.js';
import { defaultColumnMapping } from '../../src/modules/csv-imports/import.validator.js';
import { ConfirmedCustomerModel } from '../../src/modules/sales-customers/customer.model.js';
import { backfillConfirmedCustomers } from '../../src/modules/sales-customers/customer-lifecycle.js';
import { enableBranchLeadRouting } from '../../src/modules/leads/enable-lead-routing.js';
const config = testConfig({ rateLimitMax: 100000, awsRegion: 'ap-south-1', s3Bucket: 'test-commercial-files' });
const blobs = new Map<string, Buffer>();
const storage: CommercialStorage = {
  upload: vi.fn<CommercialStorage['upload']>().mockResolvedValue({ url: 'https://storage.example.invalid', fields: {} }),
  verifyCsv: vi.fn<CommercialStorage['verifyCsv']>().mockResolvedValue('csv-version'),
  open: vi.fn<CommercialStorage['open']>().mockImplementation((file) => { const body = blobs.get(file.objectKey); return body ? Promise.resolve(Readable.from([body])) : Promise.reject(new Error('Missing blob')); }),
  write: vi.fn<CommercialStorage['write']>().mockImplementation((file, body) => { blobs.set(file.objectKey, body); return Promise.resolve('export-version'); }),
  download: vi.fn<CommercialStorage['download']>().mockResolvedValue('https://storage.example.invalid/signed'),
};
const app = createApp(config, { logger: createLogger(config), isDatabaseReady: () => Promise.resolve(true), commercialStorage: storage });
const auth = new AuthService(config); const worker = new ImportWorker(storage); const exports = new ExportService(config, storage);
let replica: MongoMemoryReplSet | undefined; let md: string; let rootId: Types.ObjectId; let stateId: string; let districtId: string; let blockId: string;
let branch: string; let foreignBranch: string; let sequence = 0;
interface Employee { id: string; token: string }
let mh: Employee; let bh: Employee; let tc: Employee; let tc2: Employee; let tc3: Employee; let sex: Employee; let sex2: Employee; let other: Employee; let otherTc: Employee;
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- Assert the response shape at the HTTP test boundary.
const data = <T>(res: Response): T => (res.body as { data: T }).data;
const bearer = (token = md) => `Bearer ${token}`;
interface Job { _id: string; status: string; revision: number; totalRows: number; acceptedRows: number; duplicateRows: number; rejectedRows: number; importedRows: number; errorCode: string }
interface Customer { _id: string; revision: number; assignedTo: string; status: string }
interface Lead { _id: string; revision: number; assignedTo: string | null; status: string; salesExecutiveId: string | null; estimatedProjectValue: string; workflowVersion: number }
const requirements = { requiredCapacityKw: '5.00', ratePerKw: '55000.00', paymentMode: 'BANK', panelBrand: 'TEST_BRAND', panelTechnology: 'TEST_TECH', leadSource: 'TEST_SOURCE' };
const leadInput = (extra = {}) => ({ ...requirements, customerName: 'Synthetic customer', mobileNumber: '+919876543210', branchId: branch,
  stateId, districtId, blockId, siteAddress: 'Synthetic site address', ...extra });
const csvHeader = 'Customer Name,Mobile Number,Alternate Number,State,District,Block/Tehsil,Site Address,Remarks\n';
const csvRow = (mobile: string, name = 'Synthetic customer') => `${name},${mobile},,TST,D1,B1,Fixture site address,Fixture remarks\n`;
async function login(id: Types.ObjectId, email: string) {
  const delivery = await CredentialDeliveryModel.findOne({ userId: id }).select('+encryptedToken').lean(); if (!delivery) throw new Error('Invitation missing');
  await auth.resetPassword(decryptSecret(delivery.encryptedToken, config.tokenEncryptionKey), 'Commercial fixture password 2026!', 'INVITATION', { requestId: 'fixture' });
  return (await auth.login(email, 'Commercial fixture password 2026!', { requestId: 'fixture' })).accessToken;
}
async function employee(code: string, managerId: string, branchId: string | null): Promise<Employee> {
  sequence++; const role = await RoleModel.findOne({ code }).lean(); if (!role) throw new Error('Role missing'); const email = `commercial-${String(sequence)}@example.invalid`;
  const result = await request(app).post('/api/v1/employees').set('Authorization', bearer()).send({ employeeCode: `COM-${String(sequence)}`, firstName: 'Fixture', lastName: 'Employee',
    email, mobileNumber: `+91888000000${String(sequence).padStart(2, '0')}`, roleId: role._id, branchId, reportingManagerId: managerId, dateOfJoining: '2026-01-01' }).expect(201);
  const id = data<{ _id: string }>(result)._id; return { id, token: await login(new Types.ObjectId(id), email) };
}
async function queue(body: string, token = md, branchId = branch, columnMapping?: Record<string, string>) {
  const bytes = Buffer.from(body); const result = await request(app).post('/api/v1/csv-imports/upload-intents').set('Authorization', bearer(token)).send({ filename: 'customers.csv', size: bytes.length,
    checksumSHA256: createHash('sha256').update(bytes).digest('base64') }).expect(201);
  const fileId = data<{ fileId: string }>(result).fileId;
  const file = await FileModel.findById(fileId).select('+objectKey').lean(); if (!file) throw new Error('File missing'); blobs.set(file.objectKey, bytes);
  await request(app).post(`/api/v1/csv-imports/files/${fileId}/confirm`).set('Authorization', bearer(token)).expect(200);
  return data<Job>(await request(app).post('/api/v1/csv-imports').set('Authorization', bearer(token)).send({ fileId, branchId, ...(columnMapping ? { columnMapping } : {}) }).expect(202));
}
async function getJob(id: string, token = md) { return data<Job>(await request(app).get(`/api/v1/csv-imports/${id}`).set('Authorization', bearer(token)).expect(200)); }
async function preview(body = csvHeader + csvRow(`+91777${String(++sequence).padStart(7, '0')}`), token = md, branchId = branch) {
  const queued = await queue(body, token, branchId); expect(await worker.runOne()).toBe(true); return getJob(queued._id, token);
}
async function imported(assignee = tc, body?: string, token = md, branchId = branch): Promise<Customer[]> {
  const job = await preview(body, token, branchId);
  await request(app).post(`/api/v1/csv-imports/${job._id}/confirm`).set('Authorization', bearer(token)).send({ revision: job.revision, assignedTo: assignee.id }).expect(202);
  expect(await worker.runOne()).toBe(true); expect((await getJob(job._id, token)).status).toBe('COMPLETED');
  return CustomerModel.find({ importId: job._id }).lean().then((rows) => rows.map((row) => ({ _id: row._id.toHexString(), revision: row.revision, assignedTo: row.assignedTo.toHexString(), status: row.status })));
}
async function createLead(extra = {}, token = md) { return data<Lead>(await request(app).post('/api/v1/leads').set('Authorization', bearer(token)).send(leadInput(extra)).expect(201)); }
async function interested(): Promise<Customer> {
  const customer = (await imported())[0]; if (!customer) throw new Error('Customer fixture missing');
  return data<Customer>(await request(app).patch(`/api/v1/customers/${customer._id}/status`).set('Authorization', bearer(tc.token)).send({ revision: 0, status: 'INTERESTED', reason: 'Customer expressed interest' }).expect(200));
}
beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } }); await connectDatabase({ ...config, mongodbUri: replica.getUri('commercial') }, createLogger(config));
  await createIdentityIndexes(); await createOrganizationIndexes(); await createAttendanceIndexes(); await createCommercialIndexes();
  rootId = await bootstrapMd({ employeeCode: 'COM-MD', firstName: 'Fixture', lastName: 'Director', email: 'com-md@example.invalid', mobileNumber: '+919999999999' }, config.tokenEncryptionKey); md = await login(rootId, 'com-md@example.invalid');
  const state = await StateModel.create({ code: 'TST', name: 'Synthetic state', createdBy: rootId }); stateId = state._id.toHexString();
  const district = await DistrictModel.create({ code: 'D1', name: 'Synthetic district', stateId, createdBy: rootId }); districtId = district._id.toHexString();
  const block = await BlockModel.create({ code: 'B1', name: 'Synthetic block', districtId, kind: 'BLOCK', createdBy: rootId }); blockId = block._id.toHexString();
  const makeBranch = async (branchCode: string) => (await BranchModel.create({ branchCode, branchName: 'Synthetic office', address: 'Synthetic office address', stateId, districtId, blockId, contactNumber: '+919000000000', createdBy: rootId }))._id.toHexString();
  branch = await makeBranch('COM-A'); foreignBranch = await makeBranch('COM-B');
  mh = await employee('MH', rootId.toHexString(), branch); bh = await employee('BH', mh.id, branch); tc = await employee('TC', bh.id, branch); tc2 = await employee('TC', rootId.toHexString(), branch);
  tc3 = await employee('TC', bh.id, branch);
  sex = await employee('SEX', bh.id, branch); sex2 = await employee('SEX', rootId.toHexString(), branch); other = await employee('SEX', rootId.toHexString(), foreignBranch); otherTc = await employee('TC', rootId.toHexString(), foreignBranch);
  for (const [category, code] of [['PAYMENT_MODE', 'BANK'], ['PANEL_BRAND', 'TEST_BRAND'], ['PANEL_TECHNOLOGY', 'TEST_TECH'], ['LEAD_SOURCE', 'TEST_SOURCE']]) await request(app).post('/api/v1/reference-values').set('Authorization', bearer()).send({ category, code, label: 'Synthetic reference' }).expect(201);
}, 180000);
beforeEach(async () => {
  await Promise.all([LeadModel.deleteMany({}), CustomerModel.deleteMany({}), ConfirmedCustomerModel.deleteMany({}), ImportModel.deleteMany({}), ImportRowModel.deleteMany({}), FileModel.deleteMany({}), LeadExportModel.deleteMany({}), IdempotencyModel.deleteMany({})]);
  await CommercialSettingsModel.updateOne({ _id: 'customers' }, { $set: { duplicateScope: 'BRANCH', revision: 0 } }); blobs.clear(); vi.clearAllMocks();
});
afterAll(async () => { vi.restoreAllMocks(); await disconnectDatabase(); await replica?.stop(); });

describe('private staged CSV imports', () => {
  it.each(['Contact Name', 'Customer Name'])('accepts the %s name header for contact imports', async (nameHeader) => {
    const job = await preview(csvHeader.replace('Customer Name', nameHeader) + csvRow('+919876543219'));
    expect(job).toMatchObject({ status: 'PREVIEW_READY', acceptedRows: 1, rejectedRows: 0 });
  });
  it('accepts a queued legacy mapping with a new contact template header', async () => {
    const job = await queue(csvHeader.replace('Customer Name', 'Contact Name') + csvRow('+919876543219'), md, branch, { ...defaultColumnMapping, customerName: 'Customer Name' });
    expect(await worker.runOne()).toBe(true);
    expect(await getJob(job._id)).toMatchObject({ status: 'PREVIEW_READY', acceptedRows: 1 });
  });
  it('returns readable labels on authorized import responses without exposing related private data', async () => {
    const job = await preview();
    const expected = { createdByName: 'Fixture Director', createdByCode: 'COM-MD', branchName: 'Synthetic office', branchCode: 'COM-A', fileName: 'customers.csv', assignedToName: null };
    const detail = data<Record<string, unknown>>(await request(app).get(`/api/v1/csv-imports/${job._id}`).set('Authorization', bearer()).expect(200));
    expect(detail).toMatchObject(expected);
    const list = data<Record<string, unknown>[]>(await request(app).get('/api/v1/csv-imports').set('Authorization', bearer()).expect(200));
    expect(list).toContainEqual(expect.objectContaining({ _id: job._id, ...expected }));
    const confirmed = data<Record<string, unknown>>(await request(app).post(`/api/v1/csv-imports/${job._id}/confirm`).set('Authorization', bearer()).send({ revision: job.revision, assignedTo: tc.id }).expect(202));
    expect(confirmed).toMatchObject({ ...expected, assignedToName: 'Fixture Employee' });
    for (const key of ['email', 'mobileNumber', 'bucket', 'objectKey', 'principal', 'passwordHash']) expect(confirmed).not.toHaveProperty(key);
    await FileModel.updateOne({ _id: detail.fileId }, { $unset: { filename: 1 } });
    expect(data<{ fileName: string }>(await request(app).get(`/api/v1/csv-imports/${job._id}`).set('Authorization', bearer()).expect(200)).fileName).toMatch(/^Contact import CSV \(\d{4}-\d{2}-\d{2}\)$/);
  });
  it('identifies the invalid optional block and accepts the same data when its column is explicitly skipped', async () => {
    const body = csvHeader + csvRow('+919876543218').replace(',B1,', ',UNKNOWN_BLOCK,');
    const failed = await preview(body);
    expect(failed).toMatchObject({ acceptedRows: 0, rejectedRows: 1 });
    const rows = data<{ rowIssues: { field: string; code: string }[]; inputLocation: { block: string } }[]>(await request(app).get(`/api/v1/csv-imports/${failed._id}/rows`).set('Authorization', bearer()).expect(200));
    expect(rows[0]?.rowIssues).toEqual([{ field: 'block', code: 'NOT_FOUND_OR_AMBIGUOUS' }]);
    expect(rows[0]?.inputLocation.block).toBe('UNKNOWN_BLOCK');
    const mapping = { ...defaultColumnMapping }; delete mapping.block;
    const corrected = await queue(body, md, branch, mapping); await worker.runOne();
    expect(await getJob(corrected._id)).toMatchObject({ acceptedRows: 1, rejectedRows: 0 });
    const accepted = data<{ normalizedData: { blockId: string | null } }[]>(await request(app).get(`/api/v1/csv-imports/${corrected._id}/rows`).set('Authorization', bearer()).expect(200));
    expect(accepted[0]?.normalizedData.blockId).toBeNull();
    expect(await CustomerModel.countDocuments()).toBe(0);
  });
  it('keeps the preview unavailable until validation has finished and returns an actionable status', async () => {
    const job = await queue(csvHeader + csvRow('+919876543216'));
    const route = `/api/v1/csv-imports/${job._id}/rows`;
    const pending = await request(app).get(route).set('Authorization', bearer()).expect(409);
    expect(pending.body).toHaveProperty('error.code', 'PREVIEW_NOT_READY');
    expect(await CustomerModel.countDocuments()).toBe(0);
    await worker.runOne();
    const ready = await request(app).get(route).set('Authorization', bearer()).expect(200);
    expect(data<unknown[]>(ready)).toHaveLength(1);
    expect(await CustomerModel.countDocuments()).toBe(0);
  });
  it('lists only active eligible Telecallers in the import branch and current assignment scope', async () => {
    const job = await preview();
    const route = `/api/v1/csv-imports/${job._id}/assignees`;
    await request(app).get(route).expect(401);
    await request(app).get(route).set('Authorization', bearer(tc.token)).expect(403);
    const options = data<{ _id: string; firstName: string; lastName: string; employeeCode: string }[]>(await request(app).get(route).set('Authorization', bearer()).expect(200));
    expect(options.map((option) => option._id).sort()).toEqual([tc.id, tc2.id, tc3.id].sort());
    for (const option of options) expect(Object.keys(option).sort()).toEqual(['_id', 'employeeCode', 'firstName', 'lastName']);
    const paged = await request(app).get(`${route}?limit=1&page=2&search=Fixture`).set('Authorization', bearer()).expect(200);
    expect(data<unknown[]>(paged)).toHaveLength(1); expect(paged.body).toHaveProperty('meta.total', 3);
    await request(app).get(`${route}?branchId=${foreignBranch}`).set('Authorization', bearer()).expect(400);
    await request(app).get(`/api/v1/csv-imports/${new Types.ObjectId().toHexString()}/assignees`).set('Authorization', bearer()).expect(404);
    await UserModel.updateOne({ _id: tc3.id }, { $set: { isActive: false } });
    try {
      const remaining = data<{ _id: string }[]>(await request(app).get(route).set('Authorization', bearer()).expect(200));
      expect(remaining.map((option) => option._id).sort()).toEqual([tc.id, tc2.id].sort());
    } finally { await UserModel.updateOne({ _id: tc3.id }, { $set: { isActive: true } }); }
    const own = await preview(undefined, mh.token);
    const scoped = data<{ _id: string }[]>(await request(app).get(`/api/v1/csv-imports/${own._id}/assignees`).set('Authorization', bearer(mh.token)).expect(200));
    expect(scoped.map((option) => option._id).sort()).toEqual([tc.id, tc3.id].sort());
    await request(app).get(route).set('Authorization', bearer(mh.token)).expect(404);
  });
  it('requires import authority and rejects path traversal, arbitrary metadata and oversized uploads', async () => {
    await request(app).post('/api/v1/csv-imports/upload-intents').send({}).expect(401);
    await request(app).post('/api/v1/csv-imports/upload-intents').set('Authorization', bearer(tc.token)).send({}).expect(403);
    const valid = { filename: 'contacts.csv', size: 100, checksumSHA256: Buffer.alloc(32).toString('base64') };
    for (const changes of [{ filename: '../contacts.csv' }, { filename: 'file.exe' }, { size: 20971521 }, { objectKey: 'foreign' }, { checksumSHA256: 'bad' }]) await request(app).post('/api/v1/csv-imports/upload-intents').set('Authorization', bearer()).send({ ...valid, ...changes }).expect(400);
  });
  it('stages a complete preview with normalized phones, row errors and duplicates before any customer becomes visible', async () => {
    const job = await preview(csvHeader + csvRow('9876543210') + csvRow('+919876543210') + csvRow('not-a-phone'));
    expect(job).toMatchObject({ status: 'PREVIEW_READY', totalRows: 3, acceptedRows: 1, duplicateRows: 1, rejectedRows: 1 }); expect(await CustomerModel.countDocuments()).toBe(0);
    const rows = data<{ status: string; normalizedData: { mobileNumber: string } }[]>(await request(app).get(`/api/v1/csv-imports/${job._id}/rows?limit=100`).set('Authorization', bearer()).expect(200));
    expect(rows.map((row) => row.status)).toEqual(['VALID', 'DUPLICATE', 'REJECTED']); expect(rows[0]?.normalizedData.mobileNumber).toBe('+919876543210');
    const response = await request(app).get(`/api/v1/csv-imports/${job._id}`).set('Authorization', bearer()).expect(200);
    for (const privateField of ['principal', 'leaseId', 'sessionId']) expect(response.text).not.toContain(privateField);
  });
  it('keeps malformed/unknown-header files out of live customers and never exposes partial previews', async () => {
    for (const body of ['Wrong,Headers\na,b\n', csvHeader + '"unclosed', csvHeader]) {
      const job = await preview(body); expect(job.status).toBe('FAILED'); expect(await CustomerModel.countDocuments()).toBe(0);
      await request(app).get(`/api/v1/csv-imports/${job._id}/rows`).set('Authorization', bearer()).expect(409);
    }
  });
  it('validates active location parent chains and rejects ambiguous names or wrong-parent districts', async () => {
    const job = await preview(csvHeader + csvRow('+919876543211').replace(',D1,', ',UNKNOWN,') + csvRow('+919876543212'));
    expect(job).toMatchObject({ rejectedRows: 1, acceptedRows: 1 });
  });
  it('authorizes MH own preview and descendant assignee while denying branch peers and unrelated scopes', async () => {
    const job = await preview(undefined, mh.token); expect(job.status).toBe('PREVIEW_READY');
    await request(app).get(`/api/v1/csv-imports/${job._id}`).set('Authorization', bearer(tc.token)).expect(403);
    await request(app).post(`/api/v1/csv-imports/${job._id}/confirm`).set('Authorization', bearer(mh.token)).send({ revision: job.revision, assignedTo: tc2.id }).expect(403);
    await request(app).post(`/api/v1/csv-imports/${job._id}/confirm`).set('Authorization', bearer(mh.token)).send({ revision: job.revision, assignedTo: tc.id }).expect(202);
    await worker.runOne(); expect((await getJob(job._id, mh.token)).importedRows).toBe(1);
  });
  it('confirms once, revalidates at commit, skips racing duplicates and records assignment/audit history', async () => {
    const csv = csvHeader + csvRow('+919876543210'); const first = await preview(csv); const second = await preview(csv);
    for (const job of [first, second]) await request(app).post(`/api/v1/csv-imports/${job._id}/confirm`).set('Authorization', bearer()).send({ revision: job.revision, assignedTo: tc.id }).expect(202);
    await request(app).post(`/api/v1/csv-imports/${first._id}/confirm`).set('Authorization', bearer()).send({ revision: first.revision, assignedTo: tc.id }).expect(409);
    await Promise.all([worker.runOne(), worker.runOne()]); expect(await CustomerModel.countDocuments()).toBe(1);
    const one = await getJob(first._id); const two = await getJob(second._id); expect(one.importedRows + two.importedRows).toBe(1); expect(one.duplicateRows + two.duplicateRows).toBe(1);
    const customer = await CustomerModel.findOne().lean(); if (!customer) throw new Error('Customer missing'); expect(await AssignmentModel.countDocuments({ entityId: customer._id, entityType: 'CUSTOMER' })).toBe(1);
    expect(await ActivityLogModel.countDocuments({ action: 'CSV_IMPORT_COMPLETED', entityId: trusted({ $in: [new Types.ObjectId(first._id), new Types.ObjectId(second._id)] }) })).toBe(2);
  });
  it('fails closed when the confirming actor loses import permission before execution', async () => {
    const job = await preview(undefined, mh.token);
    await request(app).post(`/api/v1/csv-imports/${job._id}/confirm`).set('Authorization', bearer(mh.token)).send({ revision: job.revision, assignedTo: tc.id }).expect(202);
    const role = await RoleModel.findOne({ code: 'MH' }).lean(); const permission = await PermissionModel.findOne({ code: 'leads:import' }).lean(); if (!role || !permission) throw new Error('Fixture permissions missing');
    await RoleModel.updateOne({ _id: role._id }, { $pull: { permissions: { permissionId: permission._id } } });
    try { await worker.runOne(); expect((await getJob(job._id, mh.token)).status).toBe('FAILED'); expect(await CustomerModel.countDocuments()).toBe(0); }
    finally { await RoleModel.updateOne({ _id: role._id }, { $set: { permissions: role.permissions } }); }
  });
  it('rolls back a customer import batch on audit failure and retries without duplicate records', async () => {
    const job = await preview(); await request(app).post(`/api/v1/csv-imports/${job._id}/confirm`).set('Authorization', bearer()).send({ revision: job.revision, assignedTo: tc.id }).expect(202);
    const spy = vi.spyOn(ActivityLogModel, 'create').mockRejectedValueOnce(new Error('Audit unavailable'));
    try { await worker.runOne(); expect(await CustomerModel.countDocuments()).toBe(0); expect((await getJob(job._id)).status).toBe('QUEUED_COMMIT'); }
    finally { spy.mockRestore(); }
    await worker.runOne(); expect(await CustomerModel.countDocuments()).toBe(1); expect((await getJob(job._id)).status).toBe('COMPLETED');
  });
  it('rechecks delegated job source scope even when branch and recipient remain authorized', async () => {
    const role = await RoleModel.findOne({ code: 'TC' }).lean(); if (!role) throw new Error('Missing fixture role');
    const definitions = await PermissionModel.find({ code: trusted({ $in: ['imports:create', 'imports:read', 'leads:import'] }) }).lean();
    await RoleModel.updateOne({ _id: role._id }, { $push: { permissions: { $each: definitions.map((definition) => ({ permissionId: definition._id, scope: 'SELF' })) } } });
    try {
      const job = await preview(undefined, tc.token);
      await request(app).post(`/api/v1/csv-imports/${job._id}/confirm`).set('Authorization', bearer(mh.token)).send({ revision: job.revision, assignedTo: tc3.id }).expect(202);
      await UserModel.updateOne({ _id: tc.id }, { $set: { reportingManagerId: rootId } });
      await worker.runOne(); expect((await getJob(job._id)).errorCode).toBe('FORBIDDEN_SOURCE'); expect(await CustomerModel.countDocuments()).toBe(0);
    } finally {
      await UserModel.updateOne({ _id: tc.id }, { $set: { reportingManagerId: new Types.ObjectId(bh.id) } });
      await RoleModel.updateOne({ _id: role._id }, { $set: { permissions: role.permissions } });
    }
  });
  it('reclaims an abandoned lease and resumes a failed confirmed commit without duplicate customers', async () => {
    const job = await queue(csvHeader + csvRow('+919876543210'));
    await ImportModel.updateOne({ _id: job._id }, { $set: { status: 'VALIDATING', leaseId: 'abandoned', leaseUntil: new Date(Date.now() - 1) } }); await worker.runOne();
    const ready = await getJob(job._id); await request(app).post(`/api/v1/csv-imports/${job._id}/confirm`).set('Authorization', bearer()).send({ revision: ready.revision, assignedTo: tc.id }).expect(202);
    await UserModel.updateOne({ _id: tc.id }, { $set: { isActive: false } });
    try { await worker.runOne(); expect((await getJob(job._id)).status).toBe('FAILED'); } finally { await UserModel.updateOne({ _id: tc.id }, { $set: { isActive: true } }); }
    const failed = await getJob(job._id); await request(app).post(`/api/v1/csv-imports/${job._id}/confirm`).set('Authorization', bearer()).send({ revision: failed.revision, assignedTo: tc.id }).expect(202);
    await worker.runOne(); expect(await CustomerModel.countDocuments()).toBe(1); expect((await getJob(job._id)).status).toBe('COMPLETED');
  });
  it('supports company-wide dedupe without exposing cross-branch customer details and freezes policy once data exists', async () => {
    await request(app).patch('/api/v1/commercial-settings').set('Authorization', bearer()).send({ revision: 0, duplicateScope: 'COMPANY' }).expect(200);
    await imported(tc, csvHeader + csvRow('+919876543210'));
    const job = await preview(csvHeader + csvRow('+919876543210'), md, foreignBranch); expect(job).toMatchObject({ duplicateRows: 1, acceptedRows: 0 });
    await request(app).patch('/api/v1/commercial-settings').set('Authorization', bearer()).send({ revision: 1, duplicateScope: 'BRANCH' }).expect(409);
  });
});

describe('customer ownership, bulk reassignment and conversion', () => {
  it('resolves customer labels for scoped readers and refreshes names after reassignment', async () => {
    const customer = (await imported())[0]; if (!customer) throw new Error('Missing customer');
    const first = await UserModel.findById(tc.id).select('employeeCode').lean();
    const second = await UserModel.findById(tc2.id).select('employeeCode').lean();
    const expected = { assignedToName: 'Fixture Employee', assignedToCode: first?.employeeCode, createdByName: 'Fixture Director', branchName: 'Synthetic office' };
    const list = data<Record<string, unknown>[]>(await request(app).get('/api/v1/customers').set('Authorization', bearer(tc.token)).expect(200));
    expect(list).toContainEqual(expect.objectContaining({ _id: customer._id, ...expected }));
    const detail = data<Record<string, unknown>>(await request(app).get(`/api/v1/customers/${customer._id}`).set('Authorization', bearer(tc.token)).expect(200));
    expect(detail).toMatchObject(expected);
    for (const key of ['passwordHash', 'email', 'authVersion', 'user', 'assignee']) expect(detail).not.toHaveProperty(key);
    await request(app).post('/api/v1/customers/assignments').set('Authorization', bearer()).send({ items: [{ id: customer._id, revision: 0 }], assignedTo: tc2.id, reason: 'Readable assignment regression' }).expect(200);
    const reassigned = data<Record<string, unknown>>(await request(app).get(`/api/v1/customers/${customer._id}`).set('Authorization', bearer()).expect(200));
    expect(reassigned).toMatchObject({ assignedTo: tc2.id, assignedToName: 'Fixture Employee', assignedToCode: second?.employeeCode, assignedByName: 'Fixture Director' });
    const history = data<Record<string, unknown>[]>(await request(app).get(`/api/v1/customers/${customer._id}/assignments`).set('Authorization', bearer()).expect(200));
    expect(history).toContainEqual(expect.objectContaining({ previousAssigneeCode: first?.employeeCode, assignedToCode: second?.employeeCode, assignedByName: 'Fixture Director' }));
    await request(app).get(`/api/v1/customers/${customer._id}`).set('Authorization', bearer(tc.token)).expect(404);
    await CustomerModel.updateOne({ _id: customer._id }, { $set: { assignedTo: new Types.ObjectId() } });
    expect(data<Record<string, unknown>>(await request(app).get(`/api/v1/customers/${customer._id}`).set('Authorization', bearer()).expect(200))).toMatchObject({ assignedToName: null, assignedToCode: null });
  });
  it('isolates assigned customers, branch peers, subtrees and cross-branch records', async () => {
    const customer = (await imported())[0]; if (!customer) throw new Error('Missing customer');
    await request(app).get(`/api/v1/customers/${customer._id}`).set('Authorization', bearer(tc.token)).expect(200);
    await request(app).get(`/api/v1/customers/${customer._id}`).set('Authorization', bearer(tc2.token)).expect(404);
    await request(app).get(`/api/v1/customers/${customer._id}`).set('Authorization', bearer(mh.token)).expect(200);
    await request(app).get(`/api/v1/customers/${customer._id}`).set('Authorization', bearer(otherTc.token)).expect(404);
    const filtered = await request(app).get(`/api/v1/customers?assignedTo=${tc.id}&branchId=${foreignBranch}`).set('Authorization', bearer(tc.token)).expect(200); expect(filtered.body).toHaveProperty('meta.total', 0);
  });
  it('bulk reassignment checks old/new scope, recipient capability and all revisions atomically', async () => {
    const rows = await imported(tc, csvHeader + csvRow('+919876543210') + csvRow('+919876543211')); const items = rows.map((row) => ({ id: row._id, revision: row.revision }));
    await request(app).post('/api/v1/customers/assignments').set('Authorization', bearer(mh.token)).send({ items, assignedTo: tc2.id, reason: 'Outside subtree' }).expect(403);
    await request(app).post('/api/v1/customers/assignments').set('Authorization', bearer()).send({ items, assignedTo: sex.id, reason: 'Invalid work capability' }).expect(400);
    await request(app).post('/api/v1/customers/assignments').set('Authorization', bearer()).send({ items, assignedTo: otherTc.id, reason: 'Other branch' }).expect(400);
    const stale = items.map((item, index) => ({ ...item, revision: index === 1 ? 99 : 0 }));
    await request(app).post('/api/v1/customers/assignments').set('Authorization', bearer(bh.token)).send({ items: stale, assignedTo: tc2.id, reason: 'Rollback entire batch' }).expect(409);
    expect(await CustomerModel.countDocuments({ assignedTo: tc.id, revision: 0 })).toBe(2);
    await request(app).post('/api/v1/customers/assignments').set('Authorization', bearer(bh.token)).send({ items, assignedTo: tc2.id, reason: 'Rebalance calling queue' }).expect(200);
    await request(app).get(`/api/v1/customers/${rows[0]?._id ?? ''}`).set('Authorization', bearer(tc.token)).expect(404);
  });
  it('requires interest and idempotency, converts once under races and detects key/body conflicts', async () => {
    const customer = await interested(); const input = { revision: customer.revision, requirements }; const key = 'conversion-test-key-123';
    await request(app).post(`/api/v1/customers/${customer._id}/convert`).set('Authorization', bearer(tc.token)).send(input).expect(400);
    const results = await Promise.all([1, 2].map(() => request(app).post(`/api/v1/customers/${customer._id}/convert`).set('Authorization', bearer(tc.token)).set('Idempotency-Key', key).send(input)));
    expect(results.map((response) => response.status)).toEqual([200, 200]); expect(data<Lead>(results[0] as Response)._id).toBe(data<Lead>(results[1] as Response)._id);
    expect(await LeadModel.countDocuments({ sourceCustomerId: customer._id })).toBe(1); expect(await ProposalModel.countDocuments()).toBe(0);
    await request(app).post(`/api/v1/customers/${customer._id}/convert`).set('Authorization', bearer(tc.token)).set('Idempotency-Key', key).send({ ...input, requirements: { ...requirements, ratePerKw: '1.00' } }).expect(409);
    await request(app).post(`/api/v1/customers/${customer._id}/convert`).set('Authorization', bearer(tc.token)).set('Idempotency-Key', 'another-conversion-key').send(input).expect(409);
  });
  it('rejects foreign conversions, computed values and unvalidated references; audit failure rolls back conversion', async () => {
    const customer = await interested(); const route = `/api/v1/customers/${customer._id}/convert`; const input = { revision: 1, requirements };
    await request(app).post(route).set('Authorization', bearer(tc2.token)).set('Idempotency-Key', 'foreign-conversion-key').send(input).expect(404);
    await request(app).post(route).set('Authorization', bearer(tc.token)).set('Idempotency-Key', 'computed-conversion-key').send({ ...input, requirements: { ...requirements, estimatedProjectValue: '1.00' } }).expect(400);
    await request(app).post(route).set('Authorization', bearer(tc.token)).set('Idempotency-Key', 'reference-conversion-key').send({ ...input, requirements: { ...requirements, panelBrand: 'UNCONFIGURED' } }).expect(400);
    const spy = vi.spyOn(ActivityLogModel, 'create').mockRejectedValueOnce(new Error('Audit unavailable'));
    await request(app).post(route).set('Authorization', bearer(tc.token)).set('Idempotency-Key', 'rollback-conversion-key').send(input).expect(500); spy.mockRestore();
    expect(await LeadModel.countDocuments()).toBe(0); expect(await CustomerModel.findById(customer._id).lean()).toMatchObject({ status: 'INTERESTED', revision: 1 });
  });
});

describe('lead scopes, assignment history and controlled workflow', () => {
  it('includes the real assigner identity on authorized lead lists, details and history without requiring directory access', async () => {
    const lead = await createLead({ assignedTo: sex.id }, bh.token);
    const assigner = await UserModel.findById(bh.id).select('firstName lastName employeeCode').lean();
    if (!assigner) throw new Error('Assigner fixture missing');
    const expected = { assignedByName: `${assigner.firstName} ${assigner.lastName}`.trim(), assignedByCode: assigner.employeeCode };
    await request(app).get(`/api/v1/employees/${bh.id}`).set('Authorization', bearer(sex.token)).expect(404);
    await UserModel.updateOne({ _id: bh.id }, { $set: { isActive: false } });
    try {
      const detail = await request(app).get(`/api/v1/leads/${lead._id}`).set('Authorization', bearer(sex.token)).expect(200);
      expect(data<Record<string, unknown>>(detail)).toMatchObject(expected);
      const list = data<Record<string, unknown>[]>(await request(app).get('/api/v1/leads').set('Authorization', bearer(sex.token)).expect(200));
      expect(list.find(row => row._id === lead._id)).toMatchObject(expected);
      const history = await request(app).get(`/api/v1/leads/${lead._id}/assignments`).set('Authorization', bearer(sex.token)).expect(200);
      expect(data<Record<string, unknown>[]>(history)).toEqual(expect.arrayContaining([expect.objectContaining(expected)]));
      expect(history.text).not.toMatch(/passwordHash|mobileNumber|email|permissions/);
      await request(app).get(`/api/v1/leads/${lead._id}/assignments`).set('Authorization', bearer(sex2.token)).expect(404);
    } finally { await UserModel.updateOne({ _id: bh.id }, { $set: { isActive: true } }); }
  });
  it('migrates legacy telecaller privileges to branch routing idempotently without granting executive assignment', async () => {
    const role = await RoleModel.findOne({ code: 'TC' }).lean();
    const update = await PermissionModel.findOne({ code: 'leads:update' }).lean();
    const route = await PermissionModel.findOne({ code: 'leads:route' }).lean();
    if (!role || !update || !route) throw new Error('Routing test prerequisites missing');
    const original = role.permissions;
    await RoleModel.updateOne({ _id: role._id }, { $set: { permissions: [...original.filter(grant => !grant.permissionId.equals(route._id)), { permissionId: update._id, scope: 'SELF' }] } });
    try {
      expect(await enableBranchLeadRouting()).toBe(1);
      expect(await enableBranchLeadRouting()).toBe(0);
      const migrated = await RoleModel.findById(role._id).lean();
      expect(migrated?.permissions.some(grant => grant.permissionId.equals(route._id) && grant.scope === 'SELF')).toBe(true);
      expect(migrated?.permissions.some(grant => grant.permissionId.equals(update._id))).toBe(false);
    } finally { await RoleModel.updateOne({ _id: role._id }, { $set: { permissions: original } }); }
  });
  it('routes a telecaller contact across branches and delegates only to that branch head or its ancestors', async () => {
    const destinationHead = await employee('BH', mh.id, foreignBranch);
    const officialHead = await employee('BH', rootId.toHexString(), foreignBranch);
    await BranchModel.updateOne({ _id: foreignBranch }, { $set: { branchHeadId: officialHead.id } });
    try {
      const customer = await interested();
      const choices = data<{ _id: string; label: string }[]>(await request(app).get('/api/v1/leads/branch-options').set('Authorization', bearer(tc.token)).expect(200));
      expect(choices.some((choice) => choice._id === foreignBranch)).toBe(true);
      await request(app).post(`/api/v1/customers/${customer._id}/convert`).set('Authorization', bearer(tc.token)).set('Idempotency-Key', 'telecaller-no-direct-sales').send({ revision: customer.revision, requirements, branchId: foreignBranch, proposedSalesExecutiveId: other.id }).expect(403);
      const lead = data<Lead>(await request(app).post(`/api/v1/customers/${customer._id}/convert`).set('Authorization', bearer(tc.token)).set('Idempotency-Key', 'telecaller-route-cross-branch').send({ revision: customer.revision, requirements, branchId: foreignBranch }).expect(200));
      expect(lead).toMatchObject({ assignedTo: null, branchId: foreignBranch, assignmentState: 'UNASSIGNED' });
      const queue = data<{ _id: string }[]>(await request(app).get('/api/v1/leads?assignmentState=UNASSIGNED').set('Authorization', bearer(destinationHead.token)).expect(200));
      expect(queue.some((row) => row._id === lead._id)).toBe(true);
      await request(app).get(`/api/v1/leads/${lead._id}`).set('Authorization', bearer(mh.token)).expect(404);
      await BranchModel.updateOne({ _id: foreignBranch }, { $set: { branchHeadId: destinationHead.id } });
      await request(app).get(`/api/v1/leads/${lead._id}`).set('Authorization', bearer(mh.token)).expect(200);
      await request(app).get(`/api/v1/leads/${lead._id}`).set('Authorization', bearer(bh.token)).expect(404);
      await request(app).get(`/api/v1/leads/${lead._id}`).set('Authorization', bearer(other.token)).expect(404);
      await request(app).patch(`/api/v1/leads/${lead._id}/status`).set('Authorization', bearer(tc.token)).send({ revision: 0, status: 'CONTACTED', reason: 'Cannot progress a routed lead' }).expect(403);
      await request(app).post(`/api/v1/leads/${lead._id}/assignments`).set('Authorization', bearer(tc.token)).send({ revision: 0, assignedTo: other.id, reason: 'Cannot assign an executive' }).expect(403);
      const options = data<{ _id: string }[]>(await request(app).get(`/api/v1/leads/${lead._id}/assignees`).set('Authorization', bearer(mh.token)).expect(200));
      expect(options.some((row) => row._id === other.id)).toBe(true); expect(options.some((row) => row._id === sex.id || row._id === otherTc.id)).toBe(false);
      await request(app).post(`/api/v1/leads/${lead._id}/assignments`).set('Authorization', bearer(destinationHead.token)).send({ revision: 0, assignedTo: sex.id, reason: 'Wrong receiving branch' }).expect(400);
      await request(app).post(`/api/v1/leads/${lead._id}/assignments`).set('Authorization', bearer(mh.token)).send({ revision: 0, assignedTo: other.id, reason: 'Branch-head ancestor assigns local executive' }).expect(200);
      await request(app).post(`/api/v1/leads/${lead._id}/route`).set('Authorization', bearer(tc.token)).send({ revision: 1, branchId: branch, reason: 'Cannot reroute an assigned lead' }).expect(409);
      await request(app).get(`/api/v1/leads/${lead._id}`).set('Authorization', bearer(other.token)).expect(200);
      await request(app).get(`/api/v1/leads/${lead._id}`).set('Authorization', bearer(sex.token)).expect(404);
      await request(app).patch(`/api/v1/leads/${lead._id}/status`).set('Authorization', bearer(other.token)).send({ revision: 1, status: 'CONTACTED', reason: 'Assigned executive contacts the lead' }).expect(200);
    } finally {
      await BranchModel.updateOne({ _id: foreignBranch }, { $set: { branchHeadId: null } });
      await UserModel.deleteMany({ _id: trusted({ $in: [new Types.ObjectId(destinationHead.id), new Types.ObjectId(officialHead.id)] }) });
    }
  });
  it('lets telecallers route their own new leads while rejecting inactive branches, foreign leads, stale revisions and direct executive assignment', async () => {
    const lead = await createLead({ branchId: foreignBranch, assignedTo: null }, tc.token);
    expect(lead).toMatchObject({ assignedTo: null, assignmentState: 'UNASSIGNED' });
    await request(app).post('/api/v1/leads').set('Authorization', bearer(tc.token)).send(leadInput({ branchId: foreignBranch, assignedTo: other.id })).expect(403);
    const inactive = new Types.ObjectId();
    await request(app).post(`/api/v1/leads/${lead._id}/route`).set('Authorization', bearer(tc.token)).send({ revision: 0, branchId: inactive, reason: 'Branch must exist' }).expect(400);
    await request(app).post(`/api/v1/leads/${lead._id}/route`).set('Authorization', bearer(tc2.token)).send({ revision: 0, branchId: branch, reason: 'Not the originating caller' }).expect(404);
    await request(app).post(`/api/v1/leads/${lead._id}/route`).set('Authorization', bearer(tc.token)).send({ revision: 9, branchId: branch, reason: 'Stale lead revision' }).expect(409);
    await request(app).post(`/api/v1/leads/${lead._id}/route`).set('Authorization', bearer(tc.token)).send({ revision: 0, branchId: branch, reason: 'Correct branch for the site address' }).expect(200);
    expect(await LeadModel.findById(lead._id).lean()).toMatchObject({ branchId: new Types.ObjectId(branch), assignedTo: null, revision: 1 });
  });
  it('creates one customer atomically, scopes reads to the live lead, and preserves it across reopen/reconversion', async () => {
    let lead = await createLead({ assignedTo: sex.id });
    await request(app).get('/api/v1/sales-customers').expect(401);
    await request(app).get('/api/v1/sales-customers?status=LOST').set('Authorization', bearer()).expect(400);
    await request(app).patch(`/api/v1/leads/${lead._id}/status`).set('Authorization', bearer()).send({ revision: 0, status: 'CONVERTED', reason: 'Invalid skipped workflow' }).expect(400);
    expect(await ConfirmedCustomerModel.countDocuments()).toBe(0);
    await LeadModel.updateOne({ _id: lead._id }, { $set: { status: 'QUOTATION_SENT' } });
    const results = await Promise.all([1, 2].map(() => request(app).patch(`/api/v1/leads/${lead._id}/status`).set('Authorization', bearer()).send({ revision: 0, status: 'CONVERTED', reason: 'Project confirmed' })));
    expect(results.filter((result) => result.status === 200)).toHaveLength(1);
    expect(await ConfirmedCustomerModel.countDocuments()).toBe(1);
    const stored = await ConfirmedCustomerModel.findOne({ leadId: lead._id }).lean(); if (!stored) throw new Error('Customer missing');
    const customerId = stored._id.toHexString();
    const list = data<Record<string, unknown>[]>(await request(app).get('/api/v1/sales-customers?search=Synthetic&limit=1').set('Authorization', bearer(sex.token)).expect(200));
    expect(list).toHaveLength(1); expect(list[0]).toMatchObject({ _id: customerId, name: 'Synthetic customer', status: 'CONFIRMED', projectValue: '275000.00', assignedToName: 'Fixture Employee', confirmedByName: 'Fixture Director' });
    expect(data<unknown[]>(await request(app).get('/api/v1/sales-customers').set('Authorization', bearer(other.token)).expect(200))).toEqual([]);
    await request(app).get(`/api/v1/sales-customers/${customerId}`).set('Authorization', bearer(other.token)).expect(404);
    lead = data<Lead>(await request(app).get(`/api/v1/leads/${lead._id}`).set('Authorization', bearer()).expect(200));
    lead = data<Lead>(await request(app).patch(`/api/v1/leads/${lead._id}/status`).set('Authorization', bearer()).send({ revision: lead.revision, status: 'CONTACTED', reason: 'Review the booking' }).expect(200));
    expect(await ConfirmedCustomerModel.findById(customerId).lean()).toMatchObject({ status: 'REVIEW_REQUIRED' });
    await request(app).post(`/api/v1/leads/${lead._id}/assignments`).set('Authorization', bearer()).send({ revision: lead.revision, assignedTo: sex2.id, reason: 'New account owner' }).expect(200);
    await request(app).get(`/api/v1/sales-customers/${customerId}`).set('Authorization', bearer(sex.token)).expect(404);
    expect(data<Record<string, unknown>>(await request(app).get(`/api/v1/sales-customers/${customerId}`).set('Authorization', bearer(sex2.token)).expect(200))).toMatchObject({ assignedTo: sex2.id });
    lead = data<Lead>(await request(app).get(`/api/v1/leads/${lead._id}`).set('Authorization', bearer()).expect(200));
    await LeadModel.updateOne({ _id: lead._id }, { $set: { status: 'QUOTATION_SENT' } });
    await request(app).patch(`/api/v1/leads/${lead._id}/status`).set('Authorization', bearer()).send({ revision: lead.revision, status: 'CONVERTED', reason: 'Booking reconfirmed' }).expect(200);
    expect(await ConfirmedCustomerModel.countDocuments()).toBe(1);
    expect(await ConfirmedCustomerModel.findById(customerId).lean()).toMatchObject({ status: 'CONFIRMED', firstConvertedAt: stored.firstConvertedAt });
  });
  it('rolls back both customer and lead on confirmation failure, and backfills existing converted leads idempotently', async () => {
    const lead = await createLead({ assignedTo: sex.id });
    await LeadModel.updateOne({ _id: lead._id }, { $set: { status: 'QUOTATION_SENT' } });
    const spy = vi.spyOn(ActivityLogModel, 'create').mockRejectedValueOnce(new Error('Audit unavailable'));
    try { await request(app).patch(`/api/v1/leads/${lead._id}/status`).set('Authorization', bearer()).send({ revision: 0, status: 'CONVERTED', reason: 'Atomic confirmation' }).expect(500); } finally { spy.mockRestore(); }
    expect(await ConfirmedCustomerModel.countDocuments()).toBe(0);
    expect(await LeadModel.findById(lead._id).lean()).toMatchObject({ status: 'QUOTATION_SENT', revision: 0 });
    await LeadModel.updateOne({ _id: lead._id }, { $set: { status: 'CONVERTED' } });
    expect(await backfillConfirmedCustomers()).toBe(1);
    expect(await backfillConfirmedCustomers()).toBe(0);
    expect(await ConfirmedCustomerModel.countDocuments()).toBe(1);
  });
  it('recovers missing lead setup through the idempotent commercial migration without creating partial leads', async () => {
    // This suite connects only to its isolated MongoMemoryReplSet database.
    const workflows = await WorkflowModel.find().lean();
    await WorkflowModel.collection.deleteMany({});
    try {
      const rejected = await request(app).post('/api/v1/leads').set('Authorization', bearer()).send(leadInput()).expect(503);
      expect(rejected.body).toHaveProperty('error.code', 'COMMERCIAL_NOT_INITIALIZED');
      expect(await LeadModel.countDocuments()).toBe(0);
      await createCommercialIndexes();
      expect(await WorkflowModel.countDocuments({ version: 1 })).toBe(1);
      const created = await createLead({ assignedTo: null, nextFollowUpAt: null });
      expect(created.workflowVersion).toBe(1);
      expect(created.estimatedProjectValue).toBe('275000.00');
      await createCommercialIndexes();
      expect(await WorkflowModel.countDocuments({ version: 1 })).toBe(1);
    } finally {
      await WorkflowModel.collection.deleteMany({});
      if (workflows.length) await WorkflowModel.collection.insertMany(workflows);
    }
  });
  it('computes server values exactly and permits eligible self creation without forged assignees', async () => {
    const lead = await createLead({ assignedTo: sex.id }, sex.token); expect(lead.estimatedProjectValue).toBe('275000.00');
    await request(app).post('/api/v1/leads').set('Authorization', bearer(sex.token)).send(leadInput({ assignedTo: sex2.id })).expect(403);
    for (const fields of [{ status: 'CONVERTED' }, { createdBy: rootId }, { estimatedProjectValue: '1.00' }, { requiredCapacityKw: -1 }, { ratePerKw: '1.123' }]) await request(app).post('/api/v1/leads').set('Authorization', bearer()).send(leadInput(fields)).expect(400);
    await request(app).get(`/api/v1/leads/${lead._id}`).set('Authorization', bearer(other.token)).expect(404);
  });
  it('reassigns current canonical assignee only, preserving attribution/history and rejecting races', async () => {
    const lead = await createLead({ assignedTo: sex.id });
    const results = await Promise.all([sex2.id, sex.id].map((assignedTo) => request(app).post(`/api/v1/leads/${lead._id}/assignments`).set('Authorization', bearer(bh.token)).send({ revision: 0, assignedTo, reason: 'Assignment concurrency' })));
    expect(results.map((response) => response.status).sort()).toEqual([200, 409]);
    const updated = data<Lead>(await request(app).get(`/api/v1/leads/${lead._id}`).set('Authorization', bearer()).expect(200)); expect(updated.salesExecutiveId).toBe(sex.id);
    expect(await AssignmentModel.countDocuments({ entityId: lead._id, entityType: 'LEAD' })).toBe(2);
    await request(app).post(`/api/v1/leads/${lead._id}/assignments`).set('Authorization', bearer(mh.token)).send({ revision: 1, assignedTo: sex2.id, reason: 'Branch-head ancestor manages this branch' }).expect(200);
    await request(app).post(`/api/v1/leads/${lead._id}/assignments`).set('Authorization', bearer()).send({ revision: 2, assignedTo: other.id, reason: 'Other branch' }).expect(400);
  });
  it('applies filters before pagination and does not authorize old attribution as a current assignment', async () => {
    const lead = await createLead({ assignedTo: sex.id }); await createLead({ assignedTo: other.id, branchId: foreignBranch });
    await request(app).post(`/api/v1/leads/${lead._id}/assignments`).set('Authorization', bearer()).send({ revision: 0, assignedTo: sex2.id, reason: 'New owner' }).expect(200);
    await request(app).get(`/api/v1/leads/${lead._id}`).set('Authorization', bearer(sex.token)).expect(404);
    const response = await request(app).get('/api/v1/leads?limit=1').set('Authorization', bearer(bh.token)).expect(200); expect(response.body).toHaveProperty('meta.total', 1);
    for (const query of ['limit=101', 'sortBy=passwordHash', 'branchId=bad', 'status=HACKED']) await request(app).get(`/api/v1/leads?${query}`).set('Authorization', bearer()).expect(400);
  });
  it('accepts/rejects proposals with current source/destination checks and invalidates stale revisions', async () => {
    const customer = await interested(); const lead = data<Lead>(await request(app).post(`/api/v1/customers/${customer._id}/convert`).set('Authorization', bearer(tc.token)).set('Idempotency-Key', 'proposal-conversion-key').send({ revision: 1, requirements }).expect(200));
    await request(app).post(`/api/v1/leads/${lead._id}/assignment-proposals`).set('Authorization', bearer(tc.token)).send({ revision: 0, assignedTo: sex.id, reason: 'Telecaller cannot select an executive' }).expect(403);
    const proposal = data<{ _id: string }>(await request(app).post(`/api/v1/leads/${lead._id}/assignment-proposals`).set('Authorization', bearer()).send({ revision: 0, assignedTo: sex.id, reason: 'Suggested site visitor' }).expect(201));
    await request(app).patch(`/lead-assignment-proposals/${proposal._id}`).set('Authorization', bearer()).send({ status: 'APPROVED', reason: 'Wrong route' }).expect(404);
    await request(app).patch(`/api/v1/lead-assignment-proposals/${proposal._id}`).set('Authorization', bearer(tc.token)).send({ status: 'APPROVED', reason: 'Self approval denied' }).expect(403);
    await request(app).patch(`/api/v1/lead-assignment-proposals/${proposal._id}`).set('Authorization', bearer(bh.token)).send({ status: 'APPROVED', reason: 'Manager approved visitor' }).expect(200);
    const stale = data<{ _id: string }>(await request(app).post(`/api/v1/leads/${lead._id}/assignment-proposals`).set('Authorization', bearer()).send({ revision: 1, assignedTo: sex2.id, reason: 'Suggested replacement' }).expect(201));
    await request(app).patch(`/api/v1/leads/${lead._id}`).set('Authorization', bearer(sex.token)).send({ revision: 1, remarks: 'Updated requirements' }).expect(200);
    await request(app).patch(`/api/v1/lead-assignment-proposals/${stale._id}`).set('Authorization', bearer(bh.token)).send({ status: 'APPROVED', reason: 'Stale request' }).expect(409);
    await request(app).patch(`/api/v1/lead-assignment-proposals/${stale._id}`).set('Authorization', bearer(bh.token)).send({ status: 'REJECTED', reason: 'Lead changed since proposal' }).expect(200);
  });
  it('enforces workflow edges, hold/resume, terminal reopen grant and immutable status history', async () => {
    let lead = await createLead({ assignedTo: sex.id });
    const transition = async (status: string, token = md, expected = 200) => {
      const response = await request(app).patch(`/api/v1/leads/${lead._id}/status`).set('Authorization', bearer(token)).send({ revision: lead.revision, status, reason: 'Verified transition reason' }).expect(expected);
      if (expected === 200) lead = data<Lead>(response);
    };
    await transition('CONVERTED', md, 400); await transition('CONTACTED'); await transition('ON_HOLD'); await transition('QUALIFIED', md, 400); await transition('CONTACTED');
    await transition('NOT_INTERESTED'); await transition('CONTACTED', sex.token, 403); await transition('CONTACTED', md);
    for (const status of ['INTERESTED', 'QUALIFIED', 'SITE_VISIT_SCHEDULED', 'SITE_VISITED', 'QUOTATION_SENT', 'CONVERTED']) await transition(status);
    expect(await LeadEventModel.findOne({ leadId: lead._id, toStatus: 'CONVERTED' }).lean()).toHaveProperty('valueAtConversion');
    await expect(LeadEventModel.updateOne({ leadId: lead._id }, { $set: { reason: 'tampered' } })).rejects.toThrow('append-only');
    await expect(AssignmentModel.deleteMany({ entityId: lead._id })).rejects.toThrow('append-only');
    await request(app).patch(`/api/v1/leads/${lead._id}`).set('Authorization', bearer()).send({ revision: lead.revision, ratePerKw: '1.00' }).expect(409);
  });
  it('lets the assigned executive skip and revisit stages while preserving assignment scope, conversion and terminal reopen controls', async () => {
    let lead = await createLead({ assignedTo: sex.id });
    await request(app).patch(`/api/v1/leads/${lead._id}/status`).set('Authorization', bearer(sex2.token)).send({ revision: 0, status: 'QUALIFIED', reason: 'Not the assigned executive' }).expect(404);
    for (const status of ['SITE_VISITED', 'CONTACTED', 'NEW', 'ON_HOLD', 'QUALIFIED', 'CONVERTED']) {
      lead = data<Lead>(await request(app).patch(`/api/v1/leads/${lead._id}/status`).set('Authorization', bearer(sex.token)).send({ revision: lead.revision, status, reason: 'Assigned executive chooses the actual sales stage' }).expect(200));
      expect(lead.status).toBe(status);
    }
    expect(await ConfirmedCustomerModel.countDocuments({ leadId: lead._id })).toBe(1);
    await request(app).patch(`/api/v1/leads/${lead._id}/status`).set('Authorization', bearer(sex.token)).send({ revision: lead.revision, status: 'NEW', reason: 'Finalized leads require reopen authority' }).expect(403);
    expect(await LeadEventModel.countDocuments({ leadId: lead._id })).toBe(7);
  });
  it('exposes executable statuses to the assigned executive, with workflow restrictions for supervisors and scoped terminal reopen', async () => {
    let lead = await createLead({ assignedTo: sex.id });
    const options = async (token = sex.token) => data<{ currentStatus: string; revision: number; allowedStatuses: string[] }>(await request(app).get(`/api/v1/leads/${lead._id}/status-options`).set('Authorization', bearer(token)).expect(200));
    await request(app).get(`/api/v1/leads/${lead._id}/status-options`).expect(401);
    await request(app).get(`/api/v1/leads/${lead._id}/status-options`).set('Authorization', bearer(other.token)).expect(404);
    await request(app).get(`/api/v1/leads/${lead._id}/status-options`).set('Authorization', bearer(tc.token)).expect(403);
    const initial = await options();
    expect(initial).toMatchObject({ currentStatus: 'NEW', revision: 0 });
    expect(initial.allowedStatuses).toContain('CONTACTED');
    expect(initial.allowedStatuses).toContain('CONVERTED'); expect(initial.allowedStatuses).not.toContain('NEW');
    const change = async (status: string) => { lead = data<Lead>(await request(app).patch(`/api/v1/leads/${lead._id}/status`).set('Authorization', bearer(sex.token)).send({ revision: lead.revision, status, reason: 'Allowed next status regression' }).expect(200)); };
    await change('CONTACTED');
    expect((await options()).allowedStatuses).toContain('INTERESTED');
    await change('ON_HOLD');
    expect((await options()).allowedStatuses).toContain('QUALIFIED');
    expect((await options(md)).allowedStatuses).toEqual(['CONTACTED']);
    await change('CONTACTED'); await change('NOT_INTERESTED');
    expect((await options()).allowedStatuses).toEqual([]);
    expect((await options(md)).allowedStatuses).toEqual(['CONTACTED']);
    const unassigned = await createLead({ assignedTo: null });
    await LeadModel.updateOne({ _id: unassigned._id }, { $set: { status: 'QUOTATION_SENT' } });
    const unassignedOptions = data<{ allowedStatuses: string[] }>(await request(app).get(`/api/v1/leads/${unassigned._id}/status-options`).set('Authorization', bearer()).expect(200));
    expect(unassignedOptions.allowedStatuses).not.toContain('CONVERTED');
  });
  it('versions workflows without rewriting existing leads and restricts settings/reference writes', async () => {
    const lead = await createLead({ assignedTo: sex.id });
    const current = data<{ version: number }>(await request(app).get('/api/v1/lead-workflows').set('Authorization', bearer()).expect(200));
    await request(app).post('/api/v1/lead-workflows').set('Authorization', bearer(bh.token)).send({ expectedVersion: current.version, transitions: defaultTransitions }).expect(403);
    await request(app).post('/api/v1/lead-workflows').set('Authorization', bearer()).send({ expectedVersion: current.version, transitions: [{ from: 'CONVERTED', to: 'NEW' }] }).expect(400);
    await request(app).post('/api/v1/lead-workflows').set('Authorization', bearer()).send({ expectedVersion: current.version, transitions: [{ from: 'NEW', to: 'LOST' }] }).expect(201);
    const newer = await createLead();
    expect(newer.workflowVersion).toBe(current.version + 1); expect((await LeadModel.findById(lead._id).lean())?.workflowVersion).toBe(current.version);
    const oldOptions = data<{ workflowVersion: number; allowedStatuses: string[] }>(await request(app).get(`/api/v1/leads/${lead._id}/status-options`).set('Authorization', bearer()).expect(200));
    expect(oldOptions.workflowVersion).toBe(current.version); expect(oldOptions.allowedStatuses).toContain('CONTACTED');
    const newOptions = data<{ allowedStatuses: string[] }>(await request(app).get(`/api/v1/leads/${newer._id}/status-options`).set('Authorization', bearer()).expect(200));
    expect(newOptions.allowedStatuses).toEqual(['LOST']);
    await request(app).patch(`/api/v1/leads/${lead._id}/status`).set('Authorization', bearer(sex.token)).send({ revision: 0, status: 'CONTACTED', reason: 'Pinned workflow remains valid' }).expect(200);
    await request(app).post('/api/v1/reference-values').set('Authorization', bearer(tc.token)).send({ category: 'PAYMENT_MODE', code: 'OTHER', label: 'Other' }).expect(403);
  });
});

describe('private authorized lead exports', () => {
  it('exports escaped formulas, calculates values and rechecks download access after permission changes', async () => {
    await createLead({ customerName: '=HYPERLINK("evil")', remarks: '@formula' });
    const job = data<{ _id: string }>(await request(app).post('/api/v1/leads/exports').set('Authorization', bearer()).send({}).expect(202));
    expect(await exports.runOne()).toBe(true); const result = await LeadExportModel.findById(job._id).lean(); expect(result?.status).toBe('COMPLETED');
    const file = await FileModel.findById(result?.fileId).select('+objectKey +versionId').lean(); if (!file) throw new Error('Export file missing');
    const body = blobs.get(file.objectKey)?.toString('utf8') ?? ''; expect(body).toContain('"\'=HYPERLINK('); expect(body).toContain('"\'@formula"'); expect(body).toContain('275000.00');
    await request(app).get(`/api/v1/leads/exports/${job._id}/download`).set('Authorization', bearer()).expect(200);
    await request(app).get(`/api/v1/leads/exports/${job._id}/download`).set('Authorization', bearer(tc.token)).expect(403);
    const role = await RoleModel.findOne({ code: 'MD' }).lean(); const permission = await PermissionModel.findOne({ code: 'leads:read' }).lean(); if (!role || !permission) throw new Error('Missing permissions');
    await RoleModel.updateOne({ _id: role._id }, { $pull: { permissions: { permissionId: permission._id } } });
    try { await request(app).get(`/api/v1/leads/exports/${job._id}/download`).set('Authorization', bearer()).expect(403); } finally { await RoleModel.updateOne({ _id: role._id }, { $set: { permissions: role.permissions } }); }
  });
  it('initialization preserves customized settings, workflow versions and role grants', async () => {
    const before = await RoleModel.findOne({ code: 'TC' }).lean(); await createCommercialIndexes();
    const after = await RoleModel.findOne({ code: 'TC' }).lean(); expect(after?.permissions).toEqual(before?.permissions);
    expect((await request(app).get('/api/v1/lead-workflows').set('Authorization', bearer()).expect(200)).body).toHaveProperty('data.version', 2);
  });
  it('explicit capability rollout adds only missing defaults, audits the change and increments role revision for policy reapproval', async () => {
    expect(await enableDefaultCommercialCapabilities()).toBe(0);
    const role = await RoleModel.findOne({ code: 'TC' }).lean(); const permission = await PermissionModel.findOne({ code: 'customers:receive_assignment' }).lean();
    if (!role || !permission) throw new Error('Missing role fixture');
    await RoleModel.updateOne({ _id: role._id }, { $pull: { permissions: { permissionId: permission._id } } });
    expect(await enableDefaultCommercialCapabilities()).toBe(1); expect(await enableDefaultCommercialCapabilities()).toBe(0);
    expect((await RoleModel.findById(role._id).lean())?.revision).toBe(role.revision + 1);
    expect(await ActivityLogModel.countDocuments({ action: 'COMMERCIAL_CAPABILITIES_ENABLED', entityId: role._id })).toBe(1);
  });
});
