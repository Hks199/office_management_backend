import { Types, trusted, type ClientSession } from 'mongoose';
import type { Principal } from '../auth/auth.types.js';
import { OrganizationAccess } from '../../shared/services/organization-access.js';
import { AuthorizationService } from '../permissions/authorization.service.js';
import { UserModel } from '../users/user.model.js';
import { BranchModel } from '../branches/branch.model.js';
import { RoleModel } from '../roles/role.model.js';
import { PermissionModel } from '../permissions/permission.model.js';
import { AttendanceModel } from '../attendance/attendance.model.js';
import { TargetModel } from '../targets/target.model.js';
import { TargetRepository } from '../targets/target.repository.js';
import { achievement } from '../targets/target-period.js';
import { hundredths, decimalString } from '../leads/decimal.js';
import { boundary } from '../targets/target-period.js';
import { businessDate } from '../../shared/utils/business-date.js';
import { AppError } from '../../shared/errors/app-error.js';
import { audit, type AuditContext } from '../activity-logs/audit.service.js';
import { DashboardAccess, employeeAdapter, userAdapter } from './dashboard.access.js';
import { DashboardRepository, type CountRow, type ActivityRow, type EvidenceRow } from './dashboard.repository.js';
import { AttendanceCalendarModel } from './dashboard.model.js';
import { nextDay } from './dashboard.validator.js';
import type { DashboardKind, DashboardQuery, DashboardWindow, DashboardPayload, CalendarInput } from './dashboard.types.js';
const total = (rows: CountRow[]) => rows.reduce((sum, row) => sum + row.count, 0);
const count = (rows: CountRow[], key: string) => rows.find((row) => row._id === key)?.count ?? 0;
const unavailable = (requiredPermissions: string[]) => ({ available: false, requiredPermissions });
const metric = (row?: ActivityRow) => ({ submittedCalls: row?.submittedCalls ?? 0, approvedCalls: row?.approvedCalls ?? 0, connectedCalls: row?.connectedCalls ?? 0, submittedVisits: row?.submittedVisits ?? 0, approvedVisits: row?.approvedVisits ?? 0, pendingReports: row?.pendingReports ?? 0, rejectedReports: row?.rejectedReports ?? 0, callDurationSeconds: row?.callDurationSeconds ?? 0 });
const sales = (row?: EvidenceRow) => ({ generatedLeads: row?.generatedLeads ?? 0, qualifiedLeads: row?.qualifiedLeads ?? 0, approvedConversions: row?.approvedConversions ?? 0, salesValue: row?.salesValue.toString() ?? '0.00' });
export function dashboardWindows(query: DashboardQuery, asOf: Date) {
  const start = boundary(query.startDate); const end = new Date(Math.max(start.getTime(), Math.min(boundary(query.endDate).getTime(), asOf.getTime() + 1)));
  const elapsed = end.getTime() - start.getTime(); return { current: { start, end }, previous: { start: new Date(start.getTime() - elapsed), end: start } };
}
export class DashboardService {
  readonly access = new OrganizationAccess(); private readonly authorization = new AuthorizationService(); private readonly targetRepository = new TargetRepository();
  async snapshot(actor: Principal, kind: DashboardKind, query: DashboardQuery): Promise<DashboardPayload> {
    return this.access.transaction(async (session) => this.compute(await this.access.actor(actor, 'dashboard:read', session), kind, query, session, new Date()));
  }
  // Export workers use the same calculator inside their fresh authorization/publication transaction.
  async compute(actor: Principal, kind: DashboardKind, query: DashboardQuery, session: ClientSession, asOf: Date, exporting = false): Promise<DashboardPayload> {
    this.authorization.require(actor, 'dashboard:read'); if (exporting) this.authorization.require(actor, 'dashboard:export');
    const access = new DashboardAccess(actor, query, session, exporting, asOf); const repo = new DashboardRepository(access, asOf); const windows = dashboardWindows(query, asOf);
    let data: Record<string, unknown>;
    if (kind === 'overview') data = await this.overview(repo, windows.current, exporting);
    else if (kind === 'attendance') { this.authorization.require(actor, 'attendance:read'); this.authorization.require(actor, 'users:read'); data = { available: true, days: await repo.attendance(windows.current), absence: await this.absence(repo, windows.current) }; }
    else if (kind === 'leads' || kind === 'lead-funnel') { this.authorization.require(actor, 'leads:read'); data = await this.leads(repo, windows.current); }
    else if (kind === 'targets') { this.authorization.require(actor, 'targets:read'); data = await this.targets(repo, windows.current, exporting); }
    else if (kind === 'trends') { this.authorization.require(actor, 'reports:read'); data = { available: true, rows: await repo.trends(windows.current), previous: query.compare ? { window: windows.previous, rows: await repo.trends(windows.previous) } : null, approvedOnly: true, financialMetricsAvailable: access.has('leads:read') }; }
    else data = await this.performance(repo, kind, windows.current, exporting);
    return { kind, timezone: 'Asia/Kolkata', asOf, requestedPeriod: { startDate: query.startDate, endDate: query.endDate }, data: { ...data, period: windows.current, actualIsScoped: true } };
  }
  private async leads(repo: DashboardRepository, window: DashboardWindow) {
    const rows = await repo.leads(window); const cohortTotal = total(rows.cohort); const converted = count(rows.cohort, 'CONVERTED');
    return { available: true, totalLeads: total(rows.current), convertedLeads: count(rows.current, 'CONVERTED'), pendingLeads: rows.current.filter((row) => !['CONVERTED', 'LOST', 'NOT_INTERESTED'].includes(String(row._id))).reduce((sum, row) => sum + row.count, 0),
      currentStatusFunnel: rows.current, createdInPeriod: cohortTotal, createdCohortCurrentStatuses: rows.cohort, cohortConversionPercentage: achievement(String(converted), String(cohortTotal)),
      followUps: rows.followUps, cohortIsVerifiedPerformance: false };
  }
  private async overview(repo: DashboardRepository, window: DashboardWindow, exporting: boolean) {
    const a = repo.access; const data: Record<string, unknown> = {};
    data.employees = a.has('users:read') ? { available: true, ...await repo.users() } : unavailable(['users:read']);
    data.branches = a.has('branches:read') ? { available: true, total: await repo.branches() } : unavailable(['branches:read']);
    data.customers = a.has('customers:read') ? { available: true, ...await repo.customers(window) } : unavailable(['customers:read']);
    data.leads = a.has('leads:read') ? await this.leads(repo, window) : unavailable(['leads:read']);
    data.activities = a.has('reports:read') ? { available: true, ...metric((await repo.activities(window))[0]), outcomes: await repo.outcomes(window), recent: await repo.recent(window) } : unavailable(['reports:read']);
    data.sales = a.has('reports:read') && a.has('leads:read') ? { available: true, ...sales((await repo.evidence(window))[0]), approvedOnly: true } : unavailable(['reports:read', 'leads:read']);
    data.imports = a.has('imports:read') ? { available: true, statuses: await repo.imports(window) } : unavailable(['imports:read']);
    data.attendance = a.has('attendance:read') && a.has('users:read') ? { available: true, days: await repo.attendance(window), absence: await this.absence(repo, window) } : unavailable(['attendance:read', 'users:read']);
    data.targets = a.has('targets:read') && a.has('reports:read') ? await this.targets(repo, window, exporting, true) : unavailable(['targets:read', 'reports:read']);
    if (a.has('users:read') && a.has('reports:read')) data.topEmployees = await this.performance(repo, 'employee-performance', window, false);
    else data.topEmployees = unavailable(['users:read', 'reports:read']);
    return data;
  }
  private async absence(repo: DashboardRepository, window: DashboardWindow) {
    const today = businessDate(repo.asOf); const start = boundary(today); const end = boundary(nextDay(today));
    if (window.start >= end || window.end <= start) return { available: false, reason: 'HISTORICAL_EMPLOYMENT_CALENDAR_UNAVAILABLE' };
    const a = repo.access;
    const candidates = await UserModel.find({ $and: [await a.userFilter(), await a.source('attendance:read', userAdapter, false, '_id'), { isActive: true, employmentStatus: 'ACTIVE', branchId: trusted({ $ne: null }), dateOfJoining: trusted({ $lt: new Date(`${nextDay(today)}T00:00:00Z`) }) }] }).select('_id branchId roleId').limit(1001).session(a.session).lean();
    if (candidates.length > 1000) throw new AppError(422, 'DASHBOARD_EMPLOYEE_LIMIT', 'Narrow attendance eligibility to at most 1000 employees');
    const permission = await PermissionModel.findOne({ code: 'attendance:create' }).select('_id').session(a.session).lean();
    if (!permission) throw new AppError(503, 'PERMISSIONS_NOT_INITIALIZED', 'Attendance permission registry must be initialized');
    const roles = await RoleModel.find({ _id: trusted({ $in: candidates.map((user) => user.roleId) }), isActive: true, permissions: trusted({ $elemMatch: { permissionId: permission._id, scope: 'SELF' } }) }).select('_id').session(a.session).lean();
    const eligibleRoles = new Set(roles.map((role) => role._id.toHexString())); const users = candidates.filter((user) => eligibleRoles.has(user.roleId.toHexString()));
    if (users.length > 1000) throw new AppError(422, 'DASHBOARD_EMPLOYEE_LIMIT', 'Narrow attendance eligibility to at most 1000 employees');
    const calendars = await AttendanceCalendarModel.find({ branchId: trusted({ $in: users.flatMap((user) => user.branchId ? [user.branchId] : []) }) }).session(a.session).lean();
    const calendarMap = new Map(calendars.map((calendar) => [calendar.branchId.toHexString(), calendar])); const weekday = new Date(`${today}T00:00:00Z`).getUTCDay() || 7;
    let unconfiguredEmployees = 0; const eligible: Types.ObjectId[] = [];
    for (const user of users) {
      const calendar = user.branchId ? calendarMap.get(user.branchId.toHexString()) : undefined;
      if (!calendar) { unconfiguredEmployees++; continue; }
      if (calendar.workingWeekdays.includes(weekday) && !calendar.holidays.includes(today)) eligible.push(user._id);
    }
    const present = await AttendanceModel.distinct('employeeId', { $and: [await a.source('attendance:read', employeeAdapter), { employeeId: trusted({ $in: eligible }), attendanceDate: today, checkInAt: trusted({ $lte: repo.asOf }) }] }).session(a.session);
    return { available: unconfiguredEmployees === 0, date: today, eligibleEmployees: eligible.length, employeesWithVisibleCheckIn: present.length, absentEmployees: unconfiguredEmployees ? null : eligible.length - present.length,
      unconfiguredEmployees, absenceIsProvisional: true, definition: 'Current active branched employees with attendance-submission authority, due on configured working days, without a visible check-in; not verified absence or payroll' };
  }
  private async performance(repo: DashboardRepository, kind: 'employee-performance' | 'branch-performance' | 'role-performance', window: DashboardWindow, all: boolean) {
    const a = repo.access; this.authorization.require(a.actor, 'reports:read'); this.authorization.require(a.actor, kind === 'branch-performance' ? 'branches:read' : 'users:read');
    const groupField = kind === 'branch-performance' ? '$branchId' : '$employeeId';
    let labels: { id: string; name: string; employeeCode?: string; roleId?: string }[];
    if (kind === 'branch-performance') {
      const branches = await BranchModel.find(await a.branchFilter()).select('_id branchName').limit(251).session(a.session).lean();
      if (branches.length > 250) throw new AppError(422, 'DASHBOARD_BRANCH_LIMIT', 'Narrow performance to at most 250 branches');
      labels = branches.map((branch) => ({ id: branch._id.toHexString(), name: branch.branchName }));
    } else {
      const users = await UserModel.find(await a.userFilter()).select('_id employeeCode firstName lastName roleId').limit(1001).session(a.session).lean();
      if (users.length > 1000) throw new AppError(422, 'DASHBOARD_EMPLOYEE_LIMIT', 'Narrow performance to at most 1000 employees');
      labels = users.map((user) => ({ id: user._id.toHexString(), name: `${user.firstName} ${user.lastName}`, employeeCode: user.employeeCode, roleId: user.roleId.toHexString() }));
    }
    const reports = new Map((await repo.activities(window, groupField)).map((row) => [String(row._id), row]));
    const events = a.has('leads:read') ? new Map((await repo.evidence(window, groupField)).map((row) => [String(row._id), row])) : null;
    const supplements = await repo.supplements(window, kind === 'branch-performance');
    const counts = Object.fromEntries(Object.entries(supplements).map(([key, rows]) => [key, rows ? new Map(rows.map((row) => [String(row._id), row.count])) : null]));
    let rows: Record<string, unknown>[] = labels.map((label) => ({ ...label, ...metric(reports.get(label.id)), ...(events ? sales(events.get(label.id)) : { generatedLeads: null, qualifiedLeads: null, approvedConversions: null, salesValue: null }),
      ...Object.fromEntries(Object.entries(counts).map(([key, values]) => [key, values ? values.get(label.id) ?? 0 : null])),
    }));
    if (kind === 'role-performance') {
      const groups = new Map<string, Record<string, unknown>>();
      // Role labels come exclusively from scoped employee IDs; no global role membership counts.
      const roles = await RoleModel.find({ _id: trusted({ $in: labels.flatMap((label) => label.roleId ? [new Types.ObjectId(label.roleId)] : []) }) }).select('_id name').session(a.session).lean();
      const names = new Map(roles.map((role) => [role._id.toHexString(), role.name]));
      for (const row of rows) {
        const id = String(row.roleId); const previous = groups.get(id) ?? { id, name: names.get(id) ?? 'Archived role', ...metric(), ...(events ? sales() : { salesValue: null, generatedLeads: null, qualifiedLeads: null, approvedConversions: null }), ...Object.fromEntries(Object.entries(counts).map(([key, values]) => [key, values ? 0 : null])) };
        for (const key of ['submittedCalls', 'approvedCalls', 'connectedCalls', 'submittedVisits', 'approvedVisits', 'pendingReports', 'rejectedReports', 'callDurationSeconds', ...(events ? ['generatedLeads', 'qualifiedLeads', 'approvedConversions'] : [])]) previous[key] = Number(previous[key]) + Number(row[key]);
        for (const [key, values] of Object.entries(counts)) if (values) previous[key] = Number(previous[key]) + Number(row[key]);
        if (events) previous.salesValue = decimalString(hundredths(String(previous.salesValue)) + hundredths(String(row.salesValue)));
        groups.set(id, previous);
      }
      rows = [...groups.values()];
    }
    const sort = a.query.sortBy;
    if (!events && (sort === 'salesValue' || sort === 'approvedConversions')) {
      if (sort === 'salesValue') throw new AppError(403, 'FORBIDDEN', 'leads:read is required for financial ranking');
    }
    rows.sort((left, right) => {
      let difference: number;
      if (sort === 'salesValue' && events) { const aValue = hundredths(String(left.salesValue)); const bValue = hundredths(String(right.salesValue)); difference = aValue < bValue ? -1 : aValue > bValue ? 1 : 0; }
      else if (sort === 'name') difference = String(left.name).localeCompare(String(right.name));
      else difference = Number(left[events ? sort : 'approvedCalls']) - Number(right[events ? sort : 'approvedCalls']);
      return (a.query.sortOrder === 'asc' ? difference : -difference) || String(left.id).localeCompare(String(right.id));
    });
    return { available: true, rows: all ? rows : rows.slice((a.query.page - 1) * a.query.limit, a.query.page * a.query.limit), total: rows.length, page: all ? 1 : a.query.page, limit: all ? rows.length : a.query.limit,
      rankingUsesApprovedActivity: true, financialMetricsAvailable: Boolean(events), effectiveSortBy: !events && sort === 'approvedConversions' ? 'approvedCalls' : sort, roleAttribution: 'CURRENT_EMPLOYEE_ROLE' };
  }
  private async targets(repo: DashboardRepository, window: DashboardWindow, all: boolean, optional = false) {
    const a = repo.access;
    const filter: Record<string, unknown> = { status: 'ACTIVE', startDate: trusted({ $lt: window.end }), endDate: trusted({ $gt: window.start }) };
    if (a.query.targetType) filter.targetType = a.query.targetType;
    const records = await TargetModel.find({ $and: [filter, await a.source('targets:read', employeeAdapter)] }).limit(501).session(a.session).lean();
    if (records.length > 500) throw new AppError(422, 'DASHBOARD_TARGET_LIMIT', 'Narrow target filters to at most 500 definitions');
    if (optional && records.some((record) => !['CALLS_COMPLETED', 'CONNECTED_CALLS', 'SITE_VISITS'].includes(record.targetType)) && !a.has('leads:read')) return unavailable(['leads:read']);
    const groups = new Map<string, { type: typeof records[number]['targetType']; periodType: string; branchId: Types.ObjectId; startDate: Date; endDate: Date; employees: Types.ObjectId[]; target: bigint; count: number }>();
    for (const record of records) {
      const key = [record.branchId.toHexString(), record.targetType, record.periodType, record.startDate.toISOString(), record.endDate.toISOString()].join('|');
      const group = groups.get(key) ?? { type: record.targetType, periodType: record.periodType, branchId: record.branchId, startDate: record.startDate, endDate: record.endDate, employees: [], target: 0n, count: 0 };
      group.employees.push(record.employeeId); group.target += hundredths(record.targetValue.toString()); group.count++; groups.set(key, group);
    }
    const ordered = [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)); const rows: Record<string, unknown>[] = [];
    for (const [, group] of all ? ordered : ordered.slice((a.query.page - 1) * a.query.limit, a.query.page * a.query.limit)) {
      const actualValue = await this.targetRepository.actual(a.actor, group.type, group.employees, group.branchId, group.startDate, group.endDate, repo.asOf, a.session); const targetValue = decimalString(group.target);
      rows.push({ targetType: group.type, periodType: group.periodType, branchId: group.branchId, startDate: group.startDate, endDate: group.endDate, targetCount: group.count, employeeCount: group.employees.length, targetValue, actualValue, achievementPercentage: achievement(actualValue, targetValue) });
    }
    return { available: true, rows, total: groups.size, approvedOnly: true, actualPeriod: 'FULL_TARGET_INTERVAL_INTERSECTING_REQUEST' };
  }
  async calendar(actor: Principal, branchId: Types.ObjectId, input?: CalendarInput, context?: AuditContext) {
    return this.access.transaction(async (session) => {
      const current = await this.access.actor(actor, input ? 'settings:manage' : 'dashboard:read', session);
      if (input) this.authorization.requireAll(current, 'settings:manage');
      const query: DashboardQuery = { startDate: businessDate(), endDate: nextDay(businessDate()), compare: false, page: 1, limit: 20, sortBy: 'name', sortOrder: 'asc' };
      const access = new DashboardAccess(current, query, session, false);
      if (!await BranchModel.exists({ $and: [{ _id: branchId }, await access.branchFilter()] }).session(session)) throw new AppError(404, 'NOT_FOUND', 'Branch not found');
      if (!input) return await AttendanceCalendarModel.findOne({ branchId }).session(session).lean() ?? { branchId, configured: false };
      const previous = await AttendanceCalendarModel.findOne({ branchId }).session(session).lean();
      if ((previous?.revision ?? 0) !== input.revision) throw new AppError(409, 'CONFLICT', 'Calendar changed; reload its revision');
      const calendar = await AttendanceCalendarModel.findOneAndUpdate({ branchId, ...(previous ? { revision: input.revision } : {}) }, { $set: { workingWeekdays: input.workingWeekdays, holidays: input.holidays, changedBy: current.userId }, $inc: { revision: 1 } }, { session, upsert: !previous, returnDocument: 'after', runValidators: true }).lean();
      if (!calendar) throw new AppError(409, 'CONFLICT', 'Calendar changed');
      await audit(session, context ?? { requestId: 'calendar-update' }, 'ATTENDANCE_CALENDAR_UPDATED', current.userId, 'branch', branchId, { revision: String(calendar.revision) }); return calendar;
    });
  }
}
