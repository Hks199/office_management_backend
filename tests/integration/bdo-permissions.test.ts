import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { trusted } from 'mongoose';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { testConfig } from '../helpers.js';
import { connectDatabase, disconnectDatabase } from '../../src/config/database.js';
import { createLogger } from '../../src/config/logger.js';
import { bootstrapMd } from '../../src/modules/auth/bootstrap.service.js';
import { defaultGrants } from '../../src/modules/permissions/seed.service.js';
import { alignBdoPermissions } from '../../src/modules/permissions/align-bdo-permissions.js';
import { repairMdCreationPolicies } from '../../src/modules/permissions/repair-md-creation-policies.js';
import { AuthorizationService } from '../../src/modules/permissions/authorization.service.js';
import { RoleModel } from '../../src/modules/roles/role.model.js';
import { RolePolicyModel } from '../../src/modules/roles/role-policy.model.js';
import { UserModel } from '../../src/modules/users/user.model.js';
import { PermissionModel } from '../../src/modules/permissions/permission.model.js';
import { ActivityLogModel } from '../../src/modules/activity-logs/activity-log.model.js';

let replica: MongoMemoryReplSet | undefined;
beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const config = testConfig();
  await connectDatabase({ ...config, mongodbUri: replica.getUri('bdo-permissions') }, createLogger(config));
  const rootId = await bootstrapMd({ employeeCode: 'BDO-TEST-MD', firstName: 'Test', lastName: 'Director',
    email: 'bdo-md@example.invalid', mobileNumber: '+919999999999' }, config.tokenEncryptionKey);
  // The migration requires an initialized administrator; no authentication is exercised here.
  await UserModel.updateOne({ _id: rootId }, { $set: { passwordHash: 'isolated-migration-test' } });
}, 180000);
afterAll(async () => { await disconnectDatabase(); await replica?.stop(); });

it('seeds identical BDO and MH permission scopes', () => {
  expect(defaultGrants('BDO')).toEqual(defaultGrants('MH'));
  expect(defaultGrants('BDO')).toContainEqual({ permission: 'imports:confirm', scope: 'REPORTING_SUBTREE' });
});

it('aligns an existing BDO, preserves valid creation policies, and is idempotent', async () => {
  const bdo = await RoleModel.findOne({ code: 'BDO' }).orFail().lean();
  const mh = await RoleModel.findOne({ code: 'MH' }).orFail().lean();
  // Recreate the older BDO template using resolved permission codes.
  const definitions = await PermissionModel.find({ code: trusted({ $in: ['leads:import', 'imports:create', 'imports:confirm', 'imports:read'] }) }).lean();
  expect(definitions).toHaveLength(4);
  const ids = new Set(definitions.map((definition) => definition._id.toHexString()));
  await RoleModel.updateOne({ _id: bdo._id }, { $set: {
    permissions: bdo.permissions.filter((grant) => !ids.has(grant.permissionId.toHexString())),
  } });
  const approved = await RolePolicyModel.findOne({ creatorRoleId: bdo._id, targetRoleId: mh._id }).orFail().lean();
  const stale = await RolePolicyModel.findOne({ targetRoleId: bdo._id }).orFail().lean();
  await RolePolicyModel.updateOne({ _id: stale._id }, { $set: { targetRoleRevision: 99 } });
  expect(await alignBdoPermissions()).toMatchObject({ applied: false, added: 4, removed: 0 });
  expect((await RoleModel.findById(bdo._id).orFail().lean()).revision).toBe(bdo.revision);
  expect(await alignBdoPermissions(true)).toMatchObject({ applied: true, added: 4, removed: 0 });
  const authorization = new AuthorizationService();
  expect(await authorization.grants(bdo._id)).toEqual(await authorization.grants(mh._id));
  expect((await RolePolicyModel.findById(approved._id).orFail().lean()).creatorRoleRevision).toBe(bdo.revision + 1);
  expect((await RolePolicyModel.findById(stale._id).orFail().lean()).targetRoleRevision).toBe(99);
  expect(await ActivityLogModel.countDocuments({ action: 'PERMISSION_CHANGED', entityId: bdo._id })).toBe(1);
  expect(await alignBdoPermissions(true)).toMatchObject({ changed: false, applied: false });
  expect((await RoleModel.findById(bdo._id).orFail().lean()).revision).toBe(bdo.revision + 1);
});

it('repairs stale MD policies without enabling disabled policies or changing their rules', async () => {
  const md = await RoleModel.findOne({ code: 'MD' }).orFail().lean();
  const tc = await RoleModel.findOne({ code: 'TC' }).orFail().lean();
  const disabled = await RolePolicyModel.findOne({ creatorRoleId: md._id, targetRoleId: tc._id }).orFail().lean();
  await RolePolicyModel.updateOne({ _id: disabled._id }, { $set: { isActive: false } });
  await RoleModel.updateOne({ _id: md._id }, { $inc: { revision: 1 } });
  const preview = await repairMdCreationPolicies();
  expect(preview).toMatchObject({ applied: false, policiesUpdated: 0 });
  expect(preview.roles).toEqual(['BDO', 'BH', 'MH', 'SEX']);
  expect(await repairMdCreationPolicies(true)).toMatchObject({ policiesUpdated: 4 });
  const refreshed = await RolePolicyModel.find({ creatorRoleId: md._id, isActive: true }).lean();
  for (const policy of refreshed) {
    const target = await RoleModel.findById(policy.targetRoleId).orFail().lean();
    expect(policy.creatorRoleRevision).toBe(md.revision + 1);
    expect(policy.targetRoleRevision).toBe(target.revision);
    expect(policy.branchRule).toBe('EXPLICIT_SCOPE');
    expect(policy.allowCrossBranchReporting).toBe(true);
  }
  expect((await RolePolicyModel.findById(disabled._id).orFail().lean()).isActive).toBe(false);
  expect((await repairMdCreationPolicies(true)).policiesUpdated).toBe(0);
});

it('rejects updates without an initialized active administrator', async () => {
  await UserModel.updateOne({ bootstrapKey: 'INITIAL_MD' }, { $set: { isActive: false } });
  await expect(alignBdoPermissions(true)).rejects.toThrow('active initialized bootstrap administrator');
  await expect(repairMdCreationPolicies(true)).rejects.toThrow('active initialized MD administrator');
});
