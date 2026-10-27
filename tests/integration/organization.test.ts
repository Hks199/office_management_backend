import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Response } from 'supertest';
import { Types, trusted } from 'mongoose';
import { testApp, testConfig } from '../helpers.js';
import { connectDatabase, disconnectDatabase } from '../../src/config/database.js';
import { createLogger } from '../../src/config/logger.js';
import { createIdentityIndexes } from '../../src/modules/auth/identity-indexes.js';
import { createOrganizationIndexes } from '../../src/modules/hierarchy/organization-indexes.js';
import { bootstrapMd } from '../../src/modules/auth/bootstrap.service.js';
import { AuthService } from '../../src/modules/auth/auth.service.js';
import { CredentialDeliveryModel } from '../../src/modules/auth/credential-delivery.model.js';
import { LoginAttemptModel, CredentialTokenModel } from '../../src/modules/auth/auth.models.js';
import { ActivityLogModel } from '../../src/modules/activity-logs/activity-log.model.js';
import { UserModel } from '../../src/modules/users/user.model.js';
import { RoleModel } from '../../src/modules/roles/role.model.js';
import { RolePolicyModel } from '../../src/modules/roles/role-policy.model.js';
import { BranchModel } from '../../src/modules/branches/branch.model.js';
import { StateModel, DistrictModel, BlockModel } from '../../src/modules/locations/location.model.js';
import { seedLocations } from '../../src/modules/locations/location-seed.service.js';
import { decryptSecret } from '../../src/shared/utils/crypto.js';
import { UserService } from '../../src/modules/users/user.service.js';
import type { EmployeeCreate } from '../../src/modules/users/user.types.js';
import { CustomerModel } from '../../src/modules/leads/commercial.models.js';
import { EmployeePanelModel } from '../../src/modules/auth/employee-panel.model.js';
import { PermissionModel } from '../../src/modules/permissions/permission.model.js';
import { EmployeePanelService } from '../../src/modules/auth/employee-panel.service.js';

const config = testConfig({ rateLimitMax: 10000 }); const app = testApp({ rateLimitMax: 10000 });
const password = 'Organization test password 2026!'; const authService = new AuthService(config);
let replica: MongoMemoryReplSet | undefined; let rootId: string; let rootToken: string; let sequence = 0;
const roles = new Map<string, string>();
interface Employee { _id: string; revision: number; roleId: string; branchId: string | null; reportingManagerId: string | null; email: string; employeeCode: string }
interface Branch { _id: string; revision: number; branchHeadId: string | null; isActive: boolean }
interface Location { _id: string; revision: number }
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- Assert a known API response shape at the test boundary.
const data = <T>(res: Response): T => (res.body as { data: T }).data;
const bearer = (token = rootToken) => `Bearer ${token}`;
let branchA: Branch; let branchB: Branch; let branchC: Branch; let state: Location; let district: Location; let block: Location;
let bdo: Employee; let mh: Employee; let head: Employee; let headB: Employee; let sex: Employee; let tc: Employee; let peer: Employee;
let bdoToken: string; let headToken: string; let sexToken: string; let tcToken: string;

function employeeInput(role: string, manager: string, branch: string | null): EmployeeCreate {
  sequence++; return { employeeCode: `ORG-${String(sequence).padStart(4, '0')}`, firstName: 'Fixture', lastName: `Person${String(sequence)}`,
    email: `org${String(sequence)}@example.invalid`, mobileNumber: `+91888${String(sequence).padStart(7, '0')}`,
    roleId: roles.get(role) ?? role, reportingManagerId: manager, branchId: branch, dateOfJoining: '2026-10-17T00:00:00Z' };
}
async function createEmployee(role: string, manager: string, branch: string | null, token = rootToken): Promise<Employee> {
  return data<Employee>(await request(app).post('/api/v1/employees').set('Authorization', bearer(token)).send(employeeInput(role, manager, branch)).expect(201));
}
async function signIn(employee: Employee): Promise<string> {
  const job = await CredentialDeliveryModel.findOne({ userId: employee._id }).select('+encryptedToken').lean();
  if (!job) throw new Error('Invitation fixture missing');
  await authService.resetPassword(decryptSecret(job.encryptedToken, config.tokenEncryptionKey), password, 'INVITATION', { requestId: 'fixture-setup' });
  return (await authService.login(employee.email, password, { requestId: 'fixture-login' })).accessToken;
}
async function createBranch(code: string): Promise<Branch> {
  return data<Branch>(await request(app).post('/api/v1/branches').set('Authorization', bearer()).send({ branchCode: code,
    branchName: `Fixture ${code}`, address: 'Test-only branch address', contactNumber: '+919000000000',
    stateId: state._id, districtId: district._id, blockId: block._id }).expect(201));
}
async function customRole(code: string, grants: { permissionId: string; scope: string }[] = []): Promise<string> {
  return data<{ _id: string }>(await request(app).post('/api/v1/roles').set('Authorization', bearer()).send({
    name: `Fixture ${code}`, code, permissions: grants }).expect(201))._id;
}
async function createPolicy(creator: string, target: string, managers: string[], cross = false) {
  return data<{ _id: string; revision: number }>(await request(app).post('/api/v1/role-creation-policies').set('Authorization', bearer()).send({
    creatorRoleId: creator, targetRoleId: target, allowedManagerRoleIds: managers, branchRule: 'EXPLICIT_SCOPE', allowCrossBranchReporting: cross,
  }).expect(201));
}

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await connectDatabase({ ...config, mongodbUri: replica.getUri('organization') }, createLogger(config));
  await createIdentityIndexes(); await createOrganizationIndexes();
  const id = await bootstrapMd({ employeeCode: 'ORG-MD', firstName: 'Test', lastName: 'Director', email: 'org-md@example.invalid', mobileNumber: '+919999999999' }, config.tokenEncryptionKey);
  rootId = id.toHexString();
  rootToken = await signIn({ _id: rootId, email: 'org-md@example.invalid' } as Employee);
  for (const role of await RoleModel.find().lean()) roles.set(role.code, role._id.toHexString());
  state = data<Location>(await request(app).post('/api/v1/locations/states').set('Authorization', bearer()).send({ code: 'TST', name: 'Synthetic test state' }).expect(201));
  district = data<Location>(await request(app).post('/api/v1/locations/districts').set('Authorization', bearer()).send({ code: 'D1', name: 'Synthetic test district', stateId: state._id }).expect(201));
  block = data<Location>(await request(app).post('/api/v1/locations/blocks').set('Authorization', bearer()).send({ code: 'B1', name: 'Synthetic test block', districtId: district._id, kind: 'BLOCK' }).expect(201));
  branchA = await createBranch('BR-A'); branchB = await createBranch('BR-B'); branchC = await createBranch('BR-C');
  bdo = await createEmployee('BDO', rootId, null);
  mh = await createEmployee('MH', bdo._id, branchA._id); head = await createEmployee('BH', mh._id, branchA._id);
  const mhB = await createEmployee('MH', rootId, branchB._id); headB = await createEmployee('BH', mhB._id, branchB._id);
  sex = await createEmployee('SEX', head._id, branchA._id); tc = await createEmployee('TC', head._id, branchA._id);
  peer = await createEmployee('SEX', rootId, branchA._id);
  bdoToken = await signIn(bdo); headToken = await signIn(head); sexToken = await signIn(sex); tcToken = await signIn(tc);
}, 180000);
beforeEach(async () => { await LoginAttemptModel.deleteMany({}); });
afterAll(async () => { await disconnectDatabase(); await replica?.stop(); });

