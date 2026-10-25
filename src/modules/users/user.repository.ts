import { managerIds } from './reporting-managers.js';
import { Types, trusted, type ClientSession } from 'mongoose';
import { UserModel } from './user.model.js';
import { RoleModel } from '../roles/role.model.js';
import { RolePolicyModel } from '../roles/role-policy.model.js';
import { BranchModel } from '../branches/branch.model.js';
import type { ScopePredicate } from '../permissions/authorization.service.js';
import { literalPrefix } from '../../shared/utils/query.js';
import { EMPLOYEE_PUBLIC_FIELDS, type EmployeeCreate, type EmployeeQuery } from './user.types.js';

export class UserRepository {
  async withLabels<T extends { roleId: Types.ObjectId; branchId?: Types.ObjectId | null | undefined; reportingManagerId?: Types.ObjectId | null | undefined; reportingManagerIds?: Types.ObjectId[] | undefined }>(employees: T[]) {
    if (!employees.length) return [];
    const ids = (values: (Types.ObjectId | null | undefined)[]) => [...new Set(values.filter((id): id is Types.ObjectId => Boolean(id)).map((id) => id.toHexString()))].map((id) => new Types.ObjectId(id));
    // Enrich only the already-authorized page. These projections expose names,
    // never related-role grants, branch configuration or manager contact details.
    const [roles, branches, managers] = await Promise.all([
      RoleModel.find({ _id: trusted({ $in: ids(employees.map((employee) => employee.roleId)) }) }).select('_id name code').lean(),
      BranchModel.find({ _id: trusted({ $in: ids(employees.map((employee) => employee.branchId)) }) }).select('_id branchName branchCode').lean(),
      UserModel.find({ _id: trusted({ $in: ids(employees.flatMap((employee) => managerIds(employee))) }) }).select('_id firstName lastName employeeCode').lean(),
    ]);
    const roleNames = new Map(roles.map((role) => [role._id.toHexString(), role]));
    const branchNames = new Map(branches.map((branch) => [branch._id.toHexString(), branch]));
    const managerNames = new Map(managers.map((manager) => [manager._id.toHexString(), manager]));
    return employees.map((employee) => {
      const role = roleNames.get(employee.roleId.toHexString());
      const branch = employee.branchId ? branchNames.get(employee.branchId.toHexString()) : undefined;
      const manager = employee.reportingManagerId ? managerNames.get(employee.reportingManagerId.toHexString()) : undefined;
      return { ...employee, reportingManagerIds: managerIds(employee), roleName: role?.name ?? null, roleCode: role?.code ?? null,
        branchName: branch?.branchName ?? null, branchCode: branch?.branchCode ?? null,
        reportingManagerName: manager ? `${manager.firstName} ${manager.lastName}` : null,
        reportingManagerCode: manager?.employeeCode ?? null,
        reportingManagerNames: managerIds(employee).map((id) => { const entry = managerNames.get(id.toHexString()); return entry ? `${entry.firstName} ${entry.lastName}` : 'Manager unavailable'; }),
        reportingManagerCodes: managerIds(employee).map((id) => managerNames.get(id.toHexString())?.employeeCode ?? '') };
    });
  }
  async managerOptions(scope: ScopePredicate, query: { page: number; limit: number; sortOrder: 'asc' | 'desc'; search?: string }, session: ClientSession) {
    const filter = { $and: [scope, { isActive: true, employmentStatus: trusted({ $ne: 'EXITED' }),
      ...(query.search ? { $or: ['firstName', 'lastName', 'employeeCode'].map((field) => ({ [field]: literalPrefix(query.search ?? '') })) } : {}) }] };
    const data = await UserModel.find(filter).select('_id firstName lastName employeeCode roleId').session(session)
      .sort({ firstName: query.sortOrder === 'asc' ? 1 : -1, _id: 1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean();
    const total = await UserModel.countDocuments(filter).session(session);
    return { data, total };
  }
  get(id: Types.ObjectId, scope: ScopePredicate = {}, session?: ClientSession) {
    return UserModel.findOne({ $and: [{ _id: id }, scope] }).select('+bootstrapKey').session(session ?? null).lean();
  }
  filters(query: EmployeeQuery): ScopePredicate {
    return { ...(query.branchId ? { branchId: new Types.ObjectId(query.branchId) } : {}),
      ...(query.managerId ? { $and: [{ $or: [{ reportingManagerId: new Types.ObjectId(query.managerId) }, { reportingManagerIds: new Types.ObjectId(query.managerId) }] }] } : {}),
      ...(query.roleId ? { roleId: new Types.ObjectId(query.roleId) } : {}),
      ...(query.isActive === undefined ? {} : { isActive: query.isActive }), ...(query.employmentStatus ? { employmentStatus: query.employmentStatus } : {}),
      ...(query.department ? { department: query.department } : {}),
      ...(query.startDate || query.endDate ? { createdAt: trusted({ ...(query.startDate ? { $gte: new Date(query.startDate) } : {}), ...(query.endDate ? { $lt: new Date(query.endDate) } : {}) }) } : {}),
      ...(query.search ? { $or: ['firstName', 'lastName', 'employeeCode', 'email', 'mobileNumber'].map((field) => ({ [field]: literalPrefix(query.search ?? '') })) } : {}),
    };
  }
  async list(scope: ScopePredicate, query: EmployeeQuery, selection: ScopePredicate = {}) {
    const filter = { $and: [scope, this.filters(query), selection] };
    const [data, total] = await Promise.all([UserModel.find(filter).select(EMPLOYEE_PUBLIC_FIELDS)
      .sort({ [query.sortBy]: query.sortOrder === 'asc' ? 1 : -1, _id: 1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean(),
    UserModel.countDocuments(filter)]); return { data: await this.withLabels(data), total };
  }
  role(id: Types.ObjectId, session: ClientSession) { return RoleModel.findOne({ _id: id, isActive: true }).session(session).lean(); }
  policy(creatorRoleId: Types.ObjectId, targetRoleId: Types.ObjectId, session: ClientSession) {
    return RolePolicyModel.findOne({ creatorRoleId, targetRoleId, isActive: true }).session(session).lean();
  }
  async create(input: EmployeeCreate, id: Types.ObjectId, actorId: Types.ObjectId, session: ClientSession) {
    const [employee] = await UserModel.create([{ ...input, dateOfJoining: new Date(input.dateOfJoining), _id: id, createdBy: actorId }], { session });
    if (!employee) throw new Error('Employee insertion failed'); return employee.toObject();
  }
  update(id: Types.ObjectId, revision: number, changes: Record<string, unknown>, revoke: boolean, session: ClientSession) {
    return UserModel.findOneAndUpdate({ _id: id, revision }, { $set: changes, $inc: { revision: 1, ...(revoke ? { authVersion: 1 } : {}) } },
      { returnDocument: 'after', runValidators: true, session }).lean();
  }
  children(id: Types.ObjectId, session: ClientSession) { return UserModel.find({ $or: [{ reportingManagerId: id }, { reportingManagerIds: id }], isActive: true }).session(session).lean(); }
  async companyWideUsers(roleId: Types.ObjectId, session: ClientSession): Promise<boolean> {
    return Boolean(await UserModel.exists({ roleId, branchId: null }).session(session));
  }
  async activeRoleUsers(roleId: Types.ObjectId, session: ClientSession): Promise<boolean> {
    return Boolean(await UserModel.exists({ roleId, isActive: true }).session(session));
  }
  async hasPassword(id: Types.ObjectId, session: ClientSession): Promise<boolean> {
    return Boolean(await UserModel.exists({ _id: id, passwordHash: trusted({ $type: 'string' }) }).session(session));
  }
}
