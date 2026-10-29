import { Types, trusted } from 'mongoose';
import type { Principal } from '../auth/auth.types.js';
import type { AttendanceQuery } from './attendance.types.js';
import { ScopeService } from '../permissions/authorization.service.js';
import { UserModel } from '../users/user.model.js';
import { RoleModel } from '../roles/role.model.js';
import { PermissionModel } from '../permissions/permission.model.js';
import { BranchModel } from '../branches/branch.model.js';
import { AttendanceCalendarModel } from '../dashboards/dashboard.model.js';
import { AttendanceModel } from './attendance.model.js';
import { OfficeSettingsModel } from './office-settings.model.js';
import { attendanceEligibility, type OfficeSchedule } from './workforce-rules.js';
import { businessDate } from '../../shared/utils/business-date.js';
import { AppError } from '../../shared/errors/app-error.js';
export class WorkforceService {
  private readonly scopes = new ScopeService();
  async today(actor: Principal, query: AttendanceQuery) {
    const now = new Date(); const date = businessDate(now);
    let scope = await this.scopes.predicate(actor, 'attendance:read', { ownerField: '_id', branchField: 'branchId' });
    if (query.managerId) scope = this.scopes.combine(scope, { _id: trusted({ $in: await this.scopes.descendants(new Types.ObjectId(query.managerId), false) }) });
    scope = this.scopes.combine(scope, {
      ...(query.employeeId ? { _id: new Types.ObjectId(query.employeeId) } : {}),
      ...(query.roleId ? { roleId: new Types.ObjectId(query.roleId) } : {}),
      ...(query.branchId ? { branchId: new Types.ObjectId(query.branchId) } : {}),
    });
    const employees = await UserModel.find(scope).select('_id branchId roleId isActive employmentStatus dateOfJoining').limit(5001).maxTimeMS(5000).lean();
    if (employees.length > 5000) throw new AppError(422, 'WORKFORCE_LIMIT', 'Narrow the team to at most 5000 employees');
    const [permission, office, branches, calendars] = await Promise.all([
      PermissionModel.findOne({ code: 'attendance:create' }).select('_id').lean(),
      OfficeSettingsModel.findById('office').lean(),
      BranchModel.find({ _id: trusted({ $in: employees.flatMap((user) => user.branchId ? [user.branchId] : []) }) }).select('_id isActive attendancePolicy').lean(),
      AttendanceCalendarModel.find({ branchId: trusted({ $in: employees.flatMap((user) => user.branchId ? [user.branchId] : []) }) }).lean(),
    ]);
    if (!permission) throw new AppError(503, 'PERMISSIONS_NOT_INITIALIZED', 'Attendance permission registry must be initialized');
    const roles = await RoleModel.find({ _id: trusted({ $in: employees.map((user) => user.roleId) }), isActive: true,
      permissions: trusted({ $elemMatch: { permissionId: permission._id, scope: 'SELF' } }) }).select('_id').lean();
    const eligibleRoles = new Set(roles.map((role) => role._id.toHexString()));
    const branchMap = new Map(branches.map((branch) => [branch._id.toHexString(), branch]));
    const calendarMap = new Map(calendars.map((calendar) => [calendar.branchId.toHexString(), calendar]));
    const attendanceScope = await this.scopes.predicate(actor, 'attendance:read', { ownerField: 'employeeId', branchField: 'branchId' });
    const presentIds = await AttendanceModel.distinct('employeeId', { $and: [attendanceScope,
      { attendanceDate: date, employeeId: trusted({ $in: employees.map((user) => user._id) }), checkInAt: trusted({ $lte: now }) }] }).maxTimeMS(5000);
    const present = new Set(presentIds.map((id: Types.ObjectId) => id.toHexString()));
    const counts = { totalEmployees: employees.length, activeEmployees: 0, onLeave: 0, inactiveEmployees: 0,
      notRequired: 0, present: 0, absent: 0, notDue: 0, nonWorkingDay: 0, notConfigured: 0 };
    for (const employee of employees) {
      if (!employee.isActive || employee.employmentStatus === 'EXITED') { counts.inactiveEmployees++; continue; }
      if (employee.employmentStatus === 'ON_LEAVE') { counts.onLeave++; continue; }
      counts.activeEmployees++;
      if (!eligibleRoles.has(employee.roleId.toHexString()) || businessDate(employee.dateOfJoining) > date) { counts.notRequired++; continue; }
      const branch = employee.branchId ? branchMap.get(employee.branchId.toHexString()) : undefined;
      if (employee.branchId && !branch?.isActive) { counts.notRequired++; continue; }
      const calendar = employee.branchId ? calendarMap.get(employee.branchId.toHexString()) : undefined;
      const policy = branch?.attendancePolicy;
      const startMinute = policy?.startMinute ?? office?.startMinute;
      const endMinute = policy?.endMinute ?? office?.endMinute;
      const schedule: OfficeSchedule | null = (calendar || office) && startMinute != null && endMinute != null ? {
        startMinute, endMinute, graceMinutes: policy?.startMinute != null ? policy.graceMinutes : office?.graceMinutes ?? 0,
        workingWeekdays: calendar?.workingWeekdays ?? office?.workingWeekdays ?? [],
        // Office holidays apply to all branches; branch holidays are additional exceptions.
        holidays: [...(calendar?.holidays ?? []), ...(office?.holidays ?? [])],
      } : null;
      const state = attendanceEligibility(date, schedule, present.has(employee._id.toHexString()), now);
      counts[({ NOT_CONFIGURED: 'notConfigured', NON_WORKING_DAY: 'nonWorkingDay', NOT_DUE: 'notDue', PRESENT: 'present', ABSENT: 'absent' } as const)[state]]++;
    }
    return { date, timezone: 'Asia/Kolkata', ...counts, absenceIsProvisional: true,
      definition: 'Today only: active attendance-eligible employees with no check-in after office start plus grace; excludes recorded leave, holidays and weekly offs. Not payroll.' };
  }
}
