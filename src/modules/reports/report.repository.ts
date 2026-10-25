import { Types, trusted, type ClientSession } from 'mongoose';
import { UserModel } from '../users/user.model.js';
import { ReportModel, ReportHistoryModel, CALL_OUTCOMES } from './report.model.js';
import type { ReportQuery } from './report.validator.js';
export function reportDto(record: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !['requestHash', 'idempotencyKey'].includes(key)).map(([key, value]: [string, unknown]) =>
    [key, ['requiredCapacityKw', 'ratePerKw', 'estimatedProjectValue'].includes(key) && value instanceof Types.Decimal128 ? value.toString() : value]));
}
// Every caller must supply a server-generated scope predicate; no client MongoDB filters.
export class ReportRepository {
  async list(filter: Record<string, unknown>, query: ReportQuery) {
    const [rows, total] = await Promise.all([
      ReportModel.find(filter).sort({ createdAt: query.sortOrder === 'asc' ? 1 : -1, _id: query.sortOrder === 'asc' ? 1 : -1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean(), ReportModel.countDocuments(filter),
    ]);
    const employees = await UserModel.find({ _id: trusted({ $in: rows.map(row => row.employeeId) }) }).select('_id firstName lastName').lean();
    const names = new Map(employees.map(employee => [employee._id.toHexString(), `${employee.firstName} ${employee.lastName}`.trim()]));
    return { data: rows.map(row => ({ ...reportDto(row), employeeName: names.get(row.employeeId.toHexString()) ?? null })), total };
  }
  async get(filter: Record<string, unknown>, session?: ClientSession) { return ReportModel.findOne(filter).session(session ?? null).lean(); }
  async history(id: Types.ObjectId, query: ReportQuery) {
    const filter = { reportId: id };
    const [data, total] = await Promise.all([ReportHistoryModel.find(filter).sort({ revision: -1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean(), ReportHistoryModel.countDocuments(filter)]); return { data, total };
  }
  async daily(match: Record<string, unknown>, query: ReportQuery) {
    const outcomeFields = Object.fromEntries(CALL_OUTCOMES.map((outcome) => [`outcome_${outcome}`, { $sum: { $cond: [{ $eq: ['$callOutcome', outcome] }, 1, 0] } }]));
    const pipeline = [{ $match: match }, { $group: { _id: { date: '$businessDate', employeeId: '$employeeId' }, totalCalls: { $sum: 1 }, callDurationSeconds: { $sum: '$callDurationSeconds' },
      approvedCalls: { $sum: { $cond: [{ $eq: ['$reviewStatus', 'APPROVED'] }, 1, 0] } }, approvedDurationSeconds: { $sum: { $cond: [{ $eq: ['$reviewStatus', 'APPROVED'] }, '$callDurationSeconds', 0] } },
      interestedCalls: { $sum: { $cond: [{ $eq: ['$customerInterest', 'INTERESTED'] }, 1, 0] } },
      ...outcomeFields,
    } }, { $project: { totalCalls: 1, callDurationSeconds: 1, approvedCalls: 1, approvedDurationSeconds: 1, interestedCalls: 1,
      outcomeCounts: Object.fromEntries(CALL_OUTCOMES.map((outcome) => [outcome, `$outcome_${outcome}`])),
    } }, { $sort: { '_id.date': query.sortOrder === 'asc' ? 1 as const : -1 as const, '_id.employeeId': 1 as const } }];
    const [result] = await ReportModel.aggregate<{ rows: Record<string, unknown>[]; count: { total: number }[] }>([...pipeline, { $facet: { rows: [{ $skip: (query.page - 1) * query.limit }, { $limit: query.limit }], count: [{ $count: 'total' }] } }]);
    return { data: result?.rows ?? [], total: result?.count[0]?.total ?? 0, timezone: 'Asia/Kolkata' };
  }
}
