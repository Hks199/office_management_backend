import mongoose, { trusted } from 'mongoose';
import { isAdministrator } from '../../constants/permissions.js';
import { AuthorizationService } from './authorization.service.js';
import { RoleModel } from '../roles/role.model.js';
import { RolePolicyModel } from '../roles/role-policy.model.js';
import { UserModel } from '../users/user.model.js';
import { SecurityStateModel } from '../auth/auth.models.js';
import { audit } from '../activity-logs/audit.service.js';

/** Explicit operator repair; never reapproves policies during an ordinary lookup. */
export async function repairMdCreationPolicies(apply = false) {
  return mongoose.connection.transaction(async (session) => {
    if (apply) {
      await SecurityStateModel.updateOne({ _id: 'administration' }, { $inc: { revision: 1 } }, { upsert: true, session });
      await SecurityStateModel.updateOne({ _id: 'hierarchy' }, { $inc: { revision: 1 } }, { upsert: true, session });
    }
    const root = await UserModel.findOne({ bootstrapKey: 'INITIAL_MD', isActive: true }).select('+passwordHash').session(session).lean();
    const md = await RoleModel.findOne({ code: 'MD', isSystemRole: true, isActive: true }).session(session).lean();
    if (!root?.passwordHash || !md || !root.roleId.equals(md._id) ||
      !isAdministrator(await new AuthorizationService().grants(md._id, session) ?? [])) {
      throw new Error('An active initialized MD administrator is required');
    }
    const targets = await RoleModel.find({ isActive: true, isSystemRole: true,
      code: trusted({ $in: ['BDO', 'MH', 'BH', 'SEX', 'TC'] }),
    }).session(session).lean();
    const policies = await RolePolicyModel.find({ creatorRoleId: md._id, isActive: true }).session(session).lean();
    const changed: string[] = [];
    for (const policy of policies) {
      const target = targets.find((role) => role._id.equals(policy.targetRoleId));
      if (!target || (policy.creatorRoleRevision === md.revision && policy.targetRoleRevision === target.revision)) continue;
      const activeManagers = await RoleModel.countDocuments({ _id: trusted({ $in: policy.allowedManagerRoleIds }), isActive: true }).session(session);
      if (!policy.allowedManagerRoleIds.length || activeManagers !== policy.allowedManagerRoleIds.length) {
        throw new Error('Review inactive manager roles before reapproving MD policies');
      }
      changed.push(target.code);
      if (!apply) continue;
      const update = await RolePolicyModel.updateOne({ _id: policy._id, revision: policy.revision }, {
        $set: { creatorRoleRevision: md.revision, targetRoleRevision: target.revision }, $inc: { revision: 1 },
      }, { session, runValidators: true });
      if (update.modifiedCount !== 1) throw new Error('Policy changed concurrently; retry');
      await audit(session, { requestId: 'internal-repair-md-creation-policies' }, 'ROLE_CREATION_POLICY_CHANGED', root._id,
        'role_creation_policy', policy._id, { reason: 'Restore MD employee creation after role updates',
          previousCreatorRevision: String(policy.creatorRoleRevision), creatorRoleRevision: String(md.revision),
          previousTargetRevision: String(policy.targetRoleRevision), targetRoleRevision: String(target.revision),
          revision: String(policy.revision + 1) });
    }
    return { applied: apply, roles: changed.sort(), policiesUpdated: apply ? changed.length : 0 };
  });
}
