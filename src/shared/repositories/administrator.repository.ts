import { Types, trusted, type ClientSession } from 'mongoose';
import { RoleModel } from '../../modules/roles/role.model.js';
import { PermissionModel } from '../../modules/permissions/permission.model.js';
import { UserModel } from '../../modules/users/user.model.js';
import { ADMINISTRATOR_PERMISSIONS } from '../../constants/permissions.js';
export class AdministratorRepository {
  async exists(session: ClientSession, exceptUser?: Types.ObjectId, exceptRole?: Types.ObjectId): Promise<boolean> {
    const definitions = await PermissionModel.find({ code: trusted({ $in: ADMINISTRATOR_PERMISSIONS }) }).session(session).lean();
    if (definitions.length !== ADMINISTRATOR_PERMISSIONS.length) return false;
    const roles = await RoleModel.find({ isActive: true, ...(exceptRole ? { _id: trusted({ $ne: exceptRole }) } : {}) }).session(session).lean();
    const roleIds = roles.filter((role) => definitions.every((definition) => role.permissions.some((grant) =>
      grant.permissionId.equals(definition._id) && grant.scope === 'ALL'))).map((role) => role._id);
    return Boolean(await UserModel.exists({ isActive: true, employmentStatus: trusted({ $ne: 'EXITED' }),
      passwordHash: trusted({ $type: 'string' }),
      roleId: trusted({ $in: roleIds }), ...(exceptUser ? { _id: trusted({ $ne: exceptUser }) } : {}) }).session(session));
  }
}
