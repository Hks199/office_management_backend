import { managerIds, managerSelection } from './reporting-managers.js';
import { Types, trusted, type ClientSession } from 'mongoose';
import type { AppConfig } from '../../config/env.js';
import type { Principal } from '../auth/auth.types.js';
import { AuthorizationService, ScopeService } from '../permissions/authorization.service.js';
import { OrganizationAccess } from '../../shared/services/organization-access.js';
import { AdministratorRepository } from '../../shared/repositories/administrator.repository.js';
import { UserRepository } from './user.repository.js';
import { EmployeePolicyService } from './employee-policy.service.js';
import { HierarchyRepository } from '../hierarchy/hierarchy.repository.js';
import { BranchRepository } from '../branches/branch.repository.js';
import { AuthRepository } from '../auth/auth.repository.js';
import { audit, type AuditContext } from '../activity-logs/audit.service.js';
import { randomToken, tokenHash, encryptSecret } from '../../shared/utils/crypto.js';
import { AppError } from '../../shared/errors/app-error.js';
import { isAdministrator, type PermissionCode } from '../../constants/permissions.js';
import { employeeDto, type EmployeeRecord, type EmployeeCreate, type EmployeeQuery, type EmployeeUpdate, type HierarchyQuery } from './user.types.js';
import { RolePolicyModel } from '../roles/role-policy.model.js';
import { RoleModel } from '../roles/role.model.js';

const missing = () => new AppError(404, 'NOT_FOUND', 'Employee not found');
export class UserService {
  private readonly access = new OrganizationAccess(); private readonly scopes = new ScopeService();
  private readonly authorization = new AuthorizationService(); private readonly policy = new EmployeePolicyService();
  private readonly auth = new AuthRepository(); private readonly branches = new BranchRepository();
  private readonly hierarchy = new HierarchyRepository(); private readonly administrators = new AdministratorRepository();
  constructor(private readonly config: AppConfig, private readonly repository = new UserRepository()) {}
  private readonly adapter = { ownerField: '_id', branchField: 'branchId' } as const;
  async managerOptions(actor: Principal,
    query: { roleId: string; page: number; limit: number; sortOrder: 'asc' | 'desc'; search?: string }) {
    return this.access.transaction(async (session) => {
      const current = await this.access.actor(actor, 'users:create', session);
      const roleId = new Types.ObjectId(query.roleId);
      const { policy } = await this.policy.template(current, roleId, session);
      const scope = await this.scopes.predicate(current, 'users:create', this.adapter, session);
      const candidates: Record<string, unknown>[] = [scope, { _id: current.userId }];
      const root = (await this.hierarchy.ancestors(current.userId, session)).find((ancestor) => ancestor.bootstrapKey === 'INITIAL_MD');
      if (root) {
        const manager = await this.repository.get(root._id, {}, session);
        if (manager && await this.policy.mhMdReporting(current, roleId, manager, session)) candidates.push({ _id: manager._id });
      }
      const relationships = await RolePolicyModel.find({ creatorRoleId: trusted({ $in: policy.allowedManagerRoleIds }), targetRoleId: roleId, isActive: true }).session(session).lean();
      const eligibleIds = relationships.filter((entry) => entry.allowedManagerRoleIds.some((id) => id.equals(entry.creatorRoleId))).map((entry) => entry.creatorRoleId);
      const roles = await RoleModel.find({ _id: trusted({ $in: eligibleIds }), isActive: true }).select('_id code').session(session).lean();
      const result = await this.repository.managerOptions({ $and: [{ $or: candidates }, { roleId: trusted({ $in: roles.map((role) => role._id) }) }] }, query, session);
      const codes = new Map(roles.map((role) => [role._id.toHexString(), role.code]));
      return { ...result, data: result.data.map((manager) => ({ _id: manager._id,
        label: `${manager.firstName} ${manager.lastName} (${manager.employeeCode}) — ${codes.get(manager.roleId.toHexString()) ?? ''}` })) };
    });
  }
  async branchOptions(actor: Principal,
    query: { roleId: string; page: number; limit: number; sortOrder: 'asc' | 'desc'; search?: string }) {
    return this.access.transaction(async (session) => {
      const current = await this.access.actor(actor, 'users:create', session);
      const roleId = new Types.ObjectId(query.roleId);
      const { policy } = await this.policy.template(current, roleId, session);
      const companyWide = await this.policy.companyWideCreation(current, roleId, session);
      const scope = companyWide ? {} : await this.scopes.predicate(current, 'users:create', { branchField: '_id', hierarchyBranches: true }, session);
      const selection = policy.branchRule === 'SAME_BRANCH' ? { _id: current.branchId } : {};
      return this.branches.options({ $and: [scope, selection] }, query, session);
    });
  }
  async roleOptions(actor: Principal, action: 'users:create' | 'roles:assign',
    query: { page: number; limit: number; sortOrder: 'asc' | 'desc'; search?: string }) {
    return this.access.transaction(async (session) => {
      const current = await this.access.actor(actor, action, session);
      if (action === 'roles:assign') this.authorization.requireAll(current, action);
      const policies = await RolePolicyModel.find({ creatorRoleId: current.roleId, isActive: true })
        .select('targetRoleId').session(session).lean();
      const options: { _id: Types.ObjectId; name: string; code: string; allowsNoBranch: boolean }[] = [];
      let policyReviewRequired = false;
      for (const policy of policies) {
        try {
          // Reuse the same revision, active-role and sensitive-delegation checks as mutations.
          const { role } = await this.policy.template(current, policy.targetRoleId, session);
          const search = query.search?.toLowerCase();
          if (search && !role.name.toLowerCase().startsWith(search) && !role.code.toLowerCase().startsWith(search)) continue;
          options.push({ _id: role._id, name: role.name, code: role.code, allowsNoBranch: role.allowsNoBranch });
        } catch (error) {
          if (!(error instanceof AppError) || !['ROLE_NOT_ALLOWED', 'POLICY_REAPPROVAL_REQUIRED', 'PRIVILEGE_ESCALATION'].includes(error.code)) throw error;
          if (error.code === 'POLICY_REAPPROVAL_REQUIRED') policyReviewRequired = true;
        }
      }
      options.sort((left, right) => (left.name.localeCompare(right.name) || left._id.toHexString().localeCompare(right._id.toHexString())) * (query.sortOrder === 'asc' ? 1 : -1));
      return { data: options.slice((query.page - 1) * query.limit, query.page * query.limit), total: options.length, policyReviewRequired };
    });
  }
  private async invite(id: Types.ObjectId, session: ClientSession): Promise<void> {
    const token = randomToken();
    await this.auth.queueCredential(id, 'INVITATION', tokenHash(token), encryptSecret(token, this.config.tokenEncryptionKey), new Date(Date.now() + 86400000), session);
  }