describe('delegated employee panels', () => {
  const start = async (employeeId: string, token = rootToken) => data<{ panelToken: string; expiresAt: string }>(await request(app)
    .post('/api/v1/auth/employee-panels/start').set('Authorization', bearer(token)).send({ employeeId }).expect(200));

  it('opens a downline panel, performs normal work with the real manager audited, and returns without replacing login cookies', async () => {
    const response = await request(app).post('/api/v1/auth/employee-panels/start').set('Authorization', bearer())
      .send({ employeeId: head._id }).expect(200);
    const panel = data<{ panelToken: string; expiresAt: string }>(response);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(panel).not.toHaveProperty('accessToken');
    expect(new Date(panel.expiresAt).getTime()).toBeLessThanOrEqual(Date.now() + 30 * 60000);
    const me = data<{ id: string; employeePanel: { managerName: string }; grants: { permission: string }[] }>(await request(app)
      .get('/api/v1/auth/me').set('Authorization', bearer()).set('X-Employee-Panel', panel.panelToken).expect(200));
    expect(me.id).toBe(head._id); expect(me.employeePanel.managerName).toBe('Test Director');
    expect(me.grants.some((grant) => ['attendance:create', 'users:open_panel'].includes(grant.permission))).toBe(false);
    const current = await UserModel.findById(sex._id).orFail().lean();
    await request(app).patch(`/api/v1/employees/${sex._id}`).set('Authorization', bearer()).set('X-Employee-Panel', panel.panelToken)
      .send({ revision: current.revision, designation: 'Delegated profile update' }).expect(200);
    const log = await ActivityLogModel.findOne({ action: 'EMPLOYEE_UPDATED', entityId: sex._id }).sort({ createdAt: -1 }).orFail().lean();
    expect(log.actorId?.toHexString()).toBe(rootId);
    expect(log.metadata.actingAsEmployeeId).toBe(head._id);
    await UserModel.updateOne({ _id: sex._id }, { $set: { revision: current.revision }, $unset: { designation: '' } });
    await request(app).post('/api/v1/auth/employee-panels/stop').set('Authorization', bearer()).set('X-Employee-Panel', panel.panelToken).expect(200);
    await request(app).get('/api/v1/auth/me').set('Authorization', bearer()).set('X-Employee-Panel', panel.panelToken).expect(403);
    expect(data<{ id: string }>(await request(app).get('/api/v1/auth/me').set('Authorization', bearer()).expect(200)).id).toBe(rootId);
  }, 30000);

  it('blocks peers, ancestors, self, ordinary staff, nested panels, attendance and account-security changes', async () => {
    for (const employeeId of [rootId, head._id, peer._id, headB._id]) {
      await request(app).post('/api/v1/auth/employee-panels/start').set('Authorization', bearer(headToken)).send({ employeeId }).expect(403);
    }
    await request(app).post('/api/v1/auth/employee-panels/start').set('Authorization', bearer(sexToken)).send({ employeeId: tc._id }).expect(403);
    const panel = await start(sex._id, headToken);
    for (const path of ['/auth/change-password', '/auth/logout-all', '/attendance/check-in', '/attendance/check-out', '/files/upload-intents']) {
      await request(app).post(`/api/v1${path}`).set('Authorization', bearer(headToken)).set('X-Employee-Panel', panel.panelToken).send({}).expect(403);
    }
    await request(app).post('/api/v1/auth/employee-panels/start').set('Authorization', bearer(headToken))
      .set('X-Employee-Panel', panel.panelToken).send({ employeeId: tc._id }).expect(403);
    await request(app).get(`/api/v1/employees/${rootId}`).set('Authorization', bearer(headToken)).set('X-Employee-Panel', panel.panelToken).expect(404);
  }, 30000);

  it('binds panel tokens to the manager and original login family, expires them and rejects tampering', async () => {
    const panel = await start(tc._id);
    await request(app).get('/api/v1/auth/me').set('Authorization', bearer(headToken)).set('X-Employee-Panel', panel.panelToken).expect(403);
    const otherLogin = await authService.login('org-md@example.invalid', password, { requestId: 'panel-new-family' });
    await request(app).get('/api/v1/auth/me').set('Authorization', bearer(otherLogin.accessToken)).set('X-Employee-Panel', panel.panelToken).expect(403);
    await request(app).get('/api/v1/auth/me').set('Authorization', bearer()).set('X-Employee-Panel', 'invalid').expect(403);
    await EmployeePanelModel.updateOne({ employeeId: tc._id, managerId: rootId, revokedAt: null }, { $set: { expiresAt: new Date(0) } });
    await request(app).get('/api/v1/auth/me').set('Authorization', bearer()).set('X-Employee-Panel', panel.panelToken).expect(403);
  }, 30000);

  it('revokes delegated access when a manager loses permission, and rechecks it inside business transactions', async () => {
    const panel = await start(head._id);
    const principal = await new EmployeePanelService().resolve(await authService.authenticate(rootToken), panel.panelToken);
    const role = await RoleModel.findById(roles.get('MD')).orFail().lean();
    const permission = await PermissionModel.findOne({ code: 'users:open_panel' }).orFail().lean();
    try {
      await RoleModel.updateOne({ _id: role._id }, { $set: { permissions: role.permissions.filter((grant) => !grant.permissionId.equals(permission._id)) } });
      await request(app).get('/api/v1/auth/me').set('Authorization', bearer()).set('X-Employee-Panel', panel.panelToken).expect(403);
      const employee = await UserModel.findById(sex._id).orFail().lean();
      await expect(new UserService(config).update(principal, new Types.ObjectId(sex._id), {
        revision: employee.revision, designation: 'Must not be written',
      }, { requestId: 'stale-panel-principal' })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
      expect((await UserModel.findById(sex._id).orFail().lean()).revision).toBe(employee.revision);
    } finally { await RoleModel.updateOne({ _id: role._id }, { $set: { permissions: role.permissions } }); }
  }, 30000);

  it('revokes panels when the reporting path disappears and when the original manager signs out', async () => {
    const manager = await createEmployee('BH', rootId, branchA._id); const managerToken = await signIn(manager);
    const employee = await createEmployee('SEX', manager._id, branchA._id);
    const panel = await start(employee._id, managerToken);
    await UserModel.updateOne({ _id: employee._id }, { $set: { reportingManagerId: rootId } });
    await request(app).get('/api/v1/auth/me').set('Authorization', bearer(managerToken)).set('X-Employee-Panel', panel.panelToken).expect(403);
    await UserModel.updateOne({ _id: employee._id }, { $set: { reportingManagerId: manager._id } });
    const fresh = await start(employee._id, managerToken);
    await authService.logoutAll(await authService.authenticate(managerToken), { requestId: 'manager-signout' });
    await request(app).get('/api/v1/auth/me').set('Authorization', bearer(managerToken)).set('X-Employee-Panel', fresh.panelToken).expect(401);
  }, 30000);
});

describe('employee creation policies and invitations', () => {
  it('shares a whole reporting subtree with all selected managers and revokes removed managers immediately', async () => {
    const first = await createEmployee('MH', rootId, null);
    const second = await createEmployee('MH', rootId, null);
    const outsider = await createEmployee('MH', rootId, null);
    const firstToken = await signIn(first); const secondToken = await signIn(second); const outsiderToken = await signIn(outsider);
    const input = employeeInput('BH', first._id, branchA._id);
    const shared = data<Employee & { reportingManagerIds: string[] }>(await request(app).post('/api/v1/employees')
      .set('Authorization', bearer()).send({ ...input, reportingManagerIds: [first._id, second._id] }).expect(201));
    expect(shared.reportingManagerIds).toEqual([first._id, second._id]);
    const child = await createEmployee('TC', shared._id, branchA._id);
    const contact = await CustomerModel.create({ customerName: 'Shared hierarchy contact', mobileNumber: '+918000111222',
      siteAddress: 'Synthetic test address', stateId: state._id, districtId: district._id, branchId: branchA._id,
      dedupeKey: `shared-${child._id}`, importId: new Types.ObjectId(), importRow: 1, createdBy: rootId,
      assignedTo: child._id, assignedBy: rootId, assignedAt: new Date() });
    for (const token of [firstToken, secondToken]) {
      await request(app).get(`/api/v1/employees/${child._id}`).set('Authorization', bearer(token)).expect(200);
      await request(app).get(`/api/v1/customers/${contact._id.toHexString()}`).set('Authorization', bearer(token)).expect(200);
      const tree = data<Employee[]>(await request(app).get('/api/v1/employees/downlines').set('Authorization', bearer(token)).expect(200));
      expect(tree.map((employee) => employee._id)).toEqual(expect.arrayContaining([shared._id, child._id]));
      expect(new Set(tree.map((employee) => employee._id)).size).toBe(tree.length);
    }
    await request(app).get(`/api/v1/employees/${child._id}`).set('Authorization', bearer(outsiderToken)).expect(404);
    await request(app).get(`/api/v1/customers/${contact._id.toHexString()}`).set('Authorization', bearer(outsiderToken)).expect(404);
    // Selecting a descendant through either manager edge must never create a cycle.
    await request(app).patch(`/api/v1/employees/${first._id}/manager`).set('Authorization', bearer())
      .send({ revision: first.revision, reportingManagerIds: [rootId, first._id], reason: 'Reject circular reporting' }).expect(409);
    // One invalid manager rejects the complete create, without creating a partial employee.
    const invalid = employeeInput('BH', first._id, branchA._id);
    await request(app).post('/api/v1/employees').set('Authorization', bearer())
      .send({ ...invalid, reportingManagerIds: [first._id, child._id] }).expect(403);
    expect(await UserModel.countDocuments({ employeeCode: invalid.employeeCode })).toBe(0);
    await request(app).patch(`/api/v1/employees/${shared._id}/manager`).set('Authorization', bearer())
      .send({ revision: shared.revision, reportingManagerIds: [first._id], reason: 'Remove secondary manager access' }).expect(200);
    await request(app).get(`/api/v1/employees/${child._id}`).set('Authorization', bearer(secondToken)).expect(404);
    await request(app).get(`/api/v1/customers/${contact._id.toHexString()}`).set('Authorization', bearer(secondToken)).expect(404);
    await request(app).get(`/api/v1/employees/${child._id}`).set('Authorization', bearer(firstToken)).expect(200);
    // Legacy clients can still supply a single manager.
    const restored = await request(app).patch(`/api/v1/employees/${shared._id}/manager`).set('Authorization', bearer())
      .send({ revision: shared.revision + 1, reportingManagerId: first._id, reason: 'Legacy manager update' }).expect(200);
    expect(data<{ reportingManagerIds: string[] }>(restored).reportingManagerIds).toEqual([first._id]);
  }, 30000);
  it('offers MD and BDO managers for MH creation and lets a BDO select their MD without granting administrator read access', async () => {
    const path = `/api/v1/employees/manager-options?roleId=${roles.get('MH') ?? ''}`;
    await request(app).get(path).expect(401);
    await request(app).get(path).set('Authorization', bearer(sexToken)).expect(403);
    await request(app).get('/api/v1/employees/manager-options').set('Authorization', bearer(bdoToken)).expect(400);
    await request(app).get(`${path}&limit=101`).set('Authorization', bearer(bdoToken)).expect(400);
    await request(app).get(`/api/v1/employees/manager-options?roleId=${roles.get('MD') ?? ''}`).set('Authorization', bearer(bdoToken)).expect(403);
    const options = data<{ _id: string; label: string }[]>(await request(app).get(path).set('Authorization', bearer(bdoToken)).expect(200));
    expect(options.map((manager) => manager._id).sort()).toEqual([rootId, bdo._id].sort());
    expect(options.find((manager) => manager._id === rootId)?.label).toContain('MD');
    expect(options.find((manager) => manager._id === bdo._id)?.label).toContain('BDO');
    for (const option of options) expect(Object.keys(option).sort()).toEqual(['_id', 'label']);
    const search = await request(app).get(`${path}&search=ORG-MD&limit=1`).set('Authorization', bearer(bdoToken)).expect(200);
    expect(data<{ _id: string }[]>(search).map((manager) => manager._id)).toEqual([rootId]);
    const created = await createEmployee('MH', rootId, null, bdoToken);
    expect(created.reportingManagerId).toBe(rootId);
    await request(app).get(`/api/v1/employees/${rootId}`).set('Authorization', bearer(bdoToken)).expect(404);
    await request(app).get(`/api/v1/employees/${created._id}`).set('Authorization', bearer(bdoToken)).expect(404);
    await request(app).get(`/api/v1/employees/${created._id}`).set('Authorization', bearer()).expect(200);
    await request(app).post('/api/v1/employees').set('Authorization', bearer(bdoToken))
      .send(employeeInput('MH', head._id, null)).expect(403);
    await request(app).post('/api/v1/employees').set('Authorization', bearer(bdoToken))
      .send(employeeInput('SEX', rootId, branchA._id)).expect(403);
  });
  it('allows MD, BDO and MH to have no branch while physical branch roles still require one', async () => {
    for (const code of ['MD', 'BDO', 'MH']) {
      expect((await RoleModel.findOne({ code }).lean())?.allowsNoBranch).toBe(true);
    }
    const mdCreated = await createEmployee('MH', rootId, null);
    expect(mdCreated.branchId).toBeNull();
    const bdoCreated = await createEmployee('MH', bdo._id, null, bdoToken);
    expect(bdoCreated.branchId).toBeNull();
    const options = data<{ code: string; allowsNoBranch: boolean }[]>(await request(app)
      .get('/api/v1/employees/role-options').set('Authorization', bearer(bdoToken)).expect(200));
    expect(options.find((option) => option.code === 'MH')?.allowsNoBranch).toBe(true);
    for (const code of ['BH', 'SEX', 'TC']) {
      expect((await RoleModel.findOne({ code }).lean())?.allowsNoBranch).toBe(false);
      await request(app).post('/api/v1/employees').set('Authorization', bearer())
        .send(employeeInput(code, rootId, null)).expect(400);
    }
  });
  it('offers only approved role labels to creators without role-administration access', async () => {
    const path = '/api/v1/employees/role-options';
    await request(app).get(path).expect(401);
    await request(app).get(path).set('Authorization', bearer(sexToken)).expect(403);
    await request(app).get('/api/v1/roles').set('Authorization', bearer(headToken)).expect(403);
    const response = await request(app).get(path).set('Authorization', bearer(headToken)).expect(200);
    const options = data<{ _id: string; code: string }[]>(response);
    expect(options.map((role) => role.code).sort()).toEqual(['SEX', 'TC']);
    for (const option of options) expect(Object.keys(option).sort()).toEqual(['_id', 'allowsNoBranch', 'code', 'name']);
    const search = await request(app).get(`${path}?search=tc&limit=1`).set('Authorization', bearer(headToken)).expect(200);
    expect(data<{ code: string }[]>(search)).toEqual([expect.objectContaining({ code: 'TC' })]);
    await request(app).get(`${path}?limit=101`).set('Authorization', bearer(headToken)).expect(400);
    await request(app).get(`${path}?creatorRoleId=${roles.get('MD') ?? ''}`).set('Authorization', bearer(headToken)).expect(400);
    await request(app).get(`${path}/assignment`).set('Authorization', bearer(headToken)).expect(403);
    await request(app).get(`${path}/assignment`).set('Authorization', bearer()).expect(200);
  });
  it('omits stale or inactive creation policies and unapproved custom roles from the lookup', async () => {
    const roleId = await customRole('LOOKUP_ONLY');
    const path = '/api/v1/employees/role-options?search=LOOKUP_ONLY';
    const lookup = async () => data<{ _id: string }[]>(await request(app).get(path).set('Authorization', bearer()).expect(200));
    expect(await lookup()).toEqual([]);
    const policy = await createPolicy(roles.get('MD') ?? '', roleId, [roles.get('MD') ?? '']);
    expect(await lookup()).toEqual([expect.objectContaining({ _id: roleId })]);
    await RoleModel.updateOne({ _id: roleId }, { $inc: { revision: 1 } });
    expect(await lookup()).toEqual([]);
    const staleResponse = await request(app).get(path).set('Authorization', bearer()).expect(200);
    expect((staleResponse.body as { meta: { policyReviewRequired: boolean } }).meta.policyReviewRequired).toBe(true);
    await RolePolicyModel.updateOne({ _id: policy._id }, { $set: { targetRoleRevision: 1, isActive: false } });
    expect(await lookup()).toEqual([]);
  });
  it('requires authentication and rejects public or self registration', async () => {
    await request(app).post('/api/v1/employees').send(employeeInput('SEX', head._id, branchA._id)).expect(401);
    await request(app).post('/api/v1/employees').set('Authorization', bearer(sexToken)).send(employeeInput('SEX', head._id, branchA._id)).expect(403);
    await request(app).post('/api/v1/auth/register').send({}).expect(404);
  });
  it('allows BH approved subordinate creation and returns only safe profile fields', async () => {
    const employee = await createEmployee('TC', head._id, branchA._id, headToken);
    const stored = await UserModel.findById(employee._id).select('+passwordHash').lean();
    expect(stored?.passwordHash).toBeUndefined();
    expect(await CredentialTokenModel.countDocuments({ userId: employee._id, purpose: 'INVITATION' })).toBe(1);
    const response = await request(app).get(`/api/v1/employees/${employee._id}`).set('Authorization', bearer()).expect(200);
    for (const secret of ['passwordHash', 'bootstrapKey', 'authVersion', 'authFence', 'encryptedToken']) expect(response.text).not.toContain(secret);
    expect(await ActivityLogModel.countDocuments({ action: 'EMPLOYEE_CREATED', entityId: employee._id })).toBe(1);
  });
  it('allows BDO to create approved MH templates inside an existing authorized branch', async () => {
    await createEmployee('MH', bdo._id, branchA._id, bdoToken);
  });
  it('denies higher roles, unrelated branches/managers, null required branches and forged fields', async () => {
    await request(app).post('/api/v1/employees').set('Authorization', bearer(headToken)).send(employeeInput('BDO', rootId, null)).expect(403);
    await request(app).post('/api/v1/employees').set('Authorization', bearer(headToken)).send(employeeInput('TC', headB._id, branchB._id)).expect(403);
    await request(app).post('/api/v1/employees').set('Authorization', bearer(headToken)).send(employeeInput('TC', head._id, branchC._id)).expect(403);
    await request(app).post('/api/v1/employees').set('Authorization', bearer()).send(employeeInput('SEX', rootId, null)).expect(400);
    await request(app).post('/api/v1/employees').set('Authorization', bearer()).send({ ...employeeInput('SEX', rootId, branchA._id), passwordHash: 'client-hash' }).expect(400);
    await request(app).post('/api/v1/employees').set('Authorization', bearer()).send({ ...employeeInput('SEX', rootId, branchA._id), reportingManagerId: null }).expect(400);
    await request(app).post('/api/v1/employees').set('Authorization', bearer()).send(employeeInput('MD', rootId, null)).expect(403);
    for (const dateOfJoining of ['2026-02-30', '2026-10-17T09:00:00']) {
      await request(app).post('/api/v1/employees').set('Authorization', bearer()).send({ ...employeeInput('SEX', rootId, branchA._id), dateOfJoining }).expect(400);
    }
  });
  it('prevents duplicate normalized identifiers without an orphan invitation', async () => {
    const input = employeeInput('SEX', head._id, branchA._id); input.email = sex.email.toUpperCase();
    const before = await CredentialDeliveryModel.countDocuments();
    await request(app).post('/api/v1/employees').set('Authorization', bearer()).send(input).expect(409);
    expect(await CredentialDeliveryModel.countDocuments()).toBe(before);
  });
  it('rejects inactive roles/managers and invalid reporting-role relationships', async () => {
    const former = await createEmployee('BH', mh._id, branchA._id);
    await request(app).patch(`/api/v1/employees/${former._id}/status`).set('Authorization', bearer())
      .send({ revision: 0, isActive: false, employmentStatus: 'EXITED', reason: 'Fixture termination' }).expect(200);
    await request(app).post('/api/v1/employees').set('Authorization', bearer()).send(employeeInput('SEX', former._id, branchA._id)).expect(400);
    await request(app).post('/api/v1/employees').set('Authorization', bearer()).send(employeeInput('SEX', tc._id, branchA._id)).expect(403);
    const inactiveRole = await customRole('INACTIVE_FIXTURE');
    await request(app).patch(`/api/v1/roles/${inactiveRole}`).set('Authorization', bearer()).send({ revision: 0, isActive: false }).expect(200);
    await request(app).post('/api/v1/employees').set('Authorization', bearer()).send(employeeInput(inactiveRole, rootId, branchA._id)).expect(400);
  });
  it('invalidates approved templates when permissions change until policy reapproval', async () => {
    const target = await customRole('REVIEW_TEMPLATE'); const mdRole = roles.get('MD'); if (!mdRole) throw new Error('No MD');
    const policy = await createPolicy(mdRole, target, [mdRole], true);
    await request(app).patch(`/api/v1/roles/${target}`).set('Authorization', bearer()).send({ revision: 0, name: 'Reviewed new template' }).expect(200);
    const input = employeeInput(target, rootId, branchA._id);
    const rejected = await request(app).post('/api/v1/employees').set('Authorization', bearer()).send(input).expect(409);
    expect(rejected.body).toHaveProperty('error.code', 'POLICY_REAPPROVAL_REQUIRED');
    await request(app).put(`/api/v1/role-creation-policies/${policy._id}`).set('Authorization', bearer()).send({
      revision: 0, creatorRoleId: mdRole, targetRoleId: target, allowedManagerRoleIds: [mdRole], allowCrossBranchReporting: true, branchRule: 'EXPLICIT_SCOPE',
    }).expect(200);
    await request(app).post('/api/v1/employees').set('Authorization', bearer()).send(input).expect(201);
  });
  it('requires sensitive delegation even if a subordinate policy names an administrative role', async () => {
    const definitions = await request(app).get('/api/v1/permissions').set('Authorization', bearer()).expect(200);
    const permission = data<{ _id: string; code: string }[]>(definitions).find((entry) => entry.code === 'roles:assign'); if (!permission) throw new Error('No permission');
    const role = await customRole('SENSITIVE_TEMPLATE', [{ permissionId: permission._id, scope: 'ALL' }]);
    const bhRole = roles.get('BH'); if (!bhRole) throw new Error('No BH'); await createPolicy(bhRole, role, [bhRole]);
    await request(app).post('/api/v1/employees').set('Authorization', bearer(headToken)).send(employeeInput(role, head._id, branchA._id)).expect(403);
  });
});

describe('scoped reads and hierarchy APIs', () => {
  it('returns minimal relationship labels on authorized employee reads without replacing IDs or granting parent-profile access', async () => {
    const response = await request(app).get(`/api/v1/employees/${sex._id}`).set('Authorization', bearer(sexToken)).expect(200);
    expect(data<Record<string, unknown>>(response)).toMatchObject({ roleId: roles.get('SEX'), roleName: 'Sales Executive', roleCode: 'SEX',
      branchId: branchA._id, branchName: 'Fixture BR-A', branchCode: 'BR-A', reportingManagerId: head._id,
      reportingManagerCode: head.employeeCode });
    expect(typeof data<Record<string, unknown>>(response).reportingManagerName).toBe('string');
    expect(response.text).not.toMatch(/passwordHash|authFence|bootstrapKey/);
    expect(data<Record<string, unknown>>(response)).not.toHaveProperty('reportingManager');
    await request(app).get('/api/v1/roles').set('Authorization', bearer(sexToken)).expect(403);
    await request(app).get(`/api/v1/employees/${head._id}`).set('Authorization', bearer(sexToken)).expect(404);
    const listed = data<Record<string, unknown>[]>(await request(app).get('/api/v1/employees').set('Authorization', bearer(sexToken)).expect(200));
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ _id: sex._id, roleName:'Sales Executive',branchName:'Fixture BR-A',reportingManagerCode:head.employeeCode });
    const tree = data<Record<string, unknown>[]>(await request(app).get(`/api/v1/employees/hierarchy?rootId=${head._id}`).set('Authorization', bearer(bdoToken)).expect(200));
    expect(tree.find((employee) => employee._id === sex._id)).toHaveProperty('reportingManagerCode',head.employeeCode);
    const root = data<Record<string, unknown>>(await request(app).get(`/api/v1/employees/${rootId}`).set('Authorization', bearer()).expect(200));
    expect(root).toMatchObject({ branchId:null,branchName:null,reportingManagerId:null,reportingManagerName:null });
  });
  it('lets a branch-less MH establish a team in active branches while retaining hierarchy, transfer and template restrictions', async () => {
    const fresh = await createEmployee('MH', rootId, null);
    const token = await signIn(fresh);
    const path = `/api/v1/employees/branch-options?roleId=${roles.get('BH') ?? ''}`;
    const options = data<{ _id: string }[]>(await request(app).get(path).set('Authorization', bearer(token)).expect(200));
    expect(options.map((branch) => branch._id).sort()).toEqual([branchA._id, branchB._id, branchC._id].sort());
    const managers = await request(app).get(`/api/v1/employees/manager-options?roleId=${roles.get('BH') ?? ''}`).set('Authorization', bearer(token)).expect(200);
    expect(data<{ _id: string }[]>(managers).map((manager) => manager._id)).toEqual([fresh._id]);
    const child = await createEmployee('BH', fresh._id, branchC._id, token);
    expect(child.branchId).toBe(branchC._id);
    await createEmployee('SEX', fresh._id, branchA._id, token);
    await createEmployee('TC', fresh._id, branchB._id, token);
    await request(app).get(`/api/v1/employees/${headB._id}`).set('Authorization', bearer(token)).expect(404);
    await request(app).post('/api/v1/employees').set('Authorization', bearer(token))
      .send(employeeInput('BH', rootId, branchC._id)).expect(403);
    await request(app).post('/api/v1/employees').set('Authorization', bearer(token))
      .send(employeeInput('BDO', fresh._id, null)).expect(403);
    await request(app).patch(`/api/v1/employees/${child._id}/branch`).set('Authorization', bearer(token))
      .send({ revision: 0, branchId: branchA._id, reportingManagerId: rootId, reason: 'Unrelated manager remains forbidden' }).expect(403);
    const bound = await createEmployee('MH', rootId, branchC._id);
    const boundToken = await signIn(bound);
    const restricted = await request(app).get(path).set('Authorization', bearer(boundToken)).expect(200);
    expect(data<{ _id: string }[]>(restricted).map((branch) => branch._id)).toEqual([branchC._id]);
    await request(app).post('/api/v1/employees').set('Authorization', bearer(boundToken))
      .send(employeeInput('BH', bound._id, branchB._id)).expect(403);
  });
  it('lets a company-wide BDO establish a team using minimal active branch options, without exposing unrelated employees', async () => {
    const fresh = await createEmployee('BDO', rootId, null);
    const token = await signIn(fresh);
    const path = `/api/v1/employees/branch-options?roleId=${roles.get('MH') ?? ''}`;
    await request(app).get(path).expect(401);
    await request(app).get(path).set('Authorization', bearer(sexToken)).expect(403);
    await request(app).get('/api/v1/employees/branch-options').set('Authorization', bearer(token)).expect(400);
    await request(app).get(`${path}&limit=101`).set('Authorization', bearer(token)).expect(400);
    await request(app).get(`${path}&creatorRoleId=${roles.get('MD') ?? ''}`).set('Authorization', bearer(token)).expect(400);
    await request(app).get(`/api/v1/employees/branch-options?roleId=${roles.get('MD') ?? ''}`).set('Authorization', bearer(token)).expect(403);
    const options = data<{ _id: string }[]>(await request(app).get(path).set('Authorization', bearer(token)).expect(200));
    expect(options.map((branch) => branch._id).sort()).toEqual([branchA._id, branchB._id, branchC._id].sort());
    for (const option of options) expect(Object.keys(option).sort()).toEqual(['_id', 'branchCode', 'branchName']);
    const search = await request(app).get(`${path}&search=BR-C&limit=1`).set('Authorization', bearer(token)).expect(200);
    expect(data<{ _id: string }[]>(search).map((branch) => branch._id)).toEqual([branchC._id]);
    const inactive = await createBranch('INACTIVE-LOOKUP');
    await BranchModel.updateOne({ _id: inactive._id }, { $set: { isActive: false } });
    const hidden = await request(app).get(`${path}&search=INACTIVE`).set('Authorization', bearer(token)).expect(200);
    expect(data<unknown[]>(hidden)).toEqual([]);
    await request(app).post('/api/v1/employees').set('Authorization', bearer(token))
      .send(employeeInput('MH', fresh._id, inactive._id)).expect(400);
    await request(app).post('/api/v1/employees').set('Authorization', bearer(token))
      .send(employeeInput('MH', bdo._id, branchC._id)).expect(403);
    await request(app).get(`/api/v1/employees/${headB._id}`).set('Authorization', bearer(token)).expect(404);
    const created = await createEmployee('MH', fresh._id, branchC._id, token);
    await request(app).get(`/api/v1/employees/${created._id}`).set('Authorization', bearer(token)).expect(200);
    await request(app).get(`/api/v1/employees/${headB._id}`).set('Authorization', bearer(token)).expect(404);
    await request(app).patch(`/api/v1/employees/${created._id}/branch`).set('Authorization', bearer(token))
      .send({ revision: 0, branchId: branchB._id, reportingManagerId: fresh._id, reason: 'Creation lookup does not authorize transfers' }).expect(403);
    const creatorRoleId = roles.get('BDO'); const targetRoleId = roles.get('MH');
    if (!creatorRoleId || !targetRoleId) throw new Error('Missing fixture roles');
    const filter = { creatorRoleId: new Types.ObjectId(creatorRoleId), targetRoleId: new Types.ObjectId(targetRoleId) };
    try {
      await RolePolicyModel.updateOne(filter, { $set: { allowCrossBranchReporting: false } });
      const restricted = await request(app).get(path).set('Authorization', bearer(token)).expect(200);
      expect(data<{ _id: string }[]>(restricted).map((branch) => branch._id)).toEqual([branchC._id]);
      await request(app).post('/api/v1/employees').set('Authorization', bearer(token))
        .send(employeeInput('MH', fresh._id, branchB._id)).expect(403);
    } finally {
      await RolePolicyModel.updateOne(filter, { $set: { allowCrossBranchReporting: true } });
    }
  });
  it('lets an explicitly assigned BDO see their primary branch before creating a team', async () => {
    const fresh = await createEmployee('BDO', rootId, null);
    const before = await signIn(fresh);
    const hidden = await request(app).get('/api/v1/branches').set('Authorization', bearer(before)).expect(200);
    expect(data<Branch[]>(hidden)).toEqual([]);
    await request(app).patch(`/api/v1/employees/${fresh._id}/branch`).set('Authorization', bearer())
      .send({ revision: fresh.revision, branchId: branchC._id, reportingManagerId: rootId, reason: 'Assign initial BDO branch' }).expect(200);
    await request(app).get('/api/v1/branches').set('Authorization', bearer(before)).expect(401);
    const after = (await authService.login(fresh.email, password, { requestId: 'branch-assignment-login' })).accessToken;
    const visible = await request(app).get('/api/v1/branches').set('Authorization', bearer(after)).expect(200);
    expect(data<Branch[]>(visible).map((branch) => branch._id)).toEqual([branchC._id]);
    const options = await request(app).get(`/api/v1/employees/branch-options?roleId=${roles.get('MH') ?? ''}`).set('Authorization', bearer(after)).expect(200);
    expect(data<{ _id: string }[]>(options).map((branch) => branch._id)).toEqual([branchC._id]);
    await request(app).get(`/api/v1/branches/${branchC._id}`).set('Authorization', bearer(after)).expect(200);
    await request(app).get(`/api/v1/branches/${branchB._id}`).set('Authorization', bearer(after)).expect(404);
    await createEmployee('MH', fresh._id, branchC._id, after);
    await request(app).post('/api/v1/employees').set('Authorization', bearer(after))
      .send(employeeInput('MH', fresh._id, branchB._id)).expect(403);
  });
  it('isolates self, branch peers and unrelated reporting subtrees for lists and individual records', async () => {
    await request(app).get(`/api/v1/employees/${sex._id}`).set('Authorization', bearer(sexToken)).expect(200);
    await request(app).get(`/api/v1/employees/${tc._id}`).set('Authorization', bearer(sexToken)).expect(404);
    await request(app).get(`/api/v1/employees/${peer._id}`).set('Authorization', bearer(headToken)).expect(200);
    await request(app).get(`/api/v1/employees/${peer._id}`).set('Authorization', bearer(bdoToken)).expect(404);
    const restricted = await request(app).get(`/api/v1/employees?branchId=${branchB._id}&limit=1`).set('Authorization', bearer(headToken)).expect(200);
    expect(restricted.body).toHaveProperty('meta.total', 0); expect(data<unknown[]>(restricted)).toEqual([]);
    const own = await request(app).get('/api/v1/employees?limit=1').set('Authorization', bearer(sexToken)).expect(200);
    expect(own.body).toHaveProperty('meta.total', 1);
  });
  it('applies pagination, literal search, role/manager/date filters and safe sorting', async () => {
    const response = await request(app).get(`/api/v1/employees?managerId=${head._id}&roleId=${roles.get('SEX') ?? ''}&limit=1&sortBy=employeeCode&startDate=2020-01-01&endDate=2100-01-01`)
      .set('Authorization', bearer(headToken)).expect(200);
    expect(response.body).toHaveProperty('meta.total', 1); expect(response.body).toHaveProperty('data.0._id', sex._id);
    await request(app).get('/api/v1/employees?sortBy=passwordHash').set('Authorization', bearer()).expect(400);
    await request(app).get('/api/v1/employees?limit=1000').set('Authorization', bearer()).expect(400);
    await request(app).get('/api/v1/employees?startDate=2030-01-01&endDate=2020-01-01').set('Authorization', bearer()).expect(400);
    const escaped = await request(app).get('/api/v1/employees?search=.%2A').set('Authorization', bearer()).expect(200);
    expect(escaped.body).toHaveProperty('meta.total', 0);
  });
  it('returns bounded hierarchy pages with authorized roots and no cross-scope leakage', async () => {
    const direct = await request(app).get('/api/v1/employees/downlines?depth=1').set('Authorization', bearer(bdoToken)).expect(200);
    expect(data<Employee[]>(direct).every((employee) => employee.reportingManagerId === bdo._id)).toBe(true);
    const tree = await request(app).get(`/api/v1/employees/hierarchy?rootId=${head._id}&limit=1`).set('Authorization', bearer(bdoToken)).expect(200);
    expect(data<unknown[]>(tree)).toHaveLength(1); expect(tree.body).toHaveProperty('meta.totalPages');
    await request(app).get(`/api/v1/employees/hierarchy?rootId=${peer._id}`).set('Authorization', bearer(bdoToken)).expect(404);
    await request(app).get('/api/v1/employees/hierarchy?depth=21').set('Authorization', bearer()).expect(400);
  });
  it('keeps branch-wide access independent from reporting-subtree access', async () => {
    const bdoBranches = await request(app).get('/api/v1/branches').set('Authorization', bearer(bdoToken)).expect(200);
    expect(data<Branch[]>(bdoBranches).map((branch) => branch._id)).toEqual([branchA._id]);
    await request(app).get(`/api/v1/branches/${branchC._id}`).set('Authorization', bearer(bdoToken)).expect(404);
    await request(app).get(`/api/v1/branches/${branchA._id}`).set('Authorization', bearer(sexToken)).expect(200);
    const bhBranches = await request(app).get('/api/v1/branches').set('Authorization', bearer(headToken)).expect(200);
    expect(data<Branch[]>(bhBranches).map((branch) => branch._id)).toEqual([branchA._id]);
  });
});

