import mongoose from 'mongoose';
import { isAdministrator } from '../../constants/permissions.js';
import { audit } from '../activity-logs/audit.service.js';
import { SecurityStateModel } from '../auth/auth.models.js';
import { RoleModel } from '../roles/role.model.js';
import { RolePolicyModel } from '../roles/role-policy.model.js';
import { UserModel } from '../users/user.model.js';
import { AuthorizationService } from './authorization.service.js';

/** Copies the current MH permission template, without changing reporting relationships. */
export async function alignBdoPermissions(apply = false) {
  return mongoose.connection.transaction(async (session) => {
    const root = await UserModel.findOne({ bootstrapKey: 'INITIAL_MD', isActive: true })
      .select('+passwordHash').session(session).lean();
    if (!root?.passwordHash || !isAdministrator(await new AuthorizationService().grants(root.roleId, session) ?? [])) {
      throw new Error('An active initialized bootstrap administrator is required');
    }
    const bdo = await RoleModel.findOne({ code: 'BDO', isSystemRole: true, isActive: true }).session(session).lean();
    const mh = await RoleModel.findOne({ code: 'MH', isSystemRole: true, isActive: true }).session(session).lean();
    if (!bdo || !mh) throw new Error('Active BDO and MH system roles are required');
    const keys = (grants: typeof bdo.permissions) => grants.map((grant) => `${grant.permissionId.toHexString()}:${grant.scope}`).sort();
    const before = keys(bdo.permissions); const after = keys(mh.permissions);
    const added = after.filter((key) => !before.includes(key)).length;
    const removed = before.filter((key) => !after.includes(key)).length;
    if (!added && !removed) return { changed: false, applied: false, added, removed, policiesUpdated: 0 };
    if (!apply) return { changed: true, applied: false, added, removed, policiesUpdated: 0 };

    await SecurityStateModel.updateOne({ _id: 'administration' }, { $inc: { revision: 1 } }, { upsert: true, session });
    await SecurityStateModel.updateOne({ _id: 'hierarchy' }, { $inc: { revision: 1 } }, { upsert: true, session });
    const result = await RoleModel.updateOne({ _id: bdo._id, revision: bdo.revision }, {
      $set: { permissions: mh.permissions }, $inc: { revision: 1 },
    }, { session, runValidators: true });
    if (result.modifiedCount !== 1) throw new Error('BDO role changed concurrently; retry');

    // Preserve currently approved policies only. Never reapprove an already stale policy.
    const policies = await RolePolicyModel.find({ isActive: true,
      $or: [{ creatorRoleId: bdo._id }, { targetRoleId: bdo._id }],
    }).session(session).lean();
    let policiesUpdated = 0;
    for (const policy of policies) {
      const creator = await RoleModel.findById(policy.creatorRoleId).session(session).lean();
      const target = await RoleModel.findById(policy.targetRoleId).session(session).lean();
      if (!creator?.isActive || !target?.isActive) continue;
      const oldCreatorRevision = creator._id.equals(bdo._id) ? bdo.revision : creator.revision;
      const oldTargetRevision = target._id.equals(bdo._id) ? bdo.revision : target.revision;
      if (policy.creatorRoleRevision !== oldCreatorRevision || policy.targetRoleRevision !== oldTargetRevision) continue;
      await RolePolicyModel.updateOne({ _id: policy._id, revision: policy.revision }, {
        $set: { creatorRoleRevision: creator.revision, targetRoleRevision: target.revision }, $inc: { revision: 1 },
      }, { session });
      policiesUpdated++;
      await audit(session, { requestId: 'internal-align-bdo-permissions' }, 'POLICY_UPDATED', root._id, 'role_policy', policy._id,
        { reason: 'Preserve approved policy after BDO permission alignment', revision: String(policy.revision + 1) });
    }
    await audit(session, { requestId: 'internal-align-bdo-permissions' }, 'PERMISSION_CHANGED', root._id, 'role', bdo._id,
      { sourceRole: 'MH', beforeGrants: before.join(','), afterGrants: after.join(','),
        previousRevision: String(bdo.revision), revision: String(bdo.revision + 1) });
    return { changed: true, applied: true, added, removed, policiesUpdated };
  });
}
