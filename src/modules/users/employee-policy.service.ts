import { Types, type ClientSession } from 'mongoose';
import type { Principal } from '../auth/auth.types.js';
import type { EmployeeRecord } from './user.types.js';
import { UserRepository } from './user.repository.js';
import { BranchRepository } from '../branches/branch.repository.js';
import { HierarchyRepository } from '../hierarchy/hierarchy.repository.js';
import { AppError } from '../../shared/errors/app-error.js';
import { permissionDefinition, type PermissionCode } from '../../constants/permissions.js';
import { AuthorizationService } from '../permissions/authorization.service.js';

export class EmployeePolicyService {
  private readonly branches = new BranchRepository(); private readonly hierarchy = new HierarchyRepository();
  constructor(private readonly repository = new UserRepository()) {}
  async template(actor: Principal, targetRoleId: Types.ObjectId, session: ClientSession) {
    const creator = await this.repository.role(actor.roleId, session);
    const target = await this.repository.role(targetRoleId, session);
    const policy = await this.repository.policy(actor.roleId, targetRoleId, session);
    if (!creator || !target || target.code === 'MD' || !policy) throw new AppError(403, 'ROLE_NOT_ALLOWED', 'Role is not an approved subordinate template');
    if (policy.creatorRoleRevision !== creator.revision || policy.targetRoleRevision !== target.revision) {
      throw new AppError(409, 'POLICY_REAPPROVAL_REQUIRED', 'Role changed; an administrator must reapprove its creation policy');
    }
    const targetGrants = await new AuthorizationService().grants(targetRoleId, session);
    if (targetGrants?.some((grant) => permissionDefinition(grant.permission).sensitive || (grant.scope === 'ALL' && grant.permission !== 'locations:read')) &&
      !actor.grants.some((grant) => grant.permission === 'permissions:delegate_sensitive' && grant.scope === 'ALL')) {
      throw new AppError(403, 'PRIVILEGE_ESCALATION', 'Sensitive or company-wide templates require explicit sensitive delegation');
    }
    return { role: target, policy };
  }
  async canManage(actor: Principal, target: EmployeeRecord, session: ClientSession): Promise<void> {
    if (actor.grants.some((grant) => grant.permission === 'users:create' && grant.scope === 'ALL') &&
      actor.grants.some((grant) => grant.permission === 'permissions:delegate_sensitive' && grant.scope === 'ALL')) return;
    // Branch visibility alone must not allow editing an administrator or a peer manager.
    await this.template(actor, target.roleId, session);
  }
  async companyWideCreation(actor: Principal, targetRoleId: Types.ObjectId, session: ClientSession): Promise<boolean> {
    const { policy } = await this.template(actor, targetRoleId, session);
    const creator = await this.repository.role(actor.roleId, session);
    // Company-wide BDO and MH managers must be able to establish their first team.
    // This exception applies only to approved creation templates, never transfers
    // or reads of employees outside the reporting hierarchy.
    return actor.branchId === null && (creator?.code === 'BDO' || creator?.code === 'MH') && creator.allowsNoBranch &&
      policy.branchRule === 'EXPLICIT_SCOPE' && policy.allowCrossBranchReporting &&
      policy.allowedManagerRoleIds.some((id) => id.equals(actor.roleId)) &&
      actor.grants.some((grant) => grant.permission === 'users:create' && grant.scope === 'REPORTING_SUBTREE');
  }
  async mhMdReporting(actor: Principal, targetRoleId: Types.ObjectId, manager: EmployeeRecord, session: ClientSession): Promise<boolean> {
    if (manager.bootstrapKey !== 'INITIAL_MD' || manager.reportingManagerId || !manager.isActive || manager.employmentStatus === 'EXITED') return false;
    const { role, policy } = await this.template(actor, targetRoleId, session);
    const creator = await this.repository.role(actor.roleId, session);
    const managerRole = await this.repository.role(manager.roleId, session);
    return role.code === 'MH' && creator?.code === 'BDO' && managerRole?.code === 'MD' &&
      policy.allowedManagerRoleIds.some((id) => id.equals(manager.roleId)) &&
      actor.grants.some((grant) => grant.permission === 'users:create' && grant.scope === 'REPORTING_SUBTREE') &&
      (await this.hierarchy.ancestors(actor.userId, session)).some((ancestor) => ancestor._id.equals(manager._id));
  }
  async destination(actor: Principal, action: PermissionCode, branchId: Types.ObjectId | null,
    manager: EmployeeRecord, session: ClientSession, companyWideCreation = false, allowMdManager = false): Promise<void> {
    const descendantIds = actor.grants.some((grant) => grant.permission === action && grant.scope === 'REPORTING_SUBTREE') ?
      (await this.hierarchy.descendants(actor.userId, session)).map((user) => user._id.toHexString()) : [];
    const directIds = actor.grants.some((grant) => grant.permission === action && grant.scope === 'DIRECT_REPORTS') ? await this.hierarchy.directReports(actor.userId, session) : [];
    const branches = await this.hierarchy.branches([...descendantIds.map((id) => new Types.ObjectId(id)), ...directIds], session);
    const branchAllowed = companyWideCreation || (branchId ? (actor.branchId?.equals(branchId) || branches.some((id) => id.equals(branchId))) : actor.branchId === null);
    const allowed = actor.grants.some((grant) => grant.permission === action && (
      grant.scope === 'ALL' || (grant.scope === 'BRANCH' && branchId !== null && actor.branchId?.equals(branchId) && manager.branchId?.equals(branchId)) ||
      (grant.scope === 'DIRECT_REPORTS' && branchAllowed && manager._id.equals(actor.userId)) ||
      (grant.scope === 'REPORTING_SUBTREE' && branchAllowed && (allowMdManager || manager._id.equals(actor.userId) || descendantIds.includes(manager._id.toHexString())))
    ));
    if (!allowed) throw new AppError(403, 'DESTINATION_FORBIDDEN', 'New branch and manager are outside your authorized scope');
  }
  async branch(roleId: Types.ObjectId, branchId: Types.ObjectId | null, session: ClientSession): Promise<void> {
    const role = await this.repository.role(roleId, session);
    if (!role) throw new AppError(400, 'INVALID_ROLE', 'Role must be active');
    if (!branchId) {
      if (!role.allowsNoBranch) throw new AppError(400, 'BRANCH_REQUIRED', 'This role requires a primary branch');
    } else if (!(await this.branches.get(branchId, {}, session))?.isActive) throw new AppError(400, 'INVALID_BRANCH', 'Branch must be active');
  }
  async edge(manager: EmployeeRecord, employeeRoleId: Types.ObjectId, branchId: Types.ObjectId | null, session: ClientSession): Promise<void> {
    const policy = await this.repository.policy(manager.roleId, employeeRoleId, session);
    if (!manager.isActive || manager.employmentStatus === 'EXITED' || !(await this.repository.role(manager.roleId, session)) ||
      !policy || !policy.allowedManagerRoleIds.some((id) => id.equals(manager.roleId))) {
      throw new AppError(400, 'INVALID_MANAGER', 'Manager role is not an active permitted reporting relationship');
    }
    const sameBranch = manager.branchId?.equals(branchId ?? new Types.ObjectId()) ?? branchId === null;
    if (!sameBranch && !policy.allowCrossBranchReporting) throw new AppError(400, 'CROSS_BRANCH_REPORTING', 'Cross-branch reporting requires an explicit relationship policy');
  }
  async placement(actor: Principal, action: PermissionCode, employeeId: Types.ObjectId, roleId: Types.ObjectId,
    branchId: Types.ObjectId | null, managerId: Types.ObjectId, session: ClientSession, checkTemplate: boolean): Promise<void> {
    if (managerId.equals(employeeId)) throw new AppError(409, 'HIERARCHY_CYCLE', 'Employee cannot report to themselves');
    const manager = await this.repository.get(managerId, {}, session);
    if (!manager) throw new AppError(400, 'INVALID_MANAGER', 'Manager must be active and authorized');
    await this.branch(roleId, branchId, session);
    const companyWideCreation = action === 'users:create' && checkTemplate && await this.companyWideCreation(actor, roleId, session);
    const allowMdManager = action === 'users:create' && checkTemplate && await this.mhMdReporting(actor, roleId, manager, session);
    await this.destination(actor, action, branchId, manager, session, companyWideCreation, allowMdManager);
    if (checkTemplate) {
      const { policy } = await this.template(actor, roleId, session);
      if (!policy.allowedManagerRoleIds.some((id) => id.equals(manager.roleId))) throw new AppError(403, 'MANAGER_ROLE_NOT_ALLOWED', 'Manager role is not approved for this template');
      if (policy.branchRule === 'SAME_BRANCH' && (!branchId || !actor.branchId?.equals(branchId))) throw new AppError(403, 'DESTINATION_FORBIDDEN', 'Creation policy requires your primary branch');
    }
    await this.edge(manager, roleId, branchId, session);
    const ancestors = await this.hierarchy.ancestors(managerId, session);
    if (!(manager.bootstrapKey && !manager.reportingManagerId) && !ancestors.some((node) => node.bootstrapKey === 'INITIAL_MD' && !node.reportingManagerId)) {
      throw new AppError(400, 'INVALID_MANAGER', 'Reporting chain must reach the bootstrap root');
    }
    if (ancestors.some((node) => node._id.equals(employeeId) || node._id.equals(managerId))) throw new AppError(409, 'HIERARCHY_CYCLE', 'Reporting relationship would create a cycle');
    if (ancestors.some((node) => !node.isActive || node.employmentStatus === 'EXITED')) throw new AppError(400, 'INVALID_MANAGER', 'Reporting chain contains inactive employees');
    const descendants = await this.hierarchy.descendants(employeeId, session);
    const height = descendants.reduce((max, node) => Math.max(max, node.depth + 1), 0);
    if (ancestors.reduce((max, node) => Math.max(max, node.depth + 1), 0) + 1 + height > 20) throw new AppError(409, 'HIERARCHY_TOO_DEEP', 'Reporting hierarchy is limited to 20 levels');
  }
  async childrenCompatible(employee: EmployeeRecord, session: ClientSession): Promise<void> {
    for (const child of await this.repository.children(employee._id, session)) await this.edge(employee, child.roleId, child.branchId ?? null, session);
  }
}
