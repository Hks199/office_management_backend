import { Types, trusted, type ClientSession } from 'mongoose';
import type { Principal } from '../auth/auth.types.js';
import { OrganizationAccess } from '../../shared/services/organization-access.js';
import { ScopeService, AuthorizationService } from '../permissions/authorization.service.js';
import { UserModel } from '../users/user.model.js';
import { BranchModel } from '../branches/branch.model.js';
import { TargetModel, TargetRevisionModel } from './target.model.js';
import { TargetRepository, targetAdapter, targetDto, targetFilter } from './target.repository.js';
import type { TargetInput, TargetUpdate, TargetQuery, TargetType, PeriodType } from './target.types.js';
import { achievement, targetPeriod } from './target-period.js';
import { businessDate } from '../../shared/utils/business-date.js';
import { hundredths, decimalString } from '../leads/decimal.js';
import { AppError } from '../../shared/errors/app-error.js';
import { audit, type AuditContext } from '../activity-logs/audit.service.js';
import { withEmployeeLabels } from '../../shared/services/employee-labels.js';
export class TargetService {
  private readonly access = new OrganizationAccess(); private readonly scopes = new ScopeService(); private readonly authorization = new AuthorizationService(); private readonly repository = new TargetRepository();
  private async labeled<T extends object>(record: T, session?: ClientSession) {
    const [named] = await withEmployeeLabels([record], ['employeeId', 'assignedBy', 'changedBy'], session);
    if (!named) throw new Error('Target label resolution failed');
    return named;
  }
  private async recipient(actor: Principal, action: 'targets:create' | 'targets:update', id: Types.ObjectId, type: TargetType, session: ClientSession, requireActive = true) {
    const scope = await this.scopes.predicate(actor, action, { ownerField: '_id', hierarchyField: '_id', branchField: 'branchId' }, session);
    const user = await UserModel.findOne({ $and: [{ _id: id }, scope] }).session(session).lean();
    if (!user?.branchId) throw new AppError(404, 'NOT_FOUND', 'Eligible target employee not found');
    if (requireActive) {
      const grants = await this.authorization.grants(user.roleId, session);
      const capability = type === 'CALLS_COMPLETED' || type === 'CONNECTED_CALLS' ? 'customers:receive_assignment' : type === 'LEADS_GENERATED' ? 'leads:create' : 'leads:receive_assignment';
      if (!user.isActive || user.employmentStatus !== 'ACTIVE' || !grants?.some((grant) => grant.permission === capability) || !await BranchModel.exists({ _id: user.branchId, isActive: true }).session(session)) throw new AppError(400, 'INVALID_TARGET_EMPLOYEE', 'Select an active employee with the activity capability in an active primary branch');
    }
    return user;
  }
  private value(type: TargetType, value: string) {
    const scaled = hundredths(value);
    if (type !== 'SALES_VALUE' && scaled % 100n !== 0n) throw new AppError(400, 'INVALID_TARGET_VALUE', 'Count targets require whole nonnegative values');
    return decimalString(scaled);
  }
  private async overlap(employeeId: Types.ObjectId, branchId: Types.ObjectId, type: TargetType, periodType: PeriodType, start: Date, end: Date, session: ClientSession, except?: Types.ObjectId) {
    if (await TargetModel.exists({ employeeId, branchId, targetType: type, periodType, status: 'ACTIVE', startDate: trusted({ $lt: end }), endDate: trusted({ $gt: start }), ...(except ? { _id: trusted({ $ne: except }) } : {}) }).session(session)) throw new AppError(409, 'TARGET_OVERLAP', 'Active targets of the same employee, branch, type and period type cannot overlap');
  }
  private async recordRevision(target: { _id: Types.ObjectId; employeeId: Types.ObjectId; branchId: Types.ObjectId; targetType: TargetType; targetValue: Types.Decimal128; periodType: PeriodType; startDate: Date; endDate: Date; assignedBy: Types.ObjectId; status: string; revision: number }, actor: Principal, reason: string, session: ClientSession, context: AuditContext) {
    await TargetRevisionModel.create([{ targetId: target._id, employeeId: target.employeeId, branchId: target.branchId, targetType: target.targetType, targetValue: target.targetValue, periodType: target.periodType,
      startDate: target.startDate, endDate: target.endDate, assignedBy: target.assignedBy, status: target.status, revision: target.revision, changedBy: actor.userId, reason }], { session });
    await audit(session, context, 'TARGET_REVISED', actor.userId, 'target', target._id, { revision: String(target.revision), status: target.status });
  }
  async create(actor: Principal, input: TargetInput, context: AuditContext) {
    return this.access.transaction(async (session) => {
      const current = await this.access.actor(actor, 'targets:create', session); const employeeId = new Types.ObjectId(input.employeeId);
      const user = await this.recipient(current, 'targets:create', employeeId, input.targetType, session); if (!user.branchId) throw new AppError(400, 'INVALID_BRANCH', 'Primary branch required');
      const period = targetPeriod(input.periodType, input.startDate, input.endDate); const value = this.value(input.targetType, input.targetValue);
      await this.overlap(employeeId, user.branchId, input.targetType, input.periodType, period.startDate, period.endDate, session);
      const [target] = await TargetModel.create([{ employeeId, branchId: user.branchId, targetType: input.targetType, targetValue: value, periodType: input.periodType, ...period, assignedBy: current.userId }], { session });
      if (!target) throw new Error('Target insertion failed'); await this.recordRevision(target, current, 'Initial assignment', session, context); return this.labeled(targetDto(target.toObject()), session);
    });
  }
  private async get(actor: Principal, id: Types.ObjectId, action: 'targets:read' | 'targets:update', session?: ClientSession) {
    const target = await TargetModel.findOne({ $and: [{ _id: id }, await this.scopes.predicate(actor, action, targetAdapter, session)] }).session(session ?? null).lean();
    if (!target) throw new AppError(404, 'NOT_FOUND', 'Target not found'); return target;
  }
  async read(actor: Principal, id: Types.ObjectId) { return this.labeled(targetDto(await this.get(actor, id, 'targets:read'))); }
  async list(actor: Principal, query: TargetQuery) {
    const result = await this.repository.list(targetFilter(await this.scopes.predicate(actor, 'targets:read', targetAdapter), query), query); return { data: await withEmployeeLabels(result.rows.map(targetDto), ['employeeId', 'assignedBy']), total: result.total };
  }
  async update(actor: Principal, id: Types.ObjectId, input: TargetUpdate, context: AuditContext) {
    return this.access.transaction(async (session) => {
      const current = await this.access.actor(actor, 'targets:update', session); const previous = await this.get(current, id, 'targets:update', session);
      const cancellationOnly = input.status === 'CANCELLED' && input.targetValue === undefined && input.startDate === undefined && input.endDate === undefined;
      await this.recipient(current, 'targets:update', previous.employeeId, previous.targetType, session, !cancellationOnly);
      const period = targetPeriod(previous.periodType, input.startDate ?? businessDate(previous.startDate), input.endDate ?? businessDate(previous.endDate));
      const status = input.status ?? previous.status; const value = this.value(previous.targetType, input.targetValue ?? previous.targetValue.toString());
      if (status === 'ACTIVE') await this.overlap(previous.employeeId, previous.branchId, previous.targetType, previous.periodType, period.startDate, period.endDate, session, id);
      const record = await TargetModel.findOneAndUpdate({ _id: id, revision: input.revision }, { $set: { ...period, status, targetValue: value }, $inc: { revision: 1 } }, { session, returnDocument: 'after', runValidators: true }).lean();
      if (!record) throw new AppError(409, 'CONFLICT', 'Target changed; reload its revision'); await this.recordRevision(record, current, input.reason, session, context); return this.labeled(targetDto(record), session);
    });
  }
  async revisions(actor: Principal, id: Types.ObjectId, page: number, limit: number) { await this.get(actor, id, 'targets:read'); const result = await this.repository.revisions(id, page, limit); return { ...result, data: await withEmployeeLabels(result.data, ['employeeId', 'assignedBy', 'changedBy']) }; }
  async progress(actor: Principal, id: Types.ObjectId) {
    return this.access.transaction(async (session) => {
      const current = await this.access.actor(actor, 'targets:read', session); const target = await this.get(current, id, 'targets:read', session); const asOf = new Date();
      const actualValue = await this.repository.actual(current, target.targetType, [target.employeeId], target.branchId, target.startDate, target.endDate, asOf, session);
      return { ...await this.labeled(targetDto(target), session), actualValue, achievementPercentage: achievement(actualValue, target.targetValue.toString()), asOf, actualIsScoped: true, verifiedOnly: true };
    });
  }
  async report(actor: Principal, query: TargetQuery) {
    return this.access.transaction(async (session) => {
      const current = await this.access.actor(actor, 'targets:read', session); const asOf = new Date();
      const result = await this.repository.list(targetFilter(await this.scopes.predicate(current, 'targets:read', targetAdapter, session), query), query, session);
      const data: Record<string, unknown>[] = [];
      for (const target of result.rows) {
        const actualValue = await this.repository.actual(current, target.targetType, [target.employeeId], target.branchId, target.startDate, target.endDate, asOf, session);
        data.push({ ...targetDto(target), actualValue, achievementPercentage: achievement(actualValue, target.targetValue.toString()) });
      }
      return { data: await withEmployeeLabels(data, ['employeeId', 'assignedBy'], session), total: result.total, asOf, verifiedOnly: true, actualIsScoped: true };
    });
  }
  async summary(actor: Principal, query: TargetQuery) {
    return this.access.transaction(async (session) => {
      const current = await this.access.actor(actor, 'targets:read', session); const asOf = new Date();
      const filter = targetFilter(await this.scopes.predicate(current, 'targets:read', targetAdapter, session), query);
      const rows = await TargetModel.find(filter).limit(501).session(session).lean();
      if (rows.length > 500) throw new AppError(422, 'TARGET_SUMMARY_LIMIT', 'Narrow filters to at most 500 targets');
      const groups = new Map<string, { branchId: Types.ObjectId; targetType: TargetType; periodType: string; startDate: Date; endDate: Date; employeeIds: Types.ObjectId[]; targetValue: bigint; targets: number }>();
      for (const row of rows) {
        const key = [row.branchId.toHexString(), row.targetType, row.periodType, row.startDate.toISOString(), row.endDate.toISOString()].join('|');
        const group = groups.get(key) ?? { branchId: row.branchId, targetType: row.targetType, periodType: row.periodType, startDate: row.startDate, endDate: row.endDate, employeeIds: [], targetValue: 0n, targets: 0 };
        if (!group.employeeIds.some((id) => id.equals(row.employeeId))) group.employeeIds.push(row.employeeId);
        group.targetValue += hundredths(row.targetValue.toString()); group.targets++; groups.set(key, group);
      }
      const ordered = [...groups.entries()].sort(([a], [b]) => query.sortOrder === 'asc' ? a.localeCompare(b) : b.localeCompare(a)); const data: Record<string, unknown>[] = [];
      for (const [, group] of ordered.slice((query.page - 1) * query.limit, query.page * query.limit)) {
        const actualValue = await this.repository.actual(current, group.targetType, group.employeeIds, group.branchId, group.startDate, group.endDate, asOf, session);
        const targetValue = decimalString(group.targetValue);
        data.push({ branchId: group.branchId, targetType: group.targetType, periodType: group.periodType, startDate: group.startDate, endDate: group.endDate, targetCount: group.targets, employeeCount: group.employeeIds.length, targetValue, actualValue, achievementPercentage: achievement(actualValue, targetValue) });
      }
      return { data, total: ordered.length, asOf, timezone: 'Asia/Kolkata', actualIsScoped: true, verifiedOnly: true };
    });
  }
}
