import { Types, type Aggregate, type PipelineStage } from 'mongoose';
import { UserModel } from '../users/user.model.js';
import { BranchModel } from '../branches/branch.model.js';
import { AttendanceModel } from '../attendance/attendance.model.js';
import { CustomerModel, LeadModel } from '../leads/commercial.models.js';
import { commercialAdapter, leadAdapter } from '../leads/commercial-access.js';
import { ReportModel } from '../reports/report.model.js';
import { TargetEvidenceModel, TargetModel } from '../targets/target.model.js';
import { milestoneAdapter } from '../targets/target.repository.js';
import { ImportModel } from '../csv-imports/import.models.js';
import { DashboardAccess, employeeAdapter } from './dashboard.access.js';
import type { DashboardWindow } from './dashboard.types.js';
interface AggregateModel { aggregate<R>(pipeline: PipelineStage[]): Aggregate<R[]> }
export interface CountRow { _id: string | Types.ObjectId | null; count: number }
export interface ActivityRow { _id: Types.ObjectId | string | null; submittedCalls: number; approvedCalls: number; connectedCalls: number; submittedVisits: number; approvedVisits: number; pendingReports: number; rejectedReports: number; callDurationSeconds: number }
export interface EvidenceRow { _id: Types.ObjectId | string | null; generatedLeads: number; qualifiedLeads: number; approvedConversions: number; salesValue: Types.Decimal128 }
const sumIf = (condition: unknown) => ({ $sum: { $cond: [condition, 1, 0] } });
const both = (...conditions: unknown[]) => ({ $and: conditions });
const eq = (field: string, value: string) => ({ $eq: [`$${field}`, value] });
export const windowMatch = (field: string, window: DashboardWindow) => ({ [field]: { $gte: window.start, $lt: window.end } });
export class DashboardRepository {
  constructor(readonly access: DashboardAccess, readonly asOf: Date) {}
  private async aggregate<R>(model: AggregateModel, pipeline: PipelineStage[]) { return model.aggregate<R>(pipeline).session(this.access.session).option({ maxTimeMS: 10000 }); }
  async counts(model: AggregateModel, filter: Record<string, unknown>, field: string | Record<string, unknown> | null): Promise<CountRow[]> {
    return this.aggregate<CountRow>(model, [{ $match: filter }, { $group: { _id: field, count: { $sum: 1 } } }, { $sort: { _id: 1 } }]);
  }
  async users() {
    const filter = await this.access.userFilter();
    const [result] = await this.aggregate<{ total: number; active: number }>(UserModel, [{ $match: filter }, { $group: { _id: null, total: { $sum: 1 }, active: sumIf(both({ $eq: ['$isActive', true] }, eq('employmentStatus', 'ACTIVE'))) } }]);
    return result ?? { total: 0, active: 0 };
  }
  async branches() { return (await this.counts(BranchModel, await this.access.branchFilter(), null))[0]?.count ?? 0; }
  async customers(window: DashboardWindow) {
    const filter = { $and: [await this.access.source('customers:read', commercialAdapter, true), { createdAt: { $lte: this.asOf } }] };
    const statuses = await this.counts(CustomerModel, filter, '$status');
    const created = await this.counts(CustomerModel, { $and: [filter, windowMatch('createdAt', window)] }, null); return { statuses, created: created[0]?.count ?? 0 };
  }
  async leadFilter() {
    const filter: Record<string, unknown> = { createdAt: { $lte: this.asOf } }; if (this.access.query.leadStatus) filter.status = { $in: this.access.query.leadStatus };
    if (this.access.query.leadSource) filter.leadSource = this.access.query.leadSource;
    return { $and: [filter, await this.access.source('leads:read', leadAdapter, true)] };
  }
  async leads(window: DashboardWindow) {
    const filter = await this.leadFilter();
    const current = await this.counts(LeadModel, filter, '$status');
    const cohort = await this.counts(LeadModel, { $and: [filter, windowMatch('createdAt', window)] }, '$status');
    const followUps = await this.counts(LeadModel, { $and: [filter, { status: { $nin: ['CONVERTED', 'LOST', 'NOT_INTERESTED'] }, nextFollowUpAt: { $ne: null } }] }, { $cond: [{ $lte: ['$nextFollowUpAt', this.asOf] }, 'OVERDUE', 'UPCOMING'] });
    return { current, cohort, followUps };
  }
  async activities(window: DashboardWindow, group: string | null = null) {
    const filter = await this.access.source('reports:read', employeeAdapter);
    const approvedCall = both(eq('kind', 'CALL'), eq('status', 'SUBMITTED'), eq('reviewStatus', 'APPROVED'));
    const approvedVisit = both(eq('kind', 'VISIT'), eq('status', 'SUBMITTED'), eq('reviewStatus', 'APPROVED'), { $in: ['$visitOutcome', ['COMPLETED', 'FOLLOW_UP_REQUIRED', 'NOT_INTERESTED']] });
    return this.aggregate<ActivityRow>(ReportModel, [{ $match: { $and: [filter, { $or: [ { kind: 'CALL', ...windowMatch('callEndedAt', window) }, { kind: 'VISIT', ...windowMatch('visitCompletedAt', window) }, { kind: 'VISIT', status: 'OPEN', ...windowMatch('visitStartedAt', window) } ] }] } },
      { $group: { _id: group, submittedCalls: sumIf(both(eq('kind', 'CALL'), eq('status', 'SUBMITTED'))), approvedCalls: sumIf(approvedCall),
        connectedCalls: sumIf(both(approvedCall, { $in: ['$callOutcome', ['CONNECTED', 'INTERESTED', 'NOT_INTERESTED', 'CALLBACK_REQUESTED']] })),
        submittedVisits: sumIf(both(eq('kind', 'VISIT'), eq('status', 'SUBMITTED'))), approvedVisits: sumIf(approvedVisit), pendingReports: sumIf(eq('reviewStatus', 'PENDING')), rejectedReports: sumIf(eq('reviewStatus', 'REJECTED')),
        callDurationSeconds: { $sum: { $cond: [approvedCall, '$callDurationSeconds', 0] } },
      } }, { $sort: { _id: 1 } }]);
  }
  async evidenceFilter() {
    return { $and: [await this.access.source('reports:read', employeeAdapter), await this.access.source('leads:read', milestoneAdapter, false, 'employeeId', employeeAdapter), { reviewStatus: 'APPROVED' }] };
  }
  async evidence(window: DashboardWindow, group: string | null = null) {
    return this.aggregate<EvidenceRow>(TargetEvidenceModel, [{ $match: { $and: [await this.evidenceFilter(), windowMatch('occurredAt', window)] } },
      { $group: { _id: group, generatedLeads: sumIf(eq('milestone', 'CREATED')), qualifiedLeads: sumIf(eq('milestone', 'QUALIFIED')), approvedConversions: sumIf(eq('milestone', 'CONVERTED')),
        salesValue: { $sum: { $cond: [eq('milestone', 'CONVERTED'), '$valueAtConversion', Types.Decimal128.fromString('0.00')] } },
      } }, { $sort: { _id: 1 } }]);
  }
  async outcomes(window: DashboardWindow) { return this.counts(ReportModel, { $and: [await this.access.source('reports:read', employeeAdapter), { kind: 'CALL', status: 'SUBMITTED', reviewStatus: 'APPROVED' }, windowMatch('callEndedAt', window)] }, '$callOutcome'); }
  async supplements(window: DashboardWindow, byBranch: boolean) {
    const a = this.access; const group = byBranch ? '$branchId' : '$employeeId'; const rows: Record<string, CountRow[] | null> = {};
    rows.employeeCount = a.has('users:read') ? await this.counts(UserModel, await a.userFilter(), byBranch ? '$branchId' : '$_id') : null;
    rows.currentAssignedCustomers = a.has('customers:read') ? await this.counts(CustomerModel, await a.source('customers:read', commercialAdapter, true), byBranch ? '$branchId' : '$assignedTo') : null;
    rows.currentAssignedLeads = a.has('leads:read') ? await this.counts(LeadModel, await this.leadFilter(), byBranch ? '$branchId' : '$assignedTo') : null;
    rows.approvedAttendanceRecords = a.has('attendance:read') ? await this.counts(AttendanceModel, { $and: [await a.source('attendance:read', employeeAdapter), { reviewStatus: 'APPROVED' }, windowMatch('effectiveCheckInAt', window)] }, group) : null;
    rows.activeTargetCount = a.has('targets:read') ? await this.counts(TargetModel, { $and: [await a.source('targets:read', employeeAdapter), { status: 'ACTIVE', startDate: { $lt: window.end }, endDate: { $gt: window.start } }] }, group) : null;
    return rows;
  }
  async imports(window: DashboardWindow) {
    return this.aggregate<{ _id: string; jobs: number; importedRows: number; rejectedRows: number; duplicateRows: number }>(ImportModel, [
      { $match: { $and: [await this.access.source('imports:read', { ownerField: 'createdBy', hierarchyField: 'createdBy', branchField: 'branchId' }, false, 'createdBy'), windowMatch('createdAt', window)] } },
      { $group: { _id: '$status', jobs: { $sum: 1 }, importedRows: { $sum: '$importedRows' }, rejectedRows: { $sum: '$rejectedRows' }, duplicateRows: { $sum: '$duplicateRows' } } }, { $sort: { _id: 1 } },
    ]);
  }
  async attendance(window: DashboardWindow) {
    return this.aggregate<{ _id: string; records: number; approved: number; pending: number; rejected: number; late: number; early: number; workedMinutes: number }>(AttendanceModel, [
      { $match: { $and: [await this.access.source('attendance:read', employeeAdapter), windowMatch('effectiveCheckInAt', window)] } },
      { $group: { _id: '$attendanceDate', records: { $sum: 1 }, approved: sumIf(eq('reviewStatus', 'APPROVED')), pending: sumIf(eq('reviewStatus', 'PENDING')), rejected: sumIf(eq('reviewStatus', 'REJECTED')),
        late: sumIf(both(eq('reviewStatus', 'APPROVED'), { $eq: ['$lateArrival', true] })), early: sumIf(both(eq('reviewStatus', 'APPROVED'), { $eq: ['$earlyExit', true] })),
        workedMinutes: { $sum: { $cond: [both(eq('reviewStatus', 'APPROVED'), { $ne: ['$effectiveCheckOutAt', null] }), { $divide: [{ $max: [0, { $subtract: [{ $min: ['$effectiveCheckOutAt', this.asOf] }, '$effectiveCheckInAt'] }] }, 60000] }, 0] } },
      } }, { $sort: { _id: 1 } },
    ]);
  }
  async recent(window: DashboardWindow) {
    return ReportModel.aggregate<Record<string, unknown>>([{ $match: { $and: [await this.access.source('reports:read', employeeAdapter), windowMatch('createdAt', window)] } },
      { $sort: { createdAt: -1, _id: -1 } }, { $limit: 10 }, { $project: { _id: 1, employeeId: 1, branchId: 1, kind: 1, status: 1, reviewStatus: 1, callOutcome: 1, visitOutcome: 1, createdAt: 1 } },
    ]).session(this.access.session).option({ maxTimeMS: 10000 });
  }
  async trends(window: DashboardWindow) {
    const rows: Record<string, unknown>[] = [];
    // Event aggregation preserves historical attribution and avoids current lead-status inference.
    if (this.access.has('reports:read')) {
      const filter = await this.access.source('reports:read', employeeAdapter);
      const reports = await this.aggregate<{ _id: { month: string; kind: string }; count: number }>(ReportModel, [
        { $match: { $and: [filter, { status: 'SUBMITTED', reviewStatus: 'APPROVED', $or: [{ kind: 'CALL', ...windowMatch('callEndedAt', window) }, { kind: 'VISIT', visitOutcome: { $in: ['COMPLETED', 'FOLLOW_UP_REQUIRED', 'NOT_INTERESTED'] }, ...windowMatch('visitCompletedAt', window) }] }] } },
        { $group: { _id: { month: { $dateToString: { format: '%Y-%m', timezone: 'Asia/Kolkata', date: { $cond: [eq('kind', 'CALL'), '$callEndedAt', '$visitCompletedAt'] } } }, kind: '$kind' }, count: { $sum: 1 } } }, { $sort: { '_id.month': 1, '_id.kind': 1 } },
      ]); rows.push(...reports.map((row) => ({ month: row._id.month, metric: row._id.kind === 'CALL' ? 'approvedCalls' : 'approvedVisits', value: String(row.count) })));
    }
    if (this.access.has('leads:read') && this.access.has('reports:read')) {
      const events = await this.aggregate<{ _id: { month: string; milestone: string }; count: number; value: Types.Decimal128 }>(TargetEvidenceModel, [
        { $match: { $and: [await this.evidenceFilter(), windowMatch('occurredAt', window)] } },
        { $group: { _id: { month: { $dateToString: { format: '%Y-%m', timezone: 'Asia/Kolkata', date: '$occurredAt' } }, milestone: '$milestone' }, count: { $sum: 1 }, value: { $sum: '$valueAtConversion' } } }, { $sort: { '_id.month': 1, '_id.milestone': 1 } },
      ]); for (const row of events) { rows.push({ month: row._id.month, metric: row._id.milestone === 'CREATED' ? 'generatedLeads' : row._id.milestone === 'QUALIFIED' ? 'qualifiedLeads' : 'approvedConversions', value: String(row.count) }); if (row._id.milestone === 'CONVERTED') rows.push({ month: row._id.month, metric: 'salesValue', value: row.value.toString() }); }
    }
    return rows;
  }
}
