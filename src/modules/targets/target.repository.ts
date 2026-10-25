import { Types, trusted, type ClientSession } from 'mongoose';
import type { Principal } from '../auth/auth.types.js';
import { ScopeService } from '../permissions/authorization.service.js';
import { ReportModel } from '../reports/report.model.js';
import { TargetModel, TargetEvidenceModel, TargetRevisionModel } from './target.model.js';
import type { TargetQuery, TargetType } from './target.types.js';
import { boundary } from './target-period.js';
import { businessDate } from '../../shared/utils/business-date.js';
import { decimalString } from '../leads/decimal.js';
export const targetAdapter = { ownerField: 'employeeId', branchField: 'branchId' } as const;
// Milestone hierarchy follows the credited employee, including originally unassigned leads.
export const milestoneAdapter = { ownerField: 'createdBy', assigneeField: 'assignedTo', hierarchyField: 'employeeId', branchField: 'branchId' } as const;
export function targetDto<T extends { targetValue: Types.Decimal128; startDate: Date; endDate: Date }>(target: T) {
  return { ...target, targetValue: target.targetValue.toString(), businessStartDate: businessDate(target.startDate), businessEndDate: businessDate(target.endDate), timezone: 'Asia/Kolkata' };
}
export function targetFilter(scope: Record<string, unknown>, query: TargetQuery) {
  const match: Record<string, unknown> = { status: query.status };
  for (const field of ['employeeId', 'branchId'] as const) if (query[field]) match[field] = new Types.ObjectId(query[field]);
  if (query.targetType) match.targetType = query.targetType; if (query.periodType) match.periodType = query.periodType;
  // Select targets intersecting the requested half-open business interval.
  if (query.from) match.endDate = trusted({ $gt: boundary(query.from) });
  if (query.to) match.startDate = trusted({ $lt: boundary(query.to) });
  return { $and: [scope, match] };
}
export class TargetRepository {
  private readonly scopes = new ScopeService();
  async list(filter: Record<string, unknown>, query: TargetQuery, session?: ClientSession) {
    const rows = await TargetModel.find(filter).sort({ startDate: query.sortOrder === 'asc' ? 1 : -1, _id: 1 }).skip((query.page - 1) * query.limit).limit(query.limit).session(session ?? null).lean();
    const total = await TargetModel.countDocuments(filter).session(session ?? null); return { rows, total };
  }
  async revisions(id: Types.ObjectId, page: number, limit: number) {
    const [rows, total] = await Promise.all([TargetRevisionModel.find({ targetId: id }).sort({ revision: -1 }).skip((page - 1) * limit).limit(limit).lean(), TargetRevisionModel.countDocuments({ targetId: id })]);
    return { data: rows.map(targetDto), total };
  }
  async actual(actor: Principal, type: TargetType, employees: Types.ObjectId[], branchId: Types.ObjectId, startDate: Date, endDate: Date, asOf: Date, session: ClientSession): Promise<string> {
    const reportScope = await this.scopes.predicate(actor, 'reports:read', targetAdapter, session);
    const common = { employeeId: trusted({ $in: employees }), branchId, reviewStatus: 'APPROVED' };
    const time = trusted({ $gte: startDate, $lt: endDate, $lte: asOf });
    if (type === 'CALLS_COMPLETED' || type === 'CONNECTED_CALLS' || type === 'SITE_VISITS') {
      const match: Record<string, unknown> = { ...common, status: 'SUBMITTED', kind: type === 'SITE_VISITS' ? 'VISIT' : 'CALL' };
      if (type === 'SITE_VISITS') { match.visitCompletedAt = time; match.visitOutcome = trusted({ $in: ['COMPLETED', 'FOLLOW_UP_REQUIRED', 'NOT_INTERESTED'] }); }
      else { match.callEndedAt = time; if (type === 'CONNECTED_CALLS') match.callOutcome = trusted({ $in: ['CONNECTED', 'INTERESTED', 'NOT_INTERESTED', 'CALLBACK_REQUESTED'] }); }
      const count = await ReportModel.countDocuments({ $and: [match, reportScope] }).session(session); return decimalString(BigInt(count) * 100n);
    }
    const leadScope = await this.scopes.predicate(actor, 'leads:read', milestoneAdapter, session);
    const milestone = type === 'LEADS_GENERATED' ? 'CREATED' : type === 'QUALIFIED_LEADS' ? 'QUALIFIED' : 'CONVERTED';
    const filter = { $and: [{ ...common, milestone, occurredAt: time }, reportScope, leadScope] };
    if (type !== 'SALES_VALUE') return decimalString(BigInt(await TargetEvidenceModel.countDocuments(filter).session(session)) * 100n);
    const [value] = await TargetEvidenceModel.aggregate<{ total: Types.Decimal128 }>([{ $match: filter }, { $group: { _id: null, total: { $sum: '$valueAtConversion' } } }]).session(session);
    return value?.total.toString() ?? '0.00';
  }
}