  async list(actor: Principal, query: EmployeeQuery) { return this.repository.list(await this.scopes.predicate(actor, 'users:read', this.adapter), query); }
  async get(actor: Principal, id: Types.ObjectId) {
    const user = await this.repository.get(id, await this.scopes.predicate(actor, 'users:read', this.adapter));
    if (!user) throw missing();
    const [employee] = await this.repository.withLabels([employeeDto(user)]);
    return employee;
  }
  async tree(actor: Principal, query: HierarchyQuery, includeRoot: boolean) {
    const rootId = new Types.ObjectId(query.rootId ?? query.managerId ?? actor.userId.toHexString());
    const hierarchyScope = await this.scopes.predicate(actor, 'hierarchy:read', this.adapter);
    const readScope = await this.scopes.predicate(actor, 'users:read', this.adapter);
    if (!rootId.equals(actor.userId) && !(await this.repository.get(rootId, { $and: [hierarchyScope, readScope] }))) throw missing();
    const descendants = await this.hierarchy.descendants(rootId);
    if (descendants.some((node) => node._id.equals(rootId) || node.depth >= 20)) throw new AppError(409, 'INVALID_HIERARCHY', 'Reporting hierarchy requires review');
    const visible = descendants.filter((node) => node.depth < query.depth);
    const ids = [...(includeRoot ? [rootId] : []), ...visible.map((node) => node._id)];
    const filters = { ...query }; delete filters.managerId;
    const result = await this.repository.list({ $and: [hierarchyScope, readScope] }, filters, { _id: trusted({ $in: ids }) });
    const depth = new Map(visible.map((node) => [node._id.toHexString(), node.depth + 1]));
    return { ...result, data: result.data.map((user) => ({ ...user, hierarchyDepth: depth.get(user._id.toHexString()) ?? 0 })) };
  }

