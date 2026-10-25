import { runInternal } from './run-internal.js';
import { RoleModel } from '../modules/roles/role.model.js';
import { RolePolicyModel } from '../modules/roles/role-policy.model.js';

runInternal(async () => {
  const roles = await RoleModel.find().select('code revision isActive').lean();
  const md = roles.find((role) => role.code === 'MD');
  if (!md) throw new Error('MD role missing');
  const policies = await RolePolicyModel.find({ creatorRoleId: md._id }).lean();
  process.stdout.write(`${JSON.stringify({ mdRevision: md.revision, policies: policies.map((policy) => {
    const target = roles.find((role) => role._id.equals(policy.targetRoleId));
    return { target: target?.code, active: policy.isActive, creatorRevision: policy.creatorRoleRevision,
      targetRevision: policy.targetRoleRevision, actualTargetRevision: target?.revision };
  }) })}\n`);
});
