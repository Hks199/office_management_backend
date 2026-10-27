import mongoose from 'mongoose';
import { isAdministrator } from '../../constants/permissions.js';
import { seedPermissions } from './seed.service.js';
import { AuthorizationService } from './authorization.service.js';
import { RoleModel } from '../roles/role.model.js';
import { RolePolicyModel } from '../roles/role-policy.model.js';
import { PermissionModel } from './permission.model.js';
import { UserModel } from '../users/user.model.js';
import { SecurityStateModel } from '../auth/auth.models.js';
import { audit } from '../activity-logs/audit.service.js';

export async function enableEmployeePanels() {
  return mongoose.connection.transaction(async (session) => {
    await SecurityStateModel.updateOne({ _id: 'administration' }, { $inc: { revision: 1 } }, { upsert: true, session });
    await SecurityStateModel.updateOne({ _id: 'hierarchy' }, { $inc: { revision: 1 } }, { upsert: true, session });
    const root = await UserModel.findOne({ bootstrapKey: 'INITIAL_MD', isActive: true }).select('+passwordHash').session(session).lean();
    if (!root?.passwordHash || !isAdministrator(await new AuthorizationService().grants(root.roleId, session) ?? [])) throw new Error('Active initialized MD administrator required');
    await seedPermissions(session);
    const permission = await PermissionModel.findOne({ code: 'users:open_panel' }).session(session).orFail().lean();
    const roles = await RoleModel.find({ isActive: true }).session(session).lean();
    const before = new Map(roles.map((role) => [role._id.toHexString(), role.revision]));
    const after = new Map(before); let changed = 0; let policiesUpdated = 0;
    for (const role of roles.filter((entry) => entry.isSystemRole && ['MD', 'BDO', 'MH', 'BH'].includes(entry.code))) {
      const scope = role.code === 'MD' ? 'ALL' : 'REPORTING_SUBTREE';
      if (role.permissions.some((grant) => grant.permissionId.equals(permission._id) && grant.scope === scope)) continue;
      await RoleModel.updateOne({ _id: role._id, revision: role.revision }, {
        $push: { permissions: { permissionId: permission._id, scope } }, $inc: { revision: 1 },
      }, { session, runValidators: true });
      after.set(role._id.toHexString(), role.revision + 1); changed++;
      await audit(session, { requestId: 'internal-enable-employee-panels' }, 'PERMISSION_CHANGED', root._id, 'role', role._id,
        { permission: 'users:open_panel', scope, previousRevision: String(role.revision), revision: String(role.revision + 1) });
    }
    for (const policy of await RolePolicyModel.find({ isActive: true }).session(session).lean()) {
      const creator = policy.creatorRoleId.toHexString(); const target = policy.targetRoleId.toHexString();
      if (policy.creatorRoleRevision !== before.get(creator) || policy.targetRoleRevision !== before.get(target) ||
        (before.get(creator) === after.get(creator) && before.get(target) === after.get(target))) continue;
      await RolePolicyModel.updateOne({ _id: policy._id, revision: policy.revision }, {
        $set: { creatorRoleRevision: after.get(creator), targetRoleRevision: after.get(target) }, $inc: { revision: 1 },
      }, { session });
      policiesUpdated++;
      await audit(session, { requestId: 'internal-enable-employee-panels' }, 'ROLE_CREATION_POLICY_CHANGED', root._id, 'role_creation_policy', policy._id,
        { reason: 'Preserve current creation policy while enabling employee panels', revision: String(policy.revision + 1) });
    }
    return { rolesUpdated: changed, policiesUpdated };
  });
}
