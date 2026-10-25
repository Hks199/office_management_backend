import { Types, trusted, type ClientSession } from 'mongoose';
import type { Principal } from '../auth/auth.types.js';
import type { PermissionCode } from '../../constants/permissions.js';
import { AuthorizationService, ScopeService } from '../permissions/authorization.service.js';
import { BranchModel } from '../branches/branch.model.js';
import { UserModel } from '../users/user.model.js';
import { RoleModel } from '../roles/role.model.js';
import { AppError } from '../../shared/errors/app-error.js';
export const commercialAdapter = { ownerField: 'createdBy', assigneeField: 'assignedTo', hierarchyField: 'assignedTo', branchField: 'branchId' } as const;
export const leadAdapter = { ...commercialAdapter, managedLeadBranches: true } as const;
export class CommercialAccess {
  readonly scopes = new ScopeService(); readonly authorization = new AuthorizationService();
  async recipient(id: Types.ObjectId, branchId: Types.ObjectId, kind: 'customers' | 'leads', session: ClientSession) {
    const user = await UserModel.findOne({ _id: id, branchId, isActive: true, employmentStatus: 'ACTIVE' }).session(session).lean();
    const grants = user ? await this.authorization.grants(user.roleId, session) : null;
    const eligibleRole = kind !== 'leads' || (user && await RoleModel.exists({ _id: user.roleId, code: 'SEX', isActive: true }).session(session));
    if (!user || !eligibleRole || !grants?.some((grant) => grant.permission === `${kind}:receive_assignment`) ||
      !grants.some((grant) => grant.permission === `${kind}:read` && ['ASSIGNED', 'ALL', 'BRANCH'].includes(grant.scope))) {
      throw new AppError(400, 'INVALID_ASSIGNEE', 'Select an active eligible employee in the record branch');
    }
    return user;
  }
  async destination(actor: Principal, action: PermissionCode, branchId: Types.ObjectId, assignedTo: Types.ObjectId | null, session: ClientSession): Promise<void> {
    if (!await BranchModel.exists({ _id: branchId, isActive: true }).session(session)) throw new AppError(400, 'INVALID_BRANCH', 'Branch must be active');
    for (const grant of actor.grants.filter((entry) => entry.permission === action)) {
      if (grant.scope === 'ALL' || (grant.scope === 'BRANCH' && actor.branchId?.equals(branchId))) return;
      if (action.startsWith('leads:') && (grant.scope === 'DIRECT_REPORTS' || grant.scope === 'REPORTING_SUBTREE') &&
        (await this.scopes.leadBranches(actor.userId, grant.scope === 'DIRECT_REPORTS', session)).some((id) => id.equals(branchId))) return;
      if (assignedTo && (grant.scope === 'SELF' || grant.scope === 'ASSIGNED') && assignedTo.equals(actor.userId) && actor.branchId?.equals(branchId)) return;
      if (assignedTo && (grant.scope === 'DIRECT_REPORTS' || grant.scope === 'REPORTING_SUBTREE')) {
        const ids = await this.scopes.descendants(actor.userId, grant.scope === 'DIRECT_REPORTS', session);
        if (ids.some((id) => id.equals(assignedTo))) return;
      }
    }
    throw new AppError(403, 'FORBIDDEN_DESTINATION', 'Destination is outside your authorized scope');
  }
  async importBranch(actor: Principal, action: PermissionCode, branchId: Types.ObjectId, session: ClientSession): Promise<void> {
    if (!await BranchModel.exists({ _id: branchId, isActive: true }).session(session)) throw new AppError(400, 'INVALID_BRANCH', 'Branch must be active');
    for (const grant of actor.grants.filter((entry) => entry.permission === action)) {
      if (grant.scope === 'ALL' || (['SELF', 'BRANCH'].includes(grant.scope) && actor.branchId?.equals(branchId))) return;
      if (grant.scope === 'DIRECT_REPORTS' || grant.scope === 'REPORTING_SUBTREE') {
        const ids = await this.scopes.descendants(actor.userId, grant.scope === 'DIRECT_REPORTS', session);
        if (await UserModel.exists({ _id: trusted({ $in: ids }), branchId }).session(session)) return;
      }
    }
    throw new AppError(403, 'FORBIDDEN', 'Import branch is outside your authorized scope');
  }
}
