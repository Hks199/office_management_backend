import { Types, trusted, type ClientSession } from 'mongoose';
import type { PermissionCode } from '../../constants/permissions.js';
import type { Principal } from '../auth/auth.types.js';
import { ScopeService, type ScopeResource } from '../permissions/authorization.service.js';
import { UserModel } from '../users/user.model.js';
import { BranchModel } from '../branches/branch.model.js';
import { literalPrefix } from '../../shared/utils/query.js';
import { AppError } from '../../shared/errors/app-error.js';
import type { DashboardQuery } from './dashboard.types.js';
export const employeeAdapter = { ownerField: 'employeeId', branchField: 'branchId' } as const;
export const userAdapter = { ownerField: '_id', branchField: 'branchId' } as const;
export class DashboardAccess {
  private readonly scopes = new ScopeService(); private employees: Types.ObjectId[] | undefined; private branches: Types.ObjectId[] | undefined;
  constructor(readonly actor: Principal, readonly query: DashboardQuery, readonly session: ClientSession, private readonly exporting: boolean, readonly asOf = new Date()) {}
  has(permission: PermissionCode): boolean { return this.actor.grants.some((grant) => grant.permission === permission); }
  private async dashboard(resource: ScopeResource, commercial = false) {
    const parts: Record<string, unknown>[] = [];
    for (const permission of this.exporting ? ['dashboard:read', 'dashboard:export'] as const : ['dashboard:read'] as const) {
      const scope = await this.scopes.predicate(this.actor, permission, resource, this.session);
      parts.push(commercial ? { $or: [scope, await this.scopes.predicate(this.actor, permission, { ...resource, ownerField: 'assignedTo' }, this.session)] } : scope);
    }
    return { $and: parts };
  }
  async branchScope(permission: 'branches:read' | 'dashboard:read' | 'dashboard:export') {
    if (permission.startsWith('dashboard:') && !this.actor.branchId && this.actor.grants.filter((grant) => grant.permission === permission).every((grant) => grant.scope === 'SELF')) return { _id: trusted({ $in: [] }) };
    const actor = permission.startsWith('dashboard:') ? { ...this.actor, grants: this.actor.grants.map((grant) => grant.permission === permission && grant.scope === 'SELF' ? { ...grant, scope: 'BRANCH' as const } : grant) } : this.actor;
    return this.scopes.predicate(actor, permission, { branchField: '_id', hierarchyBranches: true }, this.session);
  }
  async branchFilter() {
    const parts = [await this.branchScope('branches:read'), await this.branchScope('dashboard:read')];
    if (this.exporting) parts.push(await this.branchScope('dashboard:export'));
    const filter: Record<string, unknown> = { createdAt: trusted({ $lte: this.asOf }) }; if (this.query.branchId) filter._id = new Types.ObjectId(this.query.branchId);
    for (const field of ['stateId', 'districtId', 'blockId'] as const) if (this.query[field]) filter[field] = new Types.ObjectId(this.query[field]);
    if (this.query.employeeId || this.query.roleId || this.query.managerId || this.query.search) {
      const users = await UserModel.find(await this.userFilter(false)).select('branchId').limit(1001).session(this.session).lean();
      if (users.length > 1000) throw new AppError(422, 'DASHBOARD_DIMENSION_LIMIT', 'Narrow branch employee dimensions to at most 1000 employees');
      parts.push({ _id: trusted({ $in: users.flatMap((user) => user.branchId ? [user.branchId] : []) }) });
    }
    return { $and: [...parts, filter] };
  }
  async userFilter(includeDimensions = true) {
    const match: Record<string, unknown> = { createdAt: trusted({ $lte: this.asOf }) };
    if (this.query.employeeId) match._id = new Types.ObjectId(this.query.employeeId);
    if (this.query.roleId) match.roleId = new Types.ObjectId(this.query.roleId);
    if (this.query.managerId) match.$and = [{ $or: [{ reportingManagerId: new Types.ObjectId(this.query.managerId) }, { reportingManagerIds: new Types.ObjectId(this.query.managerId) }] }];
    if (this.query.search) match.$or = [{ firstName: literalPrefix(this.query.search) }, { lastName: literalPrefix(this.query.search) }, { employeeCode: literalPrefix(this.query.search) }];
    if (includeDimensions) Object.assign(match, await this.branchDimension());
    return { $and: [match, await this.scopes.predicate(this.actor, 'users:read', userAdapter, this.session), await this.dashboard(userAdapter)] };
  }
  private async branchDimension(): Promise<Record<string, unknown>> {
    if (this.query.stateId || this.query.districtId || this.query.blockId) {
      this.branches ??= (await BranchModel.find(await this.branchFilter()).select('_id').limit(1001).session(this.session).lean()).map((row) => row._id);
      if (this.branches.length > 1000) throw new AppError(422, 'DASHBOARD_DIMENSION_LIMIT', 'Narrow branch geography to at most 1000 branches');
      return { branchId: trusted({ $in: this.branches }) };
    }
    return this.query.branchId ? { branchId: new Types.ObjectId(this.query.branchId) } : {};
  }
  private async employeeDimension(): Promise<Types.ObjectId[] | undefined> {
    if (this.query.roleId || this.query.managerId || this.query.search) {
      this.employees ??= (await UserModel.find(await this.userFilter(false)).select('_id').limit(1001).session(this.session).lean()).map((row) => row._id);
      if (this.employees.length > 1000) throw new AppError(422, 'DASHBOARD_DIMENSION_LIMIT', 'Narrow employee filters to at most 1000 employees'); return this.employees;
    }
    return this.query.employeeId ? [new Types.ObjectId(this.query.employeeId)] : undefined;
  }
  async source(permission: PermissionCode, resource: ScopeResource, commercial = false, owner = 'employeeId', dashboardResource = resource) {
    let scope = await this.scopes.predicate(this.actor, permission, resource, this.session);
    if (permission === 'imports:read') scope = { $or: [scope, { createdBy: this.actor.userId }] };
    const parts: Record<string, unknown>[] = [scope, await this.dashboard(dashboardResource, commercial), await this.branchDimension()];
    const employees = await this.employeeDimension(); if (employees) parts.push(commercial ? { $or: [{ createdBy: trusted({ $in: employees }) }, { assignedTo: trusted({ $in: employees }) }] } : { [owner]: trusted({ $in: employees }) });
    return { $and: parts };
  }
}
