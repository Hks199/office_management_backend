import { trusted } from 'mongoose';
import { BranchModel } from '../branches/branch.model.js';
import { StateModel, DistrictModel, BlockModel } from '../locations/location.model.js';
import { RoleModel } from '../roles/role.model.js';
import { RolePolicyModel } from '../roles/role-policy.model.js';
export async function createOrganizationIndexes(): Promise<void> {
  for (const model of [BranchModel, StateModel, DistrictModel, BlockModel]) { await model.createCollection(); await model.createIndexes(); }
  // Add metadata to Phase 2 rows without silently approving changed role grants.
  await RoleModel.updateMany({ allowsNoBranch: trusted({ $exists: false }) }, { $set: { allowsNoBranch: false } });
  await RoleModel.updateMany({ isSystemRole: true, code: trusted({ $in: ['MD', 'BDO', 'MH'] }), revision: 0 }, { $set: { allowsNoBranch: true } });
  await RolePolicyModel.updateMany({ creatorRoleRevision: trusted({ $exists: false }) }, { $set: { creatorRoleRevision: 0 } });
  await RolePolicyModel.updateMany({ targetRoleRevision: trusted({ $exists: false }) }, { $set: { targetRoleRevision: 0 } });
  // Upgrade only untouched default MH policies. Preserve administrator revisions,
  // inactive policies and custom branch rules, and never reapprove changed roles.
  const marketing = await RoleModel.findOne({ code: 'MH', isSystemRole: true, revision: 0, allowsNoBranch: true }).select('_id').lean();
  if (marketing) {
    const targets = await RoleModel.find({ code: trusted({ $in: ['BH', 'SEX', 'TC'] }), isSystemRole: true, revision: 0 }).select('_id').lean();
    await RolePolicyModel.updateMany({ creatorRoleId: marketing._id, targetRoleId: trusted({ $in: targets.map((role) => role._id) }),
      allowedManagerRoleIds: marketing._id, revision: 0, creatorRoleRevision: 0, targetRoleRevision: 0,
      isActive: true, branchRule: 'EXPLICIT_SCOPE', allowCrossBranchReporting: false },
    { $set: { allowCrossBranchReporting: true }, $inc: { revision: 1 } });
  }
}
