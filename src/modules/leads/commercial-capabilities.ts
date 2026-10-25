import mongoose, { type Types } from 'mongoose';
import { RoleModel } from '../roles/role.model.js';
import { UserModel } from '../users/user.model.js';
import { PermissionModel } from '../permissions/permission.model.js';
import { SecurityStateModel } from '../auth/auth.models.js';
import { AuthorizationService } from '../permissions/authorization.service.js';
import { isAdministrator, type PermissionCode } from '../../constants/permissions.js';
import { audit } from '../activity-logs/audit.service.js';
export async function enableDefaultCommercialCapabilities(): Promise<number> {
  return mongoose.connection.transaction(async (session) => {
    await SecurityStateModel.updateOne({ _id: 'administration' }, { $inc: { revision: 1 } }, { upsert: true, session });
    await SecurityStateModel.updateOne({ _id: 'hierarchy' }, { $inc: { revision: 1 } }, { upsert: true, session });
    const root = await UserModel.findOne({ bootstrapKey: 'INITIAL_MD', isActive: true }).select('+passwordHash').session(session).lean();
    if (!root?.passwordHash || !isAdministrator(await new AuthorizationService().grants(root.roleId, session) ?? [])) throw new Error('An active initialized bootstrap administrator is required');
    const capabilities: [string, PermissionCode[]][] = [['MD', ['customers:receive_assignment', 'leads:receive_assignment']], ['TC', ['customers:receive_assignment']], ['SEX', ['leads:receive_assignment']]];
    let changed = 0;
    for (const [code, permissions] of capabilities) {
      const role = await RoleModel.findOne({ code, isSystemRole: true, isActive: true }).session(session).lean(); if (!role) throw new Error('Required active system role missing');
      const additions: { permissionId: Types.ObjectId; scope: 'SELF' }[] = [];
      for (const permission of permissions) {
        const definition = await PermissionModel.findOne({ code: permission }).session(session).lean();
        if (!definition) throw new Error('Run commercial index/registry migration first');
        if (!role.permissions.some((grant) => grant.permissionId.equals(definition._id) && grant.scope === 'SELF')) additions.push({ permissionId: definition._id, scope: 'SELF' });
      }
      if (additions.length) {
        await RoleModel.updateOne({ _id: role._id, revision: role.revision }, { $push: { permissions: { $each: additions } }, $inc: { revision: 1 } }, { session }); changed++;
        await audit(session, { requestId: 'internal-commercial-capabilities' }, 'COMMERCIAL_CAPABILITIES_ENABLED', root._id, 'role', role._id,
          { code, previousRevision: String(role.revision), revision: String(role.revision + 1), permissions: permissions.join(',') });
      }
    }
    return changed;
  });
}
