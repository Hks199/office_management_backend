import { Types, trusted, type ClientSession } from 'mongoose';
import { PermissionRepository } from './permission.repository.js';
import { HierarchyRepository } from '../hierarchy/hierarchy.repository.js';
import { UserModel } from '../users/user.model.js';
import { RoleModel } from '../roles/role.model.js';
import { BranchModel } from '../branches/branch.model.js';
import { isPermissionCode, permissionDefinition, type Grant, type PermissionCode } from '../../constants/permissions.js';
import type { Principal } from '../auth/auth.types.js';
import { AppError } from '../../shared/errors/app-error.js';
import { blockedPanelPermission } from '../auth/employee-panel-context.js';

export class AuthorizationService {
  constructor(private readonly repository = new PermissionRepository()) {}
  async grants(roleId: Types.ObjectId, session?: ClientSession): Promise<Grant[] | null> {
    const role = await this.repository.role(roleId, session);
    if (!role) return null;
    const definitions = await this.repository.definitions(role.permissions.map((grant) => grant.permissionId), session);
    const byId = new Map(definitions.map((definition) => [definition._id.toHexString(), definition.code]));
    const grants: Grant[] = [];
    for (const grant of role.permissions) {
      const code = byId.get(grant.permissionId.toHexString());
      if (code && isPermissionCode(code) && permissionDefinition(code).allowedScopes.includes(grant.scope)) {
        grants.push({ permission: code, scope: grant.scope });
      }
    }
    return grants;
  }

  require(principal: Principal, action: PermissionCode): void {
    if (principal.employeePanel && blockedPanelPermission(action)) throw new AppError(403, 'EMPLOYEE_PANEL_RESTRICTED', 'This action requires the account owner');
    if (!principal.grants.some((grant) => grant.permission === action)) throw new AppError(403, 'FORBIDDEN', 'Access denied');
  }
  requireAll(principal: Principal, action: PermissionCode): void {
    if (principal.employeePanel && blockedPanelPermission(action)) throw new AppError(403, 'EMPLOYEE_PANEL_RESTRICTED', 'This action requires the account owner');
    if (!principal.grants.some((grant) => grant.permission === action && grant.scope === 'ALL')) {
      throw new AppError(403, 'FORBIDDEN', 'Access denied');
    }
  }
}

export interface ScopeResource {
  ownerField?: '_id' | 'employeeId' | 'salesExecutiveId' | 'createdBy' | 'assignedTo';
  assigneeField?: 'assignedTo'; branchField?: 'branchId' | '_id';
  hierarchyBranches?: boolean;
  managedLeadBranches?: boolean;
  hierarchyField?: '_id' | 'employeeId' | 'salesExecutiveId' | 'assignedTo' | 'createdBy';
}
export type ScopePredicate = Record<string, unknown>;

export class ScopeService {
  constructor(private readonly repository = new HierarchyRepository()) {}
  async predicate(principal: Principal, action: PermissionCode, resource: ScopeResource, session?: ClientSession): Promise<ScopePredicate> {
    const grants = principal.grants.filter((grant) => grant.permission === action);
    if (!grants.length) throw new AppError(403, 'FORBIDDEN', 'Access denied');
    const predicates: ScopePredicate[] = [];
    for (const grant of grants) {
      if (grant.scope === 'ALL') return {};
      if (grant.scope === 'SELF' && resource.ownerField) predicates.push({ [resource.ownerField]: principal.userId });
      if (grant.scope === 'ASSIGNED' && resource.assigneeField) predicates.push({ [resource.assigneeField]: principal.userId });
      if (grant.scope === 'BRANCH' && resource.branchField && principal.branchId) predicates.push({ [resource.branchField]: principal.branchId });
      const hierarchyField = resource.hierarchyField ?? resource.ownerField;
      if ((grant.scope === 'DIRECT_REPORTS' || grant.scope === 'REPORTING_SUBTREE') && hierarchyField) {
        const ids = await this.descendants(principal.userId, grant.scope === 'DIRECT_REPORTS', session);
        predicates.push({ [hierarchyField]: trusted({ $in: ids }) });
      }
      if ((grant.scope === 'DIRECT_REPORTS' || grant.scope === 'REPORTING_SUBTREE') && resource.managedLeadBranches && resource.branchField) {
        predicates.push({ [resource.branchField]: trusted({ $in: await this.leadBranches(principal.userId, grant.scope === 'DIRECT_REPORTS', session) }) });
      }
      if ((grant.scope === 'DIRECT_REPORTS' || grant.scope === 'REPORTING_SUBTREE') && resource.hierarchyBranches) {
        const ids = await this.descendants(principal.userId, grant.scope === 'DIRECT_REPORTS', session);
        const branches = await this.repository.branches(ids, session);
        // Placement already allows the actor's primary branch. Include it in the
        // directory too, so a manager can create their first subordinate there.
        if (principal.branchId && !branches.some((id) => id.equals(principal.branchId))) branches.push(principal.branchId);
        predicates.push({ _id: trusted({ $in: branches }) });
      }
    }
    if (!predicates.length) throw new AppError(403, 'FORBIDDEN', 'Scope is not supported for this resource');
    return { $or: predicates };
  }
  async descendants(managerId: Types.ObjectId, direct: boolean, session?: ClientSession): Promise<Types.ObjectId[]> {
    if (direct) return this.repository.directReports(managerId, session);
    const descendants = await this.repository.descendants(managerId, session);
    if (descendants.some((user) => user.depth >= 20 || user._id.equals(managerId))) {
      throw new AppError(409, 'INVALID_HIERARCHY', 'Reporting hierarchy requires review');
    }
    return descendants.map((user) => user._id);
  }
  async leadBranches(managerId: Types.ObjectId, direct: boolean, session?: ClientSession): Promise<Types.ObjectId[]> {
    const descendants = await this.descendants(managerId, direct, session);
    if (!descendants.length) return [];
    const role = await RoleModel.findOne({ code: 'BH', isActive: true }).select('_id').session(session ?? null).lean();
    if (!role) return [];
    const heads = await UserModel.find({ _id: trusted({ $in: descendants }), roleId: role._id, isActive: true, employmentStatus: 'ACTIVE' })
      .select('_id branchId').session(session ?? null).lean();
    const branches = await BranchModel.find({ isActive: true, $or: [{ branchHeadId: trusted({ $in: heads.map((head) => head._id) }) },
      { branchHeadId: null, _id: trusted({ $in: heads.flatMap((head) => head.branchId ? [head.branchId] : []) }) }] }).select('_id').session(session ?? null).lean();
    return branches.map((branch) => branch._id);
  }
  combine(scope: ScopePredicate, filters: ScopePredicate): ScopePredicate { return { $and: [scope, filters] }; }
}