describe('employee mutations and transaction guards', () => {
  it('prevents branch heads editing peer managers, escalating roles or bypassing dedicated endpoints', async () => {
    await request(app).patch(`/api/v1/employees/${mh._id}`).set('Authorization', bearer(headToken)).send({ revision: 0, firstName: 'Unauthorized' }).expect(403);
    await request(app).patch(`/api/v1/employees/${tc._id}/role`).set('Authorization', bearer(headToken)).send({ revision: 0, roleId: roles.get('BDO'), reason: 'Escalation' }).expect(403);
    await request(app).patch(`/api/v1/employees/${tc._id}`).set('Authorization', bearer()).send({ revision: 0, roleId: roles.get('BDO') }).expect(400);
  });
  it('handles simultaneous profile edits with expected revisions and no lost update', async () => {
    const employee = await createEmployee('SEX', head._id, branchA._id);
    const responses = await Promise.all(['Alice', 'Beena'].map((firstName) => request(app).patch(`/api/v1/employees/${employee._id}`)
      .set('Authorization', bearer()).send({ revision: 0, firstName })));
    expect(responses.map((res) => res.status).sort()).toEqual([200, 409]);
    expect((await UserModel.findById(employee._id).lean())?.revision).toBe(1);
  });
  it('protects the last administrator and the bootstrap root placement', async () => {
    const response = await request(app).patch(`/api/v1/employees/${rootId}/status`).set('Authorization', bearer())
      .send({ revision: 0, isActive: false, employmentStatus: 'EXITED', reason: 'Root exit' }).expect(409);
    expect(response.body).toHaveProperty('error.code', 'LAST_ADMINISTRATOR');
    const md = roles.get('MD'); if (!md) throw new Error('No MD');
    const definition = data<{ permissions: { permissionId: string; scope: string }[] }>(await request(app).get(`/api/v1/roles/${md}`).set('Authorization', bearer()).expect(200));
    const pendingRole = await customRole('PENDING_ADMIN', definition.permissions); await createPolicy(md, pendingRole, [md], true);
    await createEmployee(pendingRole, rootId, branchA._id);
    const pendingDoesNotCount = await request(app).patch(`/api/v1/employees/${rootId}/status`).set('Authorization', bearer())
      .send({ revision: 0, isActive: false, employmentStatus: 'EXITED', reason: 'Pending accounts cannot preserve access' }).expect(409);
    expect(pendingDoesNotCount.body).toHaveProperty('error.code', 'LAST_ADMINISTRATOR');
    await request(app).patch(`/api/v1/employees/${rootId}/manager`).set('Authorization', bearer()).send({ revision: 0, reportingManagerId: bdo._id, reason: 'Invalid root move' }).expect(403);
  });
  it('requires active report reassignment before deactivation and revokes a terminated employee immediately', async () => {
    await request(app).patch(`/api/v1/employees/${head._id}/status`).set('Authorization', bearer())
      .send({ revision: 0, isActive: false, employmentStatus: 'EXITED', reason: 'Manager exit' }).expect(409);
    const employee = await createEmployee('SEX', head._id, branchA._id); const token = await signIn(employee);
    await request(app).patch(`/api/v1/employees/${employee._id}/status`).set('Authorization', bearer())
      .send({ revision: 0, isActive: false, employmentStatus: 'EXITED', reason: 'Employee exit' }).expect(200);
    await request(app).get('/api/v1/auth/me').set('Authorization', bearer(token)).expect(401);
    await request(app).patch(`/api/v1/employees/${employee._id}/status`).set('Authorization', bearer())
      .send({ revision: 1, isActive: true, employmentStatus: 'ACTIVE', reason: 'Approved rehire' }).expect(200);
    await request(app).get('/api/v1/auth/me').set('Authorization', bearer(token)).expect(401);
    await request(app).patch(`/api/v1/employees/${employee._id}/status`).set('Authorization', bearer())
      .send({ revision: 2, isActive: true, employmentStatus: 'EXITED', reason: 'Invalid combination' }).expect(400);
  });
  it('protects a custom last administrator from self-deactivation and loss of administrator grants', async () => {
    const md = roles.get('MD'); if (!md) throw new Error('No MD');
    const definition = data<{ permissions: { permissionId: string; scope: string }[] }>(await request(app).get(`/api/v1/roles/${md}`).set('Authorization', bearer()).expect(200));
    const roleId = await customRole('CUSTOM_ADMIN', definition.permissions); await createPolicy(md, roleId, [md], true);
    const administrator = await createEmployee(roleId, rootId, branchA._id); const token = await signIn(administrator);
    await UserModel.updateOne({ _id: rootId }, { $set: { isActive: false } });
    try {
      const status = await request(app).patch(`/api/v1/employees/${administrator._id}/status`).set('Authorization', bearer(token))
        .send({ revision: 0, isActive: false, employmentStatus: 'EXITED', reason: 'Last custom administrator' }).expect(409);
      expect(status.body).toHaveProperty('error.code', 'LAST_ADMINISTRATOR');
      const role = await request(app).patch(`/api/v1/roles/${roleId}`).set('Authorization', bearer(token)).send({ revision: 0, permissions: [] }).expect(409);
      expect(role.body).toHaveProperty('error.code', 'LAST_ADMINISTRATOR');
    } finally { await UserModel.updateOne({ _id: rootId }, { $set: { isActive: true } }); }
  });
  it('changes a manager successfully and revokes employee sessions after a contact update', async () => {
    const employee = await createEmployee('SEX', head._id, branchA._id); const token = await signIn(employee);
    const otherHead = await createEmployee('BH', mh._id, branchA._id);
    await request(app).patch(`/api/v1/employees/${employee._id}/manager`).set('Authorization', bearer())
      .send({ revision: 0, reportingManagerId: otherHead._id, reason: 'Same-branch approved manager' }).expect(200);
    await request(app).get('/api/v1/auth/me').set('Authorization', bearer(token)).expect(401);
    const credentials = await authService.login(employee.email, password, { requestId: 'test-relogin' });
    await request(app).patch(`/api/v1/employees/${employee._id}`).set('Authorization', bearer())
      .send({ revision: 1, email: `updated-${employee.email}` }).expect(200);
    await request(app).get('/api/v1/auth/me').set('Authorization', bearer(credentials.accessToken)).expect(401);
  });
  it('invalidates outstanding recovery links after a contact change and replaces pending invitations', async () => {
    const employee = await createEmployee('SEX', head._id, branchA._id); await signIn(employee);
    await authService.forgotPassword(employee.email, { requestId: 'test-recovery' });
    const reset = await CredentialDeliveryModel.findOne({ userId: employee._id, purpose: 'PASSWORD_RESET' }).select('+encryptedToken').lean();
    if (!reset) throw new Error('Missing reset'); const oldToken = decryptSecret(reset.encryptedToken, config.tokenEncryptionKey);
    await request(app).patch(`/api/v1/employees/${employee._id}`).set('Authorization', bearer()).send({ revision: 0, email: `new-${employee.email}` }).expect(200);
    await expect(authService.resetPassword(oldToken, password, 'PASSWORD_RESET', { requestId: 'old-recovery' })).rejects.toMatchObject({ statusCode: 401 });
    const pending = await createEmployee('TC', head._id, branchA._id);
    const invitation = await CredentialDeliveryModel.findOne({ userId: pending._id }).select('+encryptedToken').lean(); if (!invitation) throw new Error('Missing invitation');
    const oldInvitation = decryptSecret(invitation.encryptedToken, config.tokenEncryptionKey);
    await request(app).patch(`/api/v1/employees/${pending._id}`).set('Authorization', bearer()).send({ revision: 0, email: `new-${pending.email}` }).expect(200);
    await expect(authService.resetPassword(oldInvitation, password, 'INVITATION', { requestId: 'old-invitation' })).rejects.toMatchObject({ statusCode: 401 });
    expect(await CredentialDeliveryModel.countDocuments({ userId: pending._id, status: 'PENDING' })).toBe(1);
  });
  it('rejects self-management and unauthorized cross-branch manager changes', async () => {
    await request(app).patch(`/api/v1/employees/${sex._id}/manager`).set('Authorization', bearer())
      .send({ revision: 0, reportingManagerId: sex._id, reason: 'Self manager' }).expect(409);
    await request(app).patch(`/api/v1/employees/${sex._id}/manager`).set('Authorization', bearer())
      .send({ revision: 0, reportingManagerId: headB._id, reason: 'Cross branch' }).expect(400);
    await request(app).patch(`/api/v1/employees/${sex._id}/manager`).set('Authorization', bearer(headToken))
      .send({ revision: 0, reportingManagerId: headB._id, reason: 'Out of scope' }).expect(403);
  });
  it('transfers atomically with new scope, old-scope denial, session revocation and audited before/after IDs', async () => {
    const employee = await createEmployee('SEX', head._id, branchA._id); const token = await signIn(employee);
    const response = await request(app).patch(`/api/v1/employees/${employee._id}/branch`).set('Authorization', bearer())
      .send({ revision: 0, branchId: branchB._id, reportingManagerId: headB._id, reason: 'Approved branch transfer' }).expect(200);
    expect(data<Employee>(response).branchId).toBe(branchB._id);
    await request(app).get(`/api/v1/employees/${employee._id}`).set('Authorization', bearer(headToken)).expect(404);
    await request(app).get(`/api/v1/employees/${employee._id}`).set('Authorization', bearer(bdoToken)).expect(404);
    await request(app).get('/api/v1/auth/me').set('Authorization', bearer(token)).expect(401);
    const event = await ActivityLogModel.findOne({ action: 'EMPLOYEE_TRANSFERRED', entityId: employee._id }).lean();
    const metadata = event?.metadata as unknown as Record<string, string> | undefined;
    expect(metadata?.before).toContain(branchA._id); expect(metadata?.after).toContain(branchB._id);
  });
  it('rejects moves and role changes that would invalidate active child relationships', async () => {
    const manager = await createEmployee('BH', mh._id, branchA._id); await createEmployee('TC', manager._id, branchA._id);
    await request(app).patch(`/api/v1/employees/${manager._id}/branch`).set('Authorization', bearer())
      .send({ revision: 0, branchId: branchB._id, reportingManagerId: rootId, reason: 'Would detach child branch' }).expect(400);
    await request(app).patch(`/api/v1/employees/${manager._id}/role`).set('Authorization', bearer())
      .send({ revision: 0, roleId: roles.get('SEX'), reason: 'Would remove supervision' }).expect(400);
  });
  it('assigns a permitted subordinate role and revokes prior sessions', async () => {
    const employee = await createEmployee('SEX', head._id, branchA._id); const token = await signIn(employee);
    const response = await request(app).patch(`/api/v1/employees/${employee._id}/role`).set('Authorization', bearer())
      .send({ revision: 0, roleId: roles.get('TC'), reason: 'Approved calling assignment' }).expect(200);
    expect(data<Employee>(response).roleId).toBe(roles.get('TC'));
    await request(app).get('/api/v1/auth/me').set('Authorization', bearer(token)).expect(401);
  });
  it('serializes reciprocal manager changes so a concurrent cycle cannot commit', async () => {
    const aRole = await customRole('CYCLE_A'); const bRole = await customRole('CYCLE_B'); const md = roles.get('MD'); if (!md) throw new Error('No MD');
    await createPolicy(md, aRole, [md, bRole], true); await createPolicy(md, bRole, [md, aRole], true);
    await createPolicy(aRole, bRole, [aRole]); await createPolicy(bRole, aRole, [bRole]);
    const a = await createEmployee(aRole, rootId, branchA._id); const b = await createEmployee(bRole, rootId, branchA._id);
    const responses = await Promise.all([[a, b], [b, a]].map(([employee, manager]) => {
      if (!employee || !manager) throw new Error('Fixture missing');
      return request(app).patch(`/api/v1/employees/${employee._id}/manager`).set('Authorization', bearer())
        .send({ revision: 0, reportingManagerId: manager._id, reason: 'Concurrent manager change' });
    }));
    expect(responses.map((res) => res.status).sort()).toEqual([200, 409]);
  });
  it('limits reporting depth and preserves the existing graph on rejection', async () => {
    const a = await customRole('DEPTH_A'); const b = await customRole('DEPTH_B'); const md = roles.get('MD'); if (!md) throw new Error('No MD');
    await createPolicy(md, a, [md, b], true); await createPolicy(md, b, [md, a], true); await createPolicy(a, b, [a]); await createPolicy(b, a, [b]);
    let manager = rootId;
    for (let depth = 1; depth <= 20; depth++) manager = (await createEmployee(depth % 2 ? a : b, manager, branchA._id))._id;
    const response = await request(app).post('/api/v1/employees').set('Authorization', bearer()).send(employeeInput(a, manager, branchA._id)).expect(409);
    expect(response.body).toHaveProperty('error.code', 'HIERARCHY_TOO_DEEP');
  }, 30000);
  it('rolls back employee creation when its required audit fails', async () => {
    const principal = await authService.authenticate(rootToken); const service = new UserService(config);
    const input = employeeInput('SEX', head._id, branchA._id); const before = await CredentialDeliveryModel.countDocuments();
    await expect(service.create(principal, input, { requestId: '' })).rejects.toThrow();
    expect(await UserModel.exists({ employeeCode: input.employeeCode })).toBeNull(); expect(await CredentialDeliveryModel.countDocuments()).toBe(before);
  });
});

