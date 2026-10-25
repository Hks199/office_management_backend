import mongoose, { trusted } from 'mongoose';
import { RoleModel } from '../roles/role.model.js';
import { UserModel } from '../users/user.model.js';
import { PermissionModel } from '../permissions/permission.model.js';
import { SecurityStateModel } from '../auth/auth.models.js';
import { seedPermissions } from '../permissions/seed.service.js';
import { AuthorizationService } from '../permissions/authorization.service.js';
import { isAdministrator } from '../../constants/permissions.js';
import { audit } from '../activity-logs/audit.service.js';

export async function enableBranchLeadRouting() {
  return mongoose.connection.transaction(async (session) => {
    await SecurityStateModel.updateOne({ _id: 'administration' }, { $inc: { revision: 1 } }, { upsert: true, session });
    await SecurityStateModel.updateOne({ _id: 'hierarchy' }, { $inc: { revision: 1 } }, { upsert: true, session });
    const root = await UserModel.findOne({ bootstrapKey: 'INITIAL_MD', isActive: true }).select('+passwordHash').session(session).lean();
    if (!root?.passwordHash || !isAdministrator(await new AuthorizationService().grants(root.roleId, session) ?? [])) throw new Error('An initialized administrator is required');
    await seedPermissions(session);
    const route = await PermissionModel.findOne({ code: 'leads:route' }).session(session).lean();
    if (!route) throw new Error('Lead routing permission is missing');
    const removed = await PermissionModel.find({ code: trusted({ $in: ['leads:update', 'leads:assign', 'leads:propose_assignment'] }) }).session(session).lean();
    let changed = 0;
    for (const code of ['TC', 'MD'] as const) {
      const role = await RoleModel.findOne({ code, isSystemRole: true, isActive: true }).session(session).lean();
      if (!role) throw new Error('Active system role is missing');
      const scope = code === 'TC' ? 'SELF' as const : 'ALL' as const;
      const permissions = role.permissions.filter((grant) => code !== 'TC' || !removed.some((permission) => permission._id.equals(grant.permissionId))).map((grant) => ({ permissionId: grant.permissionId, scope: grant.scope }));
      if (!permissions.some((grant) => grant.permissionId.equals(route._id) && grant.scope === scope)) permissions.push({ permissionId: route._id, scope });
      if (permissions.length === role.permissions.length && role.permissions.every((grant, index) => grant.permissionId.equals(permissions[index]?.permissionId ?? '') && grant.scope === permissions[index]?.scope)) continue;
      await RoleModel.updateOne({ _id: role._id, revision: role.revision }, { $set: { permissions }, $inc: { revision: 1 } }, { session });
      await audit(session, { requestId: 'internal-lead-routing' }, 'BRANCH_LEAD_ROUTING_ENABLED', root._id, 'role', role._id, { code });
      changed++;
    }
    return changed;
  });
}