  private async target(actor: Principal, id: Types.ObjectId, action: PermissionCode, revision: number, session: ClientSession) {
    const target = await this.repository.get(id, await this.scopes.predicate(actor, action, this.adapter, session), session);
    if (!target) throw missing();
    if (target.revision !== revision) throw new AppError(409, 'CONFLICT', 'Employee changed; reload their revision');
    await this.policy.canManage(actor, target, session); return target;
  }
  private async save(actor: Principal, before: EmployeeRecord, changes: Record<string, unknown>, action: string,
    reason: string, revoke: boolean, session: ClientSession, context: AuditContext) {
    const employee = await this.repository.update(before._id, before.revision, changes, revoke, session);
    if (!employee) throw new AppError(409, 'CONFLICT', 'Employee changed; reload their revision');
    if (revoke) await this.auth.revokeAll(before._id, session);
    await audit(session, context, action, actor.userId, 'user', before._id, {
      before: JSON.stringify({ roleId: before.roleId, branchId: before.branchId, reportingManagerId: before.reportingManagerId, reportingManagerIds: managerIds(before), isActive: before.isActive, employmentStatus: before.employmentStatus }),
      after: JSON.stringify({ roleId: employee.roleId, branchId: employee.branchId, reportingManagerId: employee.reportingManagerId, reportingManagerIds: managerIds(employee), isActive: employee.isActive, employmentStatus: employee.employmentStatus }),
      changedFields: Object.keys(changes).join(','), reason,
    }); return employeeDto(employee);
  }
  async create(actor: Principal, input: EmployeeCreate, context: AuditContext) {
    return this.access.transaction(async (session) => {
      const current = await this.access.actor(actor, 'users:create', session); const id = new Types.ObjectId();
      const selection = managerSelection(input);
      for (const manager of selection.reportingManagerIds) await this.policy.placement(current, 'users:create', id, new Types.ObjectId(input.roleId), input.branchId ? new Types.ObjectId(input.branchId) : null,
        manager, session, true);
      const employee = await this.repository.create({ ...input, reportingManagerId: selection.reportingManagerId.toHexString(), reportingManagerIds: selection.reportingManagerIds.map((manager) => manager.toHexString()) }, id, current.userId, session);
      await this.invite(id, session);
      await audit(session, context, 'EMPLOYEE_CREATED', current.userId, 'user', id,
        { roleId: input.roleId, branchId: input.branchId ?? 'none', reportingManagerIds: selection.reportingManagerIds.map((manager) => manager.toHexString()).join(',') });
      return { ...employeeDto(employee), invitationStatus: 'PENDING' };
    });
  }
  async update(actor: Principal, id: Types.ObjectId, input: EmployeeUpdate, context: AuditContext) {
    return this.access.transaction(async (session) => {
      const { revision, ...changes } = input;
      const current = await this.access.actor(actor, 'users:update', session); const previous = await this.target(current, id, 'users:update', revision, session);
      const contactChanged = (input.email !== undefined && input.email !== previous.email) || (input.mobileNumber !== undefined && input.mobileNumber !== previous.mobileNumber);
      if (contactChanged) {
        await this.auth.invalidateCredentials(id, session);
        if (previous.isActive && previous.employmentStatus !== 'EXITED' && !(await this.repository.hasPassword(id, session))) await this.invite(id, session);
      }
      return this.save(current, previous, changes, 'EMPLOYEE_UPDATED', 'Authorized profile update', contactChanged, session, context);
    });
  }
  async manager(actor: Principal, id: Types.ObjectId, revision: number, managerId: string | string[], reason: string, context: AuditContext) {
    return this.access.transaction(async (session) => {
      const current = await this.access.actor(actor, 'users:change_manager', session); const previous = await this.target(current, id, 'users:change_manager', revision, session);
      if (previous.bootstrapKey) throw new AppError(403, 'ROOT_PROTECTED', 'The bootstrap root cannot be assigned a manager');
      const selection = managerSelection(Array.isArray(managerId) ? { reportingManagerIds: managerId } : { reportingManagerId: managerId });
      for (const manager of selection.reportingManagerIds) await this.policy.placement(current, 'users:change_manager', id, previous.roleId, previous.branchId ?? null, manager, session, false);
      return this.save(current, previous, selection, 'EMPLOYEE_MANAGER_CHANGED', reason, true, session, context);
    });
  }
  async transfer(actor: Principal, id: Types.ObjectId, revision: number, branchId: string | null, managerId: string | string[], reason: string, context: AuditContext) {
    return this.access.transaction(async (session) => {
      const current = await this.access.actor(actor, 'users:transfer', session); const previous = await this.target(current, id, 'users:transfer', revision, session);
      if (previous.bootstrapKey) throw new AppError(403, 'ROOT_PROTECTED', 'The bootstrap root remains company-wide');
      if (await this.branches.headedBy(id, session)) throw new AppError(409, 'BRANCH_HEAD_IN_USE', 'Reassign the branch head before transfer');
      const newBranch = branchId ? new Types.ObjectId(branchId) : null;
      const selection = managerSelection(Array.isArray(managerId) ? { reportingManagerIds: managerId } : { reportingManagerId: managerId });
      for (const manager of selection.reportingManagerIds) await this.policy.placement(current, 'users:transfer', id, previous.roleId, newBranch, manager, session, false);
      await this.policy.childrenCompatible({ ...previous, branchId: newBranch, ...selection }, session);
      return this.save(current, previous, { branchId: newBranch, ...selection }, 'EMPLOYEE_TRANSFERRED', reason, true, session, context);
    });
  }
  async status(actor: Principal, id: Types.ObjectId, revision: number, isActive: boolean, employmentStatus: 'ACTIVE' | 'ON_LEAVE' | 'EXITED', reason: string, context: AuditContext) {
    return this.access.transaction(async (session) => {
      const current = await this.access.actor(actor, 'users:deactivate', session); const previous = await this.target(current, id, 'users:deactivate', revision, session);
      if (!isActive) {
        const grants = await this.authorization.grants(previous.roleId, session);
        if (grants && isAdministrator(grants) && !(await this.administrators.exists(session, id))) throw new AppError(409, 'LAST_ADMINISTRATOR', 'At least one active administrator must remain');
        if (await this.branches.headedBy(id, session)) throw new AppError(409, 'BRANCH_HEAD_IN_USE', 'Reassign the branch head first');
        if ((await this.repository.children(id, session)).length) throw new AppError(409, 'ACTIVE_REPORTS', 'Reassign active direct reports first');
        await this.auth.invalidateCredentials(id, session);
      } else {
        await this.policy.branch(previous.roleId, previous.branchId ?? null, session);
        if (!previous.bootstrapKey) {
          if (!previous.reportingManagerId) throw new AppError(400, 'INVALID_MANAGER', 'Reporting manager is required');
          for (const manager of managerIds(previous)) await this.policy.placement(current, 'users:deactivate', id, previous.roleId, previous.branchId ?? null, manager, session, false);
        }
        if (!previous.isActive && !(await this.repository.hasPassword(id, session))) await this.invite(id, session);
      }
      return this.save(current, previous, { isActive, employmentStatus }, 'EMPLOYEE_STATUS_CHANGED', reason, true, session, context);
    });
  }
  async role(actor: Principal, id: Types.ObjectId, revision: number, roleId: string, reason: string, context: AuditContext) {
    return this.access.transaction(async (session) => {
      const current = await this.access.actor(actor, 'roles:assign', session); this.authorization.requireAll(current, 'roles:assign');
      // roles:assign is global administrative authority; source and destination templates are still validated.
      const previous = await this.repository.get(id, {}, session); if (!previous) throw missing();
      if (previous.revision !== revision) throw new AppError(409, 'CONFLICT', 'Employee changed; reload their revision');
      if (previous.bootstrapKey) throw new AppError(403, 'ROOT_PROTECTED', 'The bootstrap root role cannot change');
      const nextRole = new Types.ObjectId(roleId); await this.policy.template(current, nextRole, session);
      const oldGrants = await this.authorization.grants(previous.roleId, session); const nextGrants = await this.authorization.grants(nextRole, session);
      if (oldGrants && isAdministrator(oldGrants) && (!nextGrants || !isAdministrator(nextGrants)) && !(await this.administrators.exists(session, id))) {
        throw new AppError(409, 'LAST_ADMINISTRATOR', 'At least one active administrator must remain');
      }
      if (!previous.reportingManagerId) throw new AppError(400, 'INVALID_MANAGER', 'Reporting manager is required');
      for (const manager of managerIds(previous)) await this.policy.placement(current, 'roles:assign', id, nextRole, previous.branchId ?? null, manager, session, true);
      if (await this.branches.headedBy(id, session) && !nextGrants?.some((grant) => grant.permission === 'branches:update' && ['ALL', 'BRANCH'].includes(grant.scope))) {
        throw new AppError(409, 'BRANCH_HEAD_IN_USE', 'New role cannot manage the assigned branch');
      }
      await this.policy.childrenCompatible({ ...previous, roleId: nextRole }, session);
      return this.save(current, previous, { roleId: nextRole }, 'EMPLOYEE_ROLE_CHANGED', reason, true, session, context);
    });
  }
}