describe('branches and location masters', () => {
  it('supports master-data lifecycle changes in parent order and rejects stale revisions', async () => {
    const parent = data<Location>(await request(app).post('/api/v1/locations/states').set('Authorization', bearer())
      .send({ code: 'LIFECYCLE', name: 'Lifecycle fixture state' }).expect(201));
    const child = data<Location>(await request(app).post('/api/v1/locations/districts').set('Authorization', bearer())
      .send({ code: 'LIFE_D', name: 'Lifecycle fixture district', stateId: parent._id }).expect(201));
    const leaf = data<Location>(await request(app).post('/api/v1/locations/blocks').set('Authorization', bearer())
      .send({ code: 'LIFE_B', name: 'Lifecycle fixture block', districtId: child._id, kind: 'TEHSIL' }).expect(201));
    for (const [kind, id] of [['blocks', leaf._id], ['districts', child._id], ['states', parent._id]]) {
      await request(app).patch(`/api/v1/locations/${String(kind)}/${String(id)}`).set('Authorization', bearer()).send({ revision: 0, isActive: false }).expect(200);
    }
    await request(app).patch(`/api/v1/locations/blocks/${leaf._id}`).set('Authorization', bearer()).send({ revision: 1, isActive: true }).expect(400);
    await request(app).patch(`/api/v1/locations/districts/${child._id}`).set('Authorization', bearer()).send({ revision: 1, isActive: true }).expect(400);
    for (const [kind, id] of [['states', parent._id], ['districts', child._id], ['blocks', leaf._id]]) {
      await request(app).patch(`/api/v1/locations/${String(kind)}/${String(id)}`).set('Authorization', bearer())
        .send({ revision: 1, isActive: true, name: `Approved lifecycle ${String(kind)}` }).expect(200);
    }
    await request(app).patch(`/api/v1/locations/blocks/${leaf._id}`).set('Authorization', bearer()).send({ revision: 1, name: 'Stale name' }).expect(409);
    const response = await request(app).get(`/api/v1/locations/blocks?districtId=${child._id}`).set('Authorization', bearer()).expect(200);
    expect(response.body).toHaveProperty('meta.total', 1); expect(response.body).toHaveProperty('data.0._id', leaf._id);
  });
  it('validates location parent chains and restricts master mutations', async () => {
    await request(app).get(`/api/v1/locations/districts?stateId=${state._id}`).set('Authorization', bearer(tcToken)).expect(200);
    await request(app).get('/api/v1/locations/districts').set('Authorization', bearer()).expect(400);
    await request(app).post('/api/v1/locations/states').set('Authorization', bearer(tcToken)).send({ code: 'BAD', name: 'Denied' }).expect(403);
    await request(app).patch(`/api/v1/locations/states/${state._id}`).set('Authorization', bearer()).send({ revision: 0, isActive: false }).expect(409);
    const other = data<Location>(await request(app).post('/api/v1/locations/states').set('Authorization', bearer()).send({ code: 'TST2', name: 'Other test state' }).expect(201));
    await request(app).post('/api/v1/branches').set('Authorization', bearer()).send({ branchCode: 'INVALID_LOCATION', branchName: 'Invalid fixture',
      address: 'Test fixture address', contactNumber: '+919000000000', stateId: other._id, districtId: district._id, blockId: block._id }).expect(400);
    await request(app).patch(`/api/v1/locations/blocks/${block._id}`).set('Authorization', bearer()).send({ revision: 0, districtId: new Types.ObjectId().toHexString() }).expect(400);
  });
  it('allows profile-only BH branch edits and prevents other branch and sensitive field changes', async () => {
    await request(app).patch(`/api/v1/branches/${branchA._id}`).set('Authorization', bearer(headToken)).send({ revision: 0, address: 'Approved fixture office address' }).expect(200);
    await request(app).patch(`/api/v1/branches/${branchB._id}`).set('Authorization', bearer(headToken)).send({ revision: 0, branchName: 'Denied branch' }).expect(404);
    await request(app).patch(`/api/v1/branches/${branchA._id}`).set('Authorization', bearer(headToken)).send({ revision: 1, isActive: false }).expect(403);
    await request(app).patch(`/api/v1/branches/${branchA._id}`).set('Authorization', bearer()).send({ revision: 1, isActive: false }).expect(409);
  });
  it('validates dynamic branch-head eligibility and requires reassignment before transfer/deactivation', async () => {
    await request(app).patch(`/api/v1/branches/${branchA._id}/head`).set('Authorization', bearer()).send({ revision: 1, branchHeadId: sex._id, reason: 'No branch capability' }).expect(400);
    const response = await request(app).patch(`/api/v1/branches/${branchA._id}/head`).set('Authorization', bearer()).send({ revision: 1, branchHeadId: head._id, reason: 'Approved head' }).expect(200);
    expect(data<Branch>(response).branchHeadId).toBe(head._id);
    await request(app).patch(`/api/v1/employees/${head._id}/branch`).set('Authorization', bearer()).send({ revision: 0, branchId: branchB._id, reportingManagerId: rootId, reason: 'Head transfer' }).expect(409);
    await request(app).patch(`/api/v1/employees/${head._id}/status`).set('Authorization', bearer()).send({ revision: 0, isActive: false, employmentStatus: 'EXITED', reason: 'Head exit' }).expect(409);
    await request(app).patch(`/api/v1/branches/${branchA._id}/head`).set('Authorization', bearer()).send({ revision: 2, branchHeadId: null, reason: 'Clear fixture head' }).expect(200);
  });
  it('soft-deactivates empty branches and rejects new assignments into them', async () => {
    const empty = await createBranch('EMPTY_BRANCH');
    await request(app).patch(`/api/v1/branches/${empty._id}`).set('Authorization', bearer()).send({ revision: 0, isActive: false }).expect(200);
    expect((await BranchModel.findById(empty._id).lean())?.isActive).toBe(false);
    await request(app).post('/api/v1/employees').set('Authorization', bearer()).send(employeeInput('SEX', rootId, empty._id)).expect(400);
  });
  it('prevents stripping a current branch head capability through role edits', async () => {
    const md = roles.get('MD'); if (!md) throw new Error('No MD');
    const definitions = data<{ _id: string; code: string }[]>(await request(app).get('/api/v1/permissions').set('Authorization', bearer()).expect(200));
    const capability = definitions.find((permission) => permission.code === 'branches:update'); if (!capability) throw new Error('No capability');
    const roleId = await customRole('CUSTOM_BRANCH_MANAGER', [{ permissionId: capability._id, scope: 'BRANCH' }]);
    await createPolicy(md, roleId, [md], true); const employee = await createEmployee(roleId, rootId, branchC._id);
    await request(app).patch(`/api/v1/branches/${branchC._id}/head`).set('Authorization', bearer())
      .send({ revision: 0, branchHeadId: employee._id, reason: 'Capability-based appointment' }).expect(200);
    const removed = await request(app).patch(`/api/v1/roles/${roleId}`).set('Authorization', bearer()).send({ revision: 0, permissions: [] }).expect(409);
    expect(removed.body).toHaveProperty('error.code', 'BRANCH_HEAD_IN_USE');
    await request(app).patch(`/api/v1/branches/${branchC._id}/head`).set('Authorization', bearer())
      .send({ revision: 1, branchHeadId: null, reason: 'Remove fixture appointment' }).expect(200);
  });
  it('preserves active reporting relationships when an administrator edits their role policy', async () => {
    const policy = await RolePolicyModel.findOne({ creatorRoleId: roles.get('BH') ?? '', targetRoleId: roles.get('SEX') ?? '' }).lean(); if (!policy) throw new Error('No policy');
    await request(app).put(`/api/v1/role-creation-policies/${policy._id.toHexString()}`).set('Authorization', bearer()).send({ revision: policy.revision,
      creatorRoleId: roles.get('BH'), targetRoleId: roles.get('SEX'), allowedManagerRoleIds: policy.allowedManagerRoleIds.map((id) => id.toHexString()), isActive: false }).expect(409);
  });
  it('seeds vetted reference input idempotently, validates the full batch and never overwrites mismatches', async () => {
    const input = { sourceVersion: 'synthetic-test-only', states: [{ code: 'SEED_TST', name: 'Seed fixture', districts: [{ code: 'D', name: 'Seed district', blocks: [{ code: 'B', name: 'Seed block', kind: 'TEHSIL' }] }] }] };
    expect(await seedLocations(input)).toBe(3); expect(await seedLocations(input)).toBe(3);
    expect(await StateModel.countDocuments({ code: 'SEED_TST' })).toBe(1);
    await expect(seedLocations({ ...input, states: [{ code: 'SEED_TST', name: 'Do not overwrite', districts: [] }] })).rejects.toMatchObject({ code: 'LOCATION_SEED_CONFLICT' });
    await expect(seedLocations({ ...input, extra: 'unrecognized' })).rejects.toMatchObject({ code: 'INVALID_LOCATION_SEED' });
    expect(await DistrictModel.countDocuments({ name: 'Seed district' })).toBe(1); expect(await BlockModel.countDocuments({ name: 'Seed block' })).toBe(1);
  });
  it('applies organization metadata migrations without overwriting approved role settings', async () => {
    const md = roles.get('MD'); if (!md) throw new Error('No MD');
    const legacyRole = await customRole('LEGACY_TEMPLATE'); const policy = await createPolicy(md, legacyRole, [md], true);
    await RoleModel.collection.updateOne({ _id: new Types.ObjectId(legacyRole) }, { $set: { revision: 2 }, $unset: { allowsNoBranch: '' } });
    await RolePolicyModel.collection.updateOne({ _id: new Types.ObjectId(policy._id) }, { $unset: { creatorRoleRevision: '', targetRoleRevision: '' } });
    await createOrganizationIndexes();
    expect((await RoleModel.findById(legacyRole).lean())?.allowsNoBranch).toBe(false);
    await request(app).post('/api/v1/employees').set('Authorization', bearer()).send(employeeInput(legacyRole, rootId, branchA._id)).expect(409);
    await RoleModel.updateOne({ _id: legacyRole }, { $set: { allowsNoBranch: true, revision: 3 } });
    await createOrganizationIndexes();
    expect((await RoleModel.findById(legacyRole).lean())?.allowsNoBranch).toBe(true);
    const root = await RoleModel.findOne({ code: 'MD' }).lean(); expect(root?.allowsNoBranch).toBe(true);
    const marketing = await RoleModel.findOne({ code: 'MH' }).lean(); if (!marketing) throw new Error('No MH role');
    await RoleModel.updateOne({ _id: marketing._id }, { $set: { allowsNoBranch: false, revision: 0 } });
    await createOrganizationIndexes();
    expect((await RoleModel.findById(marketing._id).lean())?.allowsNoBranch).toBe(true);
    expect(await RolePolicyModel.countDocuments({ targetRoleRevision: trusted({ $gte: 0 }) })).toBeGreaterThan(0);
  });
  it('upgrades untouched MH cross-branch defaults once while preserving customized policies', async () => {
    const policies = await RolePolicyModel.find({ creatorRoleId: roles.get('MH') ?? '' }).lean();
    const legacy = policies.find((policy) => policy.targetRoleId.toHexString() === roles.get('BH'));
    const customized = policies.find((policy) => policy.targetRoleId.toHexString() === roles.get('SEX'));
    const sameBranch = policies.find((policy) => policy.targetRoleId.toHexString() === roles.get('TC'));
    if (!legacy || !customized || !sameBranch) throw new Error('Missing MH policy fixtures');
    try {
      await RolePolicyModel.updateOne({ _id: legacy._id }, { $set: { revision: 0, allowCrossBranchReporting: false } });
      await RolePolicyModel.updateOne({ _id: customized._id }, { $set: { revision: 2, allowCrossBranchReporting: false } });
      await RolePolicyModel.updateOne({ _id: sameBranch._id }, { $set: { revision: 0, branchRule: 'SAME_BRANCH', allowCrossBranchReporting: false } });
      await createOrganizationIndexes();
      expect(await RolePolicyModel.findById(legacy._id).lean()).toMatchObject({ allowCrossBranchReporting: true, revision: 1 });
      expect(await RolePolicyModel.findById(customized._id).lean()).toMatchObject({ allowCrossBranchReporting: false, revision: 2 });
      expect(await RolePolicyModel.findById(sameBranch._id).lean()).toMatchObject({ allowCrossBranchReporting: false, branchRule: 'SAME_BRANCH', revision: 0 });
      await createOrganizationIndexes();
      expect(await RolePolicyModel.findById(legacy._id).lean()).toMatchObject({ allowCrossBranchReporting: true, revision: 1 });
    } finally {
      for (const policy of policies) await RolePolicyModel.updateOne({ _id: policy._id }, { $set: {
        revision: policy.revision, allowCrossBranchReporting: policy.allowCrossBranchReporting, branchRule: policy.branchRule,
      } });
    }
  });
});
